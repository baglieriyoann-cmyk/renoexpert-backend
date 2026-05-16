// ============================================================
// pdfGenerator.js v3.5 - Style Canva pastel élégant
// ============================================================
// Inspiration : compte-rendus Canva avec couleurs pastel douces
// Palette : vert menthe, jaune crème, rose corail, rose poudré
// ============================================================

const PDFDocument = require('pdfkit');

// ============================================================
// PALETTE COULEURS (style Canva pastel)
// ============================================================
const COLORS = {
  // Couleurs principales pastel (style Canva)
  mintGreen: '#A8E5C5',      // Vert menthe pastel
  mintGreenBg: '#E8F7EF',
  mintGreenDark: '#2D8959',
  
  creamYellow: '#FFE9A8',    // Jaune crème
  creamYellowBg: '#FFF8DD',
  creamYellowDark: '#B8860B',
  
  coralRed: '#FF9595',       // Rouge corail
  coralRedBg: '#FFEAEA',
  coralRedDark: '#C53030',
  
  powderPink: '#FFC2D1',     // Rose poudré
  powderPinkBg: '#FFE8EE',
  powderPinkDark: '#B83257',
  
  skyBlue: '#A8D5FF',        // Bleu ciel
  skyBlueBg: '#E8F2FF',
  skyBlueDark: '#0066CC',
  
  // Couleurs neutres
  bgCream: '#F5F1ED',        // Fond beige crème (comme la photo)
  bgWhite: '#FFFFFF',
  bgLight: '#FAFAFA',
  
  textDark: '#1a1a1a',       // Texte titre (noir profond)
  textPrimary: '#2c2c2c',
  textSecondary: '#5e5e5e',
  textMuted: '#9a9a9a',
  
  borderLight: '#E5E2DD',
  divider: '#D5D2CD'
};

const LAYOUT = {
  pageWidth: 595.28,
  pageHeight: 841.89,
  margin: 45,
  contentWidth: 505.28
};

// ============================================================
// SIMPLIFIER LE LANGAGE (no DIY)
// ============================================================
function simplifyTerms(text) {
  if (!text) return '';
  return text
    .replace(/\bDIY\b/gi, 'Faire soi-même')
    .replace(/débutant DIY/gi, 'Bricoleur débutant')
    .replace(/DIY confirmé/gi, 'Bricoleur confirmé')
    .replace(/DIY débutant/gi, 'Bricoleur débutant')
    .replace(/Pro recommandé/gi, 'Faire faire par un artisan');
}

// ============================================================
// GESTION EMOJIS (PDFKit ne les supporte pas en standard)
// ============================================================
function emojiToText(text) {
  if (!text) return '';
  const map = {
    '🏠': '', '🔧': '', '💼': '', '🏢': '', '📍': '', '📐': '',
    '📅': '', '✅': '✓', '❌': '✗', '⚠️': '!', '⚠': '!',
    '💡': '', '🛡️': '', '💰': '', '🟢': '●', '🟡': '●', '🔴': '●',
    '📋': '', '📝': '', '🎯': '', '👍': '', '👎': '', '📊': '',
    '🤖': '', '⭐': '★', '✨': '', '🎁': '', '🚀': '', '📞': '',
    '📧': '', '👤': '', '🔨': '', '🛠️': '', '🏘️': '', '⚖️': '',
    '€': 'EUR'
  };
  let result = text;
  for (const [e, r] of Object.entries(map)) {
    result = result.split(e).join(r);
  }
  // Nettoyer le reste des emojis Unicode
  return result
    .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu, '')
    .replace(/[\u{1F000}-\u{1F2FF}]/gu, '')
    .replace(/[\u{1F100}-\u{1F1FF}]/gu, '')
    .trim();
}

// ============================================================
// HELPERS DE DESSIN
// ============================================================

function fillBackground(doc) {
  doc.rect(0, 0, LAYOUT.pageWidth, LAYOUT.pageHeight).fill(COLORS.bgCream);
}

function ensureSpace(doc, neededHeight) {
  const bottomMargin = 60;
  if (doc.y + neededHeight > LAYOUT.pageHeight - bottomMargin) {
    doc.addPage();
    fillBackground(doc);
    doc.y = LAYOUT.margin;
    return true;
  }
  return false;
}

// Carte info avec couleur de fond pastel + petite icône cercle
function drawColoredCard(doc, options) {
  const { title, content, bgColor, accentColor, textColor, icon } = options;
  
  ensureSpace(doc, 80);
  
  const startY = doc.y;
  
  // Calculer la hauteur nécessaire
  doc.fontSize(10).font('Helvetica');
  const contentHeight = content ? doc.heightOfString(emojiToText(content), { 
    width: LAYOUT.contentWidth - 60 
  }) : 0;
  const titleHeight = title ? 22 : 0;
  const cardHeight = titleHeight + contentHeight + 30;
  
  ensureSpace(doc, cardHeight + 10);
  
  // Carte avec coins arrondis
  doc.roundedRect(LAYOUT.margin, startY, LAYOUT.contentWidth, cardHeight, 12)
     .fill(bgColor);
  
  // Petit cercle accent à gauche (décoration)
  const dotColor = textColor || COLORS.textDark;
  doc.circle(LAYOUT.margin + 22, startY + 22, 5).fillOpacity(0.4).fill(dotColor).fillOpacity(1);
  doc.circle(LAYOUT.margin + 22, startY + 22, 3).fill(dotColor);
  
  let textY = startY + 16;
  
  // Titre
  if (title) {
    doc.fillColor(textColor || COLORS.textDark)
       .fontSize(11).font('Helvetica-Bold')
       .text(emojiToText(title).toUpperCase(), LAYOUT.margin + 38, textY, { 
         width: LAYOUT.contentWidth - 56,
         characterSpacing: 0.5
       });
    textY += 18;
  }
  
  // Contenu
  if (content) {
    doc.fillColor(COLORS.textPrimary)
       .fontSize(10).font('Helvetica')
       .text(emojiToText(content), LAYOUT.margin + 38, textY, { 
         width: LAYOUT.contentWidth - 56,
         lineGap: 2
       });
  }
  
  doc.y = startY + cardHeight + 14;
}

// Tableau d'en-tête style Canva (4 colonnes colorées)
function drawCanvaHeaderTable(doc, columns) {
  ensureSpace(doc, 140);
  
  const startY = doc.y;
  const colCount = columns.length;
  const gap = 4;
  const colWidth = (LAYOUT.contentWidth - (gap * (colCount - 1))) / colCount;
  const titleHeight = 38;
  const contentHeight = 90;
  
  columns.forEach((col, i) => {
    const x = LAYOUT.margin + (i * (colWidth + gap));
    
    // Header coloré
    doc.roundedRect(x, startY, colWidth, titleHeight, 8).fill(col.headerColor);
    
    doc.fillColor(COLORS.textDark)
       .fontSize(10).font('Helvetica-Bold')
       .text(emojiToText(col.title), x, startY + 13, { 
         width: colWidth,
         align: 'center',
         lineBreak: false
       });
    
    // Contenu blanc dessous
    doc.roundedRect(x, startY + titleHeight + 4, colWidth, contentHeight, 8)
       .fill(col.contentBg || COLORS.bgWhite);
    
    // Texte du contenu
    doc.fillColor(COLORS.textPrimary)
       .fontSize(9).font('Helvetica');
    
    if (Array.isArray(col.content)) {
      // Liste à puces
      let contentY = startY + titleHeight + 14;
      col.content.forEach(item => {
        doc.circle(x + 12, contentY + 4, 1.5).fill(COLORS.textPrimary);
        doc.fillColor(COLORS.textPrimary)
           .text(emojiToText(item), x + 18, contentY, { 
             width: colWidth - 22,
             lineGap: 1
           });
        contentY = doc.y + 4;
      });
    } else {
      // Texte simple centré
      doc.text(emojiToText(col.content || ''), x + 8, startY + titleHeight + 20, { 
        width: colWidth - 16,
        align: 'center',
        lineGap: 2
      });
    }
  });
  
  doc.y = startY + titleHeight + 4 + contentHeight + 18;
}

// Badge de niveau
function drawLevelBadge(doc, level) {
  const levels = {
    low: { bg: COLORS.mintGreenBg, color: COLORS.mintGreenDark, text: 'Niveau faible — Pas d\'urgence' },
    medium: { bg: COLORS.creamYellowBg, color: COLORS.creamYellowDark, text: 'Niveau modéré — A traiter' },
    high: { bg: COLORS.coralRedBg, color: COLORS.coralRedDark, text: 'Niveau urgent — Action immédiate' }
  };
  
  const l = levels[level] || levels.medium;
  const text = l.text;
  doc.fontSize(10);
  const textWidth = doc.widthOfString(text);
  const badgeWidth = textWidth + 30;
  
  doc.roundedRect(LAYOUT.margin, doc.y, badgeWidth, 26, 13).fill(l.bg);
  doc.fillColor(l.color).fontSize(10).font('Helvetica-Bold')
     .text(text, LAYOUT.margin + 15, doc.y + 8);
  doc.y += 36;
}

// Tableau classique pour données - VERSION AMÉLIORÉE PLUS VISUELLE
function drawDataTable(doc, headers, rows) {
  const colCount = headers.length;
  const colWidth = LAYOUT.contentWidth / colCount;
  const rowHeight = 34;
  const headerHeight = 38;
  
  // Détecter si c'est un tableau "TOTAL" (dernière ligne souvent en gras)
  const totalHeight = headerHeight + (rows.length * rowHeight) + 10;
  
  ensureSpace(doc, totalHeight + 10);
  
  const startY = doc.y;
  
  // Détection des lignes "TOTAL" pour mise en valeur
  const isTotalRow = (row) => {
    const firstCell = (row[0] || '').toLowerCase();
    return firstCell.includes('total') || firstCell.includes('**');
  };
  
  // Header avec dégradé vert menthe
  doc.roundedRect(LAYOUT.margin, startY, LAYOUT.contentWidth, headerHeight, 10)
     .fill(COLORS.mintGreen);
  
  headers.forEach((header, i) => {
    const cleanHeader = emojiToText(header).replace(/\*\*/g, '');
    doc.fillColor(COLORS.textDark).fontSize(10).font('Helvetica-Bold')
       .text(cleanHeader, LAYOUT.margin + 14 + (i * colWidth), startY + 14, { 
         width: colWidth - 28,
         lineBreak: true,
         characterSpacing: 0.2
       });
  });
  
  // Lignes alternées
  let currentY = startY + headerHeight;
  rows.forEach((row, rowIdx) => {
    const isTotal = isTotalRow(row);
    
    // Background
    if (isTotal) {
      // Ligne TOTAL en jaune crème (mise en valeur)
      doc.roundedRect(LAYOUT.margin, currentY, LAYOUT.contentWidth, rowHeight, 0)
         .fill(COLORS.creamYellowBg);
    } else if (rowIdx % 2 === 0) {
      doc.rect(LAYOUT.margin, currentY, LAYOUT.contentWidth, rowHeight).fill(COLORS.bgWhite);
    } else {
      doc.rect(LAYOUT.margin, currentY, LAYOUT.contentWidth, rowHeight).fill('#FBFBF8');
    }
    
    row.forEach((cell, i) => {
      const cleanCell = emojiToText((cell || '').toString()).replace(/\*\*/g, '');
      doc.fillColor(isTotal ? COLORS.textDark : COLORS.textPrimary)
         .fontSize(isTotal ? 11 : 10)
         .font(isTotal ? 'Helvetica-Bold' : 'Helvetica')
         .text(cleanCell, LAYOUT.margin + 14 + (i * colWidth), currentY + 12, { 
           width: colWidth - 28,
           lineBreak: false,
           ellipsis: true
         });
    });
    
    currentY += rowHeight;
  });
  
  // Bordure extérieure arrondie
  doc.roundedRect(LAYOUT.margin, startY, LAYOUT.contentWidth, currentY - startY, 10)
     .lineWidth(1).stroke(COLORS.borderLight);
  
  // Petite ligne décorative finale sous le tableau
  doc.y = currentY + 4;
  const lineY = doc.y;
  doc.moveTo(LAYOUT.margin + 20, lineY)
     .lineTo(LAYOUT.margin + 60, lineY)
     .strokeColor(COLORS.mintGreen).lineWidth(2).stroke();
  
  doc.y = currentY + 18;
}

// Étape numérotée style Canva amélioré - DANS UNE CARTE LÉGÈRE
function drawNumberedStep(doc, number, title, content) {
  ensureSpace(doc, 80);
  
  const startY = doc.y;
  
  // Cercle numéroté coloré (alternance de couleurs)
  const stepColors = [COLORS.mintGreen, COLORS.creamYellow, COLORS.coralRed, COLORS.powderPink, COLORS.skyBlue];
  const colorIndex = (parseInt(number) - 1) % stepColors.length;
  const stepColor = stepColors[colorIndex];
  
  // Calculer la hauteur de la carte
  doc.fontSize(10).font('Helvetica');
  const contentHeight = content ? doc.heightOfString(emojiToText(content), { 
    width: LAYOUT.contentWidth - 56,
    lineGap: 4
  }) : 0;
  const cardHeight = 32 + contentHeight + 16;
  
  ensureSpace(doc, cardHeight + 10);
  
  // Carte légère blanche autour de l'étape
  doc.roundedRect(LAYOUT.margin, startY, LAYOUT.contentWidth, cardHeight, 10)
     .fill(COLORS.bgWhite);
  
  // Barre de couleur à gauche (accent)
  doc.roundedRect(LAYOUT.margin, startY, 4, cardHeight, 2).fill(stepColor);
  
  // Ombre subtile derrière le cercle (effet pro)
  doc.circle(LAYOUT.margin + 31, startY + 19, 16).fillOpacity(0.1).fill(COLORS.textDark).fillOpacity(1);
  
  // Cercle principal avec le numéro
  doc.circle(LAYOUT.margin + 30, startY + 18, 15).fill(stepColor);
  doc.fillColor(COLORS.textDark).fontSize(13).font('Helvetica-Bold')
     .text(String(number), LAYOUT.margin + 24, startY + 11, { width: 13, align: 'center' });
  
  // Titre de l'étape
  doc.fillColor(COLORS.textDark).fontSize(12).font('Helvetica-Bold')
     .text(emojiToText(title), LAYOUT.margin + 56, startY + 12, { 
       width: LAYOUT.contentWidth - 64
     });
  
  // Contenu de l'étape avec plus d'espace
  if (content) {
    doc.fillColor(COLORS.textPrimary).fontSize(10).font('Helvetica')
       .text(emojiToText(content), LAYOUT.margin + 56, startY + 36, { 
         width: LAYOUT.contentWidth - 64,
         lineGap: 4
       });
  }
  
  doc.y = startY + cardHeight + 12;
}

// ============================================================
// RENDU DU MARKDOWN AVEC NOUVEAU STYLE
// ============================================================
function renderContent(doc, text) {
  if (!text) return;
  
  const lines = text.split('\n');
  let inTable = false;
  let tableHeaders = [];
  let tableRows = [];
  let stepCounter = 0;
  
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const trimmed = line.trim();
    
    // Tableaux markdown
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const cells = trimmed.split('|').filter(c => c.trim() !== '').map(c => c.trim());
      if (trimmed.match(/^\|[\s\-:|]+\|$/)) continue;
      
      if (!inTable) {
        inTable = true;
        tableHeaders = cells;
      } else {
        tableRows.push(cells);
      }
      continue;
    } else if (inTable) {
      drawDataTable(doc, tableHeaders, tableRows);
      inTable = false;
      tableHeaders = [];
      tableRows = [];
    }
    
    if (!trimmed) {
      doc.moveDown(0.3);
      continue;
    }
    
    if (trimmed === '---') {
      doc.moveDown(0.5);
      doc.moveTo(LAYOUT.margin + 80, doc.y)
         .lineTo(LAYOUT.pageWidth - LAYOUT.margin - 80, doc.y)
         .strokeColor(COLORS.divider).lineWidth(1).dash(2, { space: 4 }).stroke().undash();
      doc.moveDown(0.5);
      continue;
    }
    
    ensureSpace(doc, 30);
    
    // Titre H1
    if (trimmed.startsWith('# ')) {
      const titleText = emojiToText(trimmed.replace(/^#\s+/, ''));
      doc.moveDown(0.5);
      ensureSpace(doc, 40);
      
      doc.fillColor(COLORS.textDark).fontSize(20).font('Helvetica-Bold')
         .text(titleText, LAYOUT.margin, doc.y, { width: LAYOUT.contentWidth });
      
      doc.moveDown(0.3);
    }
    // Titre H2 (avec petit carré de couleur à gauche)
    else if (trimmed.startsWith('## ')) {
      const titleText = emojiToText(trimmed.replace(/^##\s+/, ''));
      doc.moveDown(0.3);
      ensureSpace(doc, 30);
      
      const titleY = doc.y;
      // Petit carré coloré à gauche du titre (alternance)
      const accentColors = [COLORS.mintGreen, COLORS.creamYellow, COLORS.coralRed, COLORS.powderPink];
      const accentColor = accentColors[Math.floor(Math.random() * accentColors.length)];
      doc.roundedRect(LAYOUT.margin, titleY + 4, 4, 16, 2).fill(accentColor);
      
      doc.fillColor(COLORS.textDark).fontSize(13).font('Helvetica-Bold')
         .text(titleText.toUpperCase(), LAYOUT.margin + 12, titleY, { 
           width: LAYOUT.contentWidth - 12,
           characterSpacing: 0.3
         });
      doc.moveDown(0.4);
    }
    // Titre H3 - Étapes ou sous-section
    else if (trimmed.startsWith('### ')) {
      const titleText = emojiToText(trimmed.replace(/^###\s+/, ''));
      
      if (titleText.match(/^Étape \d+/i) || titleText.match(/^Etape \d+/i)) {
        stepCounter++;
        const cleanTitle = titleText.replace(/^Étape \d+\s*:\s*/i, '').replace(/^Etape \d+\s*:\s*/i, '');
        
        // Collecter le contenu jusqu'à la prochaine ligne ## ou ### ou fin
        let stepContent = '';
        let j = i + 1;
        while (j < lines.length) {
          const next = lines[j].trim();
          if (next.startsWith('## ') || next.startsWith('### ') || next.startsWith('# ') || next === '---') break;
          if (next) stepContent += (stepContent ? ' ' : '') + next;
          j++;
        }
        i = j - 1; // Avancer le pointeur
        
        drawNumberedStep(doc, stepCounter, cleanTitle, stepContent);
      } else {
        doc.fillColor(COLORS.textDark).fontSize(11).font('Helvetica-Bold')
           .text(titleText, LAYOUT.margin, doc.y, { width: LAYOUT.contentWidth });
        doc.moveDown(0.3);
      }
    }
    // Liste à puces - PLUS AÉRÉE
    else if (trimmed.startsWith('- ') || trimmed.startsWith('• ') || trimmed.startsWith('* ')) {
      const itemText = emojiToText(trimmed.replace(/^[\-•\*]\s+/, '').replace(/\*\*(.*?)\*\*/g, '$1'));
      ensureSpace(doc, 22);
      
      const bulletY = doc.y + 7;
      // Puce colorée alternante
      const bulletColors = [COLORS.mintGreen, COLORS.creamYellow, COLORS.coralRed, COLORS.powderPink];
      const bulletColor = bulletColors[Math.floor(Math.random() * bulletColors.length)];
      doc.circle(LAYOUT.margin + 7, bulletY, 3).fill(bulletColor);
      
      doc.fillColor(COLORS.textPrimary).fontSize(10).font('Helvetica')
         .text(itemText, LAYOUT.margin + 20, doc.y, { 
           width: LAYOUT.contentWidth - 24,
           lineGap: 3
         });
      doc.moveDown(0.4);
    }
    // Citation
    else if (trimmed.startsWith('> ')) {
      const quoteText = emojiToText(trimmed.replace(/^>\s+/, '').replace(/\*\*(.*?)\*\*/g, '$1'));
      ensureSpace(doc, 40);
      
      drawColoredCard(doc, {
        title: 'A retenir',
        content: quoteText,
        bgColor: COLORS.creamYellowBg,
        textColor: COLORS.creamYellowDark
      });
    }
    // Texte normal - PLUS AÉRÉ
    else {
      const cleanLine = emojiToText(trimmed.replace(/\*\*(.*?)\*\*/g, '$1'));
      ensureSpace(doc, 18);
      
      doc.fillColor(COLORS.textPrimary).fontSize(10).font('Helvetica')
         .text(cleanLine, LAYOUT.margin, doc.y, { 
           width: LAYOUT.contentWidth,
           lineGap: 4,
           paragraphGap: 6
         });
      doc.moveDown(0.4);
    }
  }
  
  if (inTable && tableHeaders.length) {
    drawDataTable(doc, tableHeaders, tableRows);
  }
}

// ============================================================
// FOOTER avec palette de couleurs (style Canva)
// ============================================================
function drawCanvaFooter(doc) {
  const footerY = LAYOUT.pageHeight - 40;
  
  // Palette de petits carrés colorés à gauche
  const colors = [COLORS.mintGreen, COLORS.creamYellow, COLORS.coralRed, COLORS.powderPink, COLORS.skyBlue];
  colors.forEach((color, i) => {
    doc.roundedRect(LAYOUT.margin + (i * 18), footerY, 14, 14, 2).fill(color);
  });
  
  // Signature italique à droite (style manuscrit "Merci...")
  doc.fillColor(COLORS.textSecondary).fontSize(11).font('Helvetica-Oblique')
     .text('Merci pour votre confiance !', LAYOUT.margin, footerY + 1, { 
       width: LAYOUT.contentWidth, 
       align: 'right' 
     });
  
  // Petite ligne info en dessous
  doc.fillColor(COLORS.textMuted).fontSize(8).font('Helvetica')
     .text('RénoExpert  ·  Diagnostic par intelligence artificielle  ·  renoexpert.fr', 
       LAYOUT.margin, footerY + 18, { 
         width: LAYOUT.contentWidth, 
         align: 'center' 
       });
}

// ============================================================
// PAGE 1 : EN-TÊTE PRINCIPAL STYLE CANVA
// ============================================================
function drawCanvaHeader(doc, options) {
  const { titleMain, titleSub, icon } = options;
  
  // Petite décoration en haut (3 ronds colorés)
  const decoY = 30;
  const centerX = LAYOUT.pageWidth / 2;
  doc.circle(centerX - 24, decoY, 5).fill(COLORS.mintGreen);
  doc.circle(centerX, decoY, 5).fill(COLORS.creamYellow);
  doc.circle(centerX + 24, decoY, 5).fill(COLORS.coralRed);
  
  // Grand titre noir
  doc.fillColor(COLORS.textDark).fontSize(42).font('Helvetica-Bold')
     .text(titleMain, LAYOUT.margin, 60, { 
       width: LAYOUT.contentWidth,
       align: 'center',
       lineGap: -8
     });
  
  // Sous-titre
  doc.fillColor(COLORS.textPrimary).fontSize(16).font('Helvetica')
     .text(titleSub, LAYOUT.margin, doc.y + 4, { 
       width: LAYOUT.contentWidth,
       align: 'center'
     });
  
  // Petite ligne décorative sous le titre
  doc.moveDown(0.8);
  const lineY = doc.y;
  const lineLength = 60;
  const lineStartX = (LAYOUT.pageWidth - lineLength) / 2;
  doc.roundedRect(lineStartX, lineY, lineLength, 3, 1.5).fill(COLORS.textDark);
  doc.y = lineY + 18;
}

// ============================================================
// GÉNÉRATION DES PDFs
// ============================================================

function generateVisitePDF(data, res) {
  const { analysis, location, surface } = data;
  const cleaned = simplifyTerms(analysis);
  
  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, info: { Title: 'Diagnostic Visite - RénoExpert' }});
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="visite-renoexpert.pdf"');
  doc.pipe(res);
  
  fillBackground(doc);
  
  // En-tête style Canva
  drawCanvaHeader(doc, {
    titleMain: 'Diagnostic',
    titleSub: 'Rapport d\'analyse de bien immobilier'
  });
  
  // Tableau d'en-tête coloré 4 colonnes (style Canva)
  drawCanvaHeaderTable(doc, [
    {
      title: 'Type d\'analyse',
      headerColor: COLORS.mintGreen,
      content: 'Diagnostic complet pour visite avant achat'
    },
    {
      title: 'Localisation',
      headerColor: COLORS.creamYellow,
      content: location || 'Non précisée'
    },
    {
      title: 'Surface',
      headerColor: COLORS.coralRed,
      content: surface ? `${surface} m²` : 'Non précisée'
    },
    {
      title: 'Date',
      headerColor: COLORS.powderPink,
      content: new Date().toLocaleDateString('fr-FR')
    }
  ]);
  
  // Présentation
  drawColoredCard(doc, {
    title: 'A propos de ce rapport',
    content: 'Ce diagnostic a été réalisé à partir des photos et données fournies. Il vous aide à identifier les points forts et les vigilances avant votre visite ou décision d\'achat.',
    bgColor: COLORS.mintGreenBg,
    textColor: COLORS.mintGreenDark
  });
  
  // Contenu
  renderContent(doc, cleaned);
  
  // Avertissement
  doc.moveDown(0.5);
  drawColoredCard(doc, {
    title: 'Important',
    content: 'Ce diagnostic est indicatif. Il complète mais ne remplace pas une visite physique avec un professionnel (architecte, expert immobilier, diagnostiqueur certifié).',
    bgColor: COLORS.creamYellowBg,
    textColor: COLORS.creamYellowDark
  });
  
  // Footer sur toutes les pages
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    drawCanvaFooter(doc);
  }
  
  doc.end();
}

function generateReparationPDF(data, res) {
  const { analysis, description } = data;
  const cleaned = simplifyTerms(analysis);
  
  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, info: { Title: 'Guide Réparation - RénoExpert' }});
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="guide-reparation.pdf"');
  doc.pipe(res);
  
  fillBackground(doc);
  
  drawCanvaHeader(doc, {
    titleMain: 'Guide Travaux',
    titleSub: 'Procédure étape par étape pour vos travaux'
  });
  
  drawCanvaHeaderTable(doc, [
    {
      title: 'Type',
      headerColor: COLORS.mintGreen,
      content: 'Guide pratique de réparation'
    },
    {
      title: 'Format',
      headerColor: COLORS.creamYellow,
      content: 'A imprimer ou consulter sur mobile'
    },
    {
      title: 'Date',
      headerColor: COLORS.coralRed,
      content: new Date().toLocaleDateString('fr-FR')
    },
    {
      title: 'Source',
      headerColor: COLORS.powderPink,
      content: 'IA RénoExpert'
    }
  ]);
  
  // Carte sécurité ROUGE en priorité
  drawColoredCard(doc, {
    title: 'A LIRE AVANT DE COMMENCER',
    content: '✓ Coupez l\'électricité et l\'eau si nécessaire\n✓ Portez vos équipements de protection (gants, lunettes, masque)\n✓ Aspirez le chantier à CHAQUE étape — point essentiel\n✓ Vérifiez régulièrement l\'alignement à la règle ou au laser\n✓ En cas de doute, faites appel à un professionnel',
    bgColor: COLORS.coralRedBg,
    textColor: COLORS.coralRedDark
  });
  
  if (description) {
    drawColoredCard(doc, {
      title: 'Votre demande',
      content: description,
      bgColor: COLORS.skyBlueBg,
      textColor: COLORS.skyBlueDark
    });
  }
  
  renderContent(doc, cleaned);
  
  doc.moveDown(0.5);
  drawColoredCard(doc, {
    title: 'Conseil pour réussir',
    content: 'Imprimez ce guide ou gardez-le ouvert sur votre téléphone pendant les travaux. Ne sautez aucune étape de sécurité. Aspirez bien à chaque étape pour garantir une bonne adhérence. En cas de difficulté, n\'hésitez pas à demander conseil à un professionnel.',
    bgColor: COLORS.mintGreenBg,
    textColor: COLORS.mintGreenDark
  });
  
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    drawCanvaFooter(doc);
  }
  
  doc.end();
}

function generateAgentPDF(data, res) {
  const { analysis, agence_nom, agent_nom, location, surface } = data;
  const cleaned = simplifyTerms(analysis);
  
  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, info: { Title: 'Fiche Commerciale - RénoExpert' }});
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="fiche-agent.pdf"');
  doc.pipe(res);
  
  fillBackground(doc);
  
  drawCanvaHeader(doc, {
    titleMain: 'Fiche Commerciale',
    titleSub: `Présentation par ${agence_nom || 'votre agence'}`
  });
  
  drawCanvaHeaderTable(doc, [
    {
      title: 'Agence',
      headerColor: COLORS.mintGreen,
      content: agence_nom || 'Non précisée'
    },
    {
      title: 'Agent',
      headerColor: COLORS.creamYellow,
      content: agent_nom || 'Non précisé'
    },
    {
      title: 'Bien situé',
      headerColor: COLORS.coralRed,
      content: location || 'Non précisé'
    },
    {
      title: 'Surface',
      headerColor: COLORS.powderPink,
      content: surface ? `${surface} m²` : 'N/A'
    }
  ]);
  
  renderContent(doc, cleaned);
  
  doc.moveDown(0.5);
  drawColoredCard(doc, {
    title: 'Contact pour ce bien',
    content: `${agent_nom || 'Votre agent'} — ${agence_nom || 'Agence'}\nPour planifier une visite ou obtenir plus d'informations.`,
    bgColor: COLORS.mintGreenBg,
    textColor: COLORS.mintGreenDark
  });
  
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    drawCanvaFooter(doc);
  }
  
  doc.end();
}

function generateMarchandPDF(data, res) {
  const { analysis, mb_societe, location, surface, prix_demande, nb_lots, strategie } = data;
  const cleaned = simplifyTerms(analysis);
  const prixFormate = prix_demande ? Number(prix_demande).toLocaleString('fr-FR') + ' EUR' : 'N/A';
  
  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, info: { Title: 'Dossier MB - RénoExpert' }});
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="dossier-banque.pdf"');
  doc.pipe(res);
  
  fillBackground(doc);
  
  drawCanvaHeader(doc, {
    titleMain: 'Dossier MB',
    titleSub: 'Étude d\'opération Marchand de Biens — Article 1115 CGI'
  });
  
  drawCanvaHeaderTable(doc, [
    {
      title: 'Société MB',
      headerColor: COLORS.mintGreen,
      content: mb_societe || 'Non précisée'
    },
    {
      title: 'Bien situé',
      headerColor: COLORS.creamYellow,
      content: location || 'Non précisée'
    },
    {
      title: 'Prix demandé',
      headerColor: COLORS.coralRed,
      content: prixFormate
    },
    {
      title: 'Stratégie',
      headerColor: COLORS.powderPink,
      content: strategie || 'N/A'
    }
  ]);
  
  drawColoredCard(doc, {
    title: 'Cadre légal',
    content: 'Opération Marchand de Biens sous régime de l\'article 1115 du CGI : engagement de revente sous 5 ans, frais notaire à 3% du prix d\'achat.',
    bgColor: COLORS.creamYellowBg,
    textColor: COLORS.creamYellowDark
  });
  
  renderContent(doc, cleaned);
  
  doc.moveDown(0.5);
  drawColoredCard(doc, {
    title: 'Mentions légales',
    content: 'Ce dossier est généré à titre indicatif sur la base des informations transmises. Il ne constitue pas un conseil financier, juridique ou fiscal. Une expertise complète sur site et la validation par un professionnel (expert-comptable, notaire, banque) sont indispensables avant toute décision d\'investissement.',
    bgColor: COLORS.coralRedBg,
    textColor: COLORS.coralRedDark
  });
  
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    drawCanvaFooter(doc);
  }
  
  doc.end();
}

module.exports = {
  generateVisitePDF,
  generateReparationPDF,
  generateAgentPDF,
  generateMarchandPDF
};
