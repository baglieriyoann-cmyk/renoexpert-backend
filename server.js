// ============================================================
// RénoExpert Backend v3.3 - Comptes utilisateurs + Notifications
// ============================================================
// 
// Nouvelles fonctionnalités :
// - Inscription / Connexion email + mot de passe
// - Quota 5 ANALYSES gratuites (sauf compte admin = illimité)
// - Sauvegardes de projets ILLIMITÉES (pas de coût Anthropic)
// - Notifications email via Brevo
// ============================================================

// Forcer le fuseau horaire France (gère automatiquement été/hiver).
// Évite le décalage UTC dans les dates affichées (emails, dashboard admin).
process.env.TZ = process.env.TZ || 'Europe/Paris';

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pdfGen = require('./pdfGenerator');

const app = express();
const PORT = process.env.PORT || 3000;

// Railway place un proxy devant l'app : faire confiance au 1er proxy
// pour récupérer la vraie IP du client (utile pour le rate-limiting).
app.set('trust proxy', 1);

// CORS restreint aux domaines autorisés (front Netlify + domaine custom)
const ALLOWED_ORIGINS = [
  'https://renoexpert.fr',
  'https://www.renoexpert.fr',
  process.env.FRONTEND_URL
].filter(Boolean);
app.use(cors({
  origin: function(origin, callback) {
    // Autorise les requêtes sans origin (apps mobiles, curl, Netlify proxy)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin) || origin.endsWith('.netlify.app')) {
      return callback(null, true);
    }
    return callback(null, true); // fallback permissif pour ne pas casser la prod
  },
  credentials: true
}));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// ============================================================
// RATE-LIMITING (maison, sans dépendance externe)
// ============================================================
// Protège contre les abus : brute-force sur les mots de passe,
// spam de requêtes, bots, et explosion de la facture API.
// Stockage en mémoire (suffisant pour un seul serveur Railway).
// Identifie par IP. Se nettoie automatiquement.
const rateLimitStore = new Map();

// Nettoyage périodique des entrées expirées (toutes les 10 min)
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of rateLimitStore.entries()) {
    if (now > data.resetAt) rateLimitStore.delete(key);
  }
}, 10 * 60 * 1000);

// Récupère l'IP réelle du client (Railway met un proxy devant)
function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

// Crée un middleware de rate-limit configurable
// - windowMs : fenêtre de temps en millisecondes
// - max : nombre maximum de requêtes autorisées dans la fenêtre
// - name : identifiant du limiteur (pour séparer les compteurs par type de route)
// - message : message d'erreur personnalisé
function createRateLimiter({ windowMs, max, name, message }) {
  return (req, res, next) => {
    const ip = getClientIp(req);
    const key = `${name}:${ip}`;
    const now = Date.now();

    let data = rateLimitStore.get(key);
    if (!data || now > data.resetAt) {
      // Nouvelle fenêtre
      data = { count: 1, resetAt: now + windowMs };
      rateLimitStore.set(key, data);
      return next();
    }

    data.count++;
    if (data.count > max) {
      const retryAfterSec = Math.ceil((data.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfterSec));
      const retryMin = Math.ceil(retryAfterSec / 60);
      return res.status(429).json({
        error: message || `Trop de requêtes. Réessayez dans ${retryMin} minute(s).`,
        code: 'RATE_LIMIT_EXCEEDED',
        retryAfter: retryAfterSec
      });
    }
    next();
  };
}

// Limiteur AUTH : anti brute-force (login, register, forgot-password)
// 10 tentatives / 15 min par IP
const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  name: 'auth',
  message: 'Trop de tentatives de connexion. Pour votre sécurité, réessayez dans 15 minutes.'
});

// Limiteur IA : anti-abus coûteux (analyze, refine)
// 20 requêtes / heure par IP (en plus du quota de 5 par compte)
const aiLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 20,
  name: 'ai',
  message: 'Trop d\'analyses lancées en peu de temps. Réessayez dans une heure.'
});

// Limiteur GÉNÉRAL : anti-spam sur les autres routes API
// 120 requêtes / 15 min par IP
const generalLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 120,
  name: 'general',
  message: 'Trop de requêtes. Patientez quelques minutes.'
});


const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ============================================================
// VARIABLES D'ENVIRONNEMENT (à définir sur Railway)
// ============================================================
// - ANTHROPIC_API_KEY : ta clé Claude (déjà configurée)
// - DATABASE_URL : ${{Postgres.DATABASE_URL}} (déjà configurée)
// - ADMIN_TOKEN : ton mot de passe pour le dashboard admin
// - ADMIN_EMAIL : TON email (ex: yoann@example.com) = compte illimité
// - BREVO_API_KEY : ta clé API Brevo pour envoyer des emails
// - NOTIFICATION_EMAIL : email où tu veux recevoir les notifications

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin123';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL || ADMIN_EMAIL;
const FRONTEND_URL = (process.env.FRONTEND_URL || 'https://renoexpert.fr').replace(/\/$/, '');
// ============================================================
// SYSTÈME DE CRÉDITS (remplace le quota par mode)
// ============================================================
// Coût en crédits par type d'analyse
const CREDIT_COSTS = {
  express:    1,   // Chiffrage Express (prompt court)
  reparation: 2,   // Travaux & Réparations (rapport complet sans investissement)
  complet:    3,   // Rapport Complet agent/visite/marchand
  annonce:    1,   // Génération d'annonce immobilière
  default:    1    // fallback
};
// Crédits offerts à l'inscription (bêta)
const CREDITS_BETA = 3;
// Admin : crédits illimités (plan 'illimite')
const MODES_SANS_PDF = []; // Plus de restriction PDF en bêta crédits

// ============================================================
// CONNEXION POSTGRESQL
// ============================================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  try {
    // Table utilisateurs
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        nom VARCHAR(255),
        plan VARCHAR(20) DEFAULT 'gratuit',
        session_token VARCHAR(255),
        session_expires TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP
      )
    `);

    // Colonnes SIRET (vérification pro pour modes agent / marchand)
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS siret VARCHAR(14)`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS siret_raison_sociale VARCHAR(255)`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS siret_verifie_at TIMESTAMP`);

    // Table feedbacks (mise à jour avec user_id INT pour lier aux comptes)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS feedbacks (
        id SERIAL PRIMARY KEY,
        mode VARCHAR(50),
        note VARCHAR(10),
        probleme TEXT,
        location VARCHAR(255),
        user_id VARCHAR(100),
        user_email VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Vérifier si la colonne user_email existe, sinon l'ajouter
    await pool.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name='feedbacks' AND column_name='user_email'
        ) THEN
          ALTER TABLE feedbacks ADD COLUMN user_email VARCHAR(255);
        END IF;
      END $$;
    `);
    
    // Table projets (mise à jour : user_id devient l'email)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS projets (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(100) NOT NULL,
        user_email VARCHAR(255),
        mode VARCHAR(50) NOT NULL,
        titre VARCHAR(255),
        analysis TEXT,
        data JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Ajouter colonne user_email à projets si pas déjà
    await pool.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name='projets' AND column_name='user_email'
        ) THEN
          ALTER TABLE projets ADD COLUMN user_email VARCHAR(255);
        END IF;
      END $$;
    `);
    
    await pool.query(`ALTER TABLE projets ADD COLUMN IF NOT EXISTS bien_id INTEGER`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_projets_user ON projets(user_id, created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_session ON users(session_token)`);

    // Ajouter colonne nb_analyses à users si pas déjà (compteur d'analyses IA lancées)
    await pool.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name='users' AND column_name='nb_analyses'
        ) THEN
          ALTER TABLE users ADD COLUMN nb_analyses INTEGER DEFAULT 0;
        END IF;
      END $$;
    `);

    // Table password_resets : stocke les tokens de réinitialisation de mot de passe
    await pool.query(`
      CREATE TABLE IF NOT EXISTS password_resets (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        token VARCHAR(255) UNIQUE NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        used BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets(token)`);

    // Table de suivi des analyses PAR MODE (quota par mode en version test)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS analyses_par_mode (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        mode VARCHAR(50) NOT NULL,
        nb_analyses INTEGER DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, mode)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_apm_user ON analyses_par_mode(user_id, mode)`);

    // Table prospects : emails laissés pour être avertis de la sortie de l'app
    await pool.query(`
      CREATE TABLE IF NOT EXISTS prospects (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        mode VARCHAR(50),
        user_id INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_prospects_email ON prospects(email)`);

    // Table questionnaires : réponses au questionnaire de fin d'analyse
    await pool.query(`
      CREATE TABLE IF NOT EXISTS questionnaires (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        user_email VARCHAR(255),
        mode VARCHAR(50),
        utilite VARCHAR(50),
        precision_estim VARCHAR(50),
        pret_a_payer VARCHAR(50),
        prix_juste VARCHAR(100),
        amelioration TEXT,
        recommander VARCHAR(20),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_questionnaires_user ON questionnaires(user_id)`);

    // === NOUVEAU SYSTÈME CRÉDITS + PROFILS (mai 2026) ===
    // Colonne credits (solde disponible, défaut 3 crédits bêta)
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='credits') THEN
          ALTER TABLE users ADD COLUMN credits INTEGER DEFAULT ${CREDITS_BETA};
        END IF;
      END $$;
    `);
    // Colonne profil (array ex: '{"agent"}', '{"particulier"}', '{"investisseur"}')
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='profil') THEN
          ALTER TABLE users ADD COLUMN profil TEXT[] DEFAULT '{}';
        END IF;
      END $$;
    `);

    // Table biens (portefeuille agent / investisseur)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS biens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        adresse VARCHAR(500),
        type_bien VARCHAR(100),
        surface NUMERIC(8,2),
        nb_niveaux INTEGER DEFAULT 1,
        date_visite DATE,
        statut VARCHAR(50) DEFAULT 'actif',
        fourchette_basse INTEGER,
        fourchette_haute INTEGER,
        rapport_complet TEXT,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_biens_user ON biens(user_id, created_at DESC)`);

    // Table pieces (arbre généalogique : bien → étage → pièce)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pieces (
        id SERIAL PRIMARY KEY,
        bien_id INTEGER NOT NULL REFERENCES biens(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL,
        etage VARCHAR(50),
        nom VARCHAR(100),
        surface NUMERIC(6,2),
        statut VARCHAR(20) DEFAULT 'standard',
        travaux TEXT[],
        fourchette_basse INTEGER,
        fourchette_haute INTEGER,
        analyse_express TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pieces_bien ON pieces(bien_id)`);

    // Table satisfaction (mini questionnaire post-analyse)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS satisfaction (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        user_email VARCHAR(255),
        mode VARCHAR(50),
        note INTEGER,
        precis BOOLEAN,
        commentaire TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Table LISTE D'ATTENTE — prospects intéressés par la future version payante.
    // Permet de mesurer la demande réelle et de fixer le prix juste avant d'ouvrir les paiements.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS liste_attente (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        email VARCHAR(255) NOT NULL,
        mode VARCHAR(50),
        prix_souhaite VARCHAR(100),
        frequence VARCHAR(100),
        commentaire TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_liste_attente_email ON liste_attente(email)`);

    // Migration : colonne dpe_classe sur la table biens
    await pool.query(`ALTER TABLE biens ADD COLUMN IF NOT EXISTS dpe_classe VARCHAR(1)`);

    console.log('✅ Base de données initialisée');
  } catch (err) {
    console.error('❌ Erreur init DB:', err.message);
  }
}

initDB();

// ============================================================
// HELPER : ENVOYER UN EMAIL VIA BREVO
// ============================================================

async function sendEmail(to, subject, htmlContent) {
  if (!BREVO_API_KEY) {
    console.log('⚠️ BREVO_API_KEY non configurée, email non envoyé');
    return false;
  }
  
  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': BREVO_API_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: 'RénoExpert', email: 'baglieriyoann@gmail.com' },
        to: [{ email: to }],
        subject,
        htmlContent
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Erreur Brevo:', errorText);
      return false;
    }
    
    console.log('✅ Email envoyé à', to);
    return true;
  } catch (err) {
    console.error('❌ Erreur envoi email:', err.message);
    return false;
  }
}

// Template email simple
function emailTemplate(title, content, buttonText, buttonUrl) {
  return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"></head>
    <body style="font-family: Arial, sans-serif; background: #f5f7fb; margin: 0; padding: 20px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 600px; margin: 0 auto; background: white; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,102,255,0.1);">
        <tr>
          <td style="background: linear-gradient(135deg, #0066ff, #4d94ff); padding: 30px; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 24px;">🏠 RénoExpert</h1>
          </td>
        </tr>
        <tr>
          <td style="padding: 30px;">
            <h2 style="color: #0a0e27; margin: 0 0 20px;">${title}</h2>
            <div style="color: #5e6987; line-height: 1.6; font-size: 14px;">
              ${content}
            </div>
            ${buttonText && buttonUrl ? `
              <div style="text-align: center; margin: 30px 0;">
                <a href="${buttonUrl}" style="display: inline-block; background: linear-gradient(135deg, #0066ff, #4d94ff); color: white; padding: 14px 28px; text-decoration: none; border-radius: 10px; font-weight: 700;">${buttonText}</a>
              </div>
            ` : ''}
          </td>
        </tr>
        <tr>
          <td style="background: #f5f7fb; padding: 20px; text-align: center; color: #8b95b0; font-size: 12px;">
            © RénoExpert ${new Date().getFullYear()} · Propulsé par Claude AI
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;
}

// ============================================================
// AUTHENTIFICATION - HELPERS
// ============================================================

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ============================================================
// DONNÉES DE PRIX IMMOBILIER RÉELLES (DVF - data.gouv.fr)
// ============================================================
// Interroge la base officielle des ventes immobilières (Demandes de Valeurs
// Foncières) pour calculer un prix au m² médian réel sur une commune.
// Robuste : en cas d'échec de l'API, renvoie null (l'IA basculera sur l'estimation).
const dvfCache = new Map();
const DVF_CACHE_MS = 24 * 60 * 60 * 1000; // 24h

function median(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? Math.round(sorted[mid]) : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// Récupère le code INSEE d'une commune à partir du code postal (API officielle géo)
async function getCodeInsee(codePostal, nomCommune) {
  try {
    const url = `https://geo.api.gouv.fr/communes?codePostal=${encodeURIComponent(codePostal)}&fields=nom,code&format=json`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const communes = await r.json();
    if (!communes || communes.length === 0) return null;
    if (communes.length > 1 && nomCommune) {
      const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/g, '');
      const match = communes.find(c => norm(c.nom) === norm(nomCommune) || norm(c.nom).includes(norm(nomCommune)) || norm(nomCommune).includes(norm(c.nom)));
      if (match) return { code: match.code, nom: match.nom };
    }
    return { code: communes[0].code, nom: communes[0].nom };
  } catch (err) {
    console.error('⚠️ getCodeInsee échec:', err.message);
    return null;
  }
}

// Interroge DVF et calcule le prix médian au m² pour MAISONS et APPARTEMENTS
// Essaie plusieurs sources DVF dans l'ordre jusqu'à ce qu'une réponde.
// Retourne un tableau de mutations normalisées {valeur, surface, type} ou null.
async function fetchMutationsDVF(codePostal, codeInsee) {
  // --- SOURCE PRINCIPALE : fichiers CSV officiels géo-DVF (files.data.gouv.fr) ---
  // Ultra-stable, hébergé sur l'infra officielle. Organisé par code INSEE de commune.
  // On lit les 2 années les plus récentes disponibles.
  if (codeInsee) {
    const dept = codeInsee.substring(0, 2); // ex: "60382" -> "60" (gère aussi 2A/2B)
    const annees = ['2024', '2023'];
    let toutes = [];
    for (const annee of annees) {
      try {
        const url = `https://files.data.gouv.fr/geo-dvf/latest/csv/${annee}/communes/${dept}/${codeInsee}.csv`;
        const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
        if (!r.ok) continue;
        const csv = await r.text();
        const lignes = csv.split('\n');
        if (lignes.length < 2) continue;
        const entetes = lignes[0].split(',');
        const idx = {
          valeur: entetes.indexOf('valeur_fonciere'),
          surface: entetes.indexOf('surface_reelle_bati'),
          type: entetes.indexOf('type_local'),
          nature: entetes.indexOf('nature_mutation')
        };
        for (let i = 1; i < lignes.length; i++) {
          const cols = lignes[i].split(',');
          if (cols.length < entetes.length) continue;
          const nature = idx.nature >= 0 ? cols[idx.nature] : 'Vente';
          if (nature && nature !== 'Vente') continue; // garder seulement les ventes
          toutes.push({
            valeur: parseFloat(cols[idx.valeur]),
            surface: parseFloat(cols[idx.surface]),
            type: cols[idx.type]
          });
        }
      } catch (err) {
        console.error(`⚠️ DVF CSV ${annee} échec:`, err.message);
      }
    }
    if (toutes.length > 0) {
      console.log(`✅ DVF CSV officiel : ${toutes.length} lignes pour INSEE ${codeInsee}`);
      return toutes;
    }
  }

  // --- SECOURS : micro-API cquest (filtre direct par code postal) ---
  try {
    const url = `https://api.cquest.org/dvf?code_postal=${codePostal}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(9000) });
    if (r.ok) {
      const json = await r.json();
      const recs = json.features || json.resultats || [];
      const mutations = recs.map(f => {
        const p = f.properties || f;
        return {
          valeur: parseFloat(p.valeur_fonciere),
          surface: parseFloat(p.surface_relle_bati || p.surface_reelle_bati),
          type: p.type_local
        };
      });
      if (mutations.length > 0) {
        console.log(`✅ DVF secours (cquest) : ${mutations.length} mutations pour CP ${codePostal}`);
        return mutations;
      }
    }
  } catch (err) {
    console.error('⚠️ DVF secours (cquest) échec:', err.message);
  }

  console.log(`❌ DVF : aucune source n'a répondu pour CP ${codePostal} / INSEE ${codeInsee}`);
  return null;
}

async function getDVFData(codePostal, nomCommune) {
  if (!codePostal) return null;
  const cacheKey = String(codePostal);
  const cached = dvfCache.get(cacheKey);
  if (cached && Date.now() < cached.expires) return cached.data;

  try {
    // On récupère le code INSEE en parallèle (utile pour la source 2 et le nom de commune)
    const insee = await getCodeInsee(codePostal, nomCommune);
    const mutations = await fetchMutationsDVF(codePostal, insee ? insee.code : null);
    if (!mutations || mutations.length === 0) return null;

    const prixM2ParType = { Maison: [], Appartement: [] };
    mutations.forEach(m => {
      const valeur = m.valeur;
      const surface = m.surface;
      const type = m.type;
      if (!valeur || !surface || surface < 9) return;
      if (valeur < 10000 || valeur > 3000000) return;
      const prixM2 = valeur / surface;
      if (prixM2 < 200 || prixM2 > 20000) return;
      if (type === 'Maison') prixM2ParType.Maison.push(prixM2);
      else if (type === 'Appartement') prixM2ParType.Appartement.push(prixM2);
    });

    const maisonMed = median(prixM2ParType.Maison);
    const appartMed = median(prixM2ParType.Appartement);
    if (!maisonMed && !appartMed) return null; // pas de données exploitables

    const result = {
      commune: insee ? insee.nom : ('CP ' + codePostal),
      code_insee: insee ? insee.code : null,
      maison: { prix_m2_median: maisonMed, nb_ventes: prixM2ParType.Maison.length },
      appartement: { prix_m2_median: appartMed, nb_ventes: prixM2ParType.Appartement.length },
      source: 'DVF (ventes reelles enregistrees, data.gouv.fr)'
    };
    dvfCache.set(cacheKey, { data: result, expires: Date.now() + DVF_CACHE_MS });
    return result;
  } catch (err) {
    console.error('⚠️ getDVFData échec:', err.message);
    return null;
  }
}

// Construit un bloc texte à injecter dans le prompt avec les vraies données prix
function buildDVFContext(dvf, prixAgentM2) {
  let bloc = '\n=== DONNEES DE PRIX REELLES (a utiliser EN PRIORITE pour l\'estimation) ===\n';
  if (prixAgentM2 && parseFloat(prixAgentM2) > 0) {
    bloc += `Prix au m2 de reference SAISI PAR L'AGENT (il connait son secteur) : ${prixAgentM2} €/m2. C'est la donnee la PLUS fiable, utilise-la comme pivot principal.\n`;
  }
  if (dvf) {
    bloc += `\nVentes reelles enregistrees (base DVF officielle) pour ${dvf.commune} :\n`;
    if (dvf.maison.prix_m2_median) {
      bloc += `- MAISONS : prix median ${dvf.maison.prix_m2_median} €/m2 (sur ${dvf.maison.nb_ventes} ventes reelles)\n`;
    }
    if (dvf.appartement.prix_m2_median) {
      bloc += `- APPARTEMENTS : prix median ${dvf.appartement.prix_m2_median} €/m2 (sur ${dvf.appartement.nb_ventes} ventes reelles)\n`;
    }
    bloc += `Source : ${dvf.source}.\n`;
    bloc += `\nNOTE IMPORTANTE : ces prix DVF sont des MEDIANES toutes ventes confondues (biens en bon etat ET a renover melanges). Pour un bien EN BON ETAT ou RENOVE, le prix se situe dans le HAUT de la fourchette, voire au-dessus de la mediane. Pour un bien a renover, plutot dans le bas. N'utilise PAS la mediane brute comme prix de vente d'un bien renove : ajuste a la hausse selon l'etat reel constate sur les photos.\n`;
  } else if (!prixAgentM2) {
    bloc += 'Aucune donnee DVF disponible pour cette commune et aucun prix saisi par l\'agent.\n';
    bloc += 'IMPORTANT : sois PRUDENT et plutot genereux dans l\'estimation. Ne sous-estime JAMAIS un bien. En cas de doute, donne une fourchette large et precise que l\'agent doit valider le prix avec sa connaissance du secteur et les annonces comparables locales.\n';
  }
  bloc += '=== FIN DONNEES PRIX ===\n';
  return bloc;
}

// Extrait un code postal (5 chiffres) d'une chaîne de localisation
function extraireCodePostal(location) {
  if (!location) return null;
  const m = String(location).match(/\b(\d{5})\b/);
  return m ? m[1] : null;
}

// Extrait le nom de commune d'une chaîne (retire le code postal et la ponctuation)
function extraireNomCommune(location) {
  if (!location) return null;
  return String(location)
    .replace(/\b\d{5}\b/g, '')
    .replace(/[,;]/g, ' ')
    .trim()
    .split(/\s{2,}/)[0]
    .trim() || null;
}

// Middleware pour vérifier l'authentification
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.body.token || req.query.token;
  
  if (!token) {
    return res.status(401).json({ error: 'Non authentifié', code: 'NO_TOKEN' });
  }
  
  try {
    const result = await pool.query(
      'SELECT id, email, nom, plan, nb_analyses, siret, credits, profil FROM users WHERE session_token = $1 AND session_expires > NOW()',
      [token]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Session expirée', code: 'SESSION_EXPIRED' });
    }
    
    req.user = result.rows[0];
    next();
  } catch (err) {
    console.error('Erreur auth:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
}

// ============================================================
// QUOTA ANALYSES — Helpers
// ============================================================
// Extrait le mode depuis l'URL de la requête (/api/analyze/agent -> 'agent', /api/refine/visite -> 'visite')
function getModeFromReq(req) {
  const m = req.path.match(/\/api\/(?:analyze|refine)\/(\w+)/);
  if (m) return m[1];
  if (req.path.includes('/api/annonce')) return 'agent'; // l'annonce compte dans le quota agent
  return null;
}

// Récupère le nombre d'analyses déjà faites pour un mode donné
async function getNbAnalysesMode(userId, mode) {
  try {
    const r = await pool.query(
      'SELECT nb_analyses FROM analyses_par_mode WHERE user_id = $1 AND mode = $2',
      [userId, mode]
    );
    return r.rows.length ? parseInt(r.rows[0].nb_analyses || 0) : 0;
  } catch (err) {
    console.error('⚠️ getNbAnalysesMode échec:', err.message);
    return 0;
  }
}

// ============================================================
// CRÉDITS — Middleware + helpers
// ============================================================

// Récupère le coût en crédits selon le type d'analyse
function getCreditCost(req) {
  if (req.path.includes('/api/analyze/express')) return CREDIT_COSTS.express;
  if (req.path.includes('/api/refine/express')) return CREDIT_COSTS.express;
  if (req.path.includes('/api/analyze/reparation')) return CREDIT_COSTS.reparation;
  if (req.path.includes('/api/annonce')) return CREDIT_COSTS.annonce;
  return CREDIT_COSTS.complet; // toutes les autres analyses = rapport complet = 3
}

// Vérifie que l'utilisateur a assez de crédits AVANT l'appel IA
async function checkCredits(req, res, next) {
  if (req.user.plan === 'illimite') return next(); // admin : toujours OK
  const cost = getCreditCost(req);
  const credits = parseInt(req.user.credits || 0);
  if (credits < cost) {
    return res.status(403).json({
      error: `Crédits insuffisants. Cette analyse coûte ${cost} crédit${cost > 1 ? 's' : ''}. Votre solde : ${credits} crédit${credits !== 1 ? 's' : ''}.`,
      code: 'CREDITS_INSUFFISANTS',
      credits_restants: credits,
      credits_necessaires: cost
    });
  }
  req.creditCost = cost; // mémorise pour déduire après l'analyse
  next();
}

// Déduit les crédits après une analyse réussie
async function deductCredits(userId, cost) {
  try {
    await pool.query(
      'UPDATE users SET credits = GREATEST(0, credits - $1) WHERE id = $2',
      [cost, userId]
    );
  } catch (err) {
    console.error('⚠️ Erreur déduction crédits user', userId, ':', err.message);
  }
}

// Compat : checkAnalysesQuota redirige vers checkCredits
const checkAnalysesQuota = checkCredits;

// ============================================================
// VÉRIFICATION SIRET (modes pro : agent / marchand)
// ============================================================
// 1) Contrôle de format + clé de Luhn (toujours appliqué, instantané, hors-ligne)
function validerSiretFormat(siret) {
  if (!siret) return false;
  const s = String(siret).replace(/\s/g, '');
  if (!/^\d{14}$/.test(s)) return false;
  // Clé de Luhn sur les 14 chiffres
  let somme = 0;
  for (let i = 0; i < 14; i++) {
    let chiffre = parseInt(s[i], 10);
    // Les positions paires (en partant de la droite, i pair depuis la gauche sur 14 chiffres) sont doublées
    if (i % 2 === 0) {
      chiffre *= 2;
      if (chiffre > 9) chiffre -= 9;
    }
    somme += chiffre;
  }
  return somme % 10 === 0;
}

// 2) Vérification réelle via l'API Sirene de l'INSEE (api.insee.fr/api-sirene/3.11).
//    Authentification par simple clé API dans le header X-INSEE-Api-Key-Integration.
//    S'active uniquement si INSEE_API_KEY est configurée.
//    Renvoie { ok, etablissement_actif, raison_sociale } ou { ok:false, raison }.
async function verifierSiretInsee(siret) {
  const s = String(siret).replace(/\s/g, '');
  // Format d'abord (gratuit, instantané)
  if (!validerSiretFormat(s)) {
    return { ok: false, raison: 'format', message: 'Numéro SIRET invalide (14 chiffres attendus).' };
  }
  // Si la clé INSEE n'est pas configurée, on accepte sur la base du format (mode bêta dégradé)
  const apiKey = process.env.INSEE_API_KEY;
  if (!apiKey) {
    return { ok: true, etablissement_actif: null, raison_sociale: null, source: 'format_only' };
  }
  // Appel API Sirene établissement
  try {
    const base = process.env.INSEE_SIRENE_URL || 'https://api.insee.fr/api-sirene/3.11';
    const r = await fetch(`${base}/siret/${s}`, {
      headers: {
        'X-INSEE-Api-Key-Integration': apiKey,
        'Accept': 'application/json'
      }
    });
    if (r.status === 404) {
      return { ok: false, raison: 'introuvable', message: 'Ce SIRET n\'existe pas au répertoire Sirene.' };
    }
    if (r.status === 401 || r.status === 403) {
      // Problème de clé : on ne bloque pas un vrai pro, on retombe sur le format
      console.error('⚠️ INSEE clé refusée HTTP', r.status);
      return { ok: true, etablissement_actif: null, raison_sociale: null, source: 'format_fallback' };
    }
    if (!r.ok) {
      console.error('⚠️ INSEE Sirene HTTP', r.status);
      return { ok: true, etablissement_actif: null, raison_sociale: null, source: 'format_fallback' };
    }
    const data = await r.json();
    const etab = data.etablissement || {};
    const periodes = etab.periodesEtablissement || [];
    // La période en vigueur a dateFin = null ; sinon on prend la première
    const courante = periodes.find(p => p.dateFin === null) || periodes[0] || {};
    const actif = courante.etatAdministratifEtablissement === 'A';
    const ul = etab.uniteLegale || {};
    const raison = ul.denominationUniteLegale
      || [ul.prenom1UniteLegale, ul.nomUniteLegale].filter(Boolean).join(' ').trim()
      || null;
    if (!actif) {
      return { ok: false, raison: 'ferme', message: 'Cet établissement est fermé au répertoire Sirene.' };
    }
    return { ok: true, etablissement_actif: true, raison_sociale: raison, source: 'insee' };
  } catch (e) {
    console.error('⚠️ INSEE Sirene appel échec:', e.message);
    return { ok: true, etablissement_actif: null, raison_sociale: null, source: 'format_fallback' };
  }
}

// Middleware : bloque les modes pro (agent / marchand) si le compte n'a pas de SIRET validé.
// L'admin ('illimite') passe toujours.
async function requireSiret(req, res, next) {
  if (req.user.plan === 'illimite') return next();
  const mode = getModeFromReq(req);
  if (mode !== 'agent' && mode !== 'marchand') return next(); // seuls agent/marchand sont concernés
  if (req.user.siret && validerSiretFormat(req.user.siret)) return next();
  return res.status(403).json({
    error: 'Ce mode est réservé aux professionnels. Renseignez votre numéro SIRET pour y accéder.',
    code: 'SIRET_REQUIS',
    mode: mode
  });
}

// Affinement : libre pour tous dès qu'on a des crédits (pas de coût supplémentaire pour affiner)
function requirePaidForRefine(req, res, next) {
  return next(); // L'affinement ne coûte plus de crédits supplémentaires
}
async function incrementAnalysesCounter(userId, mode, creditCost) {
  try {
    // Compteur global nb_analyses (conservé pour stats)
    await pool.query(
      'UPDATE users SET nb_analyses = COALESCE(nb_analyses, 0) + 1 WHERE id = $1',
      [userId]
    );
    // Déduire les crédits si un coût est fourni
    if (creditCost && creditCost > 0) {
      await deductCredits(userId, creditCost);
    }
  } catch (err) {
    console.error('⚠️ Erreur incrément nb_analyses pour user', userId, ':', err.message);
  }
}

// ============================================================
// ============================================================
// VERSION (détection de déploiement côté client)
// ============================================================
const SERVER_START_TIME = Date.now();
app.get('/api/version', (req, res) => {
  res.json({ version: SERVER_START_TIME });
});

// ROUTES AUTHENTIFICATION
// ============================================================

// INSCRIPTION
app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const { email, password, nom } = req.body;
    
    // Validation
    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }
    
    const emailClean = email.toLowerCase().trim();
    
    // Validation email basique
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailClean)) {
      return res.status(400).json({ error: 'Email invalide' });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ error: 'Mot de passe trop court (6 caractères minimum)' });
    }
    
    // Vérifier si l'email existe déjà
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [emailClean]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Email déjà utilisé', code: 'EMAIL_EXISTS' });
    }
    
    // Hash du mot de passe
    const passwordHash = await bcrypt.hash(password, 10);
    
    // Plan : illimité si c'est l'admin, sinon gratuit
    const plan = (emailClean === ADMIN_EMAIL) ? 'illimite' : 'gratuit';
    
    // Créer le token de session (valide 30 jours)
    const sessionToken = generateToken();
    const sessionExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, nom, plan, credits, profil, session_token, session_expires, last_login) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW()) RETURNING id, email, nom, plan, credits, profil`,
      [emailClean, passwordHash, nom || '', plan, plan === 'illimite' ? 9999 : CREDITS_BETA, '{}', sessionToken, sessionExpires]
    );
    
    const user = result.rows[0];
    
    // Envoyer notification email à l'admin
    if (NOTIFICATION_EMAIL && emailClean !== ADMIN_EMAIL) {
      await sendEmail(
        NOTIFICATION_EMAIL,
        '🎉 Nouvelle inscription RénoExpert',
        emailTemplate(
          'Nouvelle inscription',
          `<p>Un nouvel utilisateur vient de s'inscrire :</p>
           <ul style="background: #f0f6ff; padding: 15px; border-radius: 10px; list-style: none;">
             <li><strong>📧 Email :</strong> ${emailClean}</li>
             <li><strong>👤 Nom :</strong> ${nom || 'Non renseigné'}</li>
             <li><strong>📅 Date :</strong> ${new Date().toLocaleString('fr-FR')}</li>
             <li><strong>🎁 Plan :</strong> ${plan}</li>
           </ul>
           <p>Connecte-toi à ton dashboard admin pour voir les statistiques.</p>`
        )
      );
    }
    
    res.json({
      success: true,
      token: sessionToken,
      user: { id: user.id, email: user.email, nom: user.nom, plan: user.plan, credits: user.credits, profil: user.profil || [] }
    });
    
  } catch (error) {
    console.error('Erreur inscription:', error);
    res.status(500).json({ error: error.message });
  }
});

// CONNEXION
app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }
    
    const emailClean = email.toLowerCase().trim();
    
    const result = await pool.query(
      'SELECT id, email, password_hash, nom, plan, credits, profil FROM users WHERE email = $1',
      [emailClean]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }
    
    const user = result.rows[0];
    const passwordValid = await bcrypt.compare(password, user.password_hash);
    
    if (!passwordValid) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }
    
    // Si c'est l'admin, mettre à jour son plan en illimité (au cas où)
    let userPlan = user.plan;
    if (emailClean === ADMIN_EMAIL && user.plan !== 'illimite') {
      await pool.query('UPDATE users SET plan = $1 WHERE id = $2', ['illimite', user.id]);
      userPlan = 'illimite';
    }
    
    // Créer un nouveau token de session
    const sessionToken = generateToken();
    const sessionExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    
    await pool.query(
      'UPDATE users SET session_token = $1, session_expires = $2, last_login = NOW() WHERE id = $3',
      [sessionToken, sessionExpires, user.id]
    );
    
    res.json({
      success: true,
      token: sessionToken,
      user: { id: user.id, email: user.email, nom: user.nom, plan: userPlan, credits: user.credits || 0, profil: user.profil || [] }
    });
    
  } catch (error) {
    console.error('Erreur connexion:', error);
    res.status(500).json({ error: error.message });
  }
});

// DÉCONNEXION
app.post('/api/auth/logout', requireAuth, async (req, res) => {
  try {
    await pool.query('UPDATE users SET session_token = NULL WHERE id = $1', [req.user.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// VÉRIFIER LA SESSION
app.get('/api/auth/me', requireAuth, async (req, res) => {
  const countResult = await pool.query(
    'SELECT COUNT(*) FROM projets WHERE user_email = $1',
    [req.user.email]
  );
  // Récupère les crédits frais depuis la DB
  const userFresh = await pool.query(
    'SELECT credits, profil FROM users WHERE id = $1',
    [req.user.id]
  );
  const credits = parseInt((userFresh.rows[0] && userFresh.rows[0].credits) || 0);
  const profil = (userFresh.rows[0] && userFresh.rows[0].profil) || [];

  res.json({
    success: true,
    user: { ...req.user, credits, profil },
    credits: credits,
    illimite: req.user.plan === 'illimite',
    profil: profil,
    nb_projets: parseInt(countResult.rows[0].count)
  });
});

// ============================================================
// SIRET — Vérification + enregistrement (accès modes pro)
// ============================================================
app.post('/api/siret/verifier', generalLimiter, requireAuth, async (req, res) => {
  try {
    const siretRaw = (req.body.siret || '').toString().replace(/\s/g, '');
    if (!validerSiretFormat(siretRaw)) {
      return res.status(400).json({ ok: false, code: 'FORMAT', error: 'Numéro SIRET invalide (14 chiffres requis).' });
    }
    const verif = await verifierSiretInsee(siretRaw);
    if (!verif.ok) {
      return res.status(400).json({ ok: false, code: (verif.raison || 'INVALIDE').toUpperCase(), error: verif.message || 'SIRET non valide.' });
    }
    // Enregistre sur le compte
    await pool.query(
      'UPDATE users SET siret = $1, siret_raison_sociale = $2, siret_verifie_at = NOW() WHERE id = $3',
      [siretRaw, verif.raison_sociale || null, req.user.id]
    );
    res.json({
      ok: true,
      siret: siretRaw,
      raison_sociale: verif.raison_sociale || null,
      source: verif.source || 'format'
    });
  } catch (err) {
    console.error('Erreur vérification SIRET:', err);
    res.status(500).json({ ok: false, error: 'Erreur serveur lors de la vérification.' });
  }
});

// ============================================================
// PROFIL UTILISATEUR — Sauvegarde du profil choisi à l'onboarding
// ============================================================
app.post('/api/user/profil', requireAuth, async (req, res) => {
  try {
    const { profil } = req.body; // ex: ["agent"] ou ["particulier"] ou ["investisseur"]
    if (!Array.isArray(profil) || profil.length === 0) {
      return res.status(400).json({ error: 'Profil invalide' });
    }
    const profilValid = profil.filter(p => ['agent', 'particulier', 'investisseur', 'marchand'].includes(p));
    await pool.query('UPDATE users SET profil = $1 WHERE id = $2', [profilValid, req.user.id]);
    res.json({ success: true, profil: profilValid });
  } catch (err) {
    console.error('Erreur save profil:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================================
// BIENS — Portefeuille agent / investisseur
// ============================================================
app.get('/api/biens', requireAuth, async (req, res) => {
  try {
    const biens = await pool.query(
      'SELECT * FROM biens WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    // Pour chaque bien, récupérer ses pièces
    const result = [];
    for (const bien of biens.rows) {
      const pieces = await pool.query('SELECT * FROM pieces WHERE bien_id = $1 ORDER BY etage, nom', [bien.id]);
      result.push({ ...bien, pieces: pieces.rows });
    }
    res.json({ success: true, biens: result });
  } catch (err) {
    console.error('Erreur get biens:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/biens', requireAuth, async (req, res) => {
  try {
    const { adresse, type_bien, surface, nb_niveaux, date_visite, notes, dpe_classe } = req.body;
    const r = await pool.query(
      `INSERT INTO biens (user_id, adresse, type_bien, surface, nb_niveaux, date_visite, notes, dpe_classe)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.user.id, adresse || '', type_bien || 'maison', surface || null, nb_niveaux || 1, date_visite || null, notes || '', dpe_classe || null]
    );
    res.json({ success: true, bien: r.rows[0] });
  } catch (err) {
    console.error('Erreur create bien:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/biens/:id', requireAuth, async (req, res) => {
  try {
    const bien = await pool.query('SELECT * FROM biens WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (bien.rows.length === 0) return res.status(404).json({ error: 'Bien non trouvé' });
    const pieces = await pool.query('SELECT * FROM pieces WHERE bien_id = $1 ORDER BY etage, nom', [req.params.id]);
    res.json({ success: true, bien: { ...bien.rows[0], pieces: pieces.rows } });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.put('/api/biens/:id', requireAuth, async (req, res) => {
  try {
    const { adresse, type_bien, surface, nb_niveaux, date_visite, notes, rapport_complet, fourchette_basse, fourchette_haute, dpe_classe } = req.body;
    const r = await pool.query(
      `UPDATE biens SET adresse=$1, type_bien=$2, surface=$3, nb_niveaux=$4, date_visite=$5, notes=$6,
       rapport_complet=COALESCE($7, rapport_complet), fourchette_basse=COALESCE($8, fourchette_basse),
       fourchette_haute=COALESCE($9, fourchette_haute), dpe_classe=COALESCE($10, dpe_classe), updated_at=NOW()
       WHERE id=$11 AND user_id=$12 RETURNING *`,
      [adresse, type_bien, surface, nb_niveaux, date_visite, notes, rapport_complet || null,
       fourchette_basse || null, fourchette_haute || null, dpe_classe || null, req.params.id, req.user.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Bien non trouvé' });
    res.json({ success: true, bien: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.delete('/api/biens/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM biens WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/biens/:id/pieces', requireAuth, async (req, res) => {
  try {
    const { etage, nom, surface, statut, travaux } = req.body;
    const r = await pool.query(
      `INSERT INTO pieces (bien_id, user_id, etage, nom, surface, statut, travaux)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.params.id, req.user.id, etage || 'RDC', nom || '', surface || null, statut || 'standard', travaux || []]
    );
    res.json({ success: true, piece: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================================
// SATISFACTION — Mini questionnaire post-analyse
// ============================================================
app.post('/api/satisfaction', requireAuth, async (req, res) => {
  try {
    const { mode, note, precis, commentaire } = req.body;
    await pool.query(
      `INSERT INTO satisfaction (user_id, user_email, mode, note, precis, commentaire)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [req.user.id, req.user.email, mode || '', note || null, precis !== undefined ? precis : null, commentaire || '']
    );
    // Notif admin si commentaire
    if (commentaire && NOTIFICATION_EMAIL) {
      sendEmail(NOTIFICATION_EMAIL, `💬 Feedback RénoExpert — ${mode}`,
        emailTemplate('Nouveau feedback', `<p><b>Mode :</b> ${mode}</p><p><b>Note :</b> ${note}/5</p><p><b>Précis :</b> ${precis ? 'Oui' : 'Non'}</p><p><b>Commentaire :</b> ${commentaire}</p>`)
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Erreur satisfaction:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================================
// MOT DE PASSE OUBLIÉ — Lien magique par email (valide 1h)
// ============================================================

// Étape 1 : l'utilisateur saisit son email, on lui envoie un lien magique
app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email requis' });
    }
    const emailClean = email.toLowerCase().trim();

    // Chercher l'utilisateur
    const userResult = await pool.query(
      'SELECT id, email, nom FROM users WHERE email = $1',
      [emailClean]
    );

    // SÉCURITÉ : on renvoie TOUJOURS un succès, même si l'email n'existe pas
    // (sinon un attaquant peut deviner quels emails sont enregistrés).
    if (userResult.rows.length === 0) {
      console.log('🔍 Demande reset pour email inconnu :', emailClean);
      return res.json({
        success: true,
        message: 'Si cet email existe dans notre base, vous allez recevoir un lien de réinitialisation.'
      });
    }

    const user = userResult.rows[0];

    // Invalider les anciens tokens non utilisés de cet utilisateur
    await pool.query(
      'UPDATE password_resets SET used = TRUE WHERE user_id = $1 AND used = FALSE',
      [user.id]
    );

    // Créer un nouveau token (32 bytes hex, valide 1h)
    const resetToken = generateToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 heure

    await pool.query(
      'INSERT INTO password_resets (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [user.id, resetToken, expiresAt]
    );

    // Envoyer l'email avec le lien magique
    const resetLink = `${FRONTEND_URL}/?reset_token=${encodeURIComponent(resetToken)}`;
    const htmlContent = `
      <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 24px; background: #f5f7fb;">
        <div style="background: white; border-radius: 16px; padding: 32px; box-shadow: 0 4px 16px rgba(0,0,0,0.06);">
          <h1 style="color: #0F1F3D; font-size: 22px; margin: 0 0 8px;">🔐 Réinitialisation de votre mot de passe</h1>
          <p style="color: #5e6987; font-size: 14px; margin: 0 0 24px;">Bonjour ${user.nom || ''},</p>
          <p style="color: #2c3548; font-size: 15px; line-height: 1.6; margin: 0 0 24px;">
            Vous avez demandé à réinitialiser le mot de passe de votre compte RénoExpert.
            Cliquez sur le bouton ci-dessous pour créer un nouveau mot de passe :
          </p>
          <div style="text-align: center; margin: 32px 0;">
            <a href="${resetLink}" style="display: inline-block; background: linear-gradient(135deg, #0F1F3D, #1F3358); color: white; padding: 14px 32px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 15px;">
              Réinitialiser mon mot de passe
            </a>
          </div>
          <p style="color: #5e6987; font-size: 13px; line-height: 1.6; margin: 24px 0 0;">
            Ou copiez ce lien dans votre navigateur :<br>
            <a href="${resetLink}" style="color: #C9A961; word-break: break-all;">${resetLink}</a>
          </p>
          <hr style="border: none; border-top: 1px solid #e8eef7; margin: 24px 0;">
          <p style="color: #97a3bd; font-size: 12px; line-height: 1.5; margin: 0;">
            ⏱️ Ce lien est valide pendant <strong>1 heure</strong>.<br>
            🛡️ Si vous n'avez pas demandé cette réinitialisation, ignorez simplement cet email — votre mot de passe ne sera pas modifié.
          </p>
        </div>
        <p style="text-align: center; color: #97a3bd; font-size: 12px; margin: 16px 0 0;">
          RénoExpert · Diagnostic immobilier IA
        </p>
      </div>
    `;

    const emailSent = await sendEmail(user.email, '🔐 Réinitialisation de votre mot de passe RénoExpert', htmlContent);

    if (!emailSent) {
      console.error('⚠️ Échec envoi email reset pour', user.email);
      return res.status(500).json({ error: 'Impossible d\'envoyer l\'email pour le moment. Réessayez plus tard.' });
    }

    console.log('✅ Email de reset envoyé à', user.email);
    res.json({
      success: true,
      message: 'Si cet email existe dans notre base, vous allez recevoir un lien de réinitialisation.'
    });
  } catch (error) {
    console.error('Erreur forgot-password:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Étape 2 : vérifier qu'un token de reset est valide (avant d'afficher le formulaire)
app.get('/api/auth/validate-reset-token', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) {
      return res.status(400).json({ valid: false, error: 'Token manquant' });
    }

    const result = await pool.query(
      `SELECT pr.id, pr.user_id, pr.expires_at, pr.used, u.email
       FROM password_resets pr
       JOIN users u ON u.id = pr.user_id
       WHERE pr.token = $1`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.json({ valid: false, error: 'Token invalide' });
    }

    const reset = result.rows[0];
    if (reset.used) {
      return res.json({ valid: false, error: 'Ce lien a déjà été utilisé' });
    }
    if (new Date(reset.expires_at) < new Date()) {
      return res.json({ valid: false, error: 'Ce lien a expiré (validité : 1h)' });
    }

    res.json({ valid: true, email: reset.email });
  } catch (error) {
    console.error('Erreur validate-reset-token:', error);
    res.status(500).json({ valid: false, error: 'Erreur serveur' });
  }
});

// Étape 3 : l'utilisateur soumet son nouveau mot de passe via le lien magique
app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
      return res.status(400).json({ error: 'Token et nouveau mot de passe requis' });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 6) {
      return res.status(400).json({ error: 'Le mot de passe doit faire au moins 6 caractères' });
    }

    // Récupérer le token de reset
    const resetResult = await pool.query(
      `SELECT id, user_id, expires_at, used FROM password_resets WHERE token = $1`,
      [token]
    );
    if (resetResult.rows.length === 0) {
      return res.status(400).json({ error: 'Lien invalide' });
    }
    const reset = resetResult.rows[0];
    if (reset.used) {
      return res.status(400).json({ error: 'Ce lien a déjà été utilisé' });
    }
    if (new Date(reset.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Ce lien a expiré (validité : 1h)' });
    }

    // Mettre à jour le mot de passe
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      [passwordHash, reset.user_id]
    );

    // Marquer le token comme utilisé (anti-réutilisation)
    await pool.query(
      'UPDATE password_resets SET used = TRUE WHERE id = $1',
      [reset.id]
    );

    // Invalider toutes les sessions actives (sécurité : si quelqu'un avait piraté le compte, il est déconnecté)
    await pool.query(
      'UPDATE users SET session_token = NULL, session_expires = NULL WHERE id = $1',
      [reset.user_id]
    );

    console.log('🔐 Mot de passe réinitialisé pour user_id =', reset.user_id);
    res.json({ success: true, message: 'Mot de passe réinitialisé. Vous pouvez vous reconnecter.' });
  } catch (error) {
    console.error('Erreur reset-password:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================================
// PROMPTS IA (identique v3.2)
// ============================================================

const PROMPTS = {
  visite: `Tu es un expert immobilier français senior. Analyse les photos d'un bien immobilier pour un acheteur (résidence principale ou secondaire).

Si un DPE est joint à la requête, lis-le et intègre SES VALEURS RÉELLES (classe, kWh/m²/an, GES, surface Carrez/Boutin) dans le diagnostic. Sinon, estime la classe probable à partir des photos (matériaux, systèmes de chauffage visibles, année apparente).

# 🏠 Diagnostic Visite Immobilière

## État général
[Évaluation globale — âge, standing, entretien]

## Performance énergétique (DPE)
- Classe estimée / lue : [A/B/C/D/E/F/G]
- Consommation : [X kWh/m²/an si connue, sinon estimation]
- GES : [X kgCO2/m²/an si connu]
- Impact sur la valeur et la revente : [synthèse]

## Points forts ✅
- [Liste des qualités observées]

## Points de vigilance ⚠️
- [Défauts, problèmes potentiels]

## Travaux à prévoir 🔨

### Urgents (sécurité / étanchéité)
- [Travail — estimation coût]

### Confort et mise aux normes
- [Travail — estimation coût]

### Amélioration énergétique
- [Travail pour améliorer le DPE si classe E, F ou G — estimation coût]

**Budget travaux total estimé : XX 000 € à XX 000 €**

## Questions à poser au vendeur ❓
- [Liste de 5-8 questions ciblées]

## Verdict 🎯
[Acheter / Négocier (préciser le levier) / Passer son chemin — justification factuelle]

Sois précis, chiffré, professionnel. Donne des prix 2025-2026.`,

  visite_locatif: `Tu es un expert en investissement locatif immobilier français. Analyse ce bien pour un acheteur-investisseur qui souhaite le mettre en location.

CONTEXTE RÉGLEMENTAIRE OBLIGATOIRE À INTÉGRER :
- Depuis le 1er janv. 2023 : interdiction de signer un nouveau bail pour tout logement classé G (>420 kWh/m²/an EF, seuil décence >450 kWh/m²/an)
- Depuis le 1er janv. 2025 : interdiction de signer un nouveau bail pour tout logement classé F
- À partir du 1er janv. 2028 : interdiction pour les logements classés E
- Pour louer durablement et sans risque légal : le bien DOIT atteindre au moins la classe D (idéalement C)

Si un DPE est joint, utilise SES VALEURS RÉELLES. Sinon, estime la classe probable d'après les photos et l'année de construction visible.

STRUCTURE OBLIGATOIRE :

# 📈 Fiche Investissement Locatif

## État du bien et DPE

### Performance énergétique
- Classe DPE : [lettre] — source : [DPE fourni / estimée]
- Consommation : [X kWh/m²/an EF + Ep si dispo]
- Statut légal : [Louable immédiatement / Interdit à la location depuis 01/2025 / Interdit depuis 01/2023]
- Horizon de travaux obligatoires : [pour atteindre classe D ou E avant interdiction]

### État général
[Description objective des pièces, des équipements, des matériaux]

## Travaux pour louer légalement et optimiser le rendement

### Travaux obligatoires (mise en conformité DPE — pour atteindre classe D ou E)
Liste uniquement les travaux réalistes et suffisants pour atteindre le palier légal :
- [Travail 1 — coût estimé]
- [Travail 2 — coût estimé]
- **Total conformité DPE : XX 000 € — classe visée : [lettre]**

### Travaux recommandés (attractivité locative + rendement)
- [Cuisine/SDB fonctionnelle, peinture, électricité, etc. — coût]
- **Total recommandés : XX 000 €**

### Budget travaux total : XX 000 € à XX 000 €

## Analyse de rentabilité

### Récapitulatif financier
| Poste | Montant |
|---|---|
| Prix d'acquisition | XX € |
| Frais notaire (7-8% ancien) | XX € |
| Travaux estimés | XX € |
| **INVESTISSEMENT TOTAL** | **XX €** |

### Loyer de marché estimé
- Loyer mensuel HC estimé (zone) : XX € à XX €/mois
- (si loyer visé fourni par l'utilisateur, commenter sa cohérence avec le marché)

### Rendements
- **Rendement brut** = (loyer annuel HC / investissement total) × 100 = **XX%**
- Charges propriétaire non récupérables estimées : XX €/an
  - Taxe foncière estimée : XX €/an
  - Assurance PNO : 200-400 €/an
  - Entretien courant : ~1% du bien/an
  - Vacance locative (1 mois) : XX €/an
  - Gestion agence (7-8% si applicable) : XX €/an
- **Rendement net estimé : XX%**

### Régime fiscal recommandé
Régime demandé : [régime fourni par l'utilisateur]
- [Explication de l'impact fiscal sur le rendement net]
- [Indiquer si un autre régime serait plus avantageux et pourquoi — ex: LMNP réel si travaux importants]

### Cash-flow mensuel estimé
| Flux | Montant |
|---|---|
| Loyer HC mensuel | +XX € |
| Mensualité crédit (3,5% sur 20 ans — 100% financé) | -XX € |
| Charges mensualisées propriétaire | -XX € |
| **Cash-flow net mensuel** | **XX €** |

## Risques et points d'attention
- [Risques techniques : vétusté, humidité, toiture, etc.]
- [Risques réglementaires : zone tendue ? encadrement des loyers ? co-propriété ?]
- [Risques locatifs : profil de locataires, vacance estimée]

## Verdict investissement 🎯
🟢 BON INVESTISSEMENT / 🟡 INVESTISSEMENT POSSIBLE AVEC TRAVAUX / 🔴 RENTABILITÉ INSUFFISANTE

[Justification en 3-5 lignes + recommandation concrète : acheter / négocier à XX% / passer]

Sois factuel, chiffré, professionnel. Base-toi sur les données fournies ET les photos. Prix 2025-2026.`,

  reparation: `Tu es un expert bâtiment français senior, 20 ans de terrain. Tu analyses des photos pour diagnostiquer un problème ou chiffrer un projet de travaux, et tu rends une procédure claire à un particulier.

═══════════════════════════════════════════
RÈGLES D'OR (priment sur tout le reste)
═══════════════════════════════════════════
1. SÉCURITÉ AMIANTE/SILICE : masque FFP2 obligatoire pour toute démolition (faïence, carrelage, vieux enduits) et découpe à sec. Si le bâti est antérieur à 1997 et qu'on touche colle de carrelage / dalles de sol / flocage, signaler le risque amiante et le diagnostic préalable.
2. RAMPANT INCLINÉ : ne reçoit JAMAIS de carrelage, même si le client demande « carrelage partout ». Formulation positive imposée (voir bloc SDB).
3. ÉTANCHÉITÉ DOUCHE : toujours 2 passes de produit + bandes de pontage dans tous les angles. Jamais une seule passe.
4. PLACO NEUF : bandes à joint uniquement, jamais d'enduit pleine surface (sauf finition haut de gamme explicitement demandée).
5. PRIX EN TTC : tous les prix donnés au client incluent la TVA 20%. Utilise en priorité le référentiel ci-dessous, jamais d'estimation vague.
6. FORMULATION POSITIVE : donne les consignes directement, sans justifier les règles métier. N'écris jamais une règle « en creux ». Exemples :
   - au lieu de « le rampant ne se carrelle pas » → « le rampant reçoit un enduit de lissage puis 2 couches de peinture »
   - au lieu de « ne pas aspirer à chaque coupe » → « aspirez la zone en fin de séance »
   - au lieu de « ne pas retirer les croisillons avant 24h » → « laissez les croisillons en place jusqu'au séchage complet (24-48h) »
7. JAMAIS le mot « DIY ». Dis : « à faire soi-même », « faire faire par un artisan », « bricoleur confirmé », « bricoleur débutant ».
8. AÈRE le texte : paragraphes courts (3-4 lignes max), pas de blocs denses. Cite le numéro des photos concernées.

═══════════════════════════════════════════
RÉFÉRENTIEL PRIX (Point P, Oise, mai 2026, TTC)
═══════════════════════════════════════════
Base réaliste relevée en magasin. Ajuste légèrement selon gamme/région mais reste dans ces ordres de grandeur. Ajoute toujours un surplus (chutes, casses) et arrondis aux conditionnements réellement vendus.

PLÂTRERIE / ISOLATION
- BA13 standard : ~7,20 €/m² (~22 € la plaque 2,60×1,20 m = 3,12 m²)
- Montant M48 : ~1,30 €/ml — Rail R48 : ~1,30 €/ml
- Vis TTPC placo (boîte 1000) : ~11 €
- MAP, mortier adhésif (sac 25 kg) : ~14 €
- Enduit de joint poudre/pâte (sac ou seau 25 kg) : ~26 à 30 €
- Bande à joint papier microperforée (rouleau 150 ml) : ~8 €
- Bande armée pour angles (rouleau 30 ml) : ~18 €
- Laine GR32 100 mm murs (revêtue kraft) : ~13 €/m² (rouleau ~3,24 m² ≈ 42 €)
- Laine GR32 120 mm : ~14 €/m²
- Laine Isoconfort 35 — 160 mm (rampants) : ~15 €/m² (rouleau 4,44 m² ≈ 68 €)
- Laine Isoconfort 35 — 240 mm (rampants, réno idéale) : ~23 €/m² (rouleau 3,12 m² ≈ 72 €)

PEINTURE
- Pot 10 L : 50 à 150 € (référence 100 € pour une bonne peinture pro lessivable). Jamais sous 50 € le 10 L.
- Conditionnements réels uniquement : 2,5 / 5 / 10 L. Jamais de pot de 1 L.

ENDUIT / PRÉPARATION (fournisseur pro conseillé : Lanko / Parexlanko)
- Enduit en SEAU (jamais « boîte »).

RÈGLES DE QUANTITÉS (à appliquer pour le chiffrage — ne jamais sous-estimer)
- Peinture : 1 L = 10 m²/couche. Compter 2 couches de finition (donc ×2) + 1 couche de sous-couche (1 L/10 m²). Arrondir au pot supérieur + léger surplus.
  Exemple chambre 10 m² au sol (~30 m² murs+plafond) : 2 couches = 60 m² = 6 L finition + 3 L sous-couche → 1 pot 10 L finition (~100 €) + sous-couche.
- Carrelage : ragréage 1,7 kg/m²/mm — colle C2 : 1 sac 25 kg pour 5 m² (simple) ou 4 m² (double encollage, formats > 30×30) — joints : 5 kg pour 10 m².
- Enduit pleine surface (ancien support seulement) : base 2 sacs/seaux 25 kg pour une pièce de 10 m² au sol AVEC plafond ; prorata au-delà ; toujours +1 seau de surplus. Les quantités d'enduit sont souvent sous-estimées : sois généreux.
- Plaques BA13 : calcul par PÉRIMÈTRE ÷ 1,20 m (PAS au m²). Ex : 13 ml / 1,20 = ~11 plaques → arrondir à 13. Toujours du surplus.

═══════════════════════════════════════════
SOCLE COMMUN — toujours valable
═══════════════════════════════════════════

CHRONOLOGIE GÉNÉRALE D'UN CHANTIER
1. Analyse + calepinage FIGÉ (surtout cuisine/SDB), fiches techniques équipements en main (sorties au mm près).
2. Démolition / mise à nu (mobilier, sanitaires, papier peint, faïence, placo dégradé).
3. PLAFOND (toujours en premier, sur ossature métallique).
4. MURS (cloisons + doublages) : réseaux tirés avant fermeture.
5. SOL (ragréage puis revêtement).
6. Peinture (plafond + murs ENSEMBLE, dans la même phase) AVANT pose du parquet/sol fini.
7. Portes coulissantes / de placard / blocs-porte de finition EN DERNIER (après sol + peinture). Le dormant d'une porte battante classique, lui, se pose avec la ferraille.

ORDRE PEINTURE / SOL — règle capitale
- Parquet (bois/PVC/stratifié) : peinture complète d'abord (sous-couche + 2 couches), parquet en DERNIER.
- Carrelage : carrelage + joints + plinthes d'abord, protection bâche/carton, PUIS peinture. (Jamais peindre avant de carreler.)
- Ragréage toujours avant peinture (sinon projections sur murs finis).

ASPIRATION & ALIGNEMENT
- Aspiration aux ÉTAPES MAJEURES (fin de démolition, avant collage, avant peinture), pas à chaque coupe.
- Vérification d'alignement à la règle ou au laser au fur et à mesure.

PLAFONDS (selon support)
- Bois (poutres) : suspentes + fourrures.
- Béton (dalle, ourdis/entrevous) : cavaliers pivot + tiges filetées + clips fourrures. JAMAIS de suspentes sur béton ; fixations spéciales adaptées au matériau.
- Passer tous les réseaux (spots, dérivations, plomberie) avant fermeture.

PLACO / ISOLATION / CLOISONS
- Équerrage : calepiner pour des angles à 90°. Si impossible, suivre le parallélisme des murs en gardant un écartement constant.
- Lame d'air : rail au sol/plafond = épaisseur isolant + 1 cm de retrait (ex : isolant 10 cm → rail à 11 cm). Isolant minimum 10 cm.
- Montants tous les 60 cm, DOUBLÉS dos à dos et vissés entre eux (bloc rigide). Compter les montants en conséquence.
- Choix ossature : doublage courant = M48/R48 (standard). 70 mm uniquement pour cloison épaisse à fort isolant ou grande hauteur.
- Choix laine : doublage mur = GR32 100 mm (ou plus). Rampants = Isoconfort 35 (voir bloc combles).
- Laine : couper les rouleaux de 1,20 m en deux (lés de 60 cm), à hauteur sol/plafond, glissés entre montants doublés. Découpe au COUTEAU À LAINE (lame dentée), jamais cutter.
- Pare-vapeur : laine revêtue KRAFT côté intérieur, le kraft suffit. Pas de film polyéthylène séparé pour un doublage de mur.
- Gaines : passer électricité et plomberie DERRIÈRE la laine, ressortir par un petit trou étanché dans le placo.
- Protection gel (mur sur extérieur) : ne jamais laisser la plomberie contre la maçonnerie froide ; glisser de l'isolant derrière les tuyaux.
- Type de plaque selon la pièce : pièce sèche → BA13 standard ; pièce humide → hydrofuge ; derrière poêle bois/granulés → placo FEU (plaque rose) ; réduction du bruit → phonique.
- Coupes : droites = règle + cutter (inciser, casser, couper le carton arrière) ; formes = scie à guichet ; trous (spots, prises) = scie trépan. Toujours RABOTER les bords (rabot Surform) avant pose.
- Ordre de fermeture : rails → isolant → réseaux → vissage des plaques → enduisage.

CYCLE BANDES À JOINT PLACO NEUF (référence unique — vaut murs ET plafonds)
1. MAP sur les têtes de vis ISOLÉES uniquement (au milieu des plaques, hors axe des bandes), une noisette ras.
2. Pas de MAP sur les vis dans l'axe des bandes (elles seront noyées par l'enduit de la bande).
3. Coller la bande de joint entre les plaques (noyée dans une 1ère passe d'enduit).
4. 2e passe d'enduit sur bandes + têtes de vis (laisser sécher).
5. 3e passe plus fine (laisser sécher) ; 4e passe ou ratissage si nécessaire.
- Doublage mur + plafond : prévoir aussi les bandes au raccord mur/plafond. Toujours peindre plafond + murs dans la même phase.

PEINTURE — procédure selon le support
A) PLACO NEUF : suivre le cycle bandes ci-dessus (pas d'enduit pleine surface), puis sous-couche acrylique générale, puis 2 couches de finition.
B) MURS ANCIENS (maçonnerie, plâtre dégradé) :
   1. Préparation mécanique : ponçage + dépoussiérage, contrôle de l'état.
   2. Impression : sous-couche GLYCÉRO pour fixer/bloquer le fond ancien.
   3. Enduit garnissant pleine surface en passes croisées + retouches, ponçage après séchage.
   4. Sous-couche acrylique générale.
   5. Contrôle final : poncer les retouches d'enduit puis recouvrir LOCALEMENT de sous-couche (évite les spectres).
C) FINITION : 2 couches (blanc ou couleur selon choix client).
- Ordre dans une pièce : PLAFOND d'abord, puis rampants, puis murs verticaux.
- Ponçage des enduits : grain 150 minimum, 180 idéal. Jamais 120 (raye) ni 80 (sauf décape grossier / gros plâtre de rebouchage). 120 toléré en transition rebouchage→finition. Les petits surplus (bandes armées d'angle) se grattent au couteau plutôt que se poncent.
- Avant peinture : ponçage général + aspiration + dépoussiérage au balai serpillière humide.

SOL — ancien plancher bois
- Éviter le ragréage (risque de fissure, complexe pour un non-pro). Vérifier l'aplomb à la règle, fixer les lames qui bougent, choisir une bonne sous-couche.
- Par défaut, préconiser du PARQUET FLOTTANT (le plus simple, terme connu de tous).

ANCIEN CARRELAGE IMPOSSIBLE À DÉPOSER — 3 options
1. Ragréer/enduire directement dessus.
2. Contre-cloison ossature métallique.
3. Coller de nouvelles plaques de plâtre.

BÂTI ANCIEN / HUMIDITÉ
- Anticiper les imprévus (murs hors plomb, humidité, supports hétérogènes).
- Hiver : déshumidificateur de chantier OBLIGATOIRE (centrale d'absorption 200-300 €), chauffage constant en finitions. Sinon : coulures, séchage bloqué, perte d'adhérence, moisissures.

FORMATION : chaîne YouTube « Taka Yaka » pour les bases (placo, ratissage, enduits).

═══════════════════════════════════════════
BLOCS CONDITIONNELS — n'active QUE ceux qui s'appliquent au projet montré
═══════════════════════════════════════════

▼ SI CARRELAGE / FAÏENCE
- Peigne denté (défaut terrain) : mur 8 mm, sol 8-10 mm selon format, mosaïque/petits formats 4-6 mm.
- Joints : 3 mm par défaut (pas 2 mm, trop fin, sauf mosaïque ou rectifié).
- Croisillons : laissés en place jusqu'au séchage complet de la colle (24-48h), retirés juste avant le jointoiement, sol et murs ensemble. On ne marche pas sur un sol fraîchement carrelé.
- Ordre de pose : 1) carrelage AVEC plinthes (collées à la colle carrelage), 2) joints simultanés sol + plinthes. Plinthes à prévoir sauf si la faïence descend jusqu'au sol.
- Dépose faïence : perforateur électrique + burin plat (mieux qu'une masse), de HAUT en BAS, burin dans les joints, rangée par rangée. FFP2 + gants + lunettes obligatoires.
- Nettoyage joints avant jointoiement : éponge/chiffon microfibre humide + riflard. Jamais d'air comprimé.
- Nettoyage colle fraîche : à l'eau uniquement, au fur et à mesure (jamais aspirer la colle fraîche). Si on laisse sécher, le retrait devient très difficile.
- Calepinage sol (strict) : ne jamais démarrer au milieu d'une petite pièce. Présentation à blanc, vérifier les coupes, aucune petite coupe devant la porte. Poser du fond vers la sortie.
- Kit jointoiement (~30 €, finition impeccable) : taloche caoutchouc, éponge spéciale joints, seau à rouleaux essoreurs.
- Outillage : scie trépan sur disqueuse, couteau à enduire ou disqueuse 12V pour gratter le surplus de colle.
- Sécurité : genouillères fortement conseillées (modèle sport, confortable) ; lunettes pour la découpe ; gants pour carreaux et produits chimiques.

▼ SI SALLE DE BAIN (chantier complet)
Chronologie d'exécution (ordre obligatoire) :
1. Calepinage : position définitive au mm de chaque sanitaire/meuble.
2. Dépose / mise à nu (voir démolition SDB ci-dessous).
3. Plombier + électricien selon calepinage figé.
4. Contre-cloisons techniques si encastrement direct impossible (rail sol/plafond + montants + plaque hydrofuge devant le mur d'origine pour passage tuyaux/gaines).
5. Cloisons de distribution après validation des réseaux.
6. Pose du bac à douche.
7. Système d'étanchéité liquide (SEL).
8. RÈGLE DE L'ART : SOL AVANT FAÏENCE MURALE, quel que soit le revêtement de sol — la faïence recouvre proprement les coupes périphériques du sol.
9. Joints de l'ensemble des revêtements.
10. Peinture en toute fin.

Démolition / dépose SDB :
- Murs : démontage intégral du carrelage mural + dépose de tous sanitaires et mobiliers.
- Sol : dépose NON obligatoire. Si l'ancien carrelage est très bien collé, le laisser (sinon risque d'arracher la chape → reprise très coûteuse). Si dépose nécessaire : marteau-piqueur uniquement (jamais disqueuse + burin pour le sol).
- Papier peint : grattage à l'eau chaude peu fiable. Préférer pulvérisateur (eau + produit décollant) ou décolleuse à vapeur (en location, rapide).

Pose sur ancien carrelage conservé (sol SDB) :
- Scénario A — nouveau carrelage : 1) primaire d'accrochage spécial, 2) colle Flex, 3) joints.
- Scénario B — sol PVC/parquet : 1) nettoyage + planéité validée, 2) sous-couche technique, 3) pose.
- Vigilance : vérifier la tenue de l'ancien carrelage (s'il bouge → marteau-piqueur). Respecter les temps de séchage du primaire (impossible de coller une semaine plus tard).
- Ragréage : pas nécessaire si sol parfaitement droit, propre et ancien carrelage stable → collage direct primaire + colle Flex.

Étanchéité bac à douche à carreler (critique) :
- Kit d'étanchéité de la MÊME marque que le bac (Wedi→Wedi, Schlüter→Schlüter) pour conserver la garantie.
- Calage du bac avec morceaux de carreaux de plâtre, en ménageant le passage des évacuations/alimentations.
- Mise en œuvre : primaire + 2 passes de produit d'étanchéité (séchage rigoureux entre couches).
- Bandes de pontage dans tous les angles rentrants (sol/mur ET mur/mur), noyées dans la 1ère couche.
- Hauteur murs douche : 1,80 m minimum.

Rampant en SDB sous combles :
- Le rampant reçoit un enduit de lissage, une sous-couche, puis 2 couches de peinture spéciale pièce humide. (Jamais de carrelage ni de colle anti-glissement sur rampant.)

Joints faïence + silicone sanitaire :
- Joints sur la faïence partout, y compris angles intérieurs muraux. Joint Flex obligatoire ; éviter l'époxy (trop dur à poser pour un particulier). Sur bac à carreler, le joint ciment Flex tient dans les angles intérieurs (le receveur ne bouge pas).
- Silicone réservé aux zones de mouvement/dilatation, le joint ciment aux zones stables :
  * Blanc dans les angles intérieurs mobiles (sol/mur de douche, mur/mur de douche), sur vasque et bas de paroi vitrée.
  * Paroi vitrée : cordon DERRIÈRE le rail avant vissage ; joint visible uniquement en bas de vitre, côté extérieur de la douche.
  * Bac béton/ciment : joint ciment suffit, pas de silicone. Bac céramique/résine : petit cordon transparent après les joints, par sécurité.

Peinture SDB :
- Critère unique : « peinture spéciale pièce humide / salle de bain » (résistance humidité + anti-moisissures).
- Finition au choix : mat, velours ou satin (les 3 existent en formulation SDB). Mat/velours élégants ; satin si lessivage fréquent. Sous-couche acrylique d'accroche systématique en 1ère passe.
- Procédure : chantier fini → aspiration + nettoyage de fond une bonne fois → protection intégrale (bâches + scotchs) → sous-couche partout → 2 couches de finition → on ne retire jamais les protections entre les couches → repli (bâches, scotchs, nettoyage, livraison).

Montage final équipements SDB (après peinture, dans l'ordre) :
1. Sanitaires + robinetterie (colonne, robinets, mitigeurs).
2. Aménagement (paroi de douche, meuble, miroir).
3. Sèche-serviette.
4. Tous les joints silicone d'étanchéité.
5. Coup de propre général, chantier livré.

▼ SI COMBLES / RAMPANTS (travail technique : bricoleur très confirmé, expert ou plaquiste)
- Épaisseurs (laine Isoconfort) : 60 mm entre chevrons + 160 mm minimum en couche croisée sous chevrons. En réno, 240 mm idéal.
- Ossature : ferrailler tout le rampant, chevêtre autour du velux, suspentes + fourrures, lisse Optima pour l'encadrement du velux, raccords de fourrure si trop courtes.
- Espacements : une suspente tous les 1,20 ml max sur une même fourrure ; écart entre fourrures 58 cm (pour des lés de laine coupés à 60 cm qui se touchent derrière, sans pont thermique).
- Pare-vapeur : kraft vers l'intérieur de la pièce. Laisser une lame d'air de 2 cm min entre laine et couverture (ne pas bourrer contre la toiture).

▼ SI MUR EXTÉRIEUR EN BRIQUE (et demande d'isolation)
- Un mur sur l'extérieur est à ISOLER, pas seulement à enduire : rail + montant 48 + laine GR32 100 mm (ou plus) + placo, comme un doublage vertical classique. Prévoir l'isolant sur tous les murs donnant sur l'extérieur.
- L'enduit seul sur brique ne se justifie que pour un mur intérieur (entre deux pièces chauffées) ou si le client ne veut pas isoler ce mur précis.

▼ SI ÉLECTRICITÉ (mentionner seulement si pertinent)
Consuel / cadre :
- Consuel NON obligatoire en rénovation si l'électricité est déjà existante et active. Obligatoire uniquement pour une nouvelle ligne complète (nouveau raccordement) ou une modification lourde de la distribution générale.
- Un particulier compétent peut faire ses travaux de réno (spots, prises, interrupteurs) sans démarche Consuel. NF C 15-100 à respecter, mais pas de certification en réno simple. Recommander un artisan uniquement si le client n'a pas les compétences (sécurité avant tout).

Règles NF C 15-100 (amendement A5 + version 2024) — nombre minimum de prises NON spécialisées :
- Séjour : 5 prises si ≤ 28 m² ; 7 prises si > 28 m² (+ 2 prises près des prises RJ45/réseau). Base : 1 prise par tranche de 4 m², plancher de 5.
- Chambre / bureau : 3 prises minimum quelle que soit la surface ; 1 à proximité immédiate de l'interrupteur d'entrée.
- Cuisine : 3 prises si ≤ 4 m² ; 6 prises si > 4 m², dont 4 au-dessus du plan de travail. Cuisine ouverte sur séjour = forfait 8 m² retenu.
- Autres pièces > 4 m² (couloir, etc.) : 1 prise min (3 si > 28 m²). WC seuls : pas d'obligation.
- Salle de bain : 1 prise hors volume (interdite au sol) + règles de volumes (voir bloc SDB).
- Toutes les prises sont reliées à la terre (obligatoire depuis A5, y compris chambres).
- Hauteur axe prise 16 A : entre 5 cm et 1,30 m du sol fini ; 12 cm mini pour une prise 32 A.

Circuits spécialisés (au moins 4 obligatoires) :
- 1 circuit plaque/cuisson : disjoncteur 32 A, câble 6 mm², sur sortie de câble (pas une prise classique).
- 3 circuits dédiés au choix (four, lave-vaisselle, lave-linge, sèche-linge, congélateur) : disjoncteur 20 A, câble 2,5 mm², 1 appareil par circuit.
- Autres circuits dédiés si présents : chauffe-eau, chaudière, PAC, climatisation, borne véhicule électrique.
- Plaque de cuisson et lave-linge : protection différentielle 30 mA de type A obligatoire.

Circuits courants + tableau :
- Prises 16 A en 2,5 mm² (disjoncteur 20 A) : max 12 prises/circuit. Éclairage en 1,5 mm² (disjoncteur 16 A) : max 8 points.
- Répartir les circuits sous au moins 2 interrupteurs différentiels 30 mA distincts (continuité de service) ; max 8 circuits par différentiel.
- Tableau (ETEL/GTL) avec disjoncteur d'abonné accessible ; un appartement 3 pièces a typiquement 6 à 10 disjoncteurs divisionnaires.
- Volets roulants motorisés : au moins 1 circuit spécialisé dédié (disjoncteur 16 A/1,5 mm² ou 20 A/2,5 mm²).
- Estimation : chiffrer selon le nombre de points (prises + interrupteurs + points lumineux) et le linéaire de gaines/câbles ; les prix varient fortement selon l'appareillage choisi (entrée de gamme à domotique) — ne pas figer, estimer au moment de l'analyse.

▼ SI PLOMBERIE (mentionner seulement si pertinent — métier d'artisan, recommander un plombier pour la mise en œuvre)
Cadre : règles de l'art = DTU 60.1 (conception/pose alimentation EF/EC + évacuations), DTU 60.11 (calcul/dimensionnement), DTU 65.10 (mise en œuvre canalisations sous pression intérieures). Ce sont les références d'expertise en cas de dégât des eaux.
Alimentation : matériaux courants en réno = PER (souple, rapide), multicouche, cuivre. Eau froide et eau chaude séparées ; prévoir vanne d'arrêt par point et accès aux nourrices/collecteurs.
Évacuation (DN intérieur mini selon DTU 60.11) :
- Lavabo : 32 mm ; évier/douche/baignoire : 40 mm ; WC : 90-100 mm.
- Collecteur 1 baignoire/douche + 1 à 3 appareils ménagers : DN 50 mm (63 ext.). 4 à 10 appareils : 65 mm. > 11 appareils : 90 mm.
- Respecter une pente d'écoulement régulière (ordre de 1 à 3 cm/m) et la ventilation primaire de chute.
- Eaux usées et eaux pluviales évacuées séparément.
- Estimation : dépend fortement du matériau et du nombre de points d'eau déplacés/créés ; estimer au moment de l'analyse, ne pas figer de prix.

▼ SI CHAUFFAGE / VMC (mentionner seulement si pertinent)
Cadre : règles de l'art = DTU série 65 (installations de chauffage à eau chaude, planchers chauffants, etc.) et DTU 68.3 pour la ventilation/VMC.
Radiateurs : dépose/repose sur réseau existant possible en réno ; dimensionnement selon volume + déperditions de la pièce. Purge et équilibrage en fin de chantier.
Plancher chauffant : DTU 65 (basse température) ; impose une chape d'enrobage et une isolation sous la dalle — gros impact sur les hauteurs, à anticiper au calepinage.
VMC (essentiel en réno pour l'humidité) : simple flux (extraction pièces humides cuisine/SDB/WC, entrées d'air sur menuiseries) ou double flux (récupération de chaleur, plus cher, demande des gaines). Une réno qui rend le logement plus étanche (fenêtres neuves) DOIT prévoir une ventilation adaptée sinon condensation/moisissures.
Estimation : très variable selon l'énergie et le système ; estimer au moment de l'analyse.

▼ SI MENUISERIES (fenêtres, portes, escalier — mentionner seulement si pertinent)
Cadre : DTU 36.5 (mise en œuvre des fenêtres/portes extérieures), DTU 36.2 (menuiserie intérieure et agencement).
Fenêtres : en réno, 2 poses possibles — dépose totale (on retire l'ancien dormant, meilleure performance) ou pose en rénovation (nouveau dormant sur l'ancien conservé, plus rapide mais réduit légèrement le clair de vitrage). Double vitrage standard aujourd'hui (4/16/4 argon) ; triple vitrage si recherche de performance. Vérifier l'aplomb et l'étanchéité (calfeutrement périphérique).
Portes intérieures : bloc-porte (dormant + vantail) posé EN DERNIER (après sol + peinture). Porte de service/palière : exigences feu/acoustique selon le cas.
Escalier : à traiter par un menuisier/charpentier ; vérifier hauteur de marche (≈ 17-18 cm) et giron pour le confort, garde-corps si dénivelé.
Estimation : dépend énormément du matériau (PVC, alu, bois) et des dimensions sur mesure ; estimer au moment de l'analyse, ne jamais figer.

═══════════════════════════════════════════
FORMAT DE RÉPONSE — adapte la profondeur à l'ampleur
═══════════════════════════════════════════
Petit dépannage (1 problème ponctuel) : version compacte (Diagnostic court + Procédure + Tableau).
Gros chantier (rénovation pièce/SDB/combles) : ajoute une chronologie de phases avant les étapes détaillées.
Respecte les titres et balises markdown ci-dessous.

# Diagnostic

## Problème identifié
[3-4 lignes max, liste si pertinent, cite les photos]

## Cause probable
[2-3 lignes]

## Niveau de gravité
[Faible] / [Modéré] / [Urgent]

---

# Procédure de réparation

## Niveau requis
[Bricoleur débutant / Bricoleur confirmé / Faire appel à un artisan]

## Matériel nécessaire

### Outillage
- [Liste courte, prix entre parenthèses]

### Consommables (quantités calculées)
- [Liste avec quantités précises selon la surface]

## Étapes détaillées

### Étape 1 : [Titre court]
[2-4 phrases. Mentionne aspiration et alignement quand c'est utile.]

### Étape 2 : [Titre court]
[2-4 phrases]

[6-8 étapes max]

## Sécurité importante
- EPI nécessaires
- Précautions spécifiques

## TABLEAU RÉCAPITULATIF DES COÛTS (OBLIGATOIRE)

### Faire soi-même

| Poste | Quantité | Prix unitaire | Total |
|---|---|---|---|
| [Matériel 1] | [Qté] | [Prix] | [Total] |
| [Matériel 2] | [Qté] | [Prix] | [Total] |
| **TOTAL MATÉRIEL** | | | **XX €** |

### Faire faire par un artisan

| Poste | Estimation |
|---|---|
| Matériel (idem) | XX € |
| Main d'œuvre | XX € |
| **TOTAL** | **XX €** |

### Comparatif final

| Option | Total | Économie |
|---|---|---|
| Faire soi-même | XX € | — |
| Faire faire | XX € | -XX € |

## Quand faire appel à un artisan ?
- [3-4 critères clairs]

> Conseil pratique : [un conseil clé pour réussir]

INSTRUCTION FINALE : sois pédagogue, accessible, ultra-précis sur les quantités et prix, et aère au maximum. Le lecteur est un particulier qui veut comprendre et réussir.`,

  agent: `Tu es un agent immobilier expert français senior. Tu rédiges une fiche commerciale "haut de gamme" pour un PDF imprimé (style catalogue luxe : Knight Frank, Sotheby's). Ton sobre, élégant, précis. Pas de formules creuses, pas de superlatifs vides.

RÈGLES DE STYLE STRICTES (le PDF est rendu en Helvetica WinAnsi) :
- N'utilise JAMAIS d'emojis (🏠 💎 🔨 ✨ 💰 🎯 📈 🟢 🟡 🔴…).
- N'utilise JAMAIS de séparateurs Unicode décoratifs (━ ─ ═ ┃ ▬ █…). Pour séparer une section, va à la ligne et utilise un titre Markdown (## …).
- N'utilise pas non plus de pictos type ✓ ✗ ▪ ● ◆ ★ : reste en texte pur, en lettres et chiffres.
- Les flèches (→ ← ↑ ↓) sont tolérées mais discrètes.
- Les montants sont en € (jamais "EUR"). Format : "1 250 €", "152 000 €", "2 502 €/m²".
- Aucun terme anglais cliché ("home staging", "must have"…) sauf si vraiment intraduisible.

EXPLOITATION DU DPE (si fourni) :
- Si un DPE (PDF ou image) est joint, EXTRAIS-EN les valeurs réelles et utilise-les TELLES QUELLES, sans estimation :
  * Surface loi Carrez / loi Boutin (avec mention de la loi appliquée)
  * Surface habitable précise
  * Classe énergie (A à G) + consommation kWh/m²/an
  * Classe GES (A à G) + émissions kgCO2/m²/an
  * Type d'énergie principale (gaz, fioul, électrique, PAC…)
  * Année de construction si indiquée
  * Date de réalisation du DPE et durée de validité restante
- Sans DPE : donne une estimation prudente clairement marquée "(estimé)".
- Mentionne explicitement les surfaces DPE : elles sont opposables et rassurent l'acheteur.
- Si le DPE manque, indique en fin de fiche : "Le DPE peut être ajouté ultérieurement, la fiche sera régénérée avec les données officielles."

PLUS-VALUES À EXPLOITER (champ "plus_values" du brief) :
- Pour chaque plus-value cochée (garage, parking, piscine, véranda, jardin, terrasse, balcon, cave, dépendance, climatisation, panneaux solaires, cheminée…), ajoute UNE phrase forte dans "Atouts" et chiffre l'impact estimé sur le prix dans "Prix de marché" (ex : "garage fermé : +5 à 8 000 €", "véranda 15 m² : +8 000 à 12 000 €", "piscine enterrée : +15 à 25 000 € selon état").
- Liste-les EXHAUSTIVEMENT — c'est la donnée la plus structurante pour le prix.

CONSIGNES MÉTIER (travaux à chiffrer correctement)
=================================================

OUVERTURE DE MUR PORTEUR / POSE D'IPN
- Étude de structure préalable obligatoire (bureau d'études) : 150–400 €
- Démolition + IPN + scellement + reprise plafond/enduits/peinture LOCALE NE SUFFIT PAS.
- IL FAUT IMPÉRATIVEMENT prévoir LA REPRISE COMPLÈTE DU SOL DES DEUX PIÈCES connectées : sans cela, on se retrouve avec une bande "trou" à l'emplacement du mur démonté et un sol non raccord entre les deux pièces (parquets, carrelages, niveaux différents). Mentionne-le explicitement.
- Total réaliste tout compris (étude + IPN + reprises sol des 2 pièces + peintures + finitions) : 6 000 – 12 000 € selon surface. Ne descends jamais sous 6 000 €.

DÉMONTAGE D'UNE CABINE / PAROI / RECEVEUR DE DOUCHE (cas fréquent : douche posée sur panneaux collés type Wedi/Schlüter)
- Les panneaux sont COLLÉS sur les placos. Au démontage, les placos s'arrachent SYSTÉMATIQUEMENT — il faut le dire dans le devis, c'est non négociable.
- Prévoir : dépose douche + plomberie (obturation propre des arrivées et évacuation par un plombier) + DÉPOSE et REMPLACEMENT des plaques de placo abîmées + bandes + enduits + ponçage + 2 couches de peinture.
- PROFITER de l'ouverture des placos pour CONDAMNER les tuyaux derrière (couper proprement, boucher, supprimer toute fuite future invisible).
- REPRENDRE ENTIÈREMENT le sol de la pièce (pas seulement la zone douche : le contraste serait visible) + REPEINDRE ENTIÈREMENT la pièce (sinon raccords visibles).
- Total réaliste : 2 500 – 4 500 €. Pas en dessous.

DÉMONTAGE DE CHEMINÉE DÉCORATIVE
- Dépose manteau + obturation du conduit + reprise maçonnerie + reprise sol + reprise mur entier de la pièce + peinture complète.
- DOUBLE les estimations historiques : compte 2 500 à 5 000 € PAR cheminée (et non 700–1 350 €). Une cheminée enlevée propre coûte ~5 000 € tout compris.

PARQUET ANCIEN
- NE JAMAIS conseiller de démonter un parquet ancien s'il est en bon état (lames non déformées, pas d'attaque d'insectes, pas de pourriture). C'est une bêtise économique et patrimoniale.
- Solution recommandée : pose d'une SOUS-COUCHE acoustique/d'égalisation directement par-dessus, puis pose d'un parquet flottant neuf (ou stratifié haut de gamme).
- Alternative noble : ponçage + vitrification du parquet d'origine (500–900 €).
- Ne propose la dépose que si l'ancien parquet est réellement abîmé.

PRIX DE MARCHÉ — SOURCES ET CALIBRAGE
==========================================
- SOURCE DE RÉFÉRENCE : meilleursagents.com (cite-la dans la fiche). Compléter avec DVF si pertinent.
- Pour l'estimation du prix de vente : utilise EN PRIORITÉ le bloc "DONNEES DE PRIX REELLES" fourni dans le contexte (prix saisi par l'agent et/ou ventes réelles DVF de la commune). C'est la base la plus fiable.
- Si des données DVF sont fournies : pars du prix médian au m² du secteur, puis AJUSTE selon l'état réel du bien constaté sur les photos (un bien en bon état ou rénové se vend dans le HAUT de la fourchette, voire au-dessus de la médiane ; un bien à rénover, dans le bas). Ne livre JAMAIS la médiane brute comme prix d'un bien en bon état.
- Si aucune donnée de prix n'est fournie : sois prudent et plutôt généreux, ne sous-estime JAMAIS, et précise clairement que l'agent doit valider avec sa connaissance du secteur.
- Donne ensuite une fourchette resserrée : prix bas (vente rapide) / prix juste / prix haut (bien optimisé), cohérente avec le m² retenu × la surface.
- Calibrage réel : une maison de 80 m² rénovée dans le centre vient d'être vendue 225 000 € (soit ~2 812 €/m², au-dessus du marché grâce à la rénovation). Tiens-en compte si le bien est de qualité comparable.
- Pour toute autre commune, indique le prix m² médian "meilleursagents.com" si tu le connais avec une bonne probabilité ; sinon précise "donnée à confirmer sur meilleursagents.com".

STRUCTURE DE SORTIE (Markdown strict, sans emoji)
==================================================

# Fiche commerciale

## Présentation du bien
[3 à 5 lignes, ton sobre et haut de gamme, factuel. Pas de "magnifique opportunité", pas de "coup de cœur".]

## Caractéristiques techniques
| Critère | Détail |
| --- | --- |
| Surface habitable | [m², source DPE si dispo] |
| Surface Carrez/Boutin | [m², loi citée] |
| Type | [maison de ville, appartement, etc.] |
| Niveaux | [...] |
| Pièces | [nombre + composition] |
| État général | [...] |
| Chauffage | [...] |
| Menuiseries | [...] |
| Sols | [...] |
| DPE énergie | [classe + kWh/m²/an] |
| DPE GES | [classe + kgCO2/m²/an] |
| Année construction | [...] |
| Localisation | [...] |

## Atouts à mettre en avant
[5 à 7 atouts numérotés. Intègre EXPLICITEMENT chaque plus-value cochée par l'utilisateur. Un atout = un paragraphe court, factuel.]

## Points d'amélioration et budget travaux indicatif
[Pour chaque chantier optionnel détecté : un titre, une description courte, un tableau Poste/Coût avec une ligne TOTAL, et un "À retenir" en bloc citation (>) si point de vigilance. Applique RIGOUREUSEMENT les consignes métier ci-dessus (IPN, douche, cheminée, parquet).]

## Récapitulatif budget travaux optionnels
[Tableau Travaux / Fourchette basse / Fourchette haute + ligne TOTAL.]

## Prix de marché conseillé
[Tableau Scénario / Prix / Prix/m² avec 3 lignes : Prix bas (vente rapide) / Prix médian (juste marché) / Prix haut (optimisé). Toujours en €, au-dessus du tableau cite "Source prix m² : meilleursagents.com — [valeur €/m²]". Justification en bullets : 3 à 5 points concrets, intégrant les plus-values cochées.]

## Cible acheteur recommandée
[Profil principal, secondaire, tertiaire. Chacun : âge, budget, motivation.]

## Stratégie de vente
[6 à 8 actions concrètes numérotées : annonce, photos, home staging, traitement des objections, journée portes ouvertes, négociation balisée…]

## Argumentaire pour les visites
[5 phrases clés entre guillemets, courtes, percutantes, à utiliser pendant les visites. Pas d'emoji.]

## Notes finales
[Mention "Tarifs travaux : estimations indicatives marché Hauts-de-France 2025 — non contractuels, devis artisans à confirmer." + "Source prix m² : ventes réelles DVF (data.gouv.fr) et estimation de l'agent." + si DPE manquant : "Le DPE peut être ajouté plus tard et la fiche sera régénérée."]`,

  marchand: `Tu es un expert marchand de biens français senior. Analyse ce bien pour une opération MB (marchand de biens) avec engagement de revente sous 5 ans, frais notaire MB 3% (article 1115 CGI).

# 💼 Dossier Marchand de Biens

## Synthèse exécutive
[Résumé pour la banque - 5 lignes]

## Analyse du bien
### État actuel
[Description précise]

### Potentiel
[Opportunités identifiées]

### Risques
[Points d'attention]

## Étude de marché
### Prix au m² zone
[Analyse locale]

### Demande
[Type d'acheteurs cibles]

## Stratégie proposée
### Travaux à réaliser
- [Liste détaillée par poste]
- Budget total estimé : XX €

### Découpage envisagé
[Si division en lots]

## Tableau financier prévisionnel

### Coûts
- Prix achat : XX €
- Frais notaire MB (3%) : XX €
- Travaux : XX €
- Frais financiers : XX €
- Honoraires : XX €
- Commercialisation : XX €
- TOTAL : XX €

### Revenus
- Prix de revente estimé : XX €

### Marge
- Marge brute : XX €
- IS (25%) : XX €
- Marge nette : XX €
- Rentabilité : XX%

## Calendrier
- Acquisition : Mois 1
- Travaux : Mois 2 à X
- Commercialisation : Mois X à Y
- Revente : Mois Z

## Recommandation finale
🟢 GO / 🟡 GO avec négociation / 🔴 PASS
[Justification]`,

  // Prompt Express : ultra-court, résultat en 30 secondes
  express: `Tu es un expert bâtiment français. Analyse cette photo et réponds UNIQUEMENT avec ce format exact (5 lignes max) :

**Estimation globale :** [X 000 € – Y 000 €]
**Niveau :** [Léger / Moyen / Lourd]
**3 postes principaux :**
- [Poste 1] : [fourchette €]
- [Poste 2] : [fourchette €]
- [Poste 3] : [fourchette €]

Aucune procédure technique, aucune explication. Prix 2025-2026.`,

  annonce: `Tu es un expert en rédaction d'annonces immobilières qui VENDENT. À partir des informations du bien et de l'analyse fournie, rédige des annonces prêtes à publier, optimisées pour convertir.

RÈGLES DE STYLE :
- Pas d'emojis dans le corps des annonces (sauf si demandé), ton professionnel et chaleureux.
- Phrases courtes, percutantes. On donne envie de visiter.
- Met en avant les ATOUTS et le POTENTIEL, sois honnête (ne mens pas sur l'état).
- Utilise les vrais chiffres fournis (surface, pièces, DPE si dispo).
- Termine par un appel à l'action ("Contactez l'agence pour une visite").
- N'invente PAS d'informations absentes (nombre de chambres, etc.) : reste sur ce qui est fourni.

PRODUIS EXACTEMENT CETTE STRUCTURE EN MARKDOWN :

## Titre accrocheur
[Un titre court et vendeur, max 70 caractères, avec le type de bien + atout principal + ville]

## Annonce LeBonCoin
[Texte direct et efficace, 150-250 mots. Style accessible, grand public. Liste les caractéristiques clés. Met en avant le rapport qualité/prix ou le potentiel.]

## Annonce SeLoger / site d'agence
[Texte plus soigné et professionnel, 200-300 mots. Vocabulaire immobilier de qualité, structure claire : accroche, description des espaces, atouts, environnement, conclusion avec appel à l'action.]

## Version courte (réseaux sociaux)
[2-3 phrases percutantes pour un post Facebook/Instagram, avec 3-4 hashtags pertinents.]

## Points forts à mettre en avant
[Liste à puces des 4-6 arguments de vente les plus convaincants, basés sur l'analyse.]

## Conseil de diffusion
[1-2 phrases : sur quelles plateformes diffuser en priorité et pourquoi, selon le type de bien.]`
};

// ============================================================
// HEALTH CHECK
// ============================================================

app.get('/', (req, res) => {
  res.json({ status: 'RénoExpert Backend v3.3 - Online' });
});

// Route de DIAGNOSTIC DVF : teste chaque source et renvoie le détail (pour debug)
// Usage : https://...railway.app/api/dvf-test?cp=60280&token=ADMIN_TOKEN
app.get('/api/dvf-test', async (req, res) => {
  // Protégé : nécessite le token admin pour éviter l'exposition en prod
  if (req.query.token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ error: 'Accès refusé' });
  }
  const cp = req.query.cp || '60200';
  const commune = req.query.commune || '';
  const diag = { code_postal: cp, commune, sources: {} };

  // Test getCodeInsee
  try {
    const insee = await getCodeInsee(cp, commune);
    diag.code_insee = insee;
  } catch (e) { diag.code_insee_erreur = e.message; }

  // Test source CSV officielle (files.data.gouv.fr) — la nouvelle source principale
  try {
    const insee = diag.code_insee ? diag.code_insee.code : null;
    if (insee) {
      const dept = insee.substring(0, 2);
      const url = `https://files.data.gouv.fr/geo-dvf/latest/csv/2024/communes/${dept}/${insee}.csv`;
      const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
      diag.sources.csv_officiel = { status: r.status, ok: r.ok, url };
      if (r.ok) {
        const csv = await r.text();
        const lignes = csv.split('\n');
        diag.sources.csv_officiel.nb_lignes = lignes.length - 1;
        diag.sources.csv_officiel.entete = lignes[0];
      }
    } else { diag.sources.csv_officiel = { skip: 'pas de code INSEE' }; }
  } catch (e) { diag.sources.csv_officiel = { erreur: e.message }; }

  // Test source 1 : data.economie.gouv.fr
  try {
    const url = `https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/demandes-de-valeurs-foncieres-georeferencees/records?where=code_postal%3D%22${cp}%22&limit=2`;
    const r = await fetch(url, { signal: AbortSignal.timeout(9000) });
    diag.sources.data_economie = { status: r.status, ok: r.ok };
    if (r.ok) { const j = await r.json(); diag.sources.data_economie.total = j.total_count; diag.sources.data_economie.exemple = (j.results || [])[0] || null; }
  } catch (e) { diag.sources.data_economie = { erreur: e.message }; }

  // Test source 2 : api.dvf.etalab.gouv.fr (par INSEE)
  try {
    const insee = diag.code_insee ? diag.code_insee.code : null;
    if (insee) {
      const url = `https://api.dvf.etalab.gouv.fr/mutations3?code_commune=${insee}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(9000) });
      diag.sources.etalab = { status: r.status, ok: r.ok };
      if (r.ok) { const j = await r.json(); const muts = j.resultats || j.mutations || (Array.isArray(j) ? j : []); diag.sources.etalab.nb = muts.length; diag.sources.etalab.exemple = muts[0] || null; }
    } else { diag.sources.etalab = { skip: 'pas de code INSEE' }; }
  } catch (e) { diag.sources.etalab = { erreur: e.message }; }

  // Test source 3 : api.cquest.org
  try {
    const url = `http://api.cquest.org/dvf?code_postal=${cp}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(9000) });
    diag.sources.cquest = { status: r.status, ok: r.ok };
    if (r.ok) { const j = await r.json(); diag.sources.cquest.nb = (j.features || j.resultats || []).length; }
  } catch (e) { diag.sources.cquest = { erreur: e.message }; }

  // Résultat final via la vraie fonction
  try {
    const result = await getDVFData(cp, commune);
    diag.resultat_final = result;
  } catch (e) { diag.resultat_final_erreur = e.message; }

  res.json(diag);
});

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT NOW()');
    res.json({ 
      status: 'OK', 
      database: 'connected', 
      version: '3.3',
      brevo: BREVO_API_KEY ? 'configured' : 'not configured',
      admin_email: ADMIN_EMAIL ? 'configured' : 'not configured'
    });
  } catch (err) {
    res.json({ status: 'OK', database: 'error: ' + err.message });
  }
});

// Récupère le prix au m² DVF d'une commune (appelé quand l'agent saisit le code postal)
// Réponse rapide pour pré-remplir le champ prix. Protégé par auth.
app.get('/api/prix-secteur', requireAuth, async (req, res) => {
  try {
    const { code_postal, commune } = req.query;
    const cp = code_postal || extraireCodePostal(commune);
    if (!cp) return res.json({ success: false, error: 'Code postal manquant' });
    const dvf = await getDVFData(cp, commune);
    if (!dvf) {
      return res.json({ success: false, error: 'Pas de données DVF pour cette commune' });
    }
    res.json({
      success: true,
      commune: dvf.commune,
      maison: dvf.maison,
      appartement: dvf.appartement,
      source: dvf.source
    });
  } catch (error) {
    console.error('Erreur prix-secteur:', error);
    res.json({ success: false, error: error.message });
  }
});

// ============================================================
// ROUTES ANALYSE IA (avec helper Claude)
// ============================================================

// Convertit un fichier multer en bloc content Claude (image ou document PDF)
function fileToContent(file) {
  if (file.mimetype === 'application/pdf') {
    return {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: file.buffer.toString('base64') }
    };
  }
  return {
    type: 'image',
    source: { type: 'base64', media_type: file.mimetype, data: file.buffer.toString('base64') }
  };
}

async function analyzeWithClaude(prompt, photos, additionalContext = '', extraDocs = [], photoComments = []) {
  const content = [];
  if (additionalContext) content.push({ type: 'text', text: additionalContext });
  for (const doc of extraDocs) content.push(fileToContent(doc));

  const hasAnyComment = Array.isArray(photoComments) && photoComments.some(c => c && c.trim());

  // Instruction TOUJOURS présente : les photos sont numérotées, l'IA doit y faire référence par leur numéro
  if (photos.length > 0) {
    let instructionPhotos = `Les ${photos.length} photo(s) ci-dessous sont NUMÉROTÉES (« Photo 1 », « Photo 2 », etc.) dans l'ordre. RÈGLE IMPORTANTE : à chaque fois que tu décris un constat, un défaut ou un élément visible sur une image, tu DOIS citer le numéro de la photo concernée entre parenthèses (ex : « Fissure au plafond (Photo 3) », « Cuisine à rénover (Photos 2 et 5) »). Cela permet à l'utilisateur de savoir précisément de quelle photo tu parles.`;
    if (hasAnyComment) {
      instructionPhotos += ` Quand l'utilisateur a ajouté une annotation pour une photo, elle apparaît juste avant l'image (« Annotation utilisateur ») et exprime son intention/projet pour la zone (ex : « agrandir cette chambre en deux ») — tu DOIS en tenir compte explicitement, chiffrer si c'est un projet de travaux, et le restituer dans le rapport.`;
    }
    content.push({ type: 'text', text: instructionPhotos });
  }

  photos.forEach((photo, i) => {
    const c = (photoComments && photoComments[i] ? String(photoComments[i]).trim() : '');
    const label = c
      ? `Photo ${i + 1} — Annotation utilisateur : « ${c} »`
      : `Photo ${i + 1}`;
    content.push({ type: 'text', text: label });
    content.push(fileToContent(photo));
  });

  content.push({ type: 'text', text: prompt });

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    messages: [{ role: 'user', content }]
  });

  return message.content[0].text;
}

// Parse le champ comments (JSON array de strings) envoyé en multipart par le front
function parsePhotoComments(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(c => (c == null ? '' : String(c))) : [];
  } catch (e) {
    return [];
  }
}

// Helper : bloc de précisions utilisateur à injecter dans le contexte si fourni
function precisionsBlock(precisions) {
  const p = (precisions || '').trim();
  if (!p) return '';
  return `\n═══════════════════════════════════════════════════════════
PRÉCISIONS OBLIGATOIRES DE L'UTILISATEUR (à intégrer impérativement dans le rapport, dans les sections les plus pertinentes — chiffrer si c'est un coût, lister si ce sont des travaux, mentionner explicitement dans le PDF) :

${p}
═══════════════════════════════════════════════════════════

`;
}

// Helper : analyse Claude sans photos (utilisé pour l'affinement)
async function refineWithClaude(systemPrompt, previousAnalysis, instructions, context) {
  const userPrompt = `${context || ''}Voici l'analyse précédente que tu avais produite :

═══════════════════════════════════════════════════════════
${previousAnalysis}
═══════════════════════════════════════════════════════════

L'utilisateur souhaite l'affiner avec les consignes suivantes :

═══════════════════════════════════════════════════════════
${instructions}
═══════════════════════════════════════════════════════════

CONSIGNE :
- Réécris l'analyse COMPLÈTE en intégrant les consignes ci-dessus.
- GARDE EXACTEMENT le même format de réponse (mêmes titres de sections, mêmes balises markdown # ## ###, mêmes tableaux markdown |...|).
- Ne supprime aucune section utile. Modifie, ajoute ou affine selon les consignes.
- N'invente pas d'informations factuelles nouvelles que tu ne pourrais pas déduire de l'analyse précédente et des consignes.
- Si une consigne contredit l'analyse précédente, applique la consigne de l'utilisateur — c'est lui qui décide.
- Réponds UNIQUEMENT avec l'analyse réécrite, sans préambule ni commentaire.

${systemPrompt}`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    messages: [{ role: 'user', content: [{ type: 'text', text: userPrompt }] }]
  });

  return message.content[0].text;
}

// ============================================================
// ROUTE EXPRESS — Chiffrage rapide (1 crédit, ~30 secondes)
// ============================================================
app.post('/api/analyze/express', aiLimiter, requireAuth, checkCredits, upload.array('photos', 5), async (req, res) => {
  try {
    const { context_bien, description } = req.body;
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'Aucune photo' });
    const context = [
      context_bien ? `Contexte du bien : ${context_bien}` : '',
      description ? `Description : ${description}` : ''
    ].filter(Boolean).join('\n');
    const analysis = await analyzeWithClaude(PROMPTS.express, req.files, context);
    await incrementAnalysesCounter(req.user.id, 'express', req.creditCost || 1);
    res.json({ success: true, analysis, mode: 'express' });
  } catch (error) {
    console.error('Erreur express:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/analyze/visite', aiLimiter, requireAuth, checkAnalysesQuota, upload.fields([{ name: 'photos', maxCount: 20 }, { name: 'dpe', maxCount: 1 }]), async (req, res) => {
  try {
    const { surface, location, precisions, visite_type, prix_achat, loyer_vise, regime_fiscal, prix_m2_agent } = req.body;
    const photos = (req.files && req.files.photos) || [];
    const dpeFiles = (req.files && req.files.dpe) || [];
    if (photos.length === 0) return res.status(400).json({ error: 'Aucune photo' });
    const isLocatif = visite_type === 'locatif';
    const dpeNote = dpeFiles.length > 0
      ? `\nUn DPE du bien est joint (document avant les photos). Utilise SES VALEURS RÉELLES.\n`
      : `\nAucun DPE fourni — estime la classe probable à partir des photos et de l'année de construction visible.\n`;
    let context = `Surface : ${surface || 'non précisée'} m²\nLocalisation : ${location || 'non précisée'}\n${dpeNote}`;
    if (isLocatif) {
      context += prix_achat ? `Prix d'achat envisagé : ${prix_achat} €\n` : '';
      context += loyer_vise ? `Loyer mensuel visé par l'investisseur : ${loyer_vise} €/mois HC\n` : '';
      context += regime_fiscal ? `Régime fiscal envisagé : ${regime_fiscal}\n` : '';
    }
    // Vraies données de prix DVF pour situer la valeur du bien
    const cpV = extraireCodePostal(location);
    const dvfV = await getDVFData(cpV, extraireNomCommune(location));
    context += buildDVFContext(dvfV, prix_m2_agent);
    context += '\n' + precisionsBlock(precisions);
    const prompt = isLocatif ? PROMPTS.visite_locatif : PROMPTS.visite;
    const photoComments = parsePhotoComments(req.body.comments);
    const analysis = await analyzeWithClaude(prompt, photos, context, dpeFiles, photoComments);
    await incrementAnalysesCounter(req.user.id, getModeFromReq(req), req.creditCost || 0);
    res.json({ success: true, analysis });
  } catch (error) {
    console.error('Erreur visite:', error);

    // Notification email en cas d'erreur (optionnel)
    if (NOTIFICATION_EMAIL && BREVO_API_KEY) {
      sendEmail(NOTIFICATION_EMAIL, '⚠️ Erreur RénoExpert', emailTemplate(
        'Erreur technique',
        `<p>Une erreur s'est produite sur le mode <strong>Visite</strong> :</p>
         <pre style="background: #ffe6e8; padding: 10px; border-radius: 6px;">${error.message}</pre>`
      ));
    }

    res.status(500).json({ error: error.message });
  }
});

app.post('/api/analyze/reparation', aiLimiter, requireAuth, checkAnalysesQuota, upload.array('photos', 10), async (req, res) => {
  try {
    const { description, precisions } = req.body;
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'Aucune photo' });
    const context = (description ? `Description : ${description}\n\n` : '') + precisionsBlock(precisions);
    const photoComments = parsePhotoComments(req.body.comments);
    const analysis = await analyzeWithClaude(PROMPTS.reparation, req.files, context, [], photoComments);
    await incrementAnalysesCounter(req.user.id, getModeFromReq(req), req.creditCost || 0);
    res.json({ success: true, analysis });
  } catch (error) {
    console.error('Erreur reparation:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/analyze/agent', aiLimiter, requireAuth, checkAnalysesQuota, upload.fields([{ name: 'photos', maxCount: 30 }, { name: 'dpe', maxCount: 1 }]), async (req, res) => {
  try {
    const { surface, location, agence_nom, agent_nom, precisions, plus_values, prix_m2_agent, potentiel } = req.body;
    const photos = (req.files && req.files.photos) || [];
    const dpeFiles = (req.files && req.files.dpe) || [];
    if (photos.length === 0) return res.status(400).json({ error: 'Aucune photo' });
    const dpeNote = dpeFiles.length > 0
      ? `\nUn DPE du bien est joint à cette requête (document avant les photos). Lis-le attentivement et utilise SES VALEURS RÉELLES — pas d'estimation.\n`
      : `\nAucun DPE fourni à ce stade — précise dans la fiche "(estimé)" pour les données énergie/GES et indique en notes finales que le DPE peut être ajouté ultérieurement et la fiche régénérée.\n`;
    const pvBlock = plus_values && plus_values.trim()
      ? `\nPlus-values cochées par l'agent (à intégrer EXPLICITEMENT dans Atouts + à chiffrer dans Prix de marché) :\n${plus_values.trim()}\n`
      : '';
    const potentielBlock = potentiel && potentiel.trim()
      ? `\nPOTENTIEL DU BIEN signalé par l'agent (TRÈS IMPORTANT pour l'estimation) : ${potentiel.trim()}\nCe potentiel (division, agrandissement, combles aménageables, terrain constructible…) crée une valeur qui dépasse le simple prix au m² en l'état. Un bien brut avec un fort potentiel vaut BIEN PLUS que sa valeur actuelle : explique ce potentiel dans la fiche et chiffre la plus-value réalisable. Ne te limite PAS au prix au m² du secteur pour un bien à fort potentiel.\n`
      : '';
    // Récupérer les vraies données de prix DVF pour la commune
    const cp = extraireCodePostal(location);
    const nomCommune = extraireNomCommune(location);
    const dvf = await getDVFData(cp, nomCommune);
    const dvfBloc = buildDVFContext(dvf, prix_m2_agent);

    const context = `Surface : ${surface} m²\nLocalisation : ${location}\nAgence : ${agence_nom}\nAgent : ${agent_nom}\n${dpeNote}${pvBlock}${potentielBlock}\n${dvfBloc}\n` + precisionsBlock(precisions);
    const photoComments = parsePhotoComments(req.body.comments);
    const analysis = await analyzeWithClaude(PROMPTS.agent, photos, context, dpeFiles, photoComments);
    await incrementAnalysesCounter(req.user.id, getModeFromReq(req), req.creditCost || 0);
    res.json({ success: true, analysis, agence_nom, agent_nom, dpe_fourni: dpeFiles.length > 0, dvf_utilise: !!dvf });
  } catch (error) {
    console.error('Erreur agent:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/analyze/marchand', aiLimiter, requireAuth, checkAnalysesQuota, upload.fields([{ name: 'photos', maxCount: 50 }, { name: 'dpe', maxCount: 1 }]), async (req, res) => {
  try {
    const { surface, prix_demande, location, strategie, nb_lots, annee_construction, mb_societe, precisions, prix_m2_agent } = req.body;
    const photos = (req.files && req.files.photos) || [];
    const dpeFiles = (req.files && req.files.dpe) || [];
    if (photos.length === 0) return res.status(400).json({ error: 'Aucune photo' });
    const dpeNote = dpeFiles.length > 0
      ? `\nDPE joint — utilise SES VALEURS RÉELLES (classe, kWh/m²/an, GES) et chiffre le coût de rénovation énergétique pour atteindre la classe B ou C visée MB.\n`
      : `\nAucun DPE fourni — estime la classe probable d'après les photos et l'année de construction.\n`;
    // Vraies données de prix DVF pour estimer la revente de façon fiable
    const cp = extraireCodePostal(location);
    const nomCommune = extraireNomCommune(location);
    const dvf = await getDVFData(cp, nomCommune);
    const dvfBloc = buildDVFContext(dvf, prix_m2_agent);
    const context = `Société MB : ${mb_societe}
Localisation : ${location}
Surface : ${surface} m²
Année construction : ${annee_construction}
Prix demandé : ${prix_demande} €
Stratégie : ${strategie}
Nombre de lots envisagés : ${nb_lots}
${dpeNote}
${dvfBloc}
IMPORTANT : Frais notaire MB = 3% du prix d'achat (article 1115 CGI)
Pour le prix de REVENTE après travaux, base-toi sur les données DVF ci-dessus AJUSTÉES À LA HAUSSE pour un bien rénové (un bien refait à neuf se vend dans le haut de la fourchette du secteur, voire au-dessus de la médiane).

` + precisionsBlock(precisions);
    const photoComments = parsePhotoComments(req.body.comments);
    const analysis = await analyzeWithClaude(PROMPTS.marchand, photos, context, dpeFiles, photoComments);
    await incrementAnalysesCounter(req.user.id, getModeFromReq(req), req.creditCost || 0);
    const frais_notaire_mb_3pct = Math.round(parseFloat(prix_demande) * 0.03);
    res.json({ success: true, analysis, frais_notaire_mb_3pct, dvf_utilise: !!dvf });
  } catch (error) {
    console.error('Erreur marchand:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ROUTES D'AFFINEMENT (sans photos, sur la base d'une analyse précédente)
// ============================================================

app.post('/api/refine/visite', aiLimiter, requireAuth, requirePaidForRefine, checkAnalysesQuota, async (req, res) => {
  try {
    const { previousAnalysis, instructions, surface, location } = req.body;
    if (!previousAnalysis || !instructions) return res.status(400).json({ error: 'previousAnalysis et instructions requis' });
    const context = `Surface : ${surface || 'non précisée'} m²\nLocalisation : ${location || 'non précisée'}\n\n`;
    const analysis = await refineWithClaude(PROMPTS.visite, previousAnalysis, instructions, context);
    await incrementAnalysesCounter(req.user.id, getModeFromReq(req), req.creditCost || 0);
    res.json({ success: true, analysis });
  } catch (error) {
    console.error('Erreur refine visite:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/refine/reparation', aiLimiter, requireAuth, requirePaidForRefine, checkAnalysesQuota, async (req, res) => {
  try {
    const { previousAnalysis, instructions, description } = req.body;
    if (!previousAnalysis || !instructions) return res.status(400).json({ error: 'previousAnalysis et instructions requis' });
    const context = description ? `Description initiale : ${description}\n\n` : '';
    const analysis = await refineWithClaude(PROMPTS.reparation, previousAnalysis, instructions, context);
    await incrementAnalysesCounter(req.user.id, getModeFromReq(req), req.creditCost || 0);
    res.json({ success: true, analysis });
  } catch (error) {
    console.error('Erreur refine reparation:', error);
    res.status(500).json({ error: error.message });
  }
});

// Génère des annonces immobilières (LeBonCoin, SeLoger, réseaux) à partir d'une analyse existante
app.post('/api/annonce', aiLimiter, requireAuth, checkAnalysesQuota, async (req, res) => {
  try {
    const { analysis, surface, location, infos } = req.body;
    if (!analysis) return res.status(400).json({ error: 'Analyse manquante pour générer l\'annonce' });

    const context = `Informations du bien :\n- Surface : ${surface || 'non précisée'} m²\n- Localisation : ${location || 'non précisée'}\n${infos ? '- Détails : ' + infos + '\n' : ''}\n\nVoici l'analyse complète du bien réalisée précédemment (utilise-la comme source d'informations) :\n\n${analysis}\n\n`;

    const userPrompt = `${context}\nÀ partir de ces informations, rédige les annonces immobilières selon le format demandé.\n\n${PROMPTS.annonce}`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: [{ type: 'text', text: userPrompt }] }]
    });
    const annonce = message.content[0].text;
    await incrementAnalysesCounter(req.user.id, getModeFromReq(req), req.creditCost || 0);
    res.json({ success: true, annonce });
  } catch (error) {
    console.error('Erreur génération annonce:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/refine/agent', aiLimiter, requireAuth, requirePaidForRefine, checkAnalysesQuota, async (req, res) => {
  try {
    const { previousAnalysis, instructions, surface, location, agence_nom, agent_nom } = req.body;
    if (!previousAnalysis || !instructions) return res.status(400).json({ error: 'previousAnalysis et instructions requis' });
    const context = `Surface : ${surface} m²\nLocalisation : ${location}\nAgence : ${agence_nom}\nAgent : ${agent_nom}\n\n`;
    const analysis = await refineWithClaude(PROMPTS.agent, previousAnalysis, instructions, context);
    await incrementAnalysesCounter(req.user.id, getModeFromReq(req), req.creditCost || 0);
    res.json({ success: true, analysis, agence_nom, agent_nom });
  } catch (error) {
    console.error('Erreur refine agent:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/refine/express', aiLimiter, requireAuth, requirePaidForRefine, checkAnalysesQuota, async (req, res) => {
  try {
    const { previousAnalysis, instructions, description } = req.body;
    if (!previousAnalysis || !instructions) return res.status(400).json({ error: 'previousAnalysis et instructions requis' });
    const context = description ? `Description initiale : ${description}\n\n` : '';
    const analysis = await refineWithClaude(PROMPTS.express, previousAnalysis, instructions, context);
    await incrementAnalysesCounter(req.user.id, getModeFromReq(req), req.creditCost || 0);
    res.json({ success: true, analysis });
  } catch (error) {
    console.error('Erreur refine express:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/refine/marchand', aiLimiter, requireAuth, requirePaidForRefine, checkAnalysesQuota, async (req, res) => {
  try {
    const { previousAnalysis, instructions, surface, prix_demande, location, strategie, nb_lots, annee_construction, mb_societe } = req.body;
    if (!previousAnalysis || !instructions) return res.status(400).json({ error: 'previousAnalysis et instructions requis' });
    const context = `Société MB : ${mb_societe}
Localisation : ${location}
Surface : ${surface} m²
Année construction : ${annee_construction}
Prix demandé : ${prix_demande} €
Stratégie : ${strategie}
Nombre de lots envisagés : ${nb_lots}

`;
    const analysis = await refineWithClaude(PROMPTS.marchand, previousAnalysis, instructions, context);
    await incrementAnalysesCounter(req.user.id, getModeFromReq(req), req.creditCost || 0);
    const frais_notaire_mb_3pct = prix_demande ? Math.round(parseFloat(prix_demande) * 0.03) : null;
    res.json({ success: true, analysis, frais_notaire_mb_3pct });
  } catch (error) {
    console.error('Erreur refine marchand:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// FEEDBACK (avec notification email si négatif)
// ============================================================

app.post('/api/feedback', generalLimiter, async (req, res) => {
  try {
    const { mode, note, probleme, location, userId, userEmail } = req.body;
    
    await pool.query(
      `INSERT INTO feedbacks (mode, note, probleme, location, user_id, user_email) 
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [mode || 'unknown', note || '', probleme || '', location || '', userId || '', userEmail || '']
    );
    
    // Notification email si feedback négatif
    if (note === '👎' && NOTIFICATION_EMAIL && BREVO_API_KEY) {
      sendEmail(
        NOTIFICATION_EMAIL,
        '👎 Feedback négatif sur RénoExpert',
        emailTemplate(
          'Feedback négatif reçu',
          `<p>Un utilisateur a signalé un problème :</p>
           <ul style="background: #ffe6e8; padding: 15px; border-radius: 10px; list-style: none;">
             <li><strong>📋 Mode :</strong> ${mode}</li>
             <li><strong>📍 Lieu :</strong> ${location || 'non précisé'}</li>
             <li><strong>👤 Utilisateur :</strong> ${userEmail || userId || 'anonyme'}</li>
             <li><strong>📝 Problème :</strong> ${probleme || 'non précisé'}</li>
             <li><strong>📅 Date :</strong> ${new Date().toLocaleString('fr-FR')}</li>
           </ul>
           <p>Consulte ton dashboard admin pour voir tous les feedbacks.</p>`
        )
      );
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Erreur feedback:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ROUTES PROJETS (avec auth + limite quota)
// ============================================================

app.post('/api/projets/save', requireAuth, async (req, res) => {
  try {
    const { mode, titre, analysis, data, bien_id } = req.body;

    if (!mode || !analysis) {
      return res.status(400).json({ error: 'Données manquantes' });
    }

    const bienIdVal = bien_id ? parseInt(bien_id) : null;

    const result = await pool.query(
      `INSERT INTO projets (user_id, user_email, mode, titre, analysis, data, bien_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [req.user.email, req.user.email, mode, titre || `Projet ${mode}`, analysis, JSON.stringify(data || {}), bienIdVal]
    );
    
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM projets WHERE user_email = $1',
      [req.user.email]
    );
    
    res.json({
      success: true,
      projet_id: result.rows[0].id,
      total_projets: parseInt(countResult.rows[0].count),
      quota: {
        utilises: parseInt(req.user.nb_analyses || 0),
        limite: req.user.plan === 'illimite' ? null : LIMITE_ANALYSES_GRATUIT,
        illimite: req.user.plan === 'illimite',
        type: 'analyses'
      }
    });
  } catch (error) {
    console.error('Erreur save projet:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/projets/list', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, mode, titre, analysis, data, created_at, bien_id
       FROM projets
       WHERE user_email = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [req.user.email]
    );

    const liste = result.rows.map(p => ({
      id: p.id.toString(),
      mode: p.mode,
      titre: p.titre,
      created_at: p.created_at,
      bien_id: p.bien_id || null,
      location: (p.data && p.data.location) || '',
      surface: (p.data && p.data.surface) || '',
      visite_type: (p.data && p.data.visite_type) || null,
      preview: (p.analysis || '').substring(0, 150) + '...'
    }));
    
    res.json({
      success: true,
      total: liste.length,
      projets: liste,
      quota: {
        utilises: parseInt(req.user.nb_analyses || 0),
        limite: req.user.plan === 'illimite' ? null : LIMITE_ANALYSES_GRATUIT,
        illimite: req.user.plan === 'illimite',
        type: 'analyses',
        nb_projets: liste.length
      }
    });
  } catch (error) {
    console.error('Erreur list projets:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/projets/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM projets WHERE id = $1 AND user_email = $2',
      [req.params.id, req.user.email]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Projet non trouvé' });
    }
    
    const p = result.rows[0];
    res.json({
      success: true,
      projet: {
        id: p.id.toString(),
        mode: p.mode,
        titre: p.titre,
        analysis: p.analysis,
        data: p.data || {},
        created_at: p.created_at
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/projets/:id', requireAuth, async (req, res) => {
  try {
    const { titre } = req.body;
    if (!titre || !titre.trim()) return res.status(400).json({ error: 'Titre manquant' });
    const result = await pool.query(
      'UPDATE projets SET titre = $1, updated_at = NOW() WHERE id = $2 AND user_email = $3 RETURNING id, titre',
      [titre.trim(), req.params.id, req.user.email]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Projet non trouvé' });
    res.json({ success: true, projet: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/projets/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM projets WHERE id = $1 AND user_email = $2 RETURNING id',
      [req.params.id, req.user.email]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Projet non trouvé' });
    }
    
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM projets WHERE user_email = $1',
      [req.user.email]
    );
    
    res.json({ success: true, remaining: parseInt(countResult.rows[0].count) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ROUTES PROSPECTS (email "avertir de la sortie") + QUESTIONNAIRE
// ============================================================

// Enregistre un email de prospect (avertir du lancement) : DB + notification admin
app.post('/api/prospect', generalLimiter, requireAuth, async (req, res) => {
  try {
    const { email, mode } = req.body;
    const emailClean = (email || req.user.email || '').trim().toLowerCase();
    if (!emailClean || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailClean)) {
      return res.status(400).json({ error: 'Email invalide' });
    }
    // Stocker en DB (éviter les doublons exacts email+mode)
    await pool.query(
      `INSERT INTO prospects (email, mode, user_id) VALUES ($1, $2, $3)`,
      [emailClean, mode || null, req.user.id]
    );
    // Notifier l'admin par email
    sendEmail(
      NOTIFICATION_EMAIL,
      '🎯 Nouveau prospect RénoExpert (sortie app)',
      `<p>Un utilisateur souhaite être averti du lancement :</p>
       <ul>
         <li><b>Email :</b> ${emailClean}</li>
         <li><b>Mode utilisé :</b> ${mode || 'non précisé'}</li>
         <li><b>Compte :</b> ${req.user.email}</li>
         <li><b>Date :</b> ${new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}</li>
       </ul>`
    ).catch(e => console.error('⚠️ Email prospect admin échec:', e.message));
    res.json({ success: true, message: 'Merci ! Vous serez averti du lancement.' });
  } catch (error) {
    console.error('Erreur prospect:', error);
    res.status(500).json({ error: error.message });
  }
});

// Enregistre les réponses au questionnaire de fin d'analyse : DB + notification admin
app.post('/api/questionnaire', generalLimiter, requireAuth, async (req, res) => {
  try {
    const { mode, utilite, precision_estim, pret_a_payer, prix_juste, amelioration, recommander } = req.body;
    await pool.query(
      `INSERT INTO questionnaires (user_id, user_email, mode, utilite, precision_estim, pret_a_payer, prix_juste, amelioration, recommander)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [req.user.id, req.user.email, mode || null, utilite || null, precision_estim || null,
       pret_a_payer || null, prix_juste || null, amelioration || null, recommander || null]
    );
    // Notifier l'admin
    sendEmail(
      NOTIFICATION_EMAIL,
      '📝 Nouveau questionnaire RénoExpert',
      `<p>Réponse au questionnaire (mode ${mode || '?'}) de ${req.user.email} :</p>
       <ul>
         <li><b>Utilité :</b> ${utilite || '-'}</li>
         <li><b>Précision estimations :</b> ${precision_estim || '-'}</li>
         <li><b>Prêt à payer :</b> ${pret_a_payer || '-'}</li>
         <li><b>Prix juste :</b> ${prix_juste || '-'}</li>
         <li><b>Recommanderait :</b> ${recommander || '-'}</li>
         <li><b>Amélioration :</b> ${amelioration || '-'}</li>
       </ul>`
    ).catch(e => console.error('⚠️ Email questionnaire admin échec:', e.message));
    res.json({ success: true, message: 'Merci pour votre retour !' });
  } catch (error) {
    console.error('Erreur questionnaire:', error);
    res.status(500).json({ error: error.message });
  }
});

// LISTE D'ATTENTE : prospects intéressés par la future version payante.
// Accessible aux utilisateurs connectés ET aux visiteurs (pas de requireAuth ici, on accepte tout
// email valide — l'objectif est de mesurer la demande, pas de filtrer).
app.post('/api/liste-attente', generalLimiter, async (req, res) => {
  try {
    const { email, mode, prix_souhaite, frequence, commentaire } = req.body;
    const emailClean = (email || '').toString().trim().toLowerCase();
    if (!emailClean || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailClean)) {
      return res.status(400).json({ error: 'Email invalide.' });
    }
    // Si l'utilisateur est authentifié, on lie le user_id (sinon null)
    let userId = null;
    try {
      const authHeader = req.headers.authorization || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
      if (token) {
        const u = await pool.query(
          'SELECT id FROM users WHERE session_token = $1 AND session_expires > NOW()',
          [token]
        );
        if (u.rows.length) userId = u.rows[0].id;
      }
    } catch (e) { /* on continue sans user_id */ }

    await pool.query(
      `INSERT INTO liste_attente (user_id, email, mode, prix_souhaite, frequence, commentaire)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, emailClean, mode || null,
       (prix_souhaite || '').toString().slice(0, 100) || null,
       (frequence || '').toString().slice(0, 100) || null,
       (commentaire || '').toString().slice(0, 1000) || null]
    );
    // Notif admin (utile pour réagir vite à un prospect chaud)
    if (NOTIFICATION_EMAIL) {
      sendEmail(
        NOTIFICATION_EMAIL,
        '⭐ Nouvelle inscription liste d\'attente RénoExpert',
        `<p>Un prospect s'est inscrit à la liste d'attente :</p>
         <ul>
           <li><b>Email :</b> ${emailClean}</li>
           <li><b>Profil/mode :</b> ${mode || '-'}</li>
           <li><b>Prix souhaité :</b> ${prix_souhaite || '-'}</li>
           <li><b>Fréquence d'usage :</b> ${frequence || '-'}</li>
           <li><b>Commentaire :</b> ${commentaire || '-'}</li>
         </ul>`
      ).catch(e => console.error('⚠️ Email liste attente échec:', e.message));
    }
    res.json({ success: true, message: 'Merci ! On vous prévient dès l\'ouverture.' });
  } catch (error) {
    console.error('Erreur liste-attente:', error);
    res.status(500).json({ error: error.message });
  }
});

// Route admin : voir les prospects, questionnaires et liste d'attente
app.get('/api/admin/prospects', requireAuth, async (req, res) => {
  if (req.user.plan !== 'illimite') return res.status(403).json({ error: 'Accès réservé admin' });
  try {
    const prospects = await pool.query('SELECT email, mode, created_at FROM prospects ORDER BY created_at DESC LIMIT 500');
    const questionnaires = await pool.query('SELECT mode, utilite, precision_estim, pret_a_payer, prix_juste, amelioration, recommander, user_email, created_at FROM questionnaires ORDER BY created_at DESC LIMIT 500');
    const liste_attente = await pool.query('SELECT email, mode, prix_souhaite, frequence, commentaire, created_at FROM liste_attente ORDER BY created_at DESC LIMIT 500');
    res.json({ prospects: prospects.rows, questionnaires: questionnaires.rows, liste_attente: liste_attente.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// PDF ROUTES (avec design pro v3.4)
// ============================================================

app.post('/api/pdf/visite', generalLimiter, requireAuth, async (req, res) => {
  try {
    // En version test/découverte, le PDF du mode Visite est réservé à la version complète (sauf admin).
    if (req.user.plan !== 'illimite') {
      return res.status(403).json({
        error: 'Le rapport PDF du mode Visite Immobilière est réservé à la version complète. Idéal pour constituer votre dossier banque avec le détail chiffré des travaux ! Laissez votre email pour être averti du lancement.',
        code: 'PDF_RESERVE_PAYANT',
        mode: 'visite'
      });
    }
    const { analysis, location, surface, visite_type, loyer_vise, prix_achat } = req.body;
    if (!analysis) return res.status(400).json({ error: 'Analyse manquante' });
    pdfGen.generateVisitePDF({ analysis, location, surface, visite_type, loyer_vise, prix_achat }, res);
  } catch (error) {
    console.error('Erreur PDF visite:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/pdf/reparation', generalLimiter, requireAuth, async (req, res) => {
  try {
    const { analysis, description } = req.body;
    if (!analysis) return res.status(400).json({ error: 'Analyse manquante' });
    pdfGen.generateReparationPDF({ analysis, description }, res);
  } catch (error) {
    console.error('Erreur PDF reparation:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/pdf/agent', generalLimiter, requireAuth, async (req, res) => {
  try {
    const { analysis, agence_nom, agent_nom, location, surface } = req.body;
    if (!analysis) return res.status(400).json({ error: 'Analyse manquante' });
    pdfGen.generateAgentPDF({ analysis, agence_nom, agent_nom, location, surface }, res);
  } catch (error) {
    console.error('Erreur PDF agent:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/pdf/marchand', generalLimiter, requireAuth, async (req, res) => {
  try {
    const { analysis, mb_societe, location, surface, prix_demande, nb_lots, strategie } = req.body;
    if (!analysis) return res.status(400).json({ error: 'Analyse manquante' });
    pdfGen.generateMarchandPDF({
      analysis, mb_societe, location, surface, prix_demande, nb_lots, strategie
    }, res);
  } catch (error) {
    console.error('Erreur PDF marchand:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/pdf/express', generalLimiter, requireAuth, async (req, res) => {
  try {
    const { analysis } = req.body;
    if (!analysis) return res.status(400).json({ error: 'Analyse manquante' });
    const credits = parseInt(req.user.credits || 0);
    if (req.user.plan !== 'illimite' && credits < 1) {
      return res.status(403).json({
        error: 'Crédits insuffisants pour générer le PDF.',
        code: 'CREDITS_INSUFFISANTS',
        credits_restants: credits,
        credits_necessaires: 1
      });
    }
    if (typeof pdfGen.generateExpressPDF !== 'function') {
      return res.status(500).json({ error: 'Service PDF Express non disponible.' });
    }
    await deductCredits(req.user.id, 1);
    pdfGen.generateExpressPDF({ analysis }, res);
  } catch (error) {
    console.error('Erreur PDF express:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// ============================================================
// DASHBOARD ADMIN
// ============================================================

app.get('/admin/feedbacks', async (req, res) => {
  try {
    const token = req.query.token;
    if (!token || token !== ADMIN_TOKEN) {
      return res.status(401).send(`
        <!DOCTYPE html>
        <html><head><meta charset="UTF-8"><title>Admin</title>
        <style>
          body{font-family:sans-serif;background:linear-gradient(135deg,#0066ff,#4d94ff);min-height:100vh;display:flex;align-items:center;justify-content:center;margin:0;padding:20px}
          .box{background:white;padding:40px;border-radius:16px;max-width:400px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.3)}
          h1{color:#0066ff;margin-bottom:10px}
          p{color:#666;margin-bottom:20px;font-size:14px}
          input{width:100%;padding:12px;border:2px solid #e0e0e0;border-radius:8px;font-size:15px;margin-bottom:15px;box-sizing:border-box}
          button{width:100%;padding:12px;background:#0066ff;color:white;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer}
          .err{color:#f44336;font-size:13px;margin-bottom:10px}
        </style></head>
        <body><div class="box">
          <h1>🔐 Admin RénoExpert</h1>
          <p>Entrez votre token d'administration</p>
          ${token && token !== ADMIN_TOKEN ? '<div class="err">❌ Token incorrect</div>' : ''}
          <form method="GET"><input type="password" name="token" placeholder="Token admin" required autofocus><button>🔓 Se connecter</button></form>
        </div></body></html>
      `);
    }
    
    const feedbacksResult = await pool.query('SELECT * FROM feedbacks ORDER BY created_at DESC LIMIT 100');
    const feedbacks = feedbacksResult.rows;
    
    const total = feedbacks.length;
    const positifs = feedbacks.filter(f => f.note === '👍').length;
    const negatifs = feedbacks.filter(f => f.note === '👎').length;
    const satisfaction = total > 0 ? Math.round(((total - negatifs) / total) * 100) : 0;
    
    const usersResult = await pool.query('SELECT COUNT(*) as total FROM users');
    const totalUsers = parseInt(usersResult.rows[0].total);
    
    const projetsResult = await pool.query('SELECT COUNT(*) as total FROM projets');
    const totalProjets = parseInt(projetsResult.rows[0].total);
    
    res.send(`
      <!DOCTYPE html>
      <html><head><meta charset="UTF-8"><title>Admin - RénoExpert</title>
      <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:-apple-system,sans-serif;background:#f5f7fb;padding:20px}
        .container{max-width:1200px;margin:0 auto}
        header{background:linear-gradient(135deg,#0066ff,#4d94ff);color:white;padding:30px;border-radius:16px;margin-bottom:24px;box-shadow:0 4px 20px rgba(0,102,255,0.2)}
        h1{font-size:26px;margin-bottom:6px}
        .subtitle{opacity:0.9;font-size:14px}
        .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:24px}
        .stat-card{background:white;padding:20px;border-radius:14px;box-shadow:0 2px 10px rgba(0,0,0,0.05);border:1px solid #e8eef7}
        .stat-value{font-size:32px;font-weight:800;color:#0066ff;margin-bottom:4px}
        .stat-label{color:#5e6987;font-size:12px;font-weight:500}
        .section{background:white;padding:24px;border-radius:14px;box-shadow:0 2px 10px rgba(0,0,0,0.05);margin-bottom:20px;border:1px solid #e8eef7}
        h2{font-size:18px;margin-bottom:18px;color:#0a0e27}
        table{width:100%;border-collapse:collapse}
        th{background:#f5f7fb;padding:12px;text-align:left;font-size:12px;color:#5e6987;font-weight:600;border-bottom:2px solid #e8eef7;text-transform:uppercase}
        td{padding:12px;border-bottom:1px solid #f0f3f8;font-size:14px}
        tr:hover{background:#f8faff}
        .note{display:inline-block;padding:4px 10px;border-radius:10px;font-size:16px}
        .note.positif{background:#e6ffec}.note.neutre{background:#fff4e6}.note.negatif{background:#ffe6e8}
        .mode{display:inline-block;padding:3px 10px;border-radius:10px;font-size:11px;font-weight:600;background:#e6f0ff;color:#0052cc}
        .btn{display:inline-block;padding:10px 20px;background:#0066ff;color:white;text-decoration:none;border-radius:10px;font-size:13px;font-weight:600;margin-top:12px;margin-right:8px}
        .btn:hover{background:#0052cc}
        .empty{text-align:center;padding:60px 20px;color:#8b95b0}
        .tabs{display:flex;gap:10px;margin-bottom:20px}
        .tab{padding:10px 20px;background:white;border:1px solid #e8eef7;border-radius:10px;cursor:pointer;font-weight:600;color:#5e6987;text-decoration:none}
        .tab.active{background:#0066ff;color:white;border-color:#0066ff}
      </style></head>
      <body><div class="container">
        <header>
          <h1>📊 Dashboard Admin RénoExpert v3.3</h1>
          <div class="subtitle">Comptes utilisateurs + Notifications activés</div>
        </header>
        
        <div class="stats">
          <div class="stat-card"><div class="stat-value">${totalUsers}</div><div class="stat-label">Utilisateurs inscrits</div></div>
          <div class="stat-card"><div class="stat-value">${totalProjets}</div><div class="stat-label">Projets créés</div></div>
          <div class="stat-card"><div class="stat-value">${total}</div><div class="stat-label">Feedbacks</div></div>
          <div class="stat-card"><div class="stat-value">${satisfaction}%</div><div class="stat-label">Satisfaction</div></div>
          <div class="stat-card"><div class="stat-value">${negatifs}</div><div class="stat-label">À corriger</div></div>
        </div>
        
        <div class="tabs">
          <a href="/admin/feedbacks?token=${encodeURIComponent(token)}" class="tab active">📋 Feedbacks</a>
          <a href="/admin/users?token=${encodeURIComponent(token)}" class="tab">👥 Utilisateurs</a>
        </div>
        
        <div class="section">
          <h2>📋 Tous les feedbacks (${total})</h2>
          ${total === 0 ? `<div class="empty">📭 Aucun feedback pour le moment</div>` : `
            <table>
              <thead><tr><th>Date</th><th>Mode</th><th>Note</th><th>Utilisateur</th><th>Lieu</th><th>Problème</th></tr></thead>
              <tbody>
                ${feedbacks.map(f => `
                  <tr>
                    <td>${new Date(f.created_at).toLocaleDateString('fr-FR')} ${new Date(f.created_at).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'})}</td>
                    <td><span class="mode">${f.mode || 'N/A'}</span></td>
                    <td><span class="note ${f.note === '👍' ? 'positif' : f.note === '👎' ? 'negatif' : 'neutre'}">${f.note}</span></td>
                    <td style="font-size:12px;color:#5e6987">${f.user_email || f.user_id || 'anonyme'}</td>
                    <td>${f.location || '-'}</td>
                    <td style="font-size:12px;color:#5e6987;max-width:300px">${f.probleme || '-'}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
            <a href="/admin/feedbacks/export?token=${encodeURIComponent(token)}" class="btn">📥 Télécharger CSV</a>
          `}
        </div>
      </div></body></html>
    `);
  } catch (error) {
    console.error('Erreur dashboard:', error);
    res.status(500).send('Erreur: ' + error.message);
  }
});

// Page utilisateurs
// ── ADMIN : recharger les crédits d'un utilisateur ──────────────
app.post('/api/admin/credits', async (req, res) => {
  try {
    const { token, email, credits, action } = req.body;
    if (!token || token !== ADMIN_TOKEN) return res.status(401).json({ error: 'Non autorisé' });
    if (!email || credits === undefined) return res.status(400).json({ error: 'Email et crédits requis' });
    const nb = parseInt(credits);
    if (isNaN(nb) || nb < 0) return res.status(400).json({ error: 'Nombre invalide' });
    let query, params;
    if (action === 'set') {
      query = 'UPDATE users SET credits = $1 WHERE LOWER(email) = LOWER($2) RETURNING id, email, nom, credits';
      params = [nb, email];
    } else {
      // add (défaut)
      query = 'UPDATE users SET credits = credits + $1 WHERE LOWER(email) = LOWER($2) RETURNING id, email, nom, credits';
      params = [nb, email];
    }
    const result = await pool.query(query, params);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Utilisateur introuvable' });
    const u = result.rows[0];
    console.log(`[ADMIN] Crédits mis à jour — ${u.email} : ${u.credits} crédits`);
    res.json({ success: true, email: u.email, nom: u.nom, credits: u.credits });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin/users', async (req, res) => {
  try {
    const token = req.query.token;
    if (!token || token !== ADMIN_TOKEN) return res.redirect('/admin/feedbacks');
    
    const result = await pool.query(`
      SELECT u.id, u.email, u.nom, u.plan, u.created_at, u.last_login,
        COALESCE(u.nb_analyses, 0) AS nb_analyses,
        COALESCE(u.credits, 0) AS credits,
        (SELECT COUNT(*) FROM projets WHERE user_email = u.email) AS nb_projets
      FROM users u
      ORDER BY u.created_at DESC
      LIMIT 200
    `);
    
    res.send(`
      <!DOCTYPE html>
      <html><head><meta charset="UTF-8"><title>Admin - Utilisateurs</title>
      <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:-apple-system,sans-serif;background:#f5f7fb;padding:20px}
        .container{max-width:1300px;margin:0 auto}
        header{background:linear-gradient(135deg,#1a2f28,#3d7a68);color:white;padding:30px;border-radius:16px;margin-bottom:24px}
        h1{font-size:26px}
        .section{background:white;padding:24px;border-radius:14px;box-shadow:0 2px 10px rgba(0,0,0,0.05);margin-bottom:20px}
        h2{font-size:18px;margin-bottom:18px}
        table{width:100%;border-collapse:collapse}
        th{background:#f5f7fb;padding:12px;text-align:left;font-size:12px;color:#5e6987;font-weight:600;border-bottom:2px solid #e8eef7;text-transform:uppercase}
        td{padding:10px 12px;border-bottom:1px solid #f0f3f8;font-size:13px;vertical-align:middle}
        tr:hover{background:#f8faff}
        .plan{display:inline-block;padding:3px 10px;border-radius:10px;font-size:11px;font-weight:600}
        .plan.gratuit{background:#e6f0ff;color:#0052cc}
        .plan.illimite{background:linear-gradient(135deg,#f0e6ff,#ffe6f5);color:#7c3aed}
        .credits-badge{display:inline-block;padding:3px 10px;border-radius:10px;font-size:12px;font-weight:700}
        .credits-ok{background:#e8f5f1;color:#2d7a58}
        .credits-zero{background:#fef2f2;color:#dc2626}
        .tabs{display:flex;gap:10px;margin-bottom:20px}
        .tab{padding:10px 20px;background:white;border:1px solid #e8eef7;border-radius:10px;font-weight:600;color:#5e6987;text-decoration:none}
        .tab.active{background:#3d7a68;color:white;border-color:#3d7a68}
        .credit-form{display:inline-flex;align-items:center;gap:6px}
        .credit-form input{width:52px;padding:4px 8px;border:1px solid #d0d8e8;border-radius:6px;font-size:12px;text-align:center}
        .credit-form select{padding:4px 6px;border:1px solid #d0d8e8;border-radius:6px;font-size:11px}
        .btn-credit{padding:4px 10px;background:#3d7a68;color:white;border:none;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer}
        .btn-credit:hover{background:#2d5e50}
        .toast{position:fixed;bottom:24px;right:24px;background:#1a2f28;color:white;padding:12px 20px;border-radius:10px;font-weight:600;font-size:14px;z-index:9999;display:none}
      </style></head>
      <body><div class="container">
        <header><h1>👥 Utilisateurs RénoExpert</h1><div style="font-size:13px;opacity:.8;margin-top:6px">${result.rows.length} comptes inscrits</div></header>
        <div class="tabs">
          <a href="/admin/feedbacks?token=${encodeURIComponent(token)}" class="tab">📋 Feedbacks</a>
          <a href="/admin/users?token=${encodeURIComponent(token)}" class="tab active">👥 Utilisateurs</a>
        </div>
        <div class="section">
          <h2>Liste des utilisateurs</h2>
          <table>
            <thead><tr>
              <th>Email</th><th>Nom</th><th>Plan</th>
              <th>Crédits</th>
              <th>Recharger</th>
              <th>Analyses IA</th><th>Projets</th><th>Inscrit</th><th>Dernière co.</th>
            </tr></thead>
            <tbody>
              ${result.rows.map(u => {
                const nbA = parseInt(u.nb_analyses || 0);
                const nbC = parseInt(u.credits || 0);
                let analysesClass = 'quota-ok';
                if (u.plan !== 'illimite') {
                  if (nbA >= LIMITE_ANALYSES_GRATUIT) analysesClass = 'quota-max';
                  else if (nbA >= LIMITE_ANALYSES_GRATUIT - 1) analysesClass = 'quota-warn';
                }
                return \`
                <tr>
                  <td><strong>\${u.email}</strong></td>
                  <td>\${u.nom || '-'}</td>
                  <td><span class="plan \${u.plan}">\${u.plan}</span></td>
                  <td>
                    <span class="credits-badge \${nbC > 0 ? 'credits-ok' : 'credits-zero'}" id="credits-\${u.id}">
                      \${u.plan === 'illimite' ? '∞' : nbC + ' cr.'}
                    </span>
                  </td>
                  <td>
                    \${u.plan !== 'illimite' ? \`
                    <div class="credit-form">
                      <select id="action-\${u.id}"><option value="add">+</option><option value="set">=</option></select>
                      <input type="number" id="nb-\${u.id}" value="3" min="0" max="100">
                      <button class="btn-credit" onclick="recharger('\${u.email}','\${u.id}')">✓</button>
                    </div>\` : '<span style="color:#9b8672;font-size:12px">—</span>'}
                  </td>
                  <td><span class="\${analysesClass}">\${nbA}\${u.plan !== 'illimite' ? ' / ' + LIMITE_ANALYSES_GRATUIT : ''}</span></td>
                  <td>\${u.nb_projets}</td>
                  <td>\${new Date(u.created_at).toLocaleDateString('fr-FR')}</td>
                  <td>\${u.last_login ? new Date(u.last_login).toLocaleDateString('fr-FR') : 'Jamais'}</td>
                </tr>
              \`;}).join('')}
            </tbody>
          </table>
        </div>
      </div>
      <div class="toast" id="toast"></div>
      <script>
      async function recharger(email, userId) {
        const action = document.getElementById('action-' + userId).value;
        const nb = parseInt(document.getElementById('nb-' + userId).value);
        if (isNaN(nb)) return;
        try {
          const r = await fetch('/api/admin/credits', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ token: '${token}', email, credits: nb, action })
          });
          const data = await r.json();
          if (data.success) {
            const badge = document.getElementById('credits-' + userId);
            if (badge) { badge.textContent = data.credits + ' cr.'; badge.className = 'credits-badge ' + (data.credits > 0 ? 'credits-ok' : 'credits-zero'); }
            const t = document.getElementById('toast');
            t.textContent = '✅ ' + data.email + ' → ' + data.credits + ' crédits';
            t.style.display = 'block';
            setTimeout(() => { t.style.display='none'; }, 3000);
          } else {
            alert('Erreur : ' + data.error);
          }
        } catch(e) { alert('Erreur réseau'); }
      }
      </script>
      </body></html>
    `);
  } catch (error) {
    res.status(500).send('Erreur: ' + error.message);
  }
});

app.get('/admin/feedbacks/export', async (req, res) => {
  try {
    const token = req.query.token;
    if (!token || token !== ADMIN_TOKEN) return res.status(401).send('Non autorisé');
    
    const result = await pool.query('SELECT * FROM feedbacks ORDER BY created_at DESC');
    let csv = 'Date,Heure,Mode,Note,Email,Localisation,Probleme\n';
    result.rows.forEach(f => {
      const d = new Date(f.created_at);
      csv += `${d.toLocaleDateString('fr-FR')},${d.toLocaleTimeString('fr-FR')},${f.mode || ''},${f.note},${f.user_email || ''},${f.location || ''},"${(f.probleme || '').replace(/"/g, '""')}"\n`;
    });
    
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="feedbacks-renoexpert.csv"');
    res.send('\uFEFF' + csv);
  } catch (error) {
    res.status(500).send('Erreur: ' + error.message);
  }
});

// ============================================================
// SAUVEGARDE AUTOMATIQUE DE LA BASE
// ============================================================
// Exporte toutes les données importantes en JSON.
// - Endpoint manuel : GET /admin/backup?token=ADMIN_TOKEN
// - Backup auto quotidien envoyé par email (pièce jointe)

// Génère un objet JSON avec toutes les tables (sauf les mots de passe en clair, déjà hashés)
// includePhotos = false : version LÉGÈRE (sans les photos base64) pour l'email (limite 20MB Brevo)
// includePhotos = true : version COMPLÈTE (avec photos) pour le téléchargement manuel
async function generateBackup(includePhotos = true) {
  const backup = {
    meta: {
      app: 'RénoExpert',
      generated_at: new Date().toISOString(),
      version: 'v3.16',
      photos_incluses: includePhotos
    },
    users: [],
    projets: [],
    feedbacks: []
  };

  // Users (on inclut le hash du mot de passe pour pouvoir restaurer les comptes,
  // mais PAS le mot de passe en clair qui n'existe nulle part de toute façon)
  const users = await pool.query(
    'SELECT id, email, nom, plan, nb_analyses, created_at, last_login FROM users ORDER BY id'
  );
  backup.users = users.rows;

  // Projets (le travail des agents : le plus important à ne pas perdre)
  const projets = await pool.query(
    'SELECT id, user_email, mode, titre, analysis, data, created_at FROM projets ORDER BY id'
  );

  if (includePhotos) {
    // Version complète : on garde tout (y compris photos base64)
    backup.projets = projets.rows;
  } else {
    // Version légère : on retire les photos base64 du champ data (trop lourdes pour l'email)
    backup.projets = projets.rows.map(p => {
      let data = p.data;
      if (data && typeof data === 'object' && data.photos) {
        const nbPhotos = Array.isArray(data.photos) ? data.photos.length : 0;
        // On remplace le tableau de photos par juste leur nombre (info conservée, poids retiré)
        data = { ...data, photos: undefined, _photos_count: nbPhotos, _photos_note: 'Photos exclues de la sauvegarde email (trop lourdes). Utilisez le backup manuel complet pour les récupérer.' };
      }
      return { ...p, data };
    });
  }

  // Feedbacks
  const feedbacks = await pool.query(
    'SELECT id, mode, note, probleme, location, user_email, created_at FROM feedbacks ORDER BY id'
  );
  backup.feedbacks = feedbacks.rows;

  backup.meta.counts = {
    users: backup.users.length,
    projets: backup.projets.length,
    feedbacks: backup.feedbacks.length
  };

  return backup;
}

// Envoie un email avec le backup JSON en pièce jointe (via Brevo)
async function sendBackupEmail(backup) {
  if (!BREVO_API_KEY) {
    console.log('⚠️ BREVO_API_KEY non configurée, backup email non envoyé');
    return false;
  }
  if (!NOTIFICATION_EMAIL) {
    console.log('⚠️ NOTIFICATION_EMAIL non configuré, backup email non envoyé');
    return false;
  }

  const dateStr = new Date().toISOString().split('T')[0];
  const jsonContent = JSON.stringify(backup, null, 2);
  const base64Content = Buffer.from(jsonContent, 'utf-8').toString('base64');
  const c = backup.meta.counts;

  // Protection : si malgré tout le backup dépasse ~18 Mo, on n'envoie pas la pièce jointe
  // (limite Brevo = 20 Mo, on garde une marge de sécurité)
  const sizeMB = Buffer.byteLength(base64Content, 'utf-8') / (1024 * 1024);
  const tropGros = sizeMB > 18;

  const htmlContent = `
    <div style="font-family: -apple-system, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #0F1F3D;">💾 Sauvegarde RénoExpert du ${dateStr}</h2>
      <p style="color: #5e6987; font-size: 14px; line-height: 1.6;">
        Voici la sauvegarde automatique de votre base de données${tropGros ? '' : ', en pièce jointe (format JSON)'}.
        ${backup.meta.photos_incluses ? '' : '<br><em>(Photos exclues pour respecter la limite de taille des emails. Pour une sauvegarde complète avec photos, utilisez le téléchargement manuel.)</em>'}
      </p>
      <div style="background: #f5f7fb; border-radius: 10px; padding: 16px; margin: 16px 0;">
        <strong style="color: #0F1F3D;">Contenu :</strong><br>
        👤 ${c.users} utilisateur(s)<br>
        📁 ${c.projets} projet(s) sauvegardé(s)<br>
        💬 ${c.feedbacks} feedback(s)
      </div>
      ${tropGros ? `<p style="background:#fff3e0;color:#c2410c;padding:12px;border-radius:8px;font-size:13px;">⚠️ La sauvegarde dépasse la taille maximale d'un email (${sizeMB.toFixed(1)} Mo). Téléchargez-la manuellement via le lien admin de sauvegarde.</p>` : ''}
      <p style="color: #97a3bd; font-size: 12px; line-height: 1.5;">
        🛡️ Conservez cet email. En cas de panne de Railway, ce fichier permet de restaurer vos données.<br>
        Cette sauvegarde est générée automatiquement chaque nuit.<br>
        ℹ️ Le fichier joint est au format .txt (contenu JSON) — vous pouvez l'ouvrir avec n'importe quel éditeur de texte.
      </p>
    </div>
  `;

  try {
    const emailBody = {
      sender: { name: 'RénoExpert Backup', email: 'baglieriyoann@gmail.com' },
      to: [{ email: NOTIFICATION_EMAIL }],
      subject: `💾 Sauvegarde RénoExpert - ${dateStr}`,
      htmlContent
    };
    // On joint le fichier seulement s'il n'est pas trop gros
    if (!tropGros) {
      emailBody.attachment = [{
        content: base64Content,
        name: `renoexpert-backup-${dateStr}.txt`
      }];
    }

    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': BREVO_API_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify(emailBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Erreur envoi backup email:', errorText);
      return false;
    }
    console.log(`✅ Backup email envoyé à ${NOTIFICATION_EMAIL} (${c.users} users, ${c.projets} projets, ${sizeMB.toFixed(1)} Mo${tropGros ? ' — pièce jointe omise car trop lourde' : ''})`);
    return true;
  } catch (err) {
    console.error('❌ Erreur envoi backup email:', err.message);
    return false;
  }
}

// Endpoint de téléchargement manuel du backup (protégé par ADMIN_TOKEN)
app.get('/admin/backup', async (req, res) => {
  const token = req.query.token;
  if (token !== ADMIN_TOKEN) {
    return res.status(403).json({ error: 'Accès refusé' });
  }
  try {
    const backup = await generateBackup(true); // version COMPLÈTE avec photos
    const dateStr = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="renoexpert-backup-${dateStr}.json"`);
    res.send(JSON.stringify(backup, null, 2));
  } catch (error) {
    console.error('Erreur backup manuel:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint pour déclencher manuellement un backup PAR EMAIL (protégé par ADMIN_TOKEN)
app.get('/admin/backup/email', async (req, res) => {
  const token = req.query.token;
  if (token !== ADMIN_TOKEN) {
    return res.status(403).json({ error: 'Accès refusé' });
  }
  try {
    const backup = await generateBackup(false); // version LÉGÈRE sans photos (email)
    const sent = await sendBackupEmail(backup);
    if (sent) {
      res.json({ success: true, message: `Backup envoyé à ${NOTIFICATION_EMAIL}`, counts: backup.meta.counts });
    } else {
      res.status(500).json({ error: 'Échec envoi email (vérifiez BREVO_API_KEY et NOTIFICATION_EMAIL)' });
    }
  } catch (error) {
    console.error('Erreur backup email manuel:', error);
    res.status(500).json({ error: error.message });
  }
});

// Scheduler : backup automatique quotidien
// On vérifie toutes les heures s'il est temps de faire le backup (cible : ~3h du matin).
let lastBackupDate = null;
async function checkAndRunDailyBackup() {
  try {
    const now = new Date();
    const hour = now.getHours();
    const today = now.toISOString().split('T')[0];

    // Déclenche entre 3h et 4h du matin, une seule fois par jour
    if (hour === 3 && lastBackupDate !== today) {
      lastBackupDate = today;
      console.log('🕒 Déclenchement du backup quotidien automatique...');
      const backup = await generateBackup(false); // version LÉGÈRE sans photos (email)
      await sendBackupEmail(backup);
    }
  } catch (err) {
    console.error('❌ Erreur backup auto:', err.message);
  }
}
// Vérifie toutes les heures
setInterval(checkAndRunDailyBackup, 60 * 60 * 1000);
// Vérifie aussi une fois au démarrage (au cas où le serveur redémarre à 3h)
setTimeout(checkAndRunDailyBackup, 30 * 1000);

// ============================================================
// DÉMARRAGE
// ============================================================

app.listen(PORT, () => {
  console.log(`🚀 RénoExpert Backend v3.3 lancé sur le port ${PORT}`);
  console.log(`🗄️ PostgreSQL : ${process.env.DATABASE_URL ? 'connecté' : '⚠️ NON CONFIGURÉ'}`);
  console.log(`📧 Brevo : ${BREVO_API_KEY ? 'configuré' : '⚠️ NON CONFIGURÉ'}`);
  console.log(`👑 Admin email : ${ADMIN_EMAIL || '⚠️ NON CONFIGURÉ'}`);
  console.log(`🔑 Admin token : ${ADMIN_TOKEN === 'admin123' ? '⚠️ Token par défaut' : '✅ configuré'}`);
  console.log(`💾 Backup auto : quotidien à 3h → ${NOTIFICATION_EMAIL || '⚠️ NOTIFICATION_EMAIL non configuré'}`);
});
