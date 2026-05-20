// ============================================================
// pdfGenerator.js v4.0 - Style luxe : Blanc cassé / Marine / Or rosé
// ============================================================
// Inspiration : catalogues immobiliers haut de gamme (Knight Frank,
// Sotheby's). Palette sobre, typographie classique, accents dorés.
// ============================================================

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

// ============================================================
// LOGO (en-tête PDF)
// ============================================================
// Le logo horizontal marine/or est cherché dans le même dossier que ce fichier.
// Si absent, drawCanvaHeader() retombe automatiquement sur l'ancien rendu
// (bandeau marine + libellé doré lettré) sans casser le PDF.
const LOGO_CANDIDATES = [
  'renoexpert-horizontal-800x213.png',
  'renoexpert-horizontal-1600x426.png',
  'renoexpert-horizontal-400x106.png'
];
const LOGO_PATH = (() => {
  for (const name of LOGO_CANDIDATES) {
    const p = path.join(__dirname, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
})();
if (LOGO_PATH) {
  console.log('[pdfGenerator] Logo header trouvé :', path.basename(LOGO_PATH));
} else {
  console.log('[pdfGenerator] Aucun logo header trouvé — fallback bandeau marine');
}

// ============================================================
// PALETTE LUXE
// ============================================================
const COLORS = {
  // Fonds
  bg: '#FAFAF7',          // Blanc cassé principal
  bgPaper: '#FFFFFF',     // Papier pur (cartes)
  bgSoft: '#F2EEE4',      // Crème légère (cartes accent)
  bgMuted: '#E8E3D6',     // Beige plus prononcé (totaux)

  // Marine
  navy: '#0F1F3D',
  navyDeep: '#0A1530',
  navyLight: '#1F3358',

  // Or rosé
  gold: '#C9A961',
  goldLight: '#E0CB8E',
  goldDark: '#9A7E3C',

  // Texte
  textDark: '#0A0A0A',
  textPrimary: '#1A1A1A',
  textSecondary: '#4A4A4A',
  textMuted: '#8A8A8A',
  textOnNavy: '#FAFAF7',

  // Filets / séparateurs
  borderLight: '#E3DFD7',
  borderMid: '#C9C5BB',
  divider: '#C9A961',

  // Compat : anciens noms encore référencés ailleurs dans le fichier
  bgCream: '#FAFAF7',
  bgWhite: '#FFFFFF',
  bgLight: '#F4F1EA',
  mintGreen: '#0F1F3D', mintGreenBg: '#F2EEE4', mintGreenDark: '#0F1F3D',
  creamYellow: '#C9A961', creamYellowBg: '#F4ECD8', creamYellowDark: '#9A7E3C',
  coralRed: '#0F1F3D', coralRedBg: '#EDE7DA', coralRedDark: '#0F1F3D',
  powderPink: '#C9A961', powderPinkBg: '#F4ECD8', powderPinkDark: '#9A7E3C',
  skyBlue: '#1F3358', skyBlueBg: '#ECEFF5', skyBlueDark: '#0F1F3D'
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
// Codepoints Unicode > 0xFF présents dans WinAnsi (CP1252). Tout ce qui sort
// de cette whitelist est purgé : Helvetica + WinAnsi ne sait pas les rendre.
const WIN_ANSI_EXTRAS = new Set([
  0x20AC, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6,
  0x2030, 0x0160, 0x2039, 0x0152, 0x017D, 0x2018, 0x2019, 0x201C,
  0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A,
  0x0153, 0x017E, 0x0178
]);
function emojiToText(text) {
  if (!text) return '';
  const map = {
    // Emojis fréquents : supprimés ou mappés ASCII
    '🏠':'','🔧':'','💼':'','🏢':'','📍':'','📐':'','📅':'',
    '✅':'✓','❌':'✗','⚠️':'!','⚠':'!','💡':'','🛡️':'','💰':'',
    '🟢':'[Niveau faible]','🟡':'[Niveau modéré]','🔴':'[Niveau urgent]',
    '📋':'','📝':'','🎯':'','👍':'','👎':'','📊':'','🤖':'',
    '⭐':'','✨':'','🎁':'','🚀':'','📞':'','📧':'','👤':'',
    '🔨':'','🛠️':'','🏘️':'','⚖️':'',
    // Pictos parquet/sanitaires/jardin qui se rendaient "Ø>Þµ" / "þ"
    '🪵':'','🪟':'','🛁':'','🚿':'','🏊':'','🚗':'','🌳':'',
    '🌿':'','🌞':'','🏡':'','🏖':'','🔆':'','🌟':'',
    // Séparateurs Unicode (origine des "%P%P%P" répétés)
    '━':'','─':'','═':'','╌':'','╍':'','╎':'','╏':'',
    '┃':'','┄':'','┅':'','┆':'','┇':'',
    '▬':'','▔':'','▁':'','▂':'','▃':'','▄':'','▅':'','▆':'','▇':'','█':'',
    // Formes géométriques hors WinAnsi
    '●':'','■':'','▪':'','◆':'','★':'','☆':'',
    '○':'','◯':'','◉':'','◎':'',
    // Guillemets typographiques anglais : ASCII (FR utilise « » qui sont WinAnsi)
    '“':'"','”':'"','‘':"'",'’':"'",
    // Flèches → angles WinAnsi (rendu sobre)
    '→':'›','←':'‹','↑':'^','↓':'v',
    // Math hors WinAnsi
    '≥':'>=','≤':'<=','≠':'!=','≈':'~','×':'x','÷':'/'
    // NB : € œ Œ Ÿ « » … – — ° sont dans WinAnsi → laissés tels quels
  };
  let result = text;
  for (const [e, r] of Object.entries(map)) {
    result = result.split(e).join(r);
  }
  // Filet de sécurité : Helvetica + WinAnsi ne rend que Latin-1 (0x00-0xFF)
  // + un sous-ensemble Unicode (WIN_ANSI_EXTRAS). Le reste produit "%P%P%P",
  // "Ø>Þµ", "þ"… → on purge silencieusement, par codepoint (surrogate-safe).
  let out = '';
  for (const ch of result) {
    const cp = ch.codePointAt(0);
    if (cp <= 0xFF || WIN_ANSI_EXTRAS.has(cp)) out += ch;
  }
  return out.trim();
}

// ============================================================
// HELPERS DE DESSIN
// ============================================================

function fillBackground(doc) {
  doc.rect(0, 0, LAYOUT.pageWidth, LAYOUT.pageHeight).fill(COLORS.bg);
}

// Filet horizontal doré (séparateur sobre)
function drawGoldRule(doc, options) {
  const opts = options || {};
  const y = opts.y != null ? opts.y : doc.y;
  const width = opts.width || 60;
  const x = opts.x != null ? opts.x : (LAYOUT.pageWidth - width) / 2;
  doc.moveTo(x, y).lineTo(x + width, y)
     .strokeColor(COLORS.gold).lineWidth(0.8).stroke();
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

// Carte sobre haut de gamme : fond crème, filet or à gauche, titre marine
function drawColoredCard(doc, options) {
  const { title, content } = options;
  const padX = 22;
  const padY = 16;

  doc.fontSize(10).font('Helvetica');
  const contentHeight = content ? doc.heightOfString(emojiToText(content), {
    width: LAYOUT.contentWidth - (padX * 2)
  }) : 0;
  const titleHeight = title ? 20 : 0;
  const cardHeight = titleHeight + contentHeight + (padY * 2);

  ensureSpace(doc, cardHeight + 10);
  const startY = doc.y;

  // Fond crème léger, coins très peu arrondis (sobriété)
  doc.roundedRect(LAYOUT.margin, startY, LAYOUT.contentWidth, cardHeight, 3)
     .fill(COLORS.bgSoft);

  // Filet or vertical à gauche (signature luxe)
  doc.rect(LAYOUT.margin, startY, 3, cardHeight).fill(COLORS.gold);

  let textY = startY + padY;

  if (title) {
    doc.fillColor(COLORS.navy)
       .fontSize(10).font('Helvetica-Bold')
       .text(emojiToText(title).toUpperCase(), LAYOUT.margin + padX, textY, {
         width: LAYOUT.contentWidth - (padX * 2),
         characterSpacing: 1.2
       });
    textY += titleHeight;
  }

  if (content) {
    doc.fillColor(COLORS.textPrimary)
       .fontSize(10).font('Helvetica')
       .text(emojiToText(content), LAYOUT.margin + padX, textY, {
         width: LAYOUT.contentWidth - (padX * 2),
         lineGap: 3
       });
  }

  doc.y = startY + cardHeight + 14;
}

// Tableau d'en-tête luxe : 4 colonnes encadrées, libellés or, valeurs marine
function drawCanvaHeaderTable(doc, columns) {
  ensureSpace(doc, 140);

  const startY = doc.y;
  const colCount = columns.length;
  const colWidth = LAYOUT.contentWidth / colCount;
  const titleHeight = 30;
  const contentHeight = 80;
  const totalHeight = titleHeight + contentHeight;

  // Cadre extérieur global, filets marine très fins
  doc.rect(LAYOUT.margin, startY, LAYOUT.contentWidth, totalHeight)
     .lineWidth(0.4).strokeColor(COLORS.navy).stroke();

  columns.forEach((col, i) => {
    const x = LAYOUT.margin + (i * colWidth);

    // Séparateurs verticaux internes
    if (i > 0) {
      doc.moveTo(x, startY).lineTo(x, startY + totalHeight)
         .lineWidth(0.3).strokeColor(COLORS.borderMid).stroke();
    }

    // Bande titre : fond marine, texte ivoire en lettres espacées
    doc.rect(x, startY, colWidth, titleHeight).fill(COLORS.navy);
    doc.fillColor(COLORS.textOnNavy)
       .fontSize(8).font('Helvetica-Bold')
       .text(emojiToText(col.title).toUpperCase(), x, startY + 11, {
         width: colWidth,
         align: 'center',
         characterSpacing: 1.5,
         lineBreak: false
       });

    // Filet doré sous le titre (signature)
    doc.moveTo(x + colWidth * 0.35, startY + titleHeight - 0.5)
       .lineTo(x + colWidth * 0.65, startY + titleHeight - 0.5)
       .lineWidth(0.6).strokeColor(COLORS.gold).stroke();

    // Contenu : fond papier
    doc.rect(x, startY + titleHeight, colWidth, contentHeight).fill(COLORS.bgPaper);

    // Texte valeur centré
    const text = Array.isArray(col.content) ? col.content.join('\n') : (col.content || '');
    doc.fillColor(COLORS.textPrimary)
       .fontSize(9).font('Helvetica')
       .text(emojiToText(text), x + 6, startY + titleHeight + 18, {
         width: colWidth - 12,
         align: 'center',
         lineGap: 2
       });
  });

  doc.y = startY + totalHeight + 22;
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
  const headerHeight = 38;
  const bottomMargin = 60;
  const padX = 14;
  const padY = 12;
  
  // Détection des lignes "TOTAL" pour mise en valeur
  const isTotalRow = (row) => {
    const firstCell = (row[0] || '').toLowerCase();
    return firstCell.includes('total') || firstCell.includes('**');
  };
  
  // Calcule la hauteur nécessaire d'une cellule en fonction du contenu (wrap auto)
  const measureRowHeight = (row) => {
    let maxHeight = 0;
    row.forEach((cell, i) => {
      const cleanCell = emojiToText((cell || '').toString()).replace(/\*\*/g, '');
      doc.fontSize(isTotalRow(row) ? 11 : 10)
         .font(isTotalRow(row) ? 'Helvetica-Bold' : 'Helvetica');
      const h = doc.heightOfString(cleanCell, { width: colWidth - (padX * 2) });
      if (h > maxHeight) maxHeight = h;
    });
    return Math.max(28, maxHeight + (padY * 2));
  };
  
  // En-tête : bandeau marine, texte ivoire en lettres espacées
  const drawHeader = (startY) => {
    doc.rect(LAYOUT.margin, startY, LAYOUT.contentWidth, headerHeight)
       .fill(COLORS.navy);

    headers.forEach((header, i) => {
      const cleanHeader = emojiToText(header).replace(/\*\*/g, '');
      doc.fillColor(COLORS.textOnNavy).fontSize(9).font('Helvetica-Bold')
         .text(cleanHeader.toUpperCase(), LAYOUT.margin + padX + (i * colWidth), startY + 14, {
           width: colWidth - (padX * 2),
           lineBreak: true,
           characterSpacing: 1.2
         });
    });

    // Filet doré sous l'en-tête (signature)
    doc.moveTo(LAYOUT.margin, startY + headerHeight)
       .lineTo(LAYOUT.margin + LAYOUT.contentWidth, startY + headerHeight)
       .lineWidth(0.8).strokeColor(COLORS.gold).stroke();
    return startY + headerHeight;
  };
  
  // S'assurer qu'il y a au moins assez de place pour le header + 1 ligne
  ensureSpace(doc, headerHeight + 40);
  
  let startY = doc.y;
  let currentY = drawHeader(startY);
  let tableTopY = startY; // pour tracer la bordure extérieure par page
  
  rows.forEach((row, rowIdx) => {
    const isTotal = isTotalRow(row);
    const rowHeight = measureRowHeight(row);
    
    // Pagination : ferme la bordure courante, saute de page, redessine l'en-tête
    if (currentY + rowHeight > LAYOUT.pageHeight - bottomMargin) {
      doc.rect(LAYOUT.margin, tableTopY, LAYOUT.contentWidth, currentY - tableTopY)
         .lineWidth(0.4).strokeColor(COLORS.navy).stroke();

      doc.addPage();
      fillBackground(doc);
      doc.y = LAYOUT.margin;
      tableTopY = doc.y;
      currentY = drawHeader(tableTopY);
    }

    // Fond de ligne : alternance papier / crème légère, total = beige + filet or
    if (isTotal) {
      doc.rect(LAYOUT.margin, currentY, LAYOUT.contentWidth, rowHeight).fill(COLORS.bgMuted);
      doc.moveTo(LAYOUT.margin, currentY).lineTo(LAYOUT.margin + LAYOUT.contentWidth, currentY)
         .lineWidth(0.6).strokeColor(COLORS.gold).stroke();
    } else if (rowIdx % 2 === 0) {
      doc.rect(LAYOUT.margin, currentY, LAYOUT.contentWidth, rowHeight).fill(COLORS.bgPaper);
    } else {
      doc.rect(LAYOUT.margin, currentY, LAYOUT.contentWidth, rowHeight).fill(COLORS.bg);
    }

    // Cellules
    row.forEach((cell, i) => {
      const cleanCell = emojiToText((cell || '').toString()).replace(/\*\*/g, '');
      doc.fillColor(isTotal ? COLORS.navy : COLORS.textPrimary)
         .fontSize(isTotal ? 10.5 : 10)
         .font(isTotal ? 'Helvetica-Bold' : 'Helvetica')
         .text(cleanCell, LAYOUT.margin + padX + (i * colWidth), currentY + padY, {
           width: colWidth - (padX * 2),
           lineBreak: true
         });
    });

    currentY += rowHeight;
  });

  // Bordure extérieure finale (cadre marine fin)
  doc.rect(LAYOUT.margin, tableTopY, LAYOUT.contentWidth, currentY - tableTopY)
     .lineWidth(0.4).strokeColor(COLORS.navy).stroke();

  doc.y = currentY + 18;
}

// Étape numérotée luxe : cercle marine bordé or, fond papier, filet or
function drawNumberedStep(doc, number, title, content) {
  doc.fontSize(10).font('Helvetica');
  const contentHeight = content ? doc.heightOfString(emojiToText(content), {
    width: LAYOUT.contentWidth - 64,
    lineGap: 4
  }) : 0;
  const cardHeight = 36 + contentHeight + 18;

  ensureSpace(doc, cardHeight + 12);
  const startY = doc.y;

  // Carte papier avec cadre marine fin
  doc.rect(LAYOUT.margin, startY, LAYOUT.contentWidth, cardHeight).fill(COLORS.bgPaper);
  doc.rect(LAYOUT.margin, startY, LAYOUT.contentWidth, cardHeight)
     .lineWidth(0.4).strokeColor(COLORS.borderMid).stroke();

  // Filet or vertical à gauche (signature)
  doc.rect(LAYOUT.margin, startY, 3, cardHeight).fill(COLORS.gold);

  // Cercle marine numéroté + anneau or
  doc.circle(LAYOUT.margin + 30, startY + 22, 16).fill(COLORS.navy);
  doc.circle(LAYOUT.margin + 30, startY + 22, 16).lineWidth(0.8).strokeColor(COLORS.gold).stroke();

  const numStr = String(number);
  const numFontSize = numStr.length >= 2 ? 11 : 13;
  doc.fillColor(COLORS.textOnNavy).fontSize(numFontSize).font('Helvetica-Bold')
     .text(numStr, LAYOUT.margin + 14, startY + 16, {
       width: 32,
       align: 'center',
       lineBreak: false
     });

  // Titre marine en lettres espacées
  doc.fillColor(COLORS.navy).fontSize(11).font('Helvetica-Bold')
     .text(emojiToText(title).toUpperCase(), LAYOUT.margin + 56, startY + 14, {
       width: LAYOUT.contentWidth - 70,
       characterSpacing: 0.8
     });

  // Filet or court sous le titre
  doc.moveTo(LAYOUT.margin + 56, startY + 33)
     .lineTo(LAYOUT.margin + 96, startY + 33)
     .lineWidth(0.6).strokeColor(COLORS.gold).stroke();

  if (content) {
    doc.fillColor(COLORS.textPrimary).fontSize(10).font('Helvetica')
       .text(emojiToText(content), LAYOUT.margin + 56, startY + 40, {
         width: LAYOUT.contentWidth - 70,
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
      const cells = trimmed.slice(1, -1).split('|').map(c => c.trim());
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
    
    // Titre H1 — section principale, marine + filet or
    if (trimmed.startsWith('# ')) {
      const titleText = emojiToText(trimmed.replace(/^#\s+/, ''));
      doc.moveDown(0.6);
      ensureSpace(doc, 48);

      doc.fillColor(COLORS.navy).fontSize(18).font('Helvetica-Bold')
         .text(titleText.toUpperCase(), LAYOUT.margin, doc.y, {
           width: LAYOUT.contentWidth,
           characterSpacing: 1.5
         });
      doc.moveDown(0.15);
      drawGoldRule(doc, { y: doc.y, width: 50, x: LAYOUT.margin });
      doc.moveDown(0.5);
    }
    // Titre H2 — sous-section, libellé marine espacé + filet or à gauche
    else if (trimmed.startsWith('## ')) {
      const titleText = emojiToText(trimmed.replace(/^##\s+/, ''));
      doc.moveDown(0.4);
      ensureSpace(doc, 32);

      const titleY = doc.y;
      // Filet or vertical fin
      doc.rect(LAYOUT.margin, titleY + 3, 2, 16).fill(COLORS.gold);

      doc.fillColor(COLORS.navy).fontSize(12).font('Helvetica-Bold')
         .text(titleText.toUpperCase(), LAYOUT.margin + 10, titleY, {
           width: LAYOUT.contentWidth - 10,
           characterSpacing: 1.2
         });
      doc.moveDown(0.4);
    }
    // Titre H3 - Étapes ou sous-section
    else if (trimmed.startsWith('### ')) {
      const titleText = emojiToText(trimmed.replace(/^###\s+/, ''));

      if (titleText.match(/^Étape \d+/i) || titleText.match(/^Etape \d+/i)) {
        stepCounter++;
        const cleanTitle = titleText.replace(/^Étape \d+\s*:\s*/i, '').replace(/^Etape \d+\s*:\s*/i, '');

        let stepContent = '';
        let j = i + 1;
        while (j < lines.length) {
          const next = lines[j].trim();
          if (next.startsWith('## ') || next.startsWith('### ') || next.startsWith('# ') || next === '---') break;
          if (next) stepContent += (stepContent ? ' ' : '') + next;
          j++;
        }
        i = j - 1;

        drawNumberedStep(doc, stepCounter, cleanTitle, stepContent);
      } else {
        doc.fillColor(COLORS.navy).fontSize(11).font('Helvetica-Bold')
           .text(titleText, LAYOUT.margin, doc.y, {
             width: LAYOUT.contentWidth,
             characterSpacing: 0.4
           });
        doc.moveDown(0.3);
      }
    }
    // Liste à puces — puce carrée or, alignement sobre
    else if (trimmed.startsWith('- ') || trimmed.startsWith('• ') || trimmed.startsWith('* ')) {
      const itemText = emojiToText(trimmed.replace(/^[\-•\*]\s+/, '').replace(/\*\*(.*?)\*\*/g, '$1'));
      ensureSpace(doc, 22);

      // Puce : petit carré or
      doc.rect(LAYOUT.margin + 4, doc.y + 5, 4, 4).fill(COLORS.gold);

      doc.fillColor(COLORS.textPrimary).fontSize(10).font('Helvetica')
         .text(itemText, LAYOUT.margin + 16, doc.y, {
           width: LAYOUT.contentWidth - 20,
           lineGap: 3
         });
      doc.moveDown(0.35);
    }
    // Citation → carte sobre
    else if (trimmed.startsWith('> ')) {
      const quoteText = emojiToText(trimmed.replace(/^>\s+/, '').replace(/\*\*(.*?)\*\*/g, '$1'));
      ensureSpace(doc, 40);

      drawColoredCard(doc, {
        title: 'A retenir',
        content: quoteText
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
function drawCanvaFooter(doc, pageNumber, totalPages) {
  const footerY = LAYOUT.pageHeight - 44;

  // Filet or fin sur toute la largeur, signature luxe
  doc.moveTo(LAYOUT.margin, footerY)
     .lineTo(LAYOUT.margin + LAYOUT.contentWidth, footerY)
     .lineWidth(0.4).strokeColor(COLORS.gold).stroke();

  // Logotype textuel à gauche : marine, lettres espacées
  doc.fillColor(COLORS.navy).fontSize(8).font('Helvetica-Bold')
     .text('RÉNOEXPERT', LAYOUT.margin, footerY + 10, {
       width: 120,
       characterSpacing: 2.5,
       lineBreak: false
     });

  // Tagline centrale
  doc.fillColor(COLORS.textMuted).fontSize(7.5).font('Helvetica-Oblique')
     .text('Diagnostic immobilier par intelligence artificielle   ·   renoexpert.fr',
       LAYOUT.margin, footerY + 11, {
         width: LAYOUT.contentWidth,
         align: 'center',
         characterSpacing: 0.5
       });

  // Pagination à droite
  if (pageNumber && totalPages) {
    doc.fillColor(COLORS.navy).fontSize(8).font('Helvetica-Bold')
       .text(`${pageNumber} / ${totalPages}`, LAYOUT.margin, footerY + 11, {
         width: LAYOUT.contentWidth,
         align: 'right',
         characterSpacing: 1,
         lineBreak: false
       });
  }
}

// ============================================================
// PAGE 1 : EN-TÊTE PRINCIPAL STYLE CANVA
// ============================================================
function drawCanvaHeader(doc, options) {
  const { titleMain, titleSub } = options;
  const centerX = LAYOUT.pageWidth / 2;

  // Bandeau supérieur marine très fin (signature)
  doc.rect(0, 0, LAYOUT.pageWidth, 14).fill(COLORS.navy);

  // Filet or sous le bandeau
  doc.moveTo(0, 14).lineTo(LAYOUT.pageWidth, 14)
     .lineWidth(0.8).strokeColor(COLORS.gold).stroke();

  // --- LOGO (si disponible) ou fallback libellé doré ---
  // Le logo horizontal a un ratio ~3.75:1 (800x213). On le centre horizontalement,
  // largeur ~55% de la page, sous le bandeau supérieur avec un peu d'air.
  let titleY = 60; // valeur par défaut (sans logo, comme l'ancien rendu)

  if (LOGO_PATH) {
    try {
      const logoWidth = 200; // largeur d'affichage en points PDF
      const logoHeight = logoWidth * (213 / 800); // ~53.25 pt
      const logoX = (LAYOUT.pageWidth - logoWidth) / 2;
      const logoY = 22; // sous le bandeau marine, avec marge

      doc.image(LOGO_PATH, logoX, logoY, { width: logoWidth });

      // Le titre principal vient juste sous le logo
      titleY = logoY + logoHeight + 14;
    } catch (e) {
      console.error('[pdfGenerator] Erreur lecture logo, fallback libellé :', e.message);
      // Fallback : libellé doré lettré (rendu historique)
      doc.fillColor(COLORS.gold).fontSize(7).font('Helvetica-Bold')
         .text('R É N O E X P E R T   ·   D O S S I E R   P R O F E S S I O N N E L',
           LAYOUT.margin, 35, {
             width: LAYOUT.contentWidth,
             align: 'center',
             characterSpacing: 1.2,
             lineBreak: false
           });
      titleY = 60;
    }
  } else {
    // Pas de logo : on conserve l'ancien libellé doré lettré
    doc.fillColor(COLORS.gold).fontSize(7).font('Helvetica-Bold')
       .text('R É N O E X P E R T   ·   D O S S I E R   P R O F E S S I O N N E L',
         LAYOUT.margin, 35, {
           width: LAYOUT.contentWidth,
           align: 'center',
           characterSpacing: 1.2,
           lineBreak: false
         });
    titleY = 60;
  }

  // Grand titre marine en haut, classique haut de gamme
  doc.fillColor(COLORS.navy).fontSize(36).font('Helvetica-Bold')
     .text(titleMain, LAYOUT.margin, titleY, {
       width: LAYOUT.contentWidth,
       align: 'center',
       characterSpacing: 2,
       lineGap: -6
     });

  // Filet doré sous le titre
  doc.moveDown(0.4);
  const lineY = doc.y;
  drawGoldRule(doc, { y: lineY, width: 60 });
  doc.y = lineY + 12;

  // Sous-titre en italique discret
  doc.fillColor(COLORS.textSecondary).fontSize(11).font('Helvetica-Oblique')
     .text(titleSub, LAYOUT.margin, doc.y, {
       width: LAYOUT.contentWidth,
       align: 'center'
     });
  doc.moveDown(0.8);
}

// ============================================================
// GÉNÉRATION DES PDFs
// ============================================================

function generateVisitePDF(data, res) {
  const { analysis, location, surface, visite_type, loyer_vise, prix_achat } = data;
  const isLocatif = visite_type === 'locatif';
  const cleaned = simplifyTerms(analysis);

  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, info: { Title: isLocatif ? 'Investissement Locatif - RénoExpert' : 'Diagnostic Visite - RénoExpert' }});
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${isLocatif ? 'investissement-locatif' : 'visite'}-renoexpert.pdf"`);
  doc.pipe(res);

  fillBackground(doc);

  drawCanvaHeader(doc, {
    titleMain: isLocatif ? 'Investissement Locatif' : 'Diagnostic Visite',
    titleSub: isLocatif ? 'Analyse de rentabilite et conformite DPE' : 'Rapport d\'analyse de bien immobilier'
  });

  if (isLocatif) {
    drawCanvaHeaderTable(doc, [
      { title: 'Type', headerColor: COLORS.mintGreen, content: 'Investissement locatif' },
      { title: 'Localisation', headerColor: COLORS.creamYellow, content: location || 'Non precisee' },
      { title: 'Surface', headerColor: COLORS.coralRed, content: surface ? `${surface} m2` : 'Non precisee' },
      { title: 'Date', headerColor: COLORS.powderPink, content: new Date().toLocaleDateString('fr-FR') }
    ]);
    drawColoredCard(doc, {
      title: 'A propos de ce rapport',
      content: 'Cette analyse a ete realisee pour un projet d\'investissement locatif. Elle integre l\'evaluation energetique du bien (DPE), les travaux minimaux pour respecter la loi Climat & Resilience (interdiction de louer F/G), et la rentabilite locative previsionnelle.',
      bgColor: COLORS.mintGreenBg,
      textColor: COLORS.mintGreenDark
    });
  } else {
    drawCanvaHeaderTable(doc, [
      { title: 'Type d\'analyse', headerColor: COLORS.mintGreen, content: 'Diagnostic complet pour visite avant achat' },
      { title: 'Localisation', headerColor: COLORS.creamYellow, content: location || 'Non precisee' },
      { title: 'Surface', headerColor: COLORS.coralRed, content: surface ? `${surface} m2` : 'Non precisee' },
      { title: 'Date', headerColor: COLORS.powderPink, content: new Date().toLocaleDateString('fr-FR') }
    ]);
    drawColoredCard(doc, {
      title: 'A propos de ce rapport',
      content: 'Ce diagnostic a ete realise a partir des photos et donnees fournies. Il vous aide a identifier les points forts et les vigilances avant votre visite ou decision d\'achat.',
      bgColor: COLORS.mintGreenBg,
      textColor: COLORS.mintGreenDark
    });
  }
  
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
    drawCanvaFooter(doc, i + 1, range.count);
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
    drawCanvaFooter(doc, i + 1, range.count);
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
    drawCanvaFooter(doc, i + 1, range.count);
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
    drawCanvaFooter(doc, i + 1, range.count);
  }
  
  doc.end();
}

module.exports = {
  generateVisitePDF,
  generateReparationPDF,
  generateAgentPDF,
  generateMarchandPDF
};
