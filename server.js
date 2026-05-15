// ============================================================
// RénoExpert Backend v3.2 - Avec PostgreSQL
// ============================================================
// 
// Ce server.js remplace COMPLÈTEMENT ton ancien server.js
// Il contient TOUT : analyses IA, PDF, feedbacks, projets, dashboard admin
// Avec stockage PostgreSQL permanent
//
// ============================================================

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const PDFDocument = require('pdfkit');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB par fichier
});

// Anthropic
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Token admin
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin123';

// ============================================================
// CONNEXION POSTGRESQL
// ============================================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Initialisation des tables au démarrage
async function initDB() {
  try {
    // Table feedbacks
    await pool.query(`
      CREATE TABLE IF NOT EXISTS feedbacks (
        id SERIAL PRIMARY KEY,
        mode VARCHAR(50),
        note VARCHAR(10),
        probleme TEXT,
        location VARCHAR(255),
        user_id VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Table projets
    await pool.query(`
      CREATE TABLE IF NOT EXISTS projets (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(100) NOT NULL,
        mode VARCHAR(50) NOT NULL,
        titre VARCHAR(255),
        analysis TEXT,
        data JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Index pour recherche rapide
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_projets_user 
      ON projets(user_id, created_at DESC)
    `);
    
    console.log('✅ Base de données PostgreSQL initialisée');
  } catch (err) {
    console.error('❌ Erreur init DB:', err.message);
  }
}

initDB();

// ============================================================
// PROMPTS IA
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

  reparation: `Tu es un expert bâtiment français. Diagnostique le problème montré sur les photos et donne une procédure de réparation claire.

# 🔧 Diagnostic

## Problème identifié
[Description précise]

## Cause probable
[Pourquoi ce problème]

## Niveau de gravité
🟢 Faible / 🟡 Modéré / 🔴 Urgent

# 🛠️ Procédure de réparation

## Difficulté
[DIY débutant / DIY confirmé / Pro recommandé]

## Matériel nécessaire
- [Liste précise avec quantités]

## Étapes
### Étape 1 : [Titre]
[Description détaillée]

### Étape 2 : [Titre]
[Description]

[etc.]

## Sécurité ⚠️
[Précautions à prendre]

## Budget estimé
- DIY : XX €
- Pro : XX € à XX €

## Quand appeler un pro ?
[Critères de décision]`,

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
// ROUTE HEALTH CHECK
// ============================================================

app.get('/', (req, res) => {
  res.json({ status: 'RénoExpert Backend v3.2 - Online with PostgreSQL' });
});

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT NOW()');
    res.json({ status: 'OK', database: 'connected', version: '3.2' });
  } catch (err) {
    res.json({ status: 'OK', database: 'error: ' + err.message });
  }
});

// ============================================================
// ROUTES ANALYSE IA
// ============================================================

async function analyzeWithClaude(prompt, photos, additionalContext = '') {
  const content = [];
  
  if (additionalContext) {
    content.push({ type: 'text', text: additionalContext });
  }
  
  for (const photo of photos) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: photo.mimetype,
        data: photo.buffer.toString('base64')
      }
    });
  }
  
  content.push({ type: 'text', text: prompt });
  
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [{ role: 'user', content }]
  });
  
  return message.content[0].text;
}

app.post('/api/analyze/visite', upload.array('photos', 20), async (req, res) => {
  try {
    const { surface, location } = req.body;
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'Aucune photo' });
    }
    
    const context = `Surface : ${surface || 'non précisée'} m²\nLocalisation : ${location || 'non précisée'}\n\n`;
    const analysis = await analyzeWithClaude(PROMPTS.visite, req.files, context);
    
    res.json({ success: true, analysis });
  } catch (error) {
    console.error('Erreur visite:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/analyze/reparation', upload.array('photos', 10), async (req, res) => {
  try {
    const { description } = req.body;
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'Aucune photo' });
    }
    
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
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'Aucune photo' });
    }
    
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
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'Aucune photo' });
    }
    
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
// ROUTES FEEDBACK (avec PostgreSQL)
// ============================================================

app.post('/api/feedback', async (req, res) => {
  try {
    const { mode, note, probleme, location, userId } = req.body;
    
    await pool.query(
      `INSERT INTO feedbacks (mode, note, probleme, location, user_id) 
       VALUES ($1, $2, $3, $4, $5)`,
      [mode || 'unknown', note || '', probleme || '', location || '', userId || '']
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error('Erreur feedback:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ROUTES PROJETS (avec PostgreSQL)
// ============================================================

app.post('/api/projets/save', async (req, res) => {
  try {
    const { userId, mode, titre, analysis, data } = req.body;
    
    if (!userId || !mode || !analysis) {
      return res.status(400).json({ error: 'Données manquantes' });
    }
    
    const result = await pool.query(
      `INSERT INTO projets (user_id, mode, titre, analysis, data) 
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [userId, mode, titre || `Projet ${mode}`, analysis, JSON.stringify(data || {})]
    );
    
    // Compter le total de projets pour cet utilisateur
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM projets WHERE user_id = $1',
      [userId]
    );
    
    res.json({
      success: true,
      projet_id: result.rows[0].id,
      total_projets: parseInt(countResult.rows[0].count)
    });
  } catch (error) {
    console.error('Erreur save projet:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/projets/list', async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) {
      return res.status(400).json({ error: 'userId manquant' });
    }
    
    const result = await pool.query(
      `SELECT id, mode, titre, analysis, data, created_at 
       FROM projets 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT 50`,
      [userId]
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
      projets: liste
    });
  } catch (error) {
    console.error('Erreur list projets:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/projets/:id', async (req, res) => {
  try {
    const userId = req.query.userId;
    const projetId = req.params.id;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId manquant' });
    }
    
    const result = await pool.query(
      'SELECT * FROM projets WHERE id = $1 AND user_id = $2',
      [projetId, userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Projet non trouvé' });
    }
    
    const p = result.rows[0];
    res.json({
      success: true,
      projet: {
        id: p.id.toString(),
        userId: p.user_id,
        mode: p.mode,
        titre: p.titre,
        analysis: p.analysis,
        data: p.data || {},
        created_at: p.created_at
      }
    });
  } catch (error) {
    console.error('Erreur get projet:', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/projets/:id', async (req, res) => {
  try {
    const userId = req.query.userId;
    const projetId = req.params.id;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId manquant' });
    }
    
    const result = await pool.query(
      'DELETE FROM projets WHERE id = $1 AND user_id = $2 RETURNING id',
      [projetId, userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Projet non trouvé' });
    }
    
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM projets WHERE user_id = $1',
      [userId]
    );
    
    res.json({
      success: true,
      remaining: parseInt(countResult.rows[0].count)
    });
  } catch (error) {
    console.error('Erreur delete projet:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ROUTES PDF
// ============================================================

function setupPDF(res, filename) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);
  return doc;
}

function renderMarkdownToPDF(doc, text) {
  const lines = text.split('\n');
  for (let line of lines) {
    if (doc.y > doc.page.height - 100) doc.addPage();
    line = line.trim();
    if (!line) { doc.moveDown(0.3); continue; }
    
    if (line.startsWith('# ')) {
      doc.moveDown(0.3);
      doc.fillColor('#0052cc').fontSize(14).font('Helvetica-Bold')
         .text(line.replace(/^#\s+/, ''), { width: doc.page.width - 100 });
      doc.moveDown(0.2);
    } else if (line.startsWith('## ')) {
      doc.moveDown(0.3);
      doc.fillColor('#0066ff').fontSize(12).font('Helvetica-Bold')
         .text(line.replace(/^##\s+/, ''), { width: doc.page.width - 100 });
      doc.moveDown(0.2);
    } else if (line.startsWith('### ')) {
      doc.fillColor('#4d94ff').fontSize(11).font('Helvetica-Bold')
         .text(line.replace(/^###\s+/, ''), { width: doc.page.width - 100 });
      doc.moveDown(0.2);
    } else if (line.startsWith('- ') || line.startsWith('• ') || line.startsWith('* ')) {
      const text = line.replace(/^[\-•\*]\s+/, '').replace(/\*\*(.*?)\*\*/g, '$1');
      doc.fillColor('#0a0e27').fontSize(10).font('Helvetica')
         .text('• ' + text, { width: doc.page.width - 100, indent: 10, lineGap: 2 });
    } else {
      const cleanLine = line.replace(/\*\*(.*?)\*\*/g, '$1');
      doc.fillColor('#0a0e27').fontSize(10).font('Helvetica')
         .text(cleanLine, { width: doc.page.width - 100, lineGap: 2 });
    }
  }
}

function pdfHeader(doc, title, subtitle) {
  doc.rect(0, 0, doc.page.width, 80).fill('#0066ff');
  doc.fillColor('white').fontSize(24).font('Helvetica-Bold').text('RénoExpert', 50, 25);
  doc.fontSize(11).font('Helvetica').text(subtitle, 50, 55);
  doc.fontSize(10).text(new Date().toLocaleDateString('fr-FR'), 50, 25, {
    align: 'right', width: doc.page.width - 100
  });
  doc.fillColor('#0a0e27').fontSize(11);
  doc.y = 110;
}

// PDF VISITE
app.post('/api/pdf/visite', async (req, res) => {
  try {
    const { analysis, location, surface, date } = req.body;
    if (!analysis) return res.status(400).json({ error: 'Analyse manquante' });
    
    const doc = setupPDF(res, 'visite-renoexpert.pdf');
    pdfHeader(doc, 'Diagnostic Visite', 'Diagnostic immobilier pour visite achat');
    
    doc.fillColor('#0066ff').fontSize(13).font('Helvetica-Bold').text('📍 Informations du bien');
    doc.moveDown(0.3);
    doc.fillColor('#0a0e27').fontSize(11).font('Helvetica')
       .text(`Adresse : ${location || 'N/A'}`)
       .text(`Surface : ${surface || 'N/A'} m²`)
       .text(`Date : ${date || new Date().toLocaleDateString('fr-FR')}`);
    doc.moveDown();
    
    renderMarkdownToPDF(doc, analysis);
    doc.end();
  } catch (error) {
    console.error('Erreur PDF visite:', error);
    res.status(500).json({ error: error.message });
  }
});

// PDF RÉPARATION
app.post('/api/pdf/reparation', async (req, res) => {
  try {
    const { analysis, description, date } = req.body;
    if (!analysis) return res.status(400).json({ error: 'Analyse manquante' });
    
    const doc = setupPDF(res, 'guide-reparation.pdf');
    pdfHeader(doc, 'Guide Réparation', 'Guide pratique de réparation');
    
    // Encadré sécurité
    const yStart = doc.y;
    doc.rect(50, yStart, doc.page.width - 100, 60).fillAndStroke('#fff4e6', '#ffaa00');
    doc.fillColor('#c25a00').fontSize(11).font('Helvetica-Bold')
       .text('⚠️ À LIRE AVANT DE COMMENCER', 60, yStart + 10);
    doc.fillColor('#5e6987').fontSize(9).font('Helvetica')
       .text('• Coupez l\'électricité et l\'eau si nécessaire\n• Portez les EPI adaptés (gants, lunettes, masque)\n• En cas de doute, faites appel à un professionnel',
         60, yStart + 27, { width: doc.page.width - 120, lineGap: 2 });
    doc.y = yStart + 80;
    doc.moveDown();
    
    if (description) {
      doc.fillColor('#0066ff').fontSize(13).font('Helvetica-Bold').text('📋 Problème signalé');
      doc.moveDown(0.5);
      doc.fillColor('#0a0e27').fontSize(10).font('Helvetica').text(description, { width: doc.page.width - 100, lineGap: 3 });
      doc.moveDown();
    }
    
    doc.fillColor('#0066ff').fontSize(13).font('Helvetica-Bold').text('🔧 Diagnostic & réparation');
    doc.moveDown(0.5);
    renderMarkdownToPDF(doc, analysis);
    doc.end();
  } catch (error) {
    console.error('Erreur PDF reparation:', error);
    res.status(500).json({ error: error.message });
  }
});

// PDF AGENT
app.post('/api/pdf/agent', async (req, res) => {
  try {
    const { analysis, agence_nom, agent_nom, location, surface } = req.body;
    if (!analysis) return res.status(400).json({ error: 'Analyse manquante' });
    
    const doc = setupPDF(res, 'fiche-agent.pdf');
    pdfHeader(doc, 'Fiche Commerciale', `${agence_nom || 'Agence'} - Fiche pro`);
    
    doc.fillColor('#0066ff').fontSize(13).font('Helvetica-Bold').text('🏢 Informations agence');
    doc.moveDown(0.3);
    doc.fillColor('#0a0e27').fontSize(11).font('Helvetica')
       .text(`Agence : ${agence_nom || 'N/A'}`)
       .text(`Agent : ${agent_nom || 'N/A'}`)
       .text(`Bien : ${location || 'N/A'}`)
       .text(`Surface : ${surface || 'N/A'} m²`);
    doc.moveDown();
    
    renderMarkdownToPDF(doc, analysis);
    doc.end();
  } catch (error) {
    console.error('Erreur PDF agent:', error);
    res.status(500).json({ error: error.message });
  }
});

// PDF MARCHAND
app.post('/api/pdf/marchand', async (req, res) => {
  try {
    const { analysis, mb_societe, location, surface, prix_demande, nb_lots, strategie } = req.body;
    if (!analysis) return res.status(400).json({ error: 'Analyse manquante' });
    
    const doc = setupPDF(res, 'dossier-banque.pdf');
    pdfHeader(doc, 'Dossier Marchand de Biens', 'Dossier pour banque - Article 1115 CGI');
    
    doc.fillColor('#0066ff').fontSize(13).font('Helvetica-Bold').text('💼 Identification opération');
    doc.moveDown(0.3);
    doc.fillColor('#0a0e27').fontSize(11).font('Helvetica')
       .text(`Société MB : ${mb_societe || 'N/A'}`)
       .text(`Adresse : ${location || 'N/A'}`)
       .text(`Surface : ${surface || 'N/A'} m²`)
       .text(`Prix demandé : ${prix_demande ? Number(prix_demande).toLocaleString('fr-FR') + ' €' : 'N/A'}`)
       .text(`Stratégie : ${strategie || 'N/A'}`)
       .text(`Nombre de lots : ${nb_lots || 'N/A'}`);
    doc.moveDown();
    
    renderMarkdownToPDF(doc, analysis);
    doc.end();
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
          <form method="GET">
            <input type="password" name="token" placeholder="Token admin" required autofocus>
            <button>🔓 Se connecter</button>
          </form>
        </div></body></html>
      `);
    }
    
    // Récupérer les stats depuis PostgreSQL
    const feedbacksResult = await pool.query(
      'SELECT * FROM feedbacks ORDER BY created_at DESC LIMIT 100'
    );
    const feedbacks = feedbacksResult.rows;
    
    const total = feedbacks.length;
    const positifs = feedbacks.filter(f => f.note === '👍').length;
    const neutres = feedbacks.filter(f => f.note === '👌').length;
    const negatifs = feedbacks.filter(f => f.note === '👎').length;
    const satisfaction = total > 0 ? Math.round(((positifs + neutres) / total) * 100) : 0;
    
    const parMode = {};
    feedbacks.forEach(f => { parMode[f.mode] = (parMode[f.mode] || 0) + 1; });
    
    // Stats projets
    const projetsResult = await pool.query('SELECT COUNT(*) as total, COUNT(DISTINCT user_id) as users FROM projets');
    const totalProjets = parseInt(projetsResult.rows[0].total);
    const totalUsers = parseInt(projetsResult.rows[0].users);
    
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
        .stat-value{font-size:32px;font-weight:800;color:#0066ff;margin-bottom:4px;letter-spacing:-1px}
        .stat-label{color:#5e6987;font-size:12px;font-weight:500}
        .section{background:white;padding:24px;border-radius:14px;box-shadow:0 2px 10px rgba(0,0,0,0.05);margin-bottom:20px;border:1px solid #e8eef7}
        h2{font-size:18px;margin-bottom:18px;color:#0a0e27;font-weight:700}
        table{width:100%;border-collapse:collapse}
        th{background:#f5f7fb;padding:12px;text-align:left;font-size:12px;color:#5e6987;font-weight:600;border-bottom:2px solid #e8eef7;text-transform:uppercase;letter-spacing:0.3px}
        td{padding:12px;border-bottom:1px solid #f0f3f8;font-size:14px;color:#0a0e27}
        tr:hover{background:#f8faff}
        .note{display:inline-block;padding:4px 10px;border-radius:10px;font-size:16px}
        .note.positif{background:#e6ffec}
        .note.neutre{background:#fff4e6}
        .note.negatif{background:#ffe6e8}
        .mode{display:inline-block;padding:3px 10px;border-radius:10px;font-size:11px;font-weight:600;background:#e6f0ff;color:#0052cc}
        .probleme{color:#5e6987;font-size:13px;max-width:400px}
        .btn{display:inline-block;padding:10px 20px;background:#0066ff;color:white;text-decoration:none;border-radius:10px;font-size:13px;font-weight:600;margin-top:12px}
        .btn:hover{background:#0052cc}
        .empty{text-align:center;padding:60px 20px;color:#8b95b0}
        .empty-icon{font-size:48px;margin-bottom:10px}
        .badge-db{display:inline-block;background:rgba(255,255,255,0.2);padding:3px 10px;border-radius:6px;font-size:11px;font-weight:600;margin-left:10px}
      </style></head>
      <body><div class="container">
        <header>
          <h1>📊 Dashboard Admin RénoExpert <span class="badge-db">🗄️ PostgreSQL</span></h1>
          <div class="subtitle">Vos données sont sauvegardées de manière permanente</div>
        </header>
        
        <div class="stats">
          <div class="stat-card"><div class="stat-value">${total}</div><div class="stat-label">Total feedbacks</div></div>
          <div class="stat-card"><div class="stat-value">${satisfaction}%</div><div class="stat-label">Satisfaction</div></div>
          <div class="stat-card"><div class="stat-value">${negatifs}</div><div class="stat-label">À corriger</div></div>
          <div class="stat-card"><div class="stat-value">${totalUsers}</div><div class="stat-label">Utilisateurs</div></div>
          <div class="stat-card"><div class="stat-value">${totalProjets}</div><div class="stat-label">Projets sauvegardés</div></div>
        </div>
        
        <div class="section">
          <h2>📋 Tous les feedbacks (${total})</h2>
          ${total === 0 ? `
            <div class="empty"><div class="empty-icon">📭</div><div>Aucun feedback pour le moment</div></div>
          ` : `
            <table>
              <thead><tr><th>Date</th><th>Mode</th><th>Note</th><th>Lieu</th><th>Problème signalé</th></tr></thead>
              <tbody>
                ${feedbacks.map(f => `
                  <tr>
                    <td>${new Date(f.created_at).toLocaleDateString('fr-FR')} ${new Date(f.created_at).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'})}</td>
                    <td><span class="mode">${f.mode || 'N/A'}</span></td>
                    <td><span class="note ${f.note === '👍' ? 'positif' : f.note === '👎' ? 'negatif' : 'neutre'}">${f.note}</span></td>
                    <td>${f.location || '-'}</td>
                    <td class="probleme">${f.probleme || '-'}</td>
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

app.get('/admin/feedbacks/export', async (req, res) => {
  try {
    const token = req.query.token;
    if (!token || token !== ADMIN_TOKEN) return res.status(401).send('Non autorisé');
    
    const result = await pool.query('SELECT * FROM feedbacks ORDER BY created_at DESC');
    
    let csv = 'Date,Heure,Mode,Note,Localisation,Probleme\n';
    result.rows.forEach(f => {
      const d = new Date(f.created_at);
      csv += `${d.toLocaleDateString('fr-FR')},${d.toLocaleTimeString('fr-FR')},${f.mode || ''},${f.note},${f.location || ''},"${(f.probleme || '').replace(/"/g, '""')}"\n`;
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
  console.log(`🚀 RénoExpert Backend v3.2 lancé sur le port ${PORT}`);
  console.log(`🗄️ PostgreSQL : ${process.env.DATABASE_URL ? 'connecté' : 'NON CONFIGURÉ ⚠️'}`);
  console.log(`🔑 Admin token : ${ADMIN_TOKEN === 'admin123' ? '⚠️ Token par défaut, à changer !' : '✅ configuré'}`);
});
