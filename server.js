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

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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
  limits: { fileSize: 10 * 1024 * 1024 }
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
const LIMITE_ANALYSES_GRATUIT = 5;

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

// Middleware pour vérifier l'authentification
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.body.token || req.query.token;
  
  if (!token) {
    return res.status(401).json({ error: 'Non authentifié', code: 'NO_TOKEN' });
  }
  
  try {
    const result = await pool.query(
      'SELECT id, email, nom, plan, nb_analyses FROM users WHERE session_token = $1 AND session_expires > NOW()',
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
// Vérifie le quota d'analyses AVANT l'appel à l'IA (à utiliser comme middleware).
// Bloque l'utilisateur gratuit s'il a déjà atteint 5 analyses.
// L'admin ('illimite') passe toujours.
async function checkAnalysesQuota(req, res, next) {
  if (req.user.plan === 'illimite') {
    return next();
  }
  const nbAnalyses = parseInt(req.user.nb_analyses || 0);
  if (nbAnalyses >= LIMITE_ANALYSES_GRATUIT) {
    return res.status(403).json({
      error: `Limite atteinte : ${LIMITE_ANALYSES_GRATUIT} analyses IA gratuites utilisées. Contactez-nous pour passer en Pro.`,
      code: 'ANALYSES_QUOTA_EXCEEDED',
      quota: {
        utilises: nbAnalyses,
        limite: LIMITE_ANALYSES_GRATUIT,
        illimite: false
      }
    });
  }
  next();
}

// Incrémente le compteur d'analyses APRÈS un appel IA réussi.
// Ne bloque jamais : si l'incrément échoue, on logue et on continue (l'analyse a déjà été facturée à toi côté Anthropic).
async function incrementAnalysesCounter(userId) {
  try {
    await pool.query(
      'UPDATE users SET nb_analyses = COALESCE(nb_analyses, 0) + 1 WHERE id = $1',
      [userId]
    );
  } catch (err) {
    console.error('⚠️ Erreur incrément nb_analyses pour user', userId, ':', err.message);
  }
}

// ============================================================
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
      `INSERT INTO users (email, password_hash, nom, plan, session_token, session_expires, last_login) 
       VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING id, email, nom, plan`,
      [emailClean, passwordHash, nom || '', plan, sessionToken, sessionExpires]
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
      user: { id: user.id, email: user.email, nom: user.nom, plan: user.plan }
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
      'SELECT id, email, password_hash, nom, plan FROM users WHERE email = $1',
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
      user: { id: user.id, email: user.email, nom: user.nom, plan: userPlan }
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
  // Compter aussi les projets (pour info, plus pour quota)
  const countResult = await pool.query(
    'SELECT COUNT(*) FROM projets WHERE user_email = $1',
    [req.user.email]
  );
  
  const nbProjets = parseInt(countResult.rows[0].count);
  const nbAnalyses = parseInt(req.user.nb_analyses || 0);
  const limite = req.user.plan === 'illimite' ? null : LIMITE_ANALYSES_GRATUIT;
  
  res.json({
    success: true,
    user: req.user,
    quota: {
      utilises: nbAnalyses,
      limite: limite,
      illimite: req.user.plan === 'illimite',
      type: 'analyses',
      nb_projets: nbProjets
    }
  });
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

  reparation: `Tu es un expert bâtiment français senior avec 20 ans d'expérience terrain. Diagnostique le problème montré sur les photos et donne une procédure de réparation claire pour un particulier.

RÈGLES STRICTES :
- N'utilise JAMAIS le mot "DIY". Utilise : "à faire soi-même", "faire faire par un artisan", "bricoleur confirmé", "bricoleur débutant"
- Sois TRÈS précis sur les quantités, dimensions, dosages
- Insiste sur l'aspiration aux ÉTAPES MAJEURES du chantier (point essentiel pour la qualité). Ne JAMAIS écrire "à chaque coupe" ou "après chaque découpe".
- Mentionne la vérification d'alignement (règle ou laser) au fur et à mesure
- Donne des prix réalistes 2026
- Aére tes textes : des paragraphes COURTS (max 3-4 lignes par paragraphe), pas de blocs denses
- Termine TOUJOURS par un tableau récapitulatif des coûts détaillé
- FORMULATION POSITIVE OBLIGATOIRE : donne les instructions directement, sans expliquer ni justifier les règles internes. INTERDIT d'écrire dans le PDF :
  * « Le rampant ne se carrelle pas » → écrire « Le rampant reçoit un enduit de lissage puis 2 couches de peinture »
  * « Aspirer en fin de séance, pas à chaque coupe » → écrire « Aspirez la zone de coupe en fin de séance »
  * « Ne pas retirer les croisillons avant 24h » → écrire « Laissez les croisillons en place jusqu'au séchage complet (24-48h), retrait au moment du jointoiement »
  Le client final lit le document : il veut des consignes claires, pas des justifications de règles métier.

CONNAISSANCES TECHNIQUES CARRELAGE :
- Ragréage : 1.7 kg/m²/mm d'épaisseur
- Colle carrelage C2 : 1 sac 25kg pour 5 m² (simple encollage) ou 4 m² (double encollage pour grands formats > 30x30 cm)
- Joints carrelage : 5 kg pour 10 m²
- PEIGNE DENTÉ (valeurs par défaut terrain à utiliser sauf format hors normes) :
  * MUR : 8 mm (idéal, surtout pour faïence et travertin standard)
  * SOL : 8 à 10 mm selon format
  * Mosaïque/petits formats : 4-6 mm uniquement
- JOINTS classiques par défaut : 3 mm (pas 2 mm — trop fin pour le standard, sauf demande mosaïque ou rectifié spécifique)
- CROISILLONS : à laisser en place JUSQU'AU SÉCHAGE COMPLET de la colle (24-48h). NE JAMAIS conseiller de "sortir les croisillons après 2h" — on ne marche pas sur un sol fraîchement carrelé. Les croisillons se retirent juste avant le jointoiement, sol et murs ensemble.
- ORDRE DE POSE : 1) Carrelage AVEC plinthes ensemble (collées à la colle carrelage), 2) Joints simultanés sol + plinthes
- Kit jointoiement (~30€, finition impeccable) : taloche caoutchouc, éponge spéciale joints, seau à rouleaux essoreurs
- Outillage : scie trépan carrelage sur disqueuse, couteau enduire ou disqueuse 12V pour gratter surplus colle
- ASPIRATION à chaque étape MAJEURE du chantier (fin de démolition, avant collage, avant peinture). NE JAMAIS écrire "aspirez après chaque coupe" ni "à chaque découpe" — perte de temps inutile sur chantier. La scie à eau capte la poussière, et un nettoyage en fin de phase suffit.
- Vérification alignement règle/laser au fur et à mesure

CONNAISSANCES TECHNIQUES PLACO/ISOLATION/CLOISONS :
- Règle de la lame d'air : Rail au sol/plafond = Épaisseur isolant + 1 cm de retrait du mur (lame d'air 1cm)
- Exemple : isolant 10 cm -> rail à 11 cm du mur
- Épaisseur isolant MINIMUM aujourd'hui : 10 cm (idéal pour les performances thermiques actuelles)
- Montants tous les 60 cm max
- Découper rouleaux laine en deux si entraxe 60 cm
- GAINES TECHNIQUES : passer TOUTES les gaines DERRIÈRE la laine de verre, puis les faire RESSORTIR à travers la laine en pratiquant un PETIT TROU que l'on vient étancher proprement
- Joints placo (cycle strict) : 
  1) Rebouchage MAP sur les têtes de vis ISOLÉES UNIQUEMENT (vis en plein milieu des plaques, hors axes des bandes)
  2) PAS de MAP sur les vis dans l'axe des bandes de joints (elles seront chargées et noyées lors de l'application de la bande)
  3) Gratter J+1
  4) Coller bande + enduit (sécher complètement)
  5) Deuxième passe charge (sécher)
  6) Passe finition (sécher)
  7) 4e passe si imperfection
- Avant peinture : ponçage général + aspiration + dépoussiérage murs au balai serpillière humide

CONNAISSANCES PLAFONDS/SOUS-SOLS :
- Le plafond se fait TOUJOURS en premier (avant doublages/cloisons)
- Toujours sur structure métallique
- ATTENTION distinction critique :
  * Plafond BOIS (poutres) : suspentes + fourrures
  * Plafond BÉTON (dalle, ourdis/entrevous) : cavaliers pivot + tiges filetées + clips fourrures (JAMAIS de suspentes sur béton)
- Pour béton/ourdis : utiliser fixations spéciales adaptées au matériau pour les tiges filetées
- Passer TOUS les réseaux plafond (spots, dérivations, plomberie) AVANT fermeture

CHRONOLOGIE GÉNÉRALE TRAVAUX :
- Analyse + calepinage FIGÉ en premier (surtout cuisine/SdB)
- Démolition + mise à nu (mobilier, sanitaires, papier peint, faïence, placo pourri)
- Ordre obligatoire de reconstruction : 1) PLAFOND, 2) MURS (cloisons+doublages), 3) SOL (ragréage puis revêtement)
- Blocs-portes posés en même temps que ferraille
- Avoir TOUTES les fiches techniques équipements AVANT chantier (sorties au mm près)

ANCIEN CARRELAGE IMPOSSIBLE À DÉPOSER (3 options) :
- Ragréer/enduire directement dessus
- Contre-cloison ossature métallique
- Coller nouvelles plaques de plâtre

ORDRE PEINTURE / SOLS - RÈGLE CAPITALE :
- Si parquet (bois/PVC/stratifié) : Peinture COMPLÈTE d'abord (sous-couche + 2 couches finition), parquet en DERNIER
- Si carrelage : Carrelage + joints + plinthes EN PREMIER, protection bâche/carton, PUIS peinture (interdit de peindre avant carrelage)
- Ragréage TOUJOURS avant peinture (sinon projections sur murs finis)

BÂTI ANCIEN / HUMIDITÉ :
- Toujours anticiper imprévus (murs hors plomb, humidité, supports hétérogènes)
- Fournisseur pro recommandé : Lanko / Parexlanko
- HIVER : déshumidificateur chantier OBLIGATOIRE (centrale absorption 200-300€)
- Chauffage constant en finitions
- Risques hygrométrie élevée : coulures peinture, séchage bloqué, perte adhérence, moisissures

FORMATION RECOMMANDÉE :
- Chaîne YouTube "Taka Yaka" pour bases (placo, ratissage, enduits)

CONNAISSANCES ÉLECTRICITÉ / CONSUEL (à utiliser si pertinent) :
- Le Consuel n'est PAS obligatoire en rénovation si l'électricité est déjà existante et active dans la maison
- Le Consuel est obligatoire UNIQUEMENT pour la création complète d'une nouvelle ligne (nouveau raccordement) ou une modification lourde de la distribution générale
- Un particulier compétent en électricité peut réaliser ses travaux de rénovation seul, sans démarche Consuel
- La norme NF C 15-100 doit être respectée mais ne nécessite pas de certification en rénovation simple
- Pour des spots, prises ou interrupteurs en rénovation : pas d'obligation légale de faire intervenir un artisan certifié
- Recommander un artisan UNIQUEMENT si le client n'a pas les compétences électriques (sécurité avant tout)

═══════════════════════════════════════════════════════════
SPÉCIALITÉ SALLE DE BAIN (connaissances terrain consolidées)
═══════════════════════════════════════════════════════════

RAMPANTS EN SDB SOUS COMBLES (RÈGLE NON NÉGOCIABLE, NE PAS EXPLICITER DANS LE PDF) :
- Règle interne (ne pas écrire) : un rampant incliné ne reçoit jamais de carrelage. Même demande client "carrelage partout" → rampant en peinture.
- Formulation à utiliser dans le PDF (positive et directe) : « Le rampant reçoit un enduit de lissage, une sous-couche puis 2 couches de peinture spéciale pièce humide ».
- INTERDIT d'écrire "le rampant ne se carrelle pas", "le carrelage sur rampant n'est pas recommandé", ou toute négation justifiant la règle.
- Ne JAMAIS proposer de colle C2 TE anti-glissement "pour rampant".

PONÇAGE DES ENDUITS DE LISSAGE :
- Grain par défaut pour la finition avant peinture : 150 ou 180 (jamais 80, qui laisse des rayures sous peinture)
- 80 grains uniquement pour décape grossier ou ponçage de gros plâtre de rebouchage
- 120 grains acceptable en transition (rebouchage → finition)

PEINTURE SDB (FINITIONS) :
- Critère unique = "peinture spéciale pièce humide / salle de bain" (mention sur le pot, résistance à l'humidité + anti-moisissures)
- Finition au choix client : mat, velours OU satin — les 3 sont aujourd'hui disponibles en formulation SDB
- Ne plus imposer "satinée" par défaut. Proposer le mat ou velours en finition élégante, le satin si lessivage fréquent souhaité
- Sous-couche acrylique d'accroche systématique en première passe

CHRONOLOGIE D'EXÉCUTION SDB (ordre obligatoire) :
1. Calepinage initial : position définitive au mm près de chaque sanitaire et meuble
2. Dépose / mise à nu (voir règles démolition ci-dessous)
3. Intervention plombier + électricien selon calepinage figé
4. Contre-cloisons techniques si l'encastrement direct est impossible (ossature rail sol/plafond + montants + plaque hydrofuge devant le mur d'origine pour passage tuyaux + gaines)
5. Cloisons de distribution après validation des réseaux
6. Pose du bac à douche
7. Système d'étanchéité liquide (SEL)
8. RÈGLE DE L'ART CRUCIALE : SOL AVANT FAÏENCE MURALE. Quel que soit le revêtement de sol (carrelage neuf ou PVC/parquet), il faut IMPÉRATIVEMENT poser le sol AVANT la faïence. La faïence vient recouvrir proprement les coupes périphériques du sol pour une finition parfaite.
9. Joints de l'ensemble des revêtements
10. Peinture en TOUTE FIN

DÉMOLITION / DÉPOSE SPÉCIFIQUE SDB :
- Murs : démontage INTÉGRAL du carrelage mural + dépose absolue de TOUS sanitaires et mobiliers
- Sol : la dépose du carrelage de sol n'est PAS obligatoire. Si l'ancien carrelage est très bien collé, le LAISSER en place (sinon on risque d'arracher la chape → reprise complète très coûteuse)
- Démontage carrelage de sol (si dépose nécessaire) : MARTEAU-PIQUEUR uniquement. Ne PAS recommander disqueuse + burin pour le sol, c'est inadapté.
- Décollage papier peint : le grattage à l'eau chaude ne fonctionne PAS à tous les coups. Deux méthodes efficaces :
  * Pulvérisateur avec mélange eau + produit spécial décollage (type Leroy Merlin)
  * Décolleuse à vapeur (eau chaude) : disponible à la location, économique, beaucoup plus rapide

POSE SUR ANCIEN CARRELAGE CONSERVÉ (sol SDB) :
- Scénario A — Nouveau carrelage : 1) Primaire d'accrochage spécial, 2) Colle Flex, 3) Joints
- Scénario B — Sol PVC/parquet : 1) Nettoyage + planéité validée, 2) Sous-couche technique, 3) Pose
- VIGILANCE CRUCIALE :
  * Vérifier scrupuleusement la tenue de l'ancien carrelage. S'il bouge → démontage obligatoire au marteau-piqueur.
  * Respecter strictement les temps de séchage du primaire. Impossible de laisser l'accrocheur à nu et de coller une semaine plus tard.
- Règle ragréage : si sol parfaitement droit, propre et ancien carrelage stable, le ragréage N'EST PAS nécessaire. Collage direct possible avec primaire + colle Flex.

ÉTANCHÉITÉ BAC À DOUCHE À CARRELER (CRITIQUE) :
- Marque unique OBLIGATOIRE : pour conserver les garanties fabricant, utiliser le kit d'étanchéité de la MÊME marque que le bac (ex : bac Wedi → étanchéité Wedi, bac Schlüter → kit Schlüter)
- Calage du bac : soutien structurel du dessous à l'aide de morceaux de carreaux de plâtre. Ménage l'espace nécessaire au passage des tuyaux d'évacuation (bonde, vidage) et alimentations.
- Mise en œuvre étanchéité : primaire d'accrochage + IMPÉRATIVEMENT 2 PASSES de produit d'étanchéité (respect rigoureux du séchage entre couches)
- Bandes de pontage dans TOUS les angles rentrants (sol/mur ET mur/mur), noyées dans la première couche
- Hauteur murs douche : 1,80 m minimum

CALEPINAGE CARRELAGE SOL (règle stricte) :
- Petite pièce : INTERDICTION de commencer la pose au milieu de la pièce
- Calepinage précis amont : mesures, présentation à blanc, vérification des coupes
- AUCUNE petite coupe ne doit se retrouver au niveau de la sortie devant la porte
- Sens de progression : commencer l'encollage et la pose par le FOND de la pièce, puis reculer progressivement vers la sortie. Le calepinage initial garantit que le morceau final devant la porte a la bonne taille.

NETTOYAGE COLLE CARRELAGE (chantier propre) :
- La colle fraîche se nettoie EXCLUSIVEMENT à l'eau
- Ne JAMAIS aspirer la colle fraîche : cela bouche immédiatement l'appareil
- Nettoyage AU FUR ET À MESURE de la pose. Si on laisse sécher au lendemain, le retrait devient extrêmement compliqué.

JOINTS FAÏENCE + SILICONE SANITAIRE :
- Joints sur la faïence : partout y compris dans les angles intérieurs sur le mur
- Joint Flex OBLIGATOIRE. Éviter absolument le joint époxy (trop dur à poser pour un particulier)
- Sur bac à carreler, le joint ciment Flex tient parfaitement dans les angles intérieurs car le receveur ne bouge pas
- Silicone paroi de douche vitrée :
  * Cordon de silicone DERRIÈRE le rail de fixation AVANT de le plaquer et le visser au mur
  * Joint silicone visible UNIQUEMENT en bas de la vitre, à l'EXTÉRIEUR de la douche
- Silicone bac de douche en dur (résine blanche) :
  * Joint silicone en bas UNIQUEMENT si le receveur est parfaitement stable et ne bouge pas
  * Si produit premier prix souple qui a tendance à bouger : adapter l'application (jeu de dilatation)

MÉTHODOLOGIE PEINTURE SDB (procédure exacte) :
1. Chantier global fini → aspiration intégrale + nettoyage de fond en comble UNE bonne fois
2. Protection intégrale : poser TOUTES les bâches et TOUS les scotchs de masquage nécessaires
3. Sous-couche classique partout sur les murs
4. DEUX couches de finition
5. RÈGLE STRICTE : on NE RETIRE PAS les bâches/scotchs entre les couches. Les protections restent en place tout le long, aucun nettoyage intermédiaire.
6. Repli de chantier : peinture terminée → enlever bâches + scotchs + poubelle, nettoyage complet, livraison

MONTAGE FINAL ÉQUIPEMENTS SDB (après peinture, dans cet ordre) :
1. Sanitaires et robinetterie : colonne de douche, robinets, mitigeurs
2. Aménagement : paroi de douche, meuble SDB, miroir
3. Chauffage : sèche-serviette
4. Finitions étanches : application de TOUS les joints silicone sanitaire d'étanchéité
5. Dernier coup de propre général, chantier livré terminé

═══════════════════════════════════════════════════════════

FORMAT DE RÉPONSE (RESPECTE STRICTEMENT CE FORMAT) :

# Diagnostic

## Problème identifié
[3-4 lignes max, points clés en liste si pertinent]

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
- [Liste avec quantités précises selon surface]

## Étapes détaillées

### Étape 1 : [Titre court]
[2-4 phrases courtes. Mentionner aspiration et alignement.]

### Étape 2 : [Titre court]
[2-4 phrases courtes]

[Continuer jusqu'à 6-8 étapes max]

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

> Conseil pratique : [Un conseil clé pour réussir]

INSTRUCTION FINALE : Sois pédagogue, accessible, ULTRA-PRÉCIS sur les quantités et prix. Aére tes textes au maximum. Le lecteur est un particulier qui veut comprendre et réussir.`,

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
- À Margny-lès-Compiègne (60880), le prix moyen actuel des MAISONS est de 2 502 €/m² (source meilleursagents.com). Utilise CE chiffre comme pivot, pas une fourchette inventée.
- Donne ensuite une fourchette resserrée autour de ce pivot : -10 % (prix bas vente rapide) / pivot (prix juste) / +10 % (prix haut, bien optimisé).
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
[Mention "Tarifs travaux : estimations indicatives marché Hauts-de-France 2025 — non contractuels, devis artisans à confirmer." + "Source prix m² : meilleursagents.com." + si DPE manquant : "Le DPE peut être ajouté plus tard et la fiche sera régénérée."]`,

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
[Justification]`
};

// ============================================================
// HEALTH CHECK
// ============================================================

app.get('/', (req, res) => {
  res.json({ status: 'RénoExpert Backend v3.3 - Online' });
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
  if (hasAnyComment) {
    content.push({
      type: 'text',
      text: "Chaque photo ci-dessous est précédée d'un libellé « Photo N ». Quand l'utilisateur a ajouté une annotation pour une photo, elle apparaît juste avant l'image (« Annotation utilisateur »). Ces annotations expriment l'intention/le projet pour la zone visible (ex : « agrandir cette chambre en deux ») — tu DOIS en tenir compte explicitement dans l'analyse de cette photo, chiffrer si c'est un projet de travaux, et le restituer dans le rapport."
    });
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

app.post('/api/analyze/visite', aiLimiter, requireAuth, checkAnalysesQuota, upload.fields([{ name: 'photos', maxCount: 20 }, { name: 'dpe', maxCount: 1 }]), async (req, res) => {
  try {
    const { surface, location, precisions, visite_type, prix_achat, loyer_vise, regime_fiscal } = req.body;
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
    context += '\n' + precisionsBlock(precisions);
    const prompt = isLocatif ? PROMPTS.visite_locatif : PROMPTS.visite;
    const photoComments = parsePhotoComments(req.body.comments);
    const analysis = await analyzeWithClaude(prompt, photos, context, dpeFiles, photoComments);
    await incrementAnalysesCounter(req.user.id);
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
    await incrementAnalysesCounter(req.user.id);
    res.json({ success: true, analysis });
  } catch (error) {
    console.error('Erreur reparation:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/analyze/agent', aiLimiter, requireAuth, checkAnalysesQuota, upload.fields([{ name: 'photos', maxCount: 30 }, { name: 'dpe', maxCount: 1 }]), async (req, res) => {
  try {
    const { surface, location, agence_nom, agent_nom, precisions, plus_values } = req.body;
    const photos = (req.files && req.files.photos) || [];
    const dpeFiles = (req.files && req.files.dpe) || [];
    if (photos.length === 0) return res.status(400).json({ error: 'Aucune photo' });
    const dpeNote = dpeFiles.length > 0
      ? `\nUn DPE du bien est joint à cette requête (document avant les photos). Lis-le attentivement et utilise SES VALEURS RÉELLES — pas d'estimation.\n`
      : `\nAucun DPE fourni à ce stade — précise dans la fiche "(estimé)" pour les données énergie/GES et indique en notes finales que le DPE peut être ajouté ultérieurement et la fiche régénérée.\n`;
    const pvBlock = plus_values && plus_values.trim()
      ? `\nPlus-values cochées par l'agent (à intégrer EXPLICITEMENT dans Atouts + à chiffrer dans Prix de marché) :\n${plus_values.trim()}\n`
      : '';
    const context = `Surface : ${surface} m²\nLocalisation : ${location}\nAgence : ${agence_nom}\nAgent : ${agent_nom}\n${dpeNote}${pvBlock}\n` + precisionsBlock(precisions);
    const photoComments = parsePhotoComments(req.body.comments);
    const analysis = await analyzeWithClaude(PROMPTS.agent, photos, context, dpeFiles, photoComments);
    await incrementAnalysesCounter(req.user.id);
    res.json({ success: true, analysis, agence_nom, agent_nom, dpe_fourni: dpeFiles.length > 0 });
  } catch (error) {
    console.error('Erreur agent:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/analyze/marchand', aiLimiter, requireAuth, checkAnalysesQuota, upload.fields([{ name: 'photos', maxCount: 50 }, { name: 'dpe', maxCount: 1 }]), async (req, res) => {
  try {
    const { surface, prix_demande, location, strategie, nb_lots, annee_construction, mb_societe, precisions } = req.body;
    const photos = (req.files && req.files.photos) || [];
    const dpeFiles = (req.files && req.files.dpe) || [];
    if (photos.length === 0) return res.status(400).json({ error: 'Aucune photo' });
    const dpeNote = dpeFiles.length > 0
      ? `\nDPE joint — utilise SES VALEURS RÉELLES (classe, kWh/m²/an, GES) et chiffre le coût de rénovation énergétique pour atteindre la classe B ou C visée MB.\n`
      : `\nAucun DPE fourni — estime la classe probable d'après les photos et l'année de construction.\n`;
    const context = `Société MB : ${mb_societe}
Localisation : ${location}
Surface : ${surface} m²
Année construction : ${annee_construction}
Prix demandé : ${prix_demande} €
Stratégie : ${strategie}
Nombre de lots envisagés : ${nb_lots}
${dpeNote}
IMPORTANT : Frais notaire MB = 3% du prix d'achat (article 1115 CGI)

` + precisionsBlock(precisions);
    const photoComments = parsePhotoComments(req.body.comments);
    const analysis = await analyzeWithClaude(PROMPTS.marchand, photos, context, dpeFiles, photoComments);
    await incrementAnalysesCounter(req.user.id);
    const frais_notaire_mb_3pct = Math.round(parseFloat(prix_demande) * 0.03);
    res.json({ success: true, analysis, frais_notaire_mb_3pct });
  } catch (error) {
    console.error('Erreur marchand:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ROUTES D'AFFINEMENT (sans photos, sur la base d'une analyse précédente)
// ============================================================

app.post('/api/refine/visite', aiLimiter, requireAuth, checkAnalysesQuota, async (req, res) => {
  try {
    const { previousAnalysis, instructions, surface, location } = req.body;
    if (!previousAnalysis || !instructions) return res.status(400).json({ error: 'previousAnalysis et instructions requis' });
    const context = `Surface : ${surface || 'non précisée'} m²\nLocalisation : ${location || 'non précisée'}\n\n`;
    const analysis = await refineWithClaude(PROMPTS.visite, previousAnalysis, instructions, context);
    await incrementAnalysesCounter(req.user.id);
    res.json({ success: true, analysis });
  } catch (error) {
    console.error('Erreur refine visite:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/refine/reparation', aiLimiter, requireAuth, checkAnalysesQuota, async (req, res) => {
  try {
    const { previousAnalysis, instructions, description } = req.body;
    if (!previousAnalysis || !instructions) return res.status(400).json({ error: 'previousAnalysis et instructions requis' });
    const context = description ? `Description initiale : ${description}\n\n` : '';
    const analysis = await refineWithClaude(PROMPTS.reparation, previousAnalysis, instructions, context);
    await incrementAnalysesCounter(req.user.id);
    res.json({ success: true, analysis });
  } catch (error) {
    console.error('Erreur refine reparation:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/refine/agent', aiLimiter, requireAuth, checkAnalysesQuota, async (req, res) => {
  try {
    const { previousAnalysis, instructions, surface, location, agence_nom, agent_nom } = req.body;
    if (!previousAnalysis || !instructions) return res.status(400).json({ error: 'previousAnalysis et instructions requis' });
    const context = `Surface : ${surface} m²\nLocalisation : ${location}\nAgence : ${agence_nom}\nAgent : ${agent_nom}\n\n`;
    const analysis = await refineWithClaude(PROMPTS.agent, previousAnalysis, instructions, context);
    await incrementAnalysesCounter(req.user.id);
    res.json({ success: true, analysis, agence_nom, agent_nom });
  } catch (error) {
    console.error('Erreur refine agent:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/refine/marchand', aiLimiter, requireAuth, checkAnalysesQuota, async (req, res) => {
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
    await incrementAnalysesCounter(req.user.id);
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
    const { mode, titre, analysis, data } = req.body;
    
    if (!mode || !analysis) {
      return res.status(400).json({ error: 'Données manquantes' });
    }
    
    // ✅ Sauvegardes ILLIMITÉES pour tout le monde (aucun coût Anthropic, seulement du stockage)
    // Le quota s'applique uniquement aux analyses IA, pas aux sauvegardes.
    
    const result = await pool.query(
      `INSERT INTO projets (user_id, user_email, mode, titre, analysis, data) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [req.user.email, req.user.email, mode, titre || `Projet ${mode}`, analysis, JSON.stringify(data || {})]
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
      `SELECT id, mode, titre, analysis, data, created_at 
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
      location: (p.data && p.data.location) || '',
      surface: (p.data && p.data.surface) || '',
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
// PDF ROUTES (avec design pro v3.4)
// ============================================================

app.post('/api/pdf/visite', generalLimiter, requireAuth, async (req, res) => {
  try {
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
app.get('/admin/users', async (req, res) => {
  try {
    const token = req.query.token;
    if (!token || token !== ADMIN_TOKEN) return res.redirect('/admin/feedbacks');
    
    const result = await pool.query(`
      SELECT u.id, u.email, u.nom, u.plan, u.created_at, u.last_login,
        COALESCE(u.nb_analyses, 0) AS nb_analyses,
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
        .container{max-width:1200px;margin:0 auto}
        header{background:linear-gradient(135deg,#0066ff,#4d94ff);color:white;padding:30px;border-radius:16px;margin-bottom:24px}
        h1{font-size:26px}
        .section{background:white;padding:24px;border-radius:14px;box-shadow:0 2px 10px rgba(0,0,0,0.05);margin-bottom:20px}
        h2{font-size:18px;margin-bottom:18px}
        table{width:100%;border-collapse:collapse}
        th{background:#f5f7fb;padding:12px;text-align:left;font-size:12px;color:#5e6987;font-weight:600;border-bottom:2px solid #e8eef7;text-transform:uppercase}
        td{padding:12px;border-bottom:1px solid #f0f3f8;font-size:14px}
        tr:hover{background:#f8faff}
        .plan{display:inline-block;padding:3px 10px;border-radius:10px;font-size:11px;font-weight:600}
        .plan.gratuit{background:#e6f0ff;color:#0052cc}
        .plan.illimite{background:linear-gradient(135deg,#f0e6ff,#ffe6f5);color:#7c3aed}
        .quota-ok{color:#0aa05a;font-weight:600}
        .quota-warn{color:#f59e0b;font-weight:600}
        .quota-max{color:#dc2626;font-weight:700}
        .tabs{display:flex;gap:10px;margin-bottom:20px}
        .tab{padding:10px 20px;background:white;border:1px solid #e8eef7;border-radius:10px;font-weight:600;color:#5e6987;text-decoration:none}
        .tab.active{background:#0066ff;color:white;border-color:#0066ff}
      </style></head>
      <body><div class="container">
        <header><h1>👥 Utilisateurs RénoExpert</h1></header>
        <div class="tabs">
          <a href="/admin/feedbacks?token=${encodeURIComponent(token)}" class="tab">📋 Feedbacks</a>
          <a href="/admin/users?token=${encodeURIComponent(token)}" class="tab active">👥 Utilisateurs</a>
        </div>
        <div class="section">
          <h2>Liste des utilisateurs (${result.rows.length})</h2>
          <table>
            <thead><tr><th>Email</th><th>Nom</th><th>Plan</th><th>Analyses IA</th><th>Projets sauv.</th><th>Inscrit le</th><th>Dernière connexion</th></tr></thead>
            <tbody>
              ${result.rows.map(u => {
                const nbA = parseInt(u.nb_analyses || 0);
                let analysesClass = 'quota-ok';
                if (u.plan !== 'illimite') {
                  if (nbA >= LIMITE_ANALYSES_GRATUIT) analysesClass = 'quota-max';
                  else if (nbA >= LIMITE_ANALYSES_GRATUIT - 1) analysesClass = 'quota-warn';
                }
                return `
                <tr>
                  <td><strong>${u.email}</strong></td>
                  <td>${u.nom || '-'}</td>
                  <td><span class="plan ${u.plan}">${u.plan}</span></td>
                  <td><span class="${analysesClass}">${nbA}${u.plan !== 'illimite' ? ` / ${LIMITE_ANALYSES_GRATUIT}` : ' (illimité)'}</span></td>
                  <td><strong>${u.nb_projets}</strong></td>
                  <td>${new Date(u.created_at).toLocaleDateString('fr-FR')}</td>
                  <td>${u.last_login ? new Date(u.last_login).toLocaleDateString('fr-FR') : 'Jamais'}</td>
                </tr>
              `;}).join('')}
            </tbody>
          </table>
        </div>
      </div></body></html>
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
