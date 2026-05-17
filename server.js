// ============================================================
// RénoExpert Backend v3.3 - Comptes utilisateurs + Notifications
// ============================================================
// 
// Nouvelles fonctionnalités :
// - Inscription / Connexion email + mot de passe
// - Limite 3 projets gratuits (sauf compte admin = illimité)
// - Notifications email via Brevo
// ============================================================

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

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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
const LIMITE_PROJETS_GRATUIT = 3;

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
      'SELECT id, email, nom, plan FROM users WHERE session_token = $1 AND session_expires > NOW()',
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
// ROUTES AUTHENTIFICATION
// ============================================================

// INSCRIPTION
app.post('/api/auth/register', async (req, res) => {
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
app.post('/api/auth/login', async (req, res) => {
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
  // Calculer combien de projets l'utilisateur a déjà
  const countResult = await pool.query(
    'SELECT COUNT(*) FROM projets WHERE user_email = $1',
    [req.user.email]
  );
  
  const nbProjets = parseInt(countResult.rows[0].count);
  const limite = req.user.plan === 'illimite' ? null : LIMITE_PROJETS_GRATUIT;
  
  res.json({
    success: true,
    user: req.user,
    quota: {
      utilises: nbProjets,
      limite: limite,
      illimite: req.user.plan === 'illimite'
    }
  });
});

// ============================================================
// PROMPTS IA (identique v3.2)
// ============================================================

const PROMPTS = {
  visite: `Tu es un expert immobilier français senior. Analyse les photos d'un bien immobilier pour quelqu'un qui le visite avant achat.

Donne une analyse structurée et précise :

# 🏠 Diagnostic visuel

## État général
[Évaluation globale du bien]

## Points forts ✅
- [Liste des qualités observées]

## Points de vigilance ⚠️
- [Défauts, problèmes potentiels]

## Travaux à prévoir 🔨
- [Travaux urgents]
- [Travaux à moyen terme]
- Estimation budget : XX 000 € à XX 000 €

## Questions à poser au vendeur ❓
- [Liste de 5-8 questions importantes]

## Verdict 🎯
[Recommandation : acheter, négocier, fuir]

Sois précis, factuel, professionnel.`,

  reparation: `Tu es un expert bâtiment français senior avec 20 ans d'expérience terrain. Diagnostique le problème montré sur les photos et donne une procédure de réparation claire pour un particulier.

RÈGLES STRICTES :
- N'utilise JAMAIS le mot "DIY". Utilise : "à faire soi-même", "faire faire par un artisan", "bricoleur confirmé", "bricoleur débutant"
- Sois TRÈS précis sur les quantités, dimensions, dosages
- Insiste sur l'aspiration à CHAQUE étape (point essentiel pour la qualité)
- Mentionne la vérification d'alignement (règle ou laser) au fur et à mesure
- Donne des prix réalistes 2026
- Aére tes textes : des paragraphes COURTS (max 3-4 lignes par paragraphe), pas de blocs denses
- Termine TOUJOURS par un tableau récapitulatif des coûts détaillé

CONNAISSANCES TECHNIQUES CARRELAGE :
- Ragréage : 1.7 kg/m²/mm d'épaisseur
- Colle carrelage C2 : 1 sac 25kg pour 5 m² (simple encollage) ou 4 m² (double encollage pour grands formats > 30x30 cm)
- Joints carrelage : 5 kg pour 10 m²
- ORDRE DE POSE : 1) Carrelage AVEC plinthes ensemble (collées à la colle carrelage), 2) Joints simultanés sol + plinthes
- Kit jointoiement (~30€, finition impeccable) : taloche caoutchouc, éponge spéciale joints, seau à rouleaux essoreurs
- Outillage : scie trépan carrelage sur disqueuse, couteau enduire ou disqueuse 12V pour gratter surplus colle
- ASPIRATION à chaque étape (point essentiel)
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
🟢 Faible / 🟡 Modéré / 🔴 Urgent

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

  agent: `Tu es un agent immobilier expert français. Crée une fiche commerciale professionnelle pour ce bien.

# 📋 Fiche commerciale

## Présentation du bien
[Texte accrocheur 3-4 lignes]

## Caractéristiques techniques
- Surface : [m²]
- État général : [évaluation]
- DPE estimé : [classe]
- Année construction : [estimation]

## Atouts à mettre en avant 💎
[5-6 points commerciaux forts]

## Points d'amélioration possibles 🔨
[Travaux à mentionner avec budget indicatif]

## Prix de marché conseillé 💰
- Prix bas : XX €
- Prix médian : XX €  
- Prix haut : XX €
- Justification : [explication]

## Cible acheteur recommandée 🎯
[Profil type]

## Stratégie de vente 📈
[Conseils pour vendre rapidement]

## Argumentaire pour les visites
[5 phrases clés à dire]`,

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

async function analyzeWithClaude(prompt, photos, additionalContext = '') {
  const content = [];
  if (additionalContext) content.push({ type: 'text', text: additionalContext });
  for (const photo of photos) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: photo.mimetype, data: photo.buffer.toString('base64') }
    });
  }
  content.push({ type: 'text', text: prompt });
  
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content }]
  });
  
  return message.content[0].text;
}

app.post('/api/analyze/visite', upload.array('photos', 20), async (req, res) => {
  try {
    const { surface, location } = req.body;
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'Aucune photo' });
    const context = `Surface : ${surface || 'non précisée'} m²\nLocalisation : ${location || 'non précisée'}\n\n`;
    const analysis = await analyzeWithClaude(PROMPTS.visite, req.files, context);
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

app.post('/api/analyze/reparation', upload.array('photos', 10), async (req, res) => {
  try {
    const { description } = req.body;
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'Aucune photo' });
    const context = description ? `Description : ${description}\n\n` : '';
    const analysis = await analyzeWithClaude(PROMPTS.reparation, req.files, context);
    res.json({ success: true, analysis });
  } catch (error) {
    console.error('Erreur reparation:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/analyze/agent', upload.array('photos', 30), async (req, res) => {
  try {
    const { surface, location, agence_nom, agent_nom } = req.body;
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'Aucune photo' });
    const context = `Surface : ${surface} m²\nLocalisation : ${location}\nAgence : ${agence_nom}\nAgent : ${agent_nom}\n\n`;
    const analysis = await analyzeWithClaude(PROMPTS.agent, req.files, context);
    res.json({ success: true, analysis, agence_nom, agent_nom });
  } catch (error) {
    console.error('Erreur agent:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/analyze/marchand', upload.array('photos', 50), async (req, res) => {
  try {
    const { surface, prix_demande, location, strategie, nb_lots, annee_construction, mb_societe } = req.body;
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'Aucune photo' });
    const context = `Société MB : ${mb_societe}
Localisation : ${location}
Surface : ${surface} m²
Année construction : ${annee_construction}
Prix demandé : ${prix_demande} €
Stratégie : ${strategie}
Nombre de lots envisagés : ${nb_lots}

IMPORTANT : Frais notaire MB = 3% du prix d'achat (article 1115 CGI)

`;
    const analysis = await analyzeWithClaude(PROMPTS.marchand, req.files, context);
    const frais_notaire_mb_3pct = Math.round(parseFloat(prix_demande) * 0.03);
    res.json({ success: true, analysis, frais_notaire_mb_3pct });
  } catch (error) {
    console.error('Erreur marchand:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// FEEDBACK (avec notification email si négatif)
// ============================================================

app.post('/api/feedback', async (req, res) => {
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
    
    // Vérifier le quota (sauf si plan illimité)
    if (req.user.plan !== 'illimite') {
      const countResult = await pool.query(
        'SELECT COUNT(*) FROM projets WHERE user_email = $1',
        [req.user.email]
      );
      const nbProjets = parseInt(countResult.rows[0].count);
      
      if (nbProjets >= LIMITE_PROJETS_GRATUIT) {
        return res.status(403).json({ 
          error: `Limite atteinte : ${LIMITE_PROJETS_GRATUIT} projets maximum en gratuit. Passez en Pro pour sauvegarder plus de projets.`,
          code: 'QUOTA_EXCEEDED',
          quota: { utilises: nbProjets, limite: LIMITE_PROJETS_GRATUIT }
        });
      }
    }
    
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
        utilises: parseInt(countResult.rows[0].count),
        limite: req.user.plan === 'illimite' ? null : LIMITE_PROJETS_GRATUIT,
        illimite: req.user.plan === 'illimite'
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
        utilises: liste.length,
        limite: req.user.plan === 'illimite' ? null : LIMITE_PROJETS_GRATUIT,
        illimite: req.user.plan === 'illimite'
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

app.post('/api/pdf/visite', async (req, res) => {
  try {
    const { analysis, location, surface } = req.body;
    if (!analysis) return res.status(400).json({ error: 'Analyse manquante' });
    pdfGen.generateVisitePDF({ analysis, location, surface }, res);
  } catch (error) {
    console.error('Erreur PDF visite:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/pdf/reparation', async (req, res) => {
  try {
    const { analysis, description } = req.body;
    if (!analysis) return res.status(400).json({ error: 'Analyse manquante' });
    pdfGen.generateReparationPDF({ analysis, description }, res);
  } catch (error) {
    console.error('Erreur PDF reparation:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/pdf/agent', async (req, res) => {
  try {
    const { analysis, agence_nom, agent_nom, location, surface } = req.body;
    if (!analysis) return res.status(400).json({ error: 'Analyse manquante' });
    pdfGen.generateAgentPDF({ analysis, agence_nom, agent_nom, location, surface }, res);
  } catch (error) {
    console.error('Erreur PDF agent:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/pdf/marchand', async (req, res) => {
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
            <thead><tr><th>Email</th><th>Nom</th><th>Plan</th><th>Projets</th><th>Inscrit le</th><th>Dernière connexion</th></tr></thead>
            <tbody>
              ${result.rows.map(u => `
                <tr>
                  <td><strong>${u.email}</strong></td>
                  <td>${u.nom || '-'}</td>
                  <td><span class="plan ${u.plan}">${u.plan}</span></td>
                  <td><strong>${u.nb_projets}</strong>${u.plan !== 'illimite' ? ` / ${LIMITE_PROJETS_GRATUIT}` : ''}</td>
                  <td>${new Date(u.created_at).toLocaleDateString('fr-FR')}</td>
                  <td>${u.last_login ? new Date(u.last_login).toLocaleDateString('fr-FR') : 'Jamais'}</td>
                </tr>
              `).join('')}
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
// DÉMARRAGE
// ============================================================

app.listen(PORT, () => {
  console.log(`🚀 RénoExpert Backend v3.3 lancé sur le port ${PORT}`);
  console.log(`🗄️ PostgreSQL : ${process.env.DATABASE_URL ? 'connecté' : '⚠️ NON CONFIGURÉ'}`);
  console.log(`📧 Brevo : ${BREVO_API_KEY ? 'configuré' : '⚠️ NON CONFIGURÉ'}`);
  console.log(`👑 Admin email : ${ADMIN_EMAIL || '⚠️ NON CONFIGURÉ'}`);
  console.log(`🔑 Admin token : ${ADMIN_TOKEN === 'admin123' ? '⚠️ Token par défaut' : '✅ configuré'}`);
});
