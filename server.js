// ===================================================================
// RénoExpert v2.0 - Backend complet avec 4 modes
// Modes: Visite, Réparation, Agent Immo, Marchand de Biens
// ===================================================================

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ===================================================================
// CONFIGURATION
// ===================================================================
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB max
});

// ===================================================================
// PROMPTS IA - 4 MODES
// ===================================================================

const PROMPTS = {
  // 🏠 MODE VISITE - Particulier acheteur
  visite: `Tu es expert en bâtiment français, diagnostic pour acheteur particulier.

Analyse les photos de cette visite immobilière et fournis :

1. VERDICT (🟢 BON ÉTAT / 🟡 TRAVAUX MOYENS / 🔴 TRAVAUX LOURDS)

2. DIAGNOSTIC par pièce/zone visible :
   - Points forts (architecture, matériaux, état)
   - Points faibles (humidité, vétusté, défauts)
   - Période de construction estimée
   - Patrimoine architectural éventuel

3. TRAVAUX À PRÉVOIR (priorisés) :
   - Critiques (sécurité, structurels)
   - Importants (énergie, confort)
   - Esthétiques (cosmétique)

4. NORMES FRANÇAISES applicables :
   - DTU concernés
   - RT 2020 / RE 2020
   - NF C 15-100 si électricité
   - DPE estimation

5. BUDGET TRAVAUX estimatif (fourchette min-max)

6. QUESTIONS À POSER AU VENDEUR (10 questions essentielles)

7. POINTS DE NÉGOCIATION possibles

Réponse structurée en français, claire, avec emojis pour lisibilité mobile.
Surface fournie : {surface} m². Localisation : {location}.`,

  // 🔨 MODE RÉPARATION - DIY
  reparation: `Tu es expert artisan français spécialisé en rénovation.

L'utilisateur veut RÉPARER quelque chose. Analyse les photos et fournis :

1. DIAGNOSTIC du problème :
   - Cause probable
   - Gravité (urgent/non urgent)
   - Risques si non réparé

2. PROCÉDURE étape par étape (DIY si possible)

3. MATÉRIEL NÉCESSAIRE :
   - Produits exacts avec marques (Sika, Toupret, Bostik, etc.)
   - Magasins (Leroy Merlin, Castorama, Brico Dépôt)
   - Prix estimatif

4. COÛT COMPARATIF :
   - Coût DIY (matériel seul)
   - Coût avec artisan (matériel + MO)
   - Économie réalisée

5. NIVEAU DE DIFFICULTÉ (Facile / Moyen / Difficile / Expert)

6. TEMPS ESTIMÉ pour la réparation

7. TUTORIELS YOUTUBE recommandés (mots-clés à chercher)

8. QUAND APPELER UN PRO (signes d'alerte)

IMPORTANT : Si traitement de fissure murale, mentionner BANDE ARMÉE 
dans les produits ET les étapes.
Carrelage sale = karcher vapeur + buse rotative (technique pro, sans produits chimiques).

Réponse en français, ton accessible, structure claire.`,

  // 🏢 MODE AGENT IMMOBILIER
  agent: `Tu es consultant pour agent immobilier français professionnel.

Analyse les photos pour préparer la VENTE de ce bien :

1. FICHE TECHNIQUE :
   - Type de bien
   - Surface estimée
   - Année construction probable
   - Style architectural
   - Localisation : {location}

2. POINTS FORTS DE VENTE (argumentaire) :
   - Atouts patrimoniaux
   - Atouts techniques
   - Atouts d'emplacement
   - Cibles acheteurs potentiels

3. POINTS FAIBLES À ANTICIPER :
   - Travaux visibles
   - Objections probables des acheteurs
   - Comment les retourner positivement

4. TRAVAUX À MENTIONNER dans l'annonce :
   - Liste claire pour transparence
   - Estimation budget (fourchette)
   - Priorisation

5. STRATÉGIE DE COMMERCIALISATION :
   - Prix marché conseillé (fourchette/m²)
   - Cible acheteur idéal
   - Mise en valeur photos
   - Mots-clés annonce

6. DIAGNOSTICS OBLIGATOIRES à fournir
   (selon année construction et surface)

7. ARGUMENTAIRE PRIX face aux contre-offres

Réponse pro et structurée pour agent immobilier expérimenté.`,

  // 💼 MODE MARCHAND DE BIENS
  marchand: `Tu es expert-conseil pour MARCHAND DE BIENS français.

L'utilisateur évalue ce bien pour OPÉRATION de marchand de biens.
Analyse complète professionnelle pour décision GO/NO GO :

DONNÉES BIEN :
- Surface : {surface} m²
- Prix demandé : {prix_demande} €
- Localisation : {location}
- Stratégie : {strategie}
- Nombre de lots envisagés : {nb_lots}

LIVRE UN DOSSIER STRUCTURÉ :

1. SYNTHÈSE EXÉCUTIVE (5 lignes max)
   GO / NO GO avec justification

2. DIAGNOSTIC TECHNIQUE COMPLET :
   - État global du bien (structure, toiture, électricité, plomberie)
   - Diagnostics obligatoires à anticiper (plomb si avant 1949, amiante si avant 1997, gaz, électricité, DPE)
   - Travaux par poste

3. CHIFFRAGE TRAVAUX DÉTAILLÉ MATÉRIEL / MAIN D'ŒUVRE :
   Pour chaque poste, séparer :
   - Coût matériel
   - Coût main d'œuvre
   - Total
   
   Postes à chiffrer :
   a) Réglementaire (plomb, amiante, électricité NF C 15-100, plomberie, archi, diagnostics)
   b) Énergétique pour viser DPE C (isolation murs/combles/planchers, VMC, chauffage électrique, ECS)
   c) Aménagement (cloisons, sols, peintures, cuisines Leroy Merlin, SDB, WC)
   d) Autres (menuiseries, toiture, humidité, compteurs, façade)
   e) Aléas chantier 12%
   
   Total avec ratios 49% matériel / 51% MO en moyenne.

4. STRATÉGIE DE DIVISION en {nb_lots} lots :
   Pour chaque lot : surface, type (T2/T3/T4), étage, prix vente estimé

5. ESTIMATION REVENTE :
   - Prix marché local actuel par m²
   - Total revente brute

6. PLAN FINANCIER COMPLET :
   - Prix d'acquisition : {prix_demande} €
   - **Frais notaire MARCHAND DE BIENS : 3% (article 1115 CGI, engagement revente <5 ans)**
   - Travaux totaux (matériel + MO)
   - Frais financiers (prêt 18 mois TEG 4-5%)
   - Frais commercialisation (5% des reventes)
   - Honoraires divers (architecte, géomètre)

7. CALCUL MARGE :
   - Total engagé
   - Total revente
   - **Marge brute**
   - **Marge nette après IS 25%**
   - Rentabilité en %
   - TRI annualisé

8. POINTS DE VIGILANCE :
   - ABF (zone protégée Bâtiments de France)
   - PLU (division autorisée ?)
   - Servitudes
   - Risques techniques
   - Termites/mérule selon région

9. POINTS DE NÉGOCIATION du prix d'achat :
   - Arguments objectifs basés sur diagnostics
   - Prix cible optimal
   - Marge négociation possible

10. PLANNING type sur 18 mois :
    - Phase acquisition (M0-M1)
    - Phase travaux (M1-M12)
    - Phase commercialisation (M10-M18)

Sois précis, chiffré, professionnel. Utilise tableaux et structure claire.
Ratios pro bâtiment français FFB pour matériel/MO.`
};

// ===================================================================
// ROUTES API - 4 MODES
// ===================================================================

// 🏠 MODE 1: VISITE
app.post('/api/analyze/visite', upload.array('photos', 20), async (req, res) => {
  try {
    const { surface = 'non renseignée', location = 'France' } = req.body;
    const photos = req.files || [];
    
    if (photos.length === 0) {
      return res.status(400).json({ error: 'Au moins une photo requise' });
    }

    const prompt = PROMPTS.visite
      .replace('{surface}', surface)
      .replace('{location}', location);

    const messages = [{
      role: 'user',
      content: [
        ...photos.map(photo => ({
          type: 'image',
          source: {
            type: 'base64',
            media_type: photo.mimetype,
            data: photo.buffer.toString('base64')
          }
        })),
        { type: 'text', text: prompt }
      ]
    }];

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 4000,
      messages
    });

    res.json({
      success: true,
      mode: 'visite',
      analysis: response.content[0].text,
      tokens_used: response.usage
    });

  } catch (error) {
    console.error('Erreur mode visite:', error);
    res.status(500).json({ error: error.message });
  }
});

// 🔨 MODE 2: RÉPARATION
app.post('/api/analyze/reparation', upload.array('photos', 10), async (req, res) => {
  try {
    const { description = '' } = req.body;
    const photos = req.files || [];

    if (photos.length === 0) {
      return res.status(400).json({ error: 'Au moins une photo requise' });
    }

    const fullPrompt = description 
      ? `${PROMPTS.reparation}\n\nProblème décrit par l'utilisateur : ${description}`
      : PROMPTS.reparation;

    const messages = [{
      role: 'user',
      content: [
        ...photos.map(photo => ({
          type: 'image',
          source: {
            type: 'base64',
            media_type: photo.mimetype,
            data: photo.buffer.toString('base64')
          }
        })),
        { type: 'text', text: fullPrompt }
      ]
    }];

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 3000,
      messages
    });

    res.json({
      success: true,
      mode: 'reparation',
      analysis: response.content[0].text,
      tokens_used: response.usage
    });

  } catch (error) {
    console.error('Erreur mode réparation:', error);
    res.status(500).json({ error: error.message });
  }
});

// 🏢 MODE 3: AGENT IMMOBILIER
app.post('/api/analyze/agent', upload.array('photos', 30), async (req, res) => {
  try {
    const { 
      surface = 'non renseignée', 
      location = 'France',
      type_bien = 'maison',
      agence_nom = '',
      agent_nom = ''
    } = req.body;
    
    const photos = req.files || [];

    if (photos.length === 0) {
      return res.status(400).json({ error: 'Au moins une photo requise' });
    }

    const prompt = PROMPTS.agent
      .replace('{surface}', surface)
      .replace('{location}', location);

    const messages = [{
      role: 'user',
      content: [
        ...photos.map(photo => ({
          type: 'image',
          source: {
            type: 'base64',
            media_type: photo.mimetype,
            data: photo.buffer.toString('base64')
          }
        })),
        { type: 'text', text: prompt }
      ]
    }];

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 4000,
      messages
    });

    res.json({
      success: true,
      mode: 'agent',
      agence: agence_nom,
      agent: agent_nom,
      analysis: response.content[0].text,
      tokens_used: response.usage
    });

  } catch (error) {
    console.error('Erreur mode agent:', error);
    res.status(500).json({ error: error.message });
  }
});

// 💼 MODE 4: MARCHAND DE BIENS
app.post('/api/analyze/marchand', upload.array('photos', 50), async (req, res) => {
  try {
    const { 
      surface = 'non renseignée', 
      prix_demande = 0,
      location = 'France',
      strategie = 'Division en lots',
      nb_lots = 5,
      annee_construction = 'inconnue',
      mb_societe = ''
    } = req.body;
    
    const photos = req.files || [];

    if (photos.length === 0) {
      return res.status(400).json({ error: 'Au moins une photo requise' });
    }

    const prompt = PROMPTS.marchand
      .replace(/\{surface\}/g, surface)
      .replace(/\{prix_demande\}/g, prix_demande)
      .replace(/\{location\}/g, location)
      .replace(/\{strategie\}/g, strategie)
      .replace(/\{nb_lots\}/g, nb_lots);

    const messages = [{
      role: 'user',
      content: [
        ...photos.map(photo => ({
          type: 'image',
          source: {
            type: 'base64',
            media_type: photo.mimetype,
            data: photo.buffer.toString('base64')
          }
        })),
        { type: 'text', text: prompt }
      ]
    }];

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 8000,
      messages
    });

    // Calcul automatique de la marge avec frais notaire 3% (MB)
    const FRAIS_NOTAIRE_MB = 0.03; // 3% pour MB avec engagement revente <5 ans
    const prix = parseFloat(prix_demande) || 0;
    const fraisNotaire = Math.round(prix * FRAIS_NOTAIRE_MB);

    res.json({
      success: true,
      mode: 'marchand',
      mb_societe,
      bien: {
        surface,
        prix_demande: prix,
        location,
        strategie,
        nb_lots,
        annee_construction
      },
      frais_notaire_mb_3pct: fraisNotaire,
      message_notaire: "⚠️ Frais notaire MB: 3% (article 1115 CGI, engagement de revente <5 ans). Si non revendu sous 5 ans, rattrapage à 5-6% + pénalités.",
      analysis: response.content[0].text,
      tokens_used: response.usage
    });

  } catch (error) {
    console.error('Erreur mode marchand:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===================================================================
// GÉNÉRATION PDF
// ===================================================================

// PDF Mode Visite (5-8 pages)
app.post('/api/pdf/visite', async (req, res) => {
  try {
    const { analysis, location, surface, date } = req.body;
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=visite-renoexpert.pdf');
    doc.pipe(res);

    // Page de garde
    doc.fontSize(24).fillColor('#2c5aa0').text('RénoExpert', { align: 'center' });
    doc.fontSize(16).fillColor('#666').text('Rapport de Visite Immobilière', { align: 'center' });
    doc.moveDown(2);
    doc.fontSize(12).fillColor('#000');
    doc.text(`📍 Adresse: ${location || 'Non renseignée'}`);
    doc.text(`📐 Surface: ${surface || 'Non renseignée'} m²`);
    doc.text(`📅 Date: ${date || new Date().toLocaleDateString('fr-FR')}`);
    doc.moveDown(2);
    
    // Contenu analyse
    doc.fontSize(10).text(analysis || '', { align: 'justify' });
    
    doc.end();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PDF Mode Agent (8-12 pages avec marquage)
app.post('/api/pdf/agent', async (req, res) => {
  try {
    const { analysis, agence_nom, agent_nom, location, surface } = req.body;
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=fiche-agent.pdf');
    doc.pipe(res);

    // Page de garde avec marquage agence
    doc.rect(0, 0, 595, 100).fill('#2c5aa0');
    doc.fontSize(24).fillColor('#fff').text(agence_nom || 'Agence Immobilière', 50, 30);
    doc.fontSize(12).text(`Agent: ${agent_nom || ''}`, 50, 65);
    
    doc.fillColor('#000').moveDown(5);
    doc.fontSize(20).text('Fiche Technique du Bien', { align: 'center' });
    doc.moveDown(2);
    doc.fontSize(12);
    doc.text(`📍 Adresse: ${location || ''}`);
    doc.text(`📐 Surface: ${surface || ''} m²`);
    doc.moveDown(2);
    
    doc.fontSize(10).text(analysis || '', { align: 'justify' });
    
    doc.end();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PDF Mode Marchand (25-30 pages dossier banque)
app.post('/api/pdf/marchand', async (req, res) => {
  try {
    const { 
      analysis, 
      mb_societe, 
      location, 
      surface, 
      prix_demande,
      nb_lots,
      strategie 
    } = req.body;
    
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=dossier-banque-MB.pdf');
    doc.pipe(res);

    // ============ PAGE 1: GARDE ============
    doc.rect(0, 0, 595, 842).fill('#1a3a5c');
    doc.fontSize(36).fillColor('#fff').text(mb_societe || 'Marchand de Biens', 50, 200, { align: 'center' });
    doc.fontSize(18).fillColor('#ffd700').text('DOSSIER D\'OPÉRATION IMMOBILIÈRE', 50, 280, { align: 'center' });
    doc.moveDown(2);
    doc.fontSize(14).fillColor('#fff').text(`📍 ${location || ''}`, { align: 'center' });
    doc.text(`📐 ${surface || ''} m² habitables`, { align: 'center' });
    doc.text(`🏢 ${nb_lots || ''} lots prévus`, { align: 'center' });
    doc.text(`💰 Prix d'acquisition: ${prix_demande || ''} €`, { align: 'center' });
    
    doc.fontSize(10).fillColor('#ccc').text('Préparé par RénoExpert v2.0', 50, 750, { align: 'center' });
    doc.text(new Date().toLocaleDateString('fr-FR'), { align: 'center' });
    
    // ============ PAGE 2: SOMMAIRE ============
    doc.addPage();
    doc.fillColor('#000');
    doc.fontSize(24).text('Sommaire', { align: 'center' });
    doc.moveDown(2);
    doc.fontSize(12);
    const sommaire = [
      '1. Synthèse exécutive ............................ p.3',
      '2. Présentation du bien .......................... p.4',
      '3. Diagnostic technique complet .................. p.5',
      '4. Chiffrage travaux détaillé matériel/MO ........ p.8',
      '5. Stratégie de division en lots ................. p.12',
      '6. Étude de marché local ......................... p.14',
      '7. Plan financier et marge ....................... p.16',
      '8. Tableau de financement bancaire ............... p.18',
      '9. Calcul de rentabilité (TRI, marge nette) ...... p.20',
      '10. Analyse SWOT de l\'opération .................. p.22',
      '11. Points de vigilance .......................... p.24',
      '12. Planning sur 18 mois ......................... p.26',
      '13. Annexes (photos, plans) ...................... p.28'
    ];
    sommaire.forEach(line => {
      doc.text(line);
      doc.moveDown(0.5);
    });
    
    // ============ PAGE 3: SYNTHÈSE EXÉCUTIVE ============
    doc.addPage();
    doc.fontSize(20).fillColor('#1a3a5c').text('1. Synthèse exécutive');
    doc.moveDown();
    doc.fontSize(10).fillColor('#000');
    
    // Tableau synthèse
    const FRAIS_NOTAIRE_MB = 0.03;
    const prix = parseFloat(prix_demande) || 0;
    const fraisNotaire = Math.round(prix * FRAIS_NOTAIRE_MB);
    
    doc.text(`💰 Prix d'acquisition: ${prix.toLocaleString('fr-FR')} €`);
    doc.text(`📋 Frais notaire MB (3% art.1115 CGI): ${fraisNotaire.toLocaleString('fr-FR')} €`);
    doc.text(`🏢 Stratégie: ${strategie}`);
    doc.text(`📊 Nombre de lots: ${nb_lots}`);
    doc.moveDown();
    
    doc.fontSize(11).fillColor('#d32f2f').text('⚠️ AVERTISSEMENT FRAIS NOTAIRE');
    doc.fontSize(9).fillColor('#000').text(
      'Les frais notaire MB de 3% s\'appliquent UNIQUEMENT avec engagement de revente sous 5 ans ' +
      '(article 1115 du Code Général des Impôts). Si le bien n\'est pas revendu dans ce délai, ' +
      'rattrapage des droits classiques (5-6%) + intérêts de retard.'
    );
    
    doc.addPage();
    doc.fontSize(20).fillColor('#1a3a5c').text('Analyse IA détaillée');
    doc.moveDown();
    doc.fontSize(9).fillColor('#000').text(analysis || '', { align: 'justify' });
    
    doc.end();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===================================================================
// AUTHENTIFICATION (basique pour démo)
// ===================================================================

const users = new Map(); // En production: vraie BDD

app.post('/api/auth/signup', (req, res) => {
  const { email, password, plan = 'gratuit' } = req.body;
  if (users.has(email)) {
    return res.status(400).json({ error: 'Email déjà utilisé' });
  }
  users.set(email, { email, password, plan, created: new Date() });
  res.json({ success: true, token: 'demo-token-' + Date.now() });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = users.get(email);
  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Identifiants invalides' });
  }
  res.json({ success: true, token: 'demo-token-' + Date.now(), plan: user.plan });
});

// ===================================================================
// CALCULATEUR MARGE MB (utilitaire)
// ===================================================================

app.post('/api/calc/marge-mb', (req, res) => {
  const {
    prix_achat,
    travaux_total,
    frais_financiers = 0,
    frais_commerce = 0,
    honoraires = 0,
    prix_revente_total,
    is_taux = 0.25
  } = req.body;

  // Frais notaire MB: 3% (article 1115 CGI)
  const frais_notaire = Math.round(prix_achat * 0.03);
  
  const total_engage = prix_achat + frais_notaire + travaux_total + 
                       frais_financiers + frais_commerce + honoraires;
  
  const marge_brute = prix_revente_total - total_engage;
  const marge_nette = Math.round(marge_brute * (1 - is_taux));
  const rentabilite = ((marge_nette / total_engage) * 100).toFixed(2);
  
  res.json({
    prix_achat,
    frais_notaire_3pct: frais_notaire,
    travaux_total,
    frais_financiers,
    frais_commerce,
    honoraires,
    total_engage,
    prix_revente_total,
    marge_brute,
    marge_nette,
    rentabilite_pct: rentabilite,
    avertissement: "Frais notaire MB 3% valable avec engagement revente <5 ans (art.1115 CGI)"
  });
});

// ===================================================================
// SANTÉ DE L'API
// ===================================================================

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    version: '2.0',
    modes: ['visite', 'reparation', 'agent', 'marchand'],
    timestamp: new Date().toISOString()
  });
});

// ===================================================================
// DÉMARRAGE
// ===================================================================
app.post('/api/pdf/reparation', async (req, res) => {
  try {
    const { analysis, description, date } = req.body;
    
    if (!analysis) {
      return res.status(400).json({ error: 'Analyse manquante' });
    }
    
    // Génération du PDF avec PDFKit
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      info: {
        Title: 'Guide Réparation RénoExpert',
        Author: 'RénoExpert',
        Subject: 'Guide pratique de réparation'
      }
    });
    
    // Headers HTTP pour téléchargement PDF
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="guide-reparation.pdf"');
    
    doc.pipe(res);
    
    // ============== EN-TÊTE ==============
    // Bandeau bleu en haut
    doc.rect(0, 0, doc.page.width, 80).fill('#0066ff');
    
    // Logo / Titre
    doc.fillColor('white')
       .fontSize(24)
       .font('Helvetica-Bold')
       .text('RénoExpert', 50, 25);
    
    doc.fontSize(11)
       .font('Helvetica')
       .text('Guide pratique de réparation', 50, 55);
    
    // Date à droite
    doc.fontSize(10)
       .text(date || new Date().toLocaleDateString('fr-FR'), 50, 25, {
         align: 'right',
         width: doc.page.width - 100
       });
    
    // ============== BANDEAU CONSEILS ==============
    doc.fillColor('#0a0e27').fontSize(11);
    doc.moveDown(3);
    
    // Encadré "À lire avant de commencer"
    const yStart = doc.y + 10;
    doc.rect(50, yStart, doc.page.width - 100, 60)
       .fillAndStroke('#fff4e6', '#ffaa00');
    
    doc.fillColor('#c25a00')
       .fontSize(11)
       .font('Helvetica-Bold')
       .text('⚠️ À LIRE AVANT DE COMMENCER', 60, yStart + 10);
    
    doc.fillColor('#5e6987')
       .fontSize(9)
       .font('Helvetica')
       .text('• Coupez l\'électricité et l\'eau si nécessaire\n• Portez les EPI adaptés (gants, lunettes, masque)\n• En cas de doute, faites appel à un professionnel', 60, yStart + 27, {
         width: doc.page.width - 120,
         lineGap: 2
       });
    
    doc.y = yStart + 80;
    doc.moveDown();
    
    // ============== DESCRIPTION DU PROBLÈME ==============
    if (description && description.trim()) {
      doc.fillColor('#0066ff')
         .fontSize(13)
         .font('Helvetica-Bold')
         .text('📋 Problème signalé');
      
      doc.moveDown(0.5);
      doc.fillColor('#0a0e27')
         .fontSize(10)
         .font('Helvetica')
         .text(description, {
           width: doc.page.width - 100,
           lineGap: 3
         });
      
      doc.moveDown();
    }
    
    // ============== CONTENU ANALYSE ==============
    doc.fillColor('#0066ff')
       .fontSize(13)
       .font('Helvetica-Bold')
       .text('🔧 Diagnostic & procédure de réparation');
    
    doc.moveDown(0.5);
    
    // Traitement du markdown simple
    const lines = analysis.split('\n');
    
    for (let line of lines) {
      // Vérifier si on doit passer à la page suivante
      if (doc.y > doc.page.height - 100) {
        doc.addPage();
      }
      
      line = line.trim();
      if (!line) {
        doc.moveDown(0.3);
        continue;
      }
      
      // Titre H1 (#)
      if (line.startsWith('# ')) {
        doc.moveDown(0.3);
        doc.fillColor('#0052cc')
           .fontSize(14)
           .font('Helvetica-Bold')
           .text(line.replace(/^#\s+/, ''), { width: doc.page.width - 100 });
        doc.moveDown(0.2);
      }
      // Titre H2 (##)
      else if (line.startsWith('## ')) {
        doc.moveDown(0.3);
        doc.fillColor('#0066ff')
           .fontSize(12)
           .font('Helvetica-Bold')
           .text(line.replace(/^##\s+/, ''), { width: doc.page.width - 100 });
        doc.moveDown(0.2);
      }
      // Titre H3 (###)
      else if (line.startsWith('### ')) {
        doc.fillColor('#4d94ff')
           .fontSize(11)
           .font('Helvetica-Bold')
           .text(line.replace(/^###\s+/, ''), { width: doc.page.width - 100 });
        doc.moveDown(0.2);
      }
      // Liste à puces
      else if (line.startsWith('- ') || line.startsWith('• ') || line.startsWith('* ')) {
        const text = line.replace(/^[\-•\*]\s+/, '');
        doc.fillColor('#0a0e27')
           .fontSize(10)
           .font('Helvetica')
           .text('• ' + text.replace(/\*\*(.*?)\*\*/g, '$1'), 
             50, doc.y, 
             { width: doc.page.width - 100, indent: 10, lineGap: 2 });
      }
      // Texte normal
      else {
        // Retire le markdown gras **texte**
        const cleanLine = line.replace(/\*\*(.*?)\*\*/g, '$1');
        doc.fillColor('#0a0e27')
           .fontSize(10)
           .font('Helvetica')
           .text(cleanLine, { width: doc.page.width - 100, lineGap: 2 });
      }
    }
    
    // ============== PIED DE PAGE ==============
    // Ajouter pied de page sur la dernière page
    doc.moveDown(2);
    
    if (doc.y > doc.page.height - 100) {
      doc.addPage();
    }
    
    // Ligne séparation
    doc.moveTo(50, doc.y)
       .lineTo(doc.page.width - 50, doc.y)
       .strokeColor('#e1e8f5')
       .stroke();
    
    doc.moveDown(0.5);
    
    doc.fillColor('#5e6987')
       .fontSize(9)
       .font('Helvetica-Oblique')
       .text('Ce guide a été généré par RénoExpert - L\'IA des pros du bâtiment.', { align: 'center' });
    
    doc.fontSize(8)
       .text('Les recommandations sont indicatives. En cas de travaux importants ou de doute, consultez un professionnel qualifié.', { align: 'center' });
    
    doc.moveDown(0.3);
    doc.fontSize(8).text('© RénoExpert ' + new Date().getFullYear() + ' - renoexpert.fr', { align: 'center' });
    
    // Fin du document
    doc.end();
    
  } catch (error) {
    console.error('Erreur PDF Réparation:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===================================================================
// ROUTES HISTORIQUE DES PROJETS
// Sauvegarde et récupération des analyses de chaque utilisateur
// ===================================================================

// Stockage simple en mémoire (suffisant pour démarrer)
// ⚠️ Note : les données se perdent si Railway redémarre le serveur
// Pour persistence permanente, utiliser PostgreSQL plus tard
const projetsDB = {};  // { userId: [projets] }

// ===== SAUVEGARDER UN PROJET =====
app.post('/api/projets/save', (req, res) => {
  try {
    const {
      userId,        // identifiant utilisateur (email ou ID navigateur)
      mode,          // 'visite', 'reparation', 'agent', 'marchand'
      titre,         // titre du projet (ex: "Maison Compiègne")
      analysis,      // texte de l'analyse
      data           // toutes les autres données (location, surface, etc.)
    } = req.body;
    
    if (!userId || !mode || !analysis) {
      return res.status(400).json({ error: 'Données manquantes' });
    }
    
    if (!projetsDB[userId]) {
      projetsDB[userId] = [];
    }
    
    const projet = {
      id: Date.now().toString(),
      userId,
      mode,
      titre: titre || `Projet ${mode} ${new Date().toLocaleDateString('fr-FR')}`,
      analysis,
      data: data || {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    projetsDB[userId].unshift(projet);  // Ajouter en début
    
    // Limite à 50 projets par utilisateur
    if (projetsDB[userId].length > 50) {
      projetsDB[userId] = projetsDB[userId].slice(0, 50);
    }
    
    res.json({
      success: true,
      projet_id: projet.id,
      total_projets: projetsDB[userId].length
    });
    
  } catch (error) {
    console.error('Erreur save projet:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===== LISTER LES PROJETS D'UN UTILISATEUR =====
app.get('/api/projets/list', (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) {
      return res.status(400).json({ error: 'userId manquant' });
    }
    
    const projets = projetsDB[userId] || [];
    
    // Renvoie juste les infos résumées (pas l'analyse complète)
    const liste = projets.map(p => ({
      id: p.id,
      mode: p.mode,
      titre: p.titre,
      created_at: p.created_at,
      location: p.data.location || '',
      surface: p.data.surface || '',
      preview: p.analysis.substring(0, 150) + '...'
    }));
    
    res.json({
      success: true,
      total: liste.length,
      projets: liste
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== RÉCUPÉRER UN PROJET COMPLET =====
app.get('/api/projets/:id', (req, res) => {
  try {
    const userId = req.query.userId;
    const projetId = req.params.id;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId manquant' });
    }
    
    const projets = projetsDB[userId] || [];
    const projet = projets.find(p => p.id === projetId);
    
    if (!projet) {
      return res.status(404).json({ error: 'Projet non trouvé' });
    }
    
    res.json({ success: true, projet });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== SUPPRIMER UN PROJET =====
app.delete('/api/projets/:id', (req, res) => {
  try {
    const userId = req.query.userId;
    const projetId = req.params.id;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId manquant' });
    }
    
    if (!projetsDB[userId]) {
      return res.status(404).json({ error: 'Aucun projet' });
    }
    
    const initialLength = projetsDB[userId].length;
    projetsDB[userId] = projetsDB[userId].filter(p => p.id !== projetId);
    
    if (projetsDB[userId].length === initialLength) {
      return res.status(404).json({ error: 'Projet non trouvé' });
    }
    
    res.json({
      success: true,
      remaining: projetsDB[userId].length
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.listen(PORT, () => {
  console.log(`🚀 RénoExpert v2.0 backend démarré sur le port ${PORT}`);
  console.log(`📋 4 modes actifs: Visite, Réparation, Agent, Marchand`);
  console.log(`💰 Frais notaire MB: 3% (article 1115 CGI)`);
});

module.exports = app;
