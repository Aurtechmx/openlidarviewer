/**
 * ReportPdfRenderer.ts
 *
 * The pdf-lib-bound PDF emission. Takes a typed `ReportInputs` + a
 * `ReportTemplate` (sections in order), walks the section list, and
 * produces the final PDF Blob.
 *
 * The renderer is **layout-bounded** — each section knows its rough
 * height needs and can request a new page when it overflows. The layout
 * is hand-tuned (no full paragraph reflow); the technical-notes section
 * currently takes a single line of body copy.
 *
 * Pure of DOM; pdf-lib gives us PDF bytes that we wrap in a Blob.
 * Tests pin the pure-data section builders; the actual render is
 * exercised by the live-build smoke check.
 */

import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont, type PDFImage } from 'pdf-lib';
import type {
  ReportInputs,
  ReportResult,
  ReportSectionId,
  ReportTemplate,
  ReportTemplateId,
  ReportVisualAsset,
} from './types';
import {
  effectiveBranding,
  parseAccentColor,
  resolveTheme,
  type ParsedColor,
  type ReportThemePalette,
} from './ReportBranding';
import { describeAnnotationGroups } from '../render/annotate/annotationClustering';
import type { AnnotationType } from '../render/annotate/types';
import type { FindingTier, ReportFinding, ReportInspectionSummary } from './ReportFindings';

// ─────────────────────────────────────────────────────────────────────────────
// Layout constants — letter portrait, 0.6 inch margins.
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_WIDTH = 612;        // 8.5 in × 72
const PAGE_HEIGHT = 792;       // 11  in × 72
const MARGIN = 44;             // ~0.6 in
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const FOOTER_HEIGHT = 32;
const BODY_FONT_SIZE = 10;
const HEADER_FONT_SIZE = 14;
const TITLE_FONT_SIZE = 28;

// ─────────────────────────────────────────────────────────────────────────────
// Layout grid
//
// The renderer aligns label / value / status content to a 12-column print
// grid over the 524-point content width. Earlier versions used a single
// magic offset (`MARGIN + 120`) for the value column, which read as
// arbitrary against the surrounding rhythm. A column-based layout keeps
// the value column consistent across themes and lets new section
// renderers (acceptance, technical notes, future cloud-sampled rows)
// share one alignment rule.
//
// The grid is a column grid only — body leading is BODY_FONT_SIZE
// plus a fixed 4-pt gap, no baseline grid — with 11-point gutters
// scaled so the dataset-summary value column begins one third across
// the content width. That width matches the prior magic offset to
// within a point while making the rule explicit.
// ─────────────────────────────────────────────────────────────────────────────
const GRID_COLUMNS = 12;
const GRID_GUTTER = 8;
const GRID_TRACK_WIDTH = (CONTENT_WIDTH - GRID_GUTTER * (GRID_COLUMNS - 1)) / GRID_COLUMNS;

/** x-coordinate for the left edge of column `n` (1-based). */
function gridX(column: number): number {
  return MARGIN + (column - 1) * (GRID_TRACK_WIDTH + GRID_GUTTER);
}

/**
 * The dataset-summary value column's x-coordinate. Held at the pre-grid
 * offset (MARGIN + 120 ≈ 164 pt) so the existing reports render
 * identically across versions; new sections that want grid-aligned
 * columns use `gridX(n)` directly. Calling this out as a constant
 * makes the choice auditable instead of hidden as a magic addition.
 */
const LABEL_VALUE_GUTTER_X = MARGIN + 120;

/** A page-cursor — tracks where the next bit of content goes. */
interface PageCursor {
  page: PDFPage;
  y: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render a report to a PDF blob. The template determines section order;
 * the inputs supply the data each section needs.
 */
export async function renderReportPdf(
  inputs: ReportInputs,
  template: ReportTemplate,
): Promise<ReportResult> {
  const doc = await PDFDocument.create();
  // `showInWindowTitleBar` sets the ViewerPreferences DisplayDocTitle flag, so a
  // screen reader / PDF viewer announces the report title rather than the raw
  // filename. setLanguage tags the document language for correct pronunciation.
  // (A full tagged-structure tree for section-level navigation is out of reach
  // with this PDF library; these are the honest, supported accessibility hooks.)
  doc.setTitle(inputs.cover.title, { showInWindowTitleBar: true });
  doc.setLanguage('en-US');
  doc.setAuthor(inputs.branding.author ?? 'OpenLiDARViewer');
  doc.setCreator(`OpenLiDARViewer Report Engine v${__APP_VERSION__}`);
  doc.setProducer('pdf-lib (lazy chunk)');
  doc.setCreationDate(new Date());

  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const branding = effectiveBranding(inputs.branding);
  const accent = parseAccentColor(branding.accentColor);
  // Resolved theme palette: page background, body/muted text, rule colour,
  // row tint, accent-stripe toggle. The renderer reads these instead of
  // hard-coded RGB values.
  const theme = resolveTheme(branding.theme);

  // Logo (optional) is embedded once and reused across pages.
  let logoImage: PDFImage | undefined;
  if (branding.logoDataUrl) {
    try {
      logoImage = await embedDataUrl(doc, branding.logoDataUrl);
    } catch {
      // Best-effort — a malformed logo data URL is dropped silently so
      // the rest of the report still renders. Surfaced to the user via
      // a console warning in the caller, not here (this module is pure).
      logoImage = undefined;
    }
  }

  // The renderer state — the page cursor advances through the document.
  let cursor: PageCursor = startNewPage(doc, accent, theme, branding.organisation);

  // Per-section error isolation. A single bad section — a corrupt visual
  // blob, an annotation row with malformed coordinates, a font-embedding
  // hiccup — would historically abort the whole render, leaving the user
  // with no PDF at all. With the isolation pass, the failed section is
  // skipped, the failure is logged with the section id for diagnosis, and
  // the rest of the report continues to render. The user gets a partial
  // PDF (clearly marked in the cover metadata if the failure was the cover
  // itself) rather than nothing.
  const failedSections: ReportSectionId[] = [];
  for (const section of template.sections) {
    try {
      cursor = await renderSection(
        section, inputs, cursor, doc, accent, theme,
        helvetica, helveticaBold, logoImage, branding.organisation,
      );
    } catch (err) {
      failedSections.push(section);
      // Surface the per-section failure to the caller's console so it can
      // be investigated, but don't surface to the user — the partial PDF
      // they get is more useful than a hard error in nearly every case.
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `[report] section "${section}" failed to render and was skipped: ${reason}`,
      );
      // A failed section may have already drawn part of itself below the
      // pre-section cursor (that content cannot be recalled), and the
      // reverted cursor would let the NEXT section draw over it — the
      // page-1 overlap bug this catch used to cause. Resuming on a fresh
      // page guarantees no subsequent text can land on partially-drawn
      // content, at the cost of one extra page in this failure-only path.
      cursor = startNewPage(doc, accent, theme, branding.organisation);
    }
  }

  // Stamp page numbers in the footer of every page that was added. The
  // optional footer note (e.g. a project code) is appended
  // above the standard line on each page.
  stampFooterPageNumbers(doc, helvetica, theme, branding.footerNote);

  const bytes = await doc.save();
  // pdf-lib returns Uint8Array<ArrayBufferLike> which TS conservatively
  // unions with SharedArrayBuffer; the runtime never returns one. Copy
  // into a fresh ArrayBuffer-backed Uint8Array so Blob's BlobPart
  // constraint is satisfied without a runtime cost beyond the memcpy.
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const blob = new Blob([owned], { type: 'application/pdf' });
  return {
    blob,
    mimeType: 'application/pdf',
    pages: doc.getPageCount(),
    templateId: inputs.templateId,
    failedSections,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section dispatcher
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Per-template design DNA
//
// Six templates, six distinct covers. The user-reported "all reports look
// the same" bug was driven partly by a shared hardcoded title; the deeper
// design-excellence issue was that even with different titles, each
// template surfaced an identical layout + accent. This map gives every
// template a short tag (rendered as a small chip on the cover) and a
// default accent that the cover renderer uses when the user has not
// overridden via `branding.accentColor`. The eye reads a Survey Summary
// and a QA Validation as different documents even before reading the
// title.
//
// Colour choices are intentionally drawn from a single hue family with
// good print contrast against both light and dark themes. Each is
// readable as a 6-pt-wide rail on white and as a tinted block on
// near-black.
// ─────────────────────────────────────────────────────────────────────────────

interface TemplateDesignKey {
  /** Short, uppercase tag rendered as a chip on the cover (≤ 16 chars). */
  readonly tag: string;
  /** Default accent — used when the user hasn't supplied `branding.accentColor`. */
  readonly defaultAccent: ParsedColor;
}

const TEMPLATE_DESIGN_KEYS: Record<ReportTemplateId, TemplateDesignKey> = {
  'engineering-inspection': {
    tag: 'INSPECTION',
    defaultAccent: { r: 0.13, g: 0.45, b: 0.78 }, // engineer blue
  },
  'qa-validation': {
    tag: 'QA',
    defaultAccent: { r: 0.85, g: 0.46, b: 0.10 }, // amber
  },
  'survey-summary': {
    tag: 'SURVEY',
    defaultAccent: { r: 0.20, g: 0.55, b: 0.32 }, // surveyor green
  },
  'terrain-review': {
    tag: 'TERRAIN',
    defaultAccent: { r: 0.58, g: 0.40, b: 0.20 }, // sienna
  },
  'technical-documentation': {
    tag: 'DOCS',
    defaultAccent: { r: 0.36, g: 0.40, b: 0.45 }, // slate
  },
  'scan-acceptance': {
    tag: 'ACCEPTANCE',
    defaultAccent: { r: 0.14, g: 0.55, b: 0.55 }, // teal
  },
};

function designKeyFor(templateId: ReportTemplateId): TemplateDesignKey {
  return (
    TEMPLATE_DESIGN_KEYS[templateId] ?? {
      tag: 'REPORT',
      defaultAccent: { r: 0.0, g: 0.7, b: 1.0 },
    }
  );
}

async function renderSection(
  section: ReportSectionId,
  inputs: ReportInputs,
  cursor: PageCursor,
  doc: PDFDocument,
  accent: ParsedColor,
  theme: ReportThemePalette,
  body: PDFFont,
  bold: PDFFont,
  logo: PDFImage | undefined,
  organisation: string | undefined,
): Promise<PageCursor> {
  switch (section) {
    case 'cover':
      return renderCover(cursor, inputs, accent, theme, body, bold, logo);
    case 'inspection-summary':
      return renderInspectionSummary(cursor, inputs, doc, accent, theme, body, bold, organisation);
    case 'dataset-summary':
      return renderDatasetSummary(cursor, inputs, doc, accent, theme, body, bold, organisation);
    case 'provenance':
      return renderProvenance(cursor, inputs, doc, accent, theme, body, bold, organisation);
    case 'source-metadata':
      return renderSourceMetadata(cursor, inputs, doc, accent, theme, body, bold, organisation);
    case 'visuals':
      return renderVisuals(cursor, inputs, doc, accent, theme, body, bold, organisation);
    case 'annotations':
      return renderAnnotations(cursor, inputs, doc, accent, theme, body, bold, organisation);
    case 'measurements':
      return renderMeasurements(cursor, inputs, doc, accent, theme, body, bold, organisation);
    case 'technical-notes':
      return renderTechnicalNotes(cursor, inputs, doc, accent, theme, body, bold, organisation);
    case 'acceptance-checklist':
      return renderAcceptanceChecklist(cursor, inputs, doc, accent, theme, body, bold, organisation);
    case 'footer':
      // Footer is stamped per-page in stampFooterPageNumbers; nothing
      // section-specific to do here, but we keep the slot in the
      // template list so a future renderer can add e.g. a colophon.
      return cursor;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Page helpers
// ─────────────────────────────────────────────────────────────────────────────

function startNewPage(
  doc: PDFDocument,
  accent: ParsedColor,
  theme: ReportThemePalette,
  organisation: string | undefined,
): PageCursor {
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  // Paint the theme's page background first so dark themes render legibly.
  // Light themes have a near-white page background, so this is effectively
  // a no-op visually.
  page.drawRectangle({
    x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT,
    color: rgb(theme.pageBackground.r, theme.pageBackground.g, theme.pageBackground.b),
  });
  // Accent stripe down the left edge — uniform branding across pages.
  // The minimal-engineering theme omits the stripe for an austere look.
  if (theme.drawAccentStripe) {
    page.drawRectangle({
      x: 0, y: 0, width: 3, height: PAGE_HEIGHT,
      color: rgb(accent.r, accent.g, accent.b),
    });
  }
  // Footer hairline.
  page.drawRectangle({
    x: MARGIN, y: FOOTER_HEIGHT,
    width: CONTENT_WIDTH, height: 0.5,
    color: rgb(theme.rule.r, theme.rule.g, theme.rule.b),
  });
  // Footer text — organisation (left) + "OpenLiDARViewer" (right).
  // Stamped here so newly-added pages get the footer even before the
  // page-number pass at the end.
  void organisation; // tagged below in renderFooterText
  return { page, y: PAGE_HEIGHT - MARGIN };
}

function ensureSpace(
  cursor: PageCursor,
  needed: number,
  doc: PDFDocument,
  accent: ParsedColor,
  theme: ReportThemePalette,
  organisation: string | undefined,
): PageCursor {
  if (cursor.y - needed < FOOTER_HEIGHT + 16) {
    return startNewPage(doc, accent, theme, organisation);
  }
  return cursor;
}

/**
 * Break `text` into lines no wider than `maxWidth` at `size`, measuring with
 * the real font metrics. Words that are themselves wider than `maxWidth`
 * (a long unbroken token / URL) are hard-broken character-by-character so the
 * loop always terminates and nothing is silently clipped at the page edge.
 *
 * The input is run through `sanitiseForPdf` first so the width measurement
 * matches what actually gets drawn (the WinAnsi substitutions change string
 * length — e.g. "≥" → ">=").
 */
function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const clean = sanitiseForPdf(text);
  if (clean.length === 0) return [''];
  const lines: string[] = [];
  let line = '';
  for (const word of clean.split(/\s+/)) {
    if (word.length === 0) continue;
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) {
      lines.push(line);
      line = '';
    }
    // The word alone may still overflow — hard-break it.
    if (font.widthOfTextAtSize(word, size) <= maxWidth) {
      line = word;
    } else {
      let chunk = '';
      for (const ch of word) {
        if (chunk && font.widthOfTextAtSize(chunk + ch, size) > maxWidth) {
          lines.push(chunk);
          chunk = ch;
        } else {
          chunk += ch;
        }
      }
      line = chunk;
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [''];
}

/**
 * Keep-with-next space for a small section: the heading band plus every
 * wrapped line of a short body block. Sections that render only a
 * placeholder ask for exactly this much, so they stay on the current page
 * whenever they genuinely fit and break as ONE unit when they don't —
 * never an orphaned heading at a page bottom, and never a near-empty page
 * holding a two-line block that had room on its predecessor.
 */
function sectionKeepTogetherSpace(text: string, body: PDFFont): number {
  const lines = wrapText(text, body, BODY_FONT_SIZE, CONTENT_WIDTH).length;
  return (
    HEADER_FONT_SIZE + 18 +                 // heading + its underline band
    lines * (BODY_FONT_SIZE + 4) +          // each wrapped body line
    10                                      // trailing section gap
  );
}

function drawSectionHeader(
  cursor: PageCursor,
  text: string,
  accent: ParsedColor,
  bold: PDFFont,
): PageCursor {
  const clean = sanitiseForPdf(text);
  cursor.page.drawText(clean, {
    x: MARGIN, y: cursor.y - HEADER_FONT_SIZE,
    size: HEADER_FONT_SIZE, font: bold,
    color: rgb(accent.r, accent.g, accent.b),
  });
  // The underline spans the heading's measured text width (it used to be a
  // fixed 40 pt — an underline under only the first few characters),
  // clamped to the content width so a pathological heading cannot cross
  // the right margin.
  cursor.page.drawRectangle({
    x: MARGIN, y: cursor.y - HEADER_FONT_SIZE - 4,
    width: Math.min(bold.widthOfTextAtSize(clean, HEADER_FONT_SIZE), CONTENT_WIDTH),
    height: 1.5,
    color: rgb(accent.r, accent.g, accent.b),
  });
  return { page: cursor.page, y: cursor.y - HEADER_FONT_SIZE - 14 };
}

function drawBodyLine(
  cursor: PageCursor,
  text: string,
  body: PDFFont,
  theme: ReportThemePalette,
  indent = 0,
): PageCursor {
  // Wrap to the content width so long lines (the provenance disclaimer, free
  // notes) flow onto further lines instead of running off the right margin.
  const x = MARGIN + indent;
  const maxWidth = PAGE_WIDTH - MARGIN - x;
  let y = cursor.y;
  for (const line of wrapText(text, body, BODY_FONT_SIZE, maxWidth)) {
    cursor.page.drawText(line, {
      x, y: y - BODY_FONT_SIZE,
      size: BODY_FONT_SIZE, font: body,
      color: rgb(theme.bodyText.r, theme.bodyText.g, theme.bodyText.b),
    });
    y -= BODY_FONT_SIZE + 4;
  }
  return { page: cursor.page, y };
}

/**
 * Draw the cross-section profile as a small vector chart: a framed box with the
 * elevation polyline, self-normalised to the box so the units are immaterial.
 * Vector (not a rasterised image), so it stays sharp at any print zoom.
 */
function drawProfileChart(
  cursor: PageCursor,
  chart: ReadonlyArray<{ readonly distance: number; readonly height: number }>,
  theme: ReportThemePalette,
  accent: ParsedColor,
  doc: PDFDocument,
  body: PDFFont,
  organisation: string | undefined,
): PageCursor {
  const CHART_W = 240;
  const CHART_H = 56;
  const PAD = 5;
  // Reserve room for the chart box plus the not-to-scale disclosure beneath it.
  cursor = ensureSpace(cursor, CHART_H + 26, doc, accent, theme, organisation);
  const x0 = MARGIN + 12;
  const top = cursor.y;
  const bottom = top - CHART_H;
  const rule = rgb(theme.rule.r, theme.rule.g, theme.rule.b);

  // Bounds of the samples (finite-only; the caller already filtered).
  let dMin = Infinity, dMax = -Infinity, hMin = Infinity, hMax = -Infinity;
  for (const s of chart) {
    if (s.distance < dMin) dMin = s.distance;
    if (s.distance > dMax) dMax = s.distance;
    if (s.height < hMin) hMin = s.height;
    if (s.height > hMax) hMax = s.height;
  }
  const dSpan = dMax - dMin || 1;
  const hSpan = hMax - hMin || 1;

  // Frame (left + bottom axes).
  cursor.page.drawLine({ start: { x: x0, y: top }, end: { x: x0, y: bottom }, thickness: 0.5, color: rule });
  cursor.page.drawLine({ start: { x: x0, y: bottom }, end: { x: x0 + CHART_W, y: bottom }, thickness: 0.5, color: rule });

  const sx = (d: number): number => x0 + PAD + ((d - dMin) / dSpan) * (CHART_W - 2 * PAD);
  const sy = (h: number): number => bottom + PAD + ((h - hMin) / hSpan) * (CHART_H - 2 * PAD);
  let prev: { x: number; y: number } | null = null;
  for (const s of chart) {
    const pt = { x: sx(s.distance), y: sy(s.height) };
    if (prev) {
      cursor.page.drawLine({
        start: prev, end: pt, thickness: 0.9,
        color: rgb(accent.r, accent.g, accent.b),
      });
    }
    prev = pt;
  }
  // Honesty disclosure — the box is vertically auto-fit, so its slope is an
  // arbitrary vertical exaggeration. Without this, a reader could eyeball a
  // grade off a distorted curve. The real horizontal length, Δh and grade are
  // printed in the summary row above; the dedicated Profile sheet carries a
  // scaled, measurable section. (Convention: an undisclosed VE is the single
  // most common way a profile thumbnail misleads.)
  const caption =
    'Schematic section — vertical scale auto-fit (exaggerated), not to scale. ' +
    'Read length and grade from the values above, not off the curve.';
  const capY = bottom - 9;
  let y = capY;
  for (const line of wrapText(caption, body, BODY_FONT_SIZE - 2, PAGE_WIDTH - MARGIN - x0)) {
    cursor.page.drawText(line, {
      x: x0, y: y - (BODY_FONT_SIZE - 2),
      size: BODY_FONT_SIZE - 2, font: body,
      color: rgb(theme.mutedText.r, theme.mutedText.g, theme.mutedText.b),
    });
    y -= BODY_FONT_SIZE - 1;
  }
  return { page: cursor.page, y: y - 4 };
}

function drawLabelValueRow(
  cursor: PageCursor,
  label: string,
  value: string,
  body: PDFFont,
  bold: PDFFont,
  theme: ReportThemePalette,
): PageCursor {
  const cleanLabel = sanitiseForPdf(label);
  const labelX = gridX(1);
  const muted = rgb(theme.mutedText.r, theme.mutedText.g, theme.mutedText.b);
  const bodyColor = rgb(theme.bodyText.r, theme.bodyText.g, theme.bodyText.b);
  // Does the bold label fit before the value column with a 6-pt gap? Wide
  // labels (the provenance "Typical density (USGS QL2)" rows) used to overrun
  // the value at LABEL_VALUE_GUTTER_X — the label and value collided. When the
  // label is too wide, drop the value onto its own indented line below it.
  const labelWidth = bold.widthOfTextAtSize(cleanLabel, BODY_FONT_SIZE);
  const inlineFits = labelX + labelWidth + 6 <= LABEL_VALUE_GUTTER_X;

  cursor.page.drawText(cleanLabel, {
    x: labelX, y: cursor.y - BODY_FONT_SIZE,
    size: BODY_FONT_SIZE, font: bold, color: muted,
  });

  if (inlineFits) {
    // Value shares the row, wrapped within the column to the right margin.
    const valueX = LABEL_VALUE_GUTTER_X;
    const valueMax = PAGE_WIDTH - MARGIN - valueX;
    let y = cursor.y;
    for (const line of wrapText(value, body, BODY_FONT_SIZE, valueMax)) {
      cursor.page.drawText(line, {
        x: valueX, y: y - BODY_FONT_SIZE, size: BODY_FONT_SIZE, font: body, color: bodyColor,
      });
      y -= BODY_FONT_SIZE + 4;
    }
    return { page: cursor.page, y };
  }

  // Label too wide — value flows below it, indented one grid track, wrapped.
  let y = cursor.y - BODY_FONT_SIZE - 4;
  const valueX = gridX(2);
  const valueMax = PAGE_WIDTH - MARGIN - valueX;
  for (const line of wrapText(value, body, BODY_FONT_SIZE, valueMax)) {
    cursor.page.drawText(line, {
      x: valueX, y: y - BODY_FONT_SIZE, size: BODY_FONT_SIZE, font: body, color: bodyColor,
    });
    y -= BODY_FONT_SIZE + 4;
  }
  return { page: cursor.page, y };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sections
// ─────────────────────────────────────────────────────────────────────────────

async function renderCover(
  cursor: PageCursor,
  inputs: ReportInputs,
  accent: ParsedColor,
  theme: ReportThemePalette,
  body: PDFFont,
  bold: PDFFont,
  logo: PDFImage | undefined,
): Promise<PageCursor> {
  // Template design DNA — drives the small uppercase tag chip rendered
  // above the title so each of the six templates produces a visually
  // distinct cover even before the reader gets to the title.
  const dk = designKeyFor(inputs.templateId);

  // ── Cover left-rail — the "one bold move" the cover earns ────────────
  // A 4-pt-wide accent stripe runs from the top of the page down 220 pt,
  // anchored at the inner edge of the left margin. The rail is the visual
  // signature of the document — eyes read it before any text. Combined
  // with the per-template accent colour, two reports side by side are
  // instantly distinguishable even at a glance.
  cursor.page.drawRectangle({
    x: MARGIN - 16, y: cursor.y - 220,
    width: 4, height: 220,
    color: rgb(accent.r, accent.g, accent.b),
  });

  // Logo (optional) at the top-left, scaled to a 48-pt height.
  if (logo) {
    const scale = 48 / logo.height;
    cursor.page.drawImage(logo, {
      x: MARGIN, y: cursor.y - 48,
      width: logo.width * scale, height: 48,
    });
    cursor = { page: cursor.page, y: cursor.y - 64 };
  }
  // Template tag chip — small, uppercase, accent-coloured. Asymmetric
  // pre-title placement reinforces the left-rail and primes the eye for
  // the title beneath.
  cursor.page.drawText(sanitiseForPdf(dk.tag), {
    x: MARGIN, y: cursor.y - 9,
    size: 9, font: bold,
    color: rgb(accent.r, accent.g, accent.b),
  });
  cursor = { page: cursor.page, y: cursor.y - 18 };
  // Big title.
  cursor.page.drawText(sanitiseForPdf(inputs.cover.title), {
    x: MARGIN, y: cursor.y - TITLE_FONT_SIZE,
    size: TITLE_FONT_SIZE, font: bold,
    color: rgb(theme.bodyText.r, theme.bodyText.g, theme.bodyText.b),
  });
  cursor = { page: cursor.page, y: cursor.y - TITLE_FONT_SIZE - 4 };
  // Subtitle.
  if (inputs.cover.subtitle) {
    cursor.page.drawText(sanitiseForPdf(inputs.cover.subtitle), {
      x: MARGIN, y: cursor.y - 14,
      size: 14, font: body,
      color: rgb(theme.mutedText.r, theme.mutedText.g, theme.mutedText.b),
    });
    cursor = { page: cursor.page, y: cursor.y - 20 };
  }
  // Accent rule under the title.
  cursor.page.drawRectangle({
    x: MARGIN, y: cursor.y - 4,
    width: 80, height: 2,
    color: rgb(accent.r, accent.g, accent.b),
  });
  cursor = { page: cursor.page, y: cursor.y - 30 };

  // Cover metadata block — dataset / organisation / author / exported.
  cursor = drawLabelValueRow(cursor, 'Dataset',     inputs.cover.datasetName, body, bold, theme);
  if (inputs.branding.organisation) {
    cursor = drawLabelValueRow(cursor, 'Organisation', inputs.branding.organisation, body, bold, theme);
  }
  if (inputs.branding.author) {
    cursor = drawLabelValueRow(cursor, 'Author',     inputs.branding.author, body, bold, theme);
  }
  cursor = drawLabelValueRow(
    cursor, 'Exported', formatTimestamp(inputs.cover.exportedAt), body, bold, theme,
  );
  // optional project-metadata rows, one per provided field.
  // Rendered after the standard block so the cover stays clean when no
  // project metadata was supplied.
  const pm = inputs.branding.projectMetadata;
  if (pm) {
    if (pm.client)    cursor = drawLabelValueRow(cursor, 'Client',    pm.client,    body, bold, theme);
    if (pm.project)   cursor = drawLabelValueRow(cursor, 'Project',   pm.project,   body, bold, theme);
    if (pm.phase)     cursor = drawLabelValueRow(cursor, 'Phase',     pm.phase,     body, bold, theme);
    if (pm.reference) cursor = drawLabelValueRow(cursor, 'Reference', pm.reference, body, bold, theme);
    if (pm.date)      cursor = drawLabelValueRow(cursor, 'Date',      pm.date,      body, bold, theme);
  }
  return cursor;
}

/** Status-dot colour for a finding tier. Paired ALWAYS with text, never the
 * sole carrier of meaning — the value / detail line conveys the finding on its
 * own, so the dot stays a scanning aid (colourblind-safe by construction). */
function tierColor(tier: FindingTier): ParsedColor {
  switch (tier) {
    case 'met':     return { r: 0.16, g: 0.55, b: 0.30 }; // green
    case 'caution': return { r: 0.85, g: 0.55, b: 0.10 }; // amber
    case 'unknown': return { r: 0.55, g: 0.57, b: 0.60 }; // grey
    case 'info':    return { r: 0.30, g: 0.50, b: 0.72 }; // muted blue
  }
}

/** One finding: status dot + bold label, value, optional detail + source. */
function drawFinding(
  cursor: PageCursor,
  finding: ReportFinding,
  doc: PDFDocument,
  accent: ParsedColor,
  theme: ReportThemePalette,
  body: PDFFont,
  bold: PDFFont,
  organisation: string | undefined,
): PageCursor {
  cursor = ensureSpace(cursor, 34, doc, accent, theme, organisation);
  const dotX = MARGIN + 4;
  const textX = MARGIN + 16;
  const dot = tierColor(finding.tier);
  // Status dot, vertically centred on the label line.
  cursor.page.drawEllipse({
    x: dotX, y: cursor.y - BODY_FONT_SIZE + 3, xScale: 3, yScale: 3,
    color: rgb(dot.r, dot.g, dot.b),
  });
  // Label (bold) + value on the same line; value sits after the label.
  const cleanLabel = sanitiseForPdf(finding.label);
  cursor.page.drawText(cleanLabel, {
    x: textX, y: cursor.y - BODY_FONT_SIZE,
    size: BODY_FONT_SIZE, font: bold,
    color: rgb(theme.bodyText.r, theme.bodyText.g, theme.bodyText.b),
  });
  const labelW = bold.widthOfTextAtSize(cleanLabel, BODY_FONT_SIZE);
  const valueX = textX + labelW + 8;
  cursor.page.drawText(sanitiseForPdf(finding.value), {
    x: valueX, y: cursor.y - BODY_FONT_SIZE,
    size: BODY_FONT_SIZE, font: body,
    color: rgb(theme.bodyText.r, theme.bodyText.g, theme.bodyText.b),
  });
  let y = cursor.y - BODY_FONT_SIZE - 4;
  // Detail line(s), wrapped + indented under the label.
  if (finding.detail) {
    for (const line of wrapText(finding.detail, body, BODY_FONT_SIZE - 1, PAGE_WIDTH - MARGIN - textX)) {
      cursor.page.drawText(line, {
        x: textX, y: y - (BODY_FONT_SIZE - 1),
        size: BODY_FONT_SIZE - 1, font: body,
        color: rgb(theme.mutedText.r, theme.mutedText.g, theme.mutedText.b),
      });
      y -= BODY_FONT_SIZE + 2;
    }
  }
  if (finding.source) {
    cursor.page.drawText(`source: ${sanitiseForPdf(finding.source)}`, {
      x: textX, y: y - (BODY_FONT_SIZE - 2),
      size: BODY_FONT_SIZE - 2, font: body,
      color: rgb(theme.mutedText.r, theme.mutedText.g, theme.mutedText.b),
    });
    y -= BODY_FONT_SIZE;
  }
  return { page: cursor.page, y: y - 4 };
}

/**
 * Small horizontal density bar: measured density against the USGS QL
 * thresholds, with labelled tick marks. Drawn only when the summary carries a
 * `densityBar` (i.e. the QL comparison is applicable), so the graphic never
 * implies a standard that doesn't apply to this capture type.
 */
function drawDensityBar(
  cursor: PageCursor,
  bar: NonNullable<ReportInspectionSummary['densityBar']>,
  doc: PDFDocument,
  accent: ParsedColor,
  theme: ReportThemePalette,
  body: PDFFont,
  bold: PDFFont,
  organisation: string | undefined,
): PageCursor {
  cursor = ensureSpace(cursor, 46, doc, accent, theme, organisation);
  const x0 = MARGIN + 16;
  const barW = 300;
  const barH = 8;
  const maxThresh = bar.thresholds.reduce((m, t) => Math.max(m, t.value), 0);
  const scaleMax = Math.max(bar.measured, maxThresh) * 1.15 || 1;
  const top = cursor.y - 4;
  const rule = rgb(theme.rule.r, theme.rule.g, theme.rule.b);

  // Caption.
  cursor.page.drawText('Density vs USGS quality levels', {
    x: x0, y: top - BODY_FONT_SIZE + 2, size: BODY_FONT_SIZE - 1, font: bold,
    color: rgb(theme.bodyText.r, theme.bodyText.g, theme.bodyText.b),
  });
  const barTop = top - BODY_FONT_SIZE - 4;
  const barBottom = barTop - barH;
  // Track.
  cursor.page.drawRectangle({
    x: x0, y: barBottom, width: barW, height: barH,
    color: rgb(theme.rowTint.r, theme.rowTint.g, theme.rowTint.b),
    borderColor: rule, borderWidth: 0.5,
  });
  // Filled to measured.
  const fillW = Math.max(0, Math.min(1, bar.measured / scaleMax)) * barW;
  cursor.page.drawRectangle({
    x: x0, y: barBottom, width: fillW, height: barH,
    color: rgb(accent.r, accent.g, accent.b),
  });
  // Threshold ticks + labels.
  for (const t of bar.thresholds) {
    const tx = x0 + Math.min(1, t.value / scaleMax) * barW;
    cursor.page.drawLine({
      start: { x: tx, y: barBottom - 2 }, end: { x: tx, y: barTop + 2 },
      thickness: 0.8, color: rgb(theme.bodyText.r, theme.bodyText.g, theme.bodyText.b),
    });
    cursor.page.drawText(`${t.label} (${t.value})`, {
      x: tx - 8, y: barBottom - 11, size: BODY_FONT_SIZE - 3, font: body,
      color: rgb(theme.mutedText.r, theme.mutedText.g, theme.mutedText.b),
    });
  }
  // Measured readout at the bar end.
  cursor.page.drawText(`${bar.measured.toFixed(0)} ${sanitiseForPdf(bar.unit)}`, {
    x: x0 + barW + 8, y: barBottom - 1, size: BODY_FONT_SIZE - 1, font: bold,
    color: rgb(theme.bodyText.r, theme.bodyText.g, theme.bodyText.b),
  });
  return { page: cursor.page, y: barBottom - 16 };
}

/**
 * The Inspection summary — a scannable findings card synthesised from the
 * dataset metadata + provenance. Leads the report with what the scan IS and
 * what it does NOT establish, so a reviewer gets the verdict in a couple of
 * seconds instead of reading the whole metadata table.
 */
async function renderInspectionSummary(
  cursor: PageCursor,
  inputs: ReportInputs,
  doc: PDFDocument,
  accent: ParsedColor,
  theme: ReportThemePalette,
  body: PDFFont,
  bold: PDFFont,
  organisation: string | undefined,
): Promise<PageCursor> {
  const summary = inputs.summary;
  if (!summary) return cursor;
  cursor = ensureSpace(cursor, 70, doc, accent, theme, organisation);
  cursor = drawSectionHeader(cursor, 'Inspection summary', accent, bold);
  // Headline — the one-line characterisation, wrapped.
  for (const line of wrapText(summary.headline, bold, BODY_FONT_SIZE + 1, CONTENT_WIDTH)) {
    cursor = ensureSpace(cursor, 16, doc, accent, theme, organisation);
    cursor.page.drawText(line, {
      x: MARGIN, y: cursor.y - (BODY_FONT_SIZE + 1),
      size: BODY_FONT_SIZE + 1, font: bold,
      color: rgb(theme.bodyText.r, theme.bodyText.g, theme.bodyText.b),
    });
    cursor = { page: cursor.page, y: cursor.y - (BODY_FONT_SIZE + 1) - 6 };
  }
  cursor = { page: cursor.page, y: cursor.y - 4 };
  // Findings.
  for (const f of summary.findings) {
    cursor = drawFinding(cursor, f, doc, accent, theme, body, bold, organisation);
  }
  // Density bar (only when QL applies).
  if (summary.densityBar) {
    cursor = { page: cursor.page, y: cursor.y - 4 };
    cursor = drawDensityBar(cursor, summary.densityBar, doc, accent, theme, body, bold, organisation);
  }
  // Caveats — what the report does not establish.
  cursor = { page: cursor.page, y: cursor.y - 2 };
  for (const c of summary.caveats) {
    cursor = ensureSpace(cursor, 24, doc, accent, theme, organisation);
    cursor = drawBodyLine(cursor, `• ${c}`, body, theme, 4);
  }
  return { page: cursor.page, y: cursor.y - 12 };
}

async function renderDatasetSummary(
  cursor: PageCursor,
  inputs: ReportInputs,
  doc: PDFDocument,
  accent: ParsedColor,
  theme: ReportThemePalette,
  body: PDFFont,
  bold: PDFFont,
  organisation: string | undefined,
): Promise<PageCursor> {
  cursor = ensureSpace(cursor, 60 + inputs.datasetRows.length * 14, doc, accent, theme, organisation);
  cursor = drawSectionHeader(cursor, 'Dataset summary', accent, bold);
  for (const row of inputs.datasetRows) {
    cursor = ensureSpace(cursor, 16, doc, accent, theme, organisation);
    cursor = drawLabelValueRow(cursor, row.label, row.value, body, bold, theme);
  }
  return { page: cursor.page, y: cursor.y - 14 };
}

/**
 * Provenance fingerprint — capture-type classifier output. Auto-
 * computed (zero user action) and varies per scan, so this section
 * gives a fresh export per-template differentiation even when no
 * measurements / annotations / visuals have been captured yet.
 *
 * Renders:
 *  - Capture-type label + confidence badge (e.g. "Aerial / airborne
 *    LiDAR (ALS) — medium confidence")
 *  - "Signals" list — why the classifier picked this type
 *  - Literature-derived accuracy bounds, each with its source paper
 *  - The honest-hedge disclaimer the classifier always emits
 *
 * Skipped silently when `inputs.provenance` is omitted — templates
 * that don't include the `provenance` section don't pay for it.
 */
async function renderProvenance(
  cursor: PageCursor,
  inputs: ReportInputs,
  doc: PDFDocument,
  accent: ParsedColor,
  theme: ReportThemePalette,
  body: PDFFont,
  bold: PDFFont,
  organisation: string | undefined,
): Promise<PageCursor> {
  cursor = ensureSpace(cursor, 60, doc, accent, theme, organisation);
  cursor = drawSectionHeader(cursor, 'Provenance', accent, bold);
  if (!inputs.provenance) {
    cursor = drawBodyLine(
      cursor,
      'No provenance fingerprint available for this scan.',
      body,
      theme,
    );
    return { page: cursor.page, y: cursor.y - 10 };
  }
  const p = inputs.provenance;
  // Headline: capture type + confidence chip.
  cursor = drawLabelValueRow(
    cursor,
    'Capture type',
    `${p.label} — ${p.confidence} confidence`,
    body,
    bold,
    theme,
  );
  cursor = { page: cursor.page, y: cursor.y - 6 };
  // Signals — bullet list of the cues that drove the classification.
  if (p.signals.length > 0) {
    cursor = ensureSpace(cursor, 16 + p.signals.length * 14, doc, accent, theme, organisation);
    cursor.page.drawText('Signals', {
      x: MARGIN, y: cursor.y - BODY_FONT_SIZE,
      size: BODY_FONT_SIZE, font: bold,
      color: rgb(theme.bodyText.r, theme.bodyText.g, theme.bodyText.b),
    });
    cursor = { page: cursor.page, y: cursor.y - BODY_FONT_SIZE - 4 };
    for (const sig of p.signals) {
      cursor = ensureSpace(cursor, 14, doc, accent, theme, organisation);
      cursor = drawBodyLine(cursor, `• ${sig}`, body, theme);
    }
    cursor = { page: cursor.page, y: cursor.y - 4 };
  }
  // Literature-cited accuracy bounds — the Research-Derived ribbon.
  if (p.bounds.length > 0) {
    cursor = ensureSpace(cursor, 16 + p.bounds.length * 28, doc, accent, theme, organisation);
    cursor.page.drawText('Expected accuracy (cited literature)', {
      x: MARGIN, y: cursor.y - BODY_FONT_SIZE,
      size: BODY_FONT_SIZE, font: bold,
      color: rgb(theme.bodyText.r, theme.bodyText.g, theme.bodyText.b),
    });
    cursor = { page: cursor.page, y: cursor.y - BODY_FONT_SIZE - 4 };
    for (const b of p.bounds) {
      cursor = ensureSpace(cursor, 30, doc, accent, theme, organisation);
      cursor = drawLabelValueRow(cursor, b.label, b.value, body, bold, theme);
      // Sanitised like every other drawn string. A citation glyph outside
      // WinAnsi ("Ruzgienė") used to throw HERE, aborting the section after
      // its heading + signals were already drawn — and the reverted cursor
      // let the next section draw over them (the page-1 overlap bug).
      cursor.page.drawText(sanitiseForPdf(`source: ${b.source}`), {
        x: MARGIN + 12, y: cursor.y - BODY_FONT_SIZE,
        size: BODY_FONT_SIZE - 1, font: body,
        color: rgb(theme.mutedText.r, theme.mutedText.g, theme.mutedText.b),
      });
      cursor = { page: cursor.page, y: cursor.y - BODY_FONT_SIZE - 6 };
    }
  }
  // Honest-hedge disclaimer — the classifier always emits one.
  cursor = ensureSpace(cursor, 26, doc, accent, theme, organisation);
  cursor = drawBodyLine(cursor, p.disclaimer, body, theme);
  return { page: cursor.page, y: cursor.y - 10 };
}

/**
 * v0.5.4 — "Declared source metadata": the file's own metadata declarations,
 * verbatim. Standard-schema fields first, then the extension-namespace
 * fields under their own sub-heading. The section leads with the honesty
 * disclosure (declared by the file, not verified by OpenLiDARViewer) and is
 * OMITTED ENTIRELY when the file declares nothing — an empty shell would
 * imply the viewer looked for metadata and vouches for its absence.
 */
async function renderSourceMetadata(
  cursor: PageCursor,
  inputs: ReportInputs,
  doc: PDFDocument,
  accent: ParsedColor,
  theme: ReportThemePalette,
  body: PDFFont,
  bold: PDFFont,
  organisation: string | undefined,
): Promise<PageCursor> {
  const sm = inputs.sourceMetadata;
  if (!sm || (sm.standard.length === 0 && sm.extensions.length === 0)) return cursor;
  cursor = ensureSpace(cursor, 72, doc, accent, theme, organisation);
  cursor = drawSectionHeader(cursor, 'Declared source metadata', accent, bold);
  cursor = drawBodyLine(
    cursor,
    'The fields below are quoted verbatim from the source file\'s own ' +
      'metadata — declared by the file, not verified by OpenLiDARViewer.',
    body,
    theme,
  );
  cursor = { page: cursor.page, y: cursor.y - 4 };
  for (const f of sm.standard) {
    cursor = ensureSpace(cursor, 16, doc, accent, theme, organisation);
    cursor = drawLabelValueRow(cursor, f.name, f.value, body, bold, theme);
  }
  if (sm.extensions.length > 0) {
    cursor = ensureSpace(cursor, 30, doc, accent, theme, organisation);
    cursor = { page: cursor.page, y: cursor.y - 4 };
    cursor.page.drawText('Extension fields (file-declared)', {
      x: MARGIN, y: cursor.y - BODY_FONT_SIZE,
      size: BODY_FONT_SIZE, font: bold,
      color: rgb(theme.bodyText.r, theme.bodyText.g, theme.bodyText.b),
    });
    cursor = { page: cursor.page, y: cursor.y - BODY_FONT_SIZE - 4 };
    // Extension namespaces disclosed once, compactly, rather than per row.
    const uris = [...new Set(sm.extensions.map((f) => f.namespaceUri).filter(Boolean))];
    if (uris.length > 0) {
      cursor = drawBodyLine(cursor, `Namespace: ${uris.join(', ')}`, body, theme, 4);
    }
    for (const f of sm.extensions) {
      cursor = ensureSpace(cursor, 16, doc, accent, theme, organisation);
      cursor = drawLabelValueRow(cursor, f.name, f.value, body, bold, theme);
    }
  }
  return { page: cursor.page, y: cursor.y - 14 };
}

async function renderVisuals(
  cursor: PageCursor,
  inputs: ReportInputs,
  doc: PDFDocument,
  accent: ParsedColor,
  theme: ReportThemePalette,
  body: PDFFont,
  bold: PDFFont,
  organisation: string | undefined,
): Promise<PageCursor> {
  // Section appears even when empty so the template's intended structure is
  // visible — the placeholder tells the user what to do to fill it. Keep-
  // with-next: the empty block reserves exactly heading + placeholder.
  const vPlaceholder =
    'No visuals captured. Use Image export in the Inspector to add height / intensity / classification rasters.';
  cursor = ensureSpace(
    cursor,
    inputs.visuals.length === 0 ? sectionKeepTogetherSpace(vPlaceholder, body) : 60,
    doc, accent, theme, organisation,
  );
  cursor = drawSectionHeader(cursor, 'Visuals', accent, bold);
  if (inputs.visuals.length === 0) {
    cursor = drawBodyLine(cursor, vPlaceholder, body, theme);
    return { page: cursor.page, y: cursor.y - 10 };
  }
  for (const v of inputs.visuals) {
    const embedded = await embedVisual(doc, v);
    if (!embedded) continue;
    // Scale to fit content width, capping the height so a single visual
    // never dominates a page.
    const aspect = embedded.height / embedded.width;
    const w = Math.min(CONTENT_WIDTH, embedded.width);
    const h = Math.min(w * aspect, PAGE_HEIGHT - FOOTER_HEIGHT - MARGIN - 60);
    cursor = ensureSpace(cursor, h + 30, doc, accent, theme, organisation);
    cursor.page.drawImage(embedded, {
      x: MARGIN, y: cursor.y - h,
      width: w, height: h,
    });
    cursor = { page: cursor.page, y: cursor.y - h - 6 };
    cursor.page.drawText(sanitiseForPdf(v.caption), {
      x: MARGIN, y: cursor.y - BODY_FONT_SIZE,
      size: BODY_FONT_SIZE, font: body,
      color: rgb(theme.mutedText.r, theme.mutedText.g, theme.mutedText.b),
    });
    cursor = { page: cursor.page, y: cursor.y - BODY_FONT_SIZE - 12 };
  }
  return cursor;
}

async function renderAnnotations(
  cursor: PageCursor,
  inputs: ReportInputs,
  doc: PDFDocument,
  accent: ParsedColor,
  theme: ReportThemePalette,
  body: PDFFont,
  bold: PDFFont,
  organisation: string | undefined,
): Promise<PageCursor> {
  // Keep-with-next (see renderMeasurements).
  const aPlaceholder =
    'No annotations on this scan. Use the Annotate tool on the tool dock to flag issues, name features, or attach notes.';
  cursor = ensureSpace(
    cursor,
    inputs.annotations.length === 0 ? sectionKeepTogetherSpace(aPlaceholder, body) : 60,
    doc, accent, theme, organisation,
  );
  cursor = drawSectionHeader(cursor, `Annotations (${inputs.annotations.length})`, accent, bold);
  if (inputs.annotations.length === 0) {
    cursor = drawBodyLine(cursor, aPlaceholder, body, theme);
    return { page: cursor.page, y: cursor.y - 10 };
  }
  // Grouping summary — same line the live Annotations panel shows, so the
  // deliverable opens with the shape of the notes (totals, categories, areas).
  const groupSummary = describeAnnotationGroups(
    inputs.annotations.map((a) => ({ type: a.type as AnnotationType, localPosition: a.position })),
  );
  if (groupSummary) cursor = drawBodyLine(cursor, groupSummary, body, theme);
  for (const a of inputs.annotations) {
    cursor = ensureSpace(cursor, 36, doc, accent, theme, organisation);
    // Title + type badge.
    cursor.page.drawText(sanitiseForPdf(`${a.title}  [${a.type}]`), {
      x: MARGIN, y: cursor.y - BODY_FONT_SIZE,
      size: BODY_FONT_SIZE, font: bold,
      color: rgb(theme.bodyText.r, theme.bodyText.g, theme.bodyText.b),
    });
    cursor = { page: cursor.page, y: cursor.y - BODY_FONT_SIZE - 2 };
    if (a.note) {
      cursor = drawBodyLine(cursor, a.note, body, theme);
    }
    cursor = drawBodyLine(
      cursor,
      `Position: ${a.position.x.toFixed(3)}, ${a.position.y.toFixed(3)}, ${a.position.z.toFixed(3)}`,
      body,
      theme,
    );
    cursor = { page: cursor.page, y: cursor.y - 6 };
  }
  return cursor;
}

async function renderMeasurements(
  cursor: PageCursor,
  inputs: ReportInputs,
  doc: PDFDocument,
  accent: ParsedColor,
  theme: ReportThemePalette,
  body: PDFFont,
  bold: PDFFont,
  organisation: string | undefined,
): Promise<PageCursor> {
  // Keep-with-next: an empty section is a heading + a short placeholder —
  // reserve exactly that, so the block stays with its predecessor whenever
  // it fits and never splits across the break.
  const mPlaceholder =
    'No measurements taken. Use the Measure tool on the tool dock to record distances, areas, or volumes before exporting.';
  cursor = ensureSpace(
    cursor,
    inputs.measurements.length === 0 ? sectionKeepTogetherSpace(mPlaceholder, body) : 60,
    doc, accent, theme, organisation,
  );
  cursor = drawSectionHeader(cursor, `Measurements (${inputs.measurements.length})`, accent, bold);
  if (inputs.measurements.length === 0) {
    cursor = drawBodyLine(cursor, mPlaceholder, body, theme);
    return { page: cursor.page, y: cursor.y - 10 };
  }
  for (const m of inputs.measurements) {
    // v0.3.10 Profile-as-Deliverable — profile rows expand into a
    // multi-line block when `profileExtras` is present. Estimate the
    // vertical space needed before drawing so a row never splits
    // across a page boundary.
    const extras = m.profileExtras;
    const rowH = extras
      ? 16 + 12 * 4 + (extras.coverageCaveat ? 12 : 0) + (extras.chart ? 68 : 0)
      : 16;
    cursor = ensureSpace(cursor, rowH, doc, accent, theme, organisation);
    cursor = drawLabelValueRow(cursor, `${m.kind} · ${m.name}`, m.value, body, bold, theme);
    if (extras) {
      cursor = drawLabelValueRow(cursor, '  summary', extras.summary, body, bold, theme);
      cursor = drawLabelValueRow(cursor, '  stations', extras.stations, body, bold, theme);
      cursor = drawLabelValueRow(cursor, '  interval', extras.stationInterval, body, bold, theme);
      cursor = drawLabelValueRow(cursor, '  slopes', extras.slopeSummary, body, bold, theme);
      if (extras.coverageCaveat) {
        cursor = drawLabelValueRow(cursor, '  coverage', extras.coverageCaveat, body, bold, theme);
      }
      if (extras.chart && extras.chart.length >= 2) {
        cursor = drawProfileChart(cursor, extras.chart, theme, accent, doc, body, organisation);
      }
    }
  }
  // Footer caveat — civil/survey users need to see "this is not
  // survey-grade unless validated" once at the bottom of the
  // measurements section. v0.3.10 Profile-as-Deliverable stream.
  if (inputs.measurements.some((m) => m.kind === 'profile')) {
    cursor = ensureSpace(cursor, 14, doc, accent, theme, organisation);
    cursor = drawBodyLine(
      cursor,
      'Note: profile measurements are for visual inspection. Treat them as ' +
        'survey-grade only when validated against ground truth + procedures.',
      body,
      theme,
    );
  }
  return { page: cursor.page, y: cursor.y - 10 };
}

/**
 * Keep every drawn string WinAnsi-encodable. pdf-lib's
 * StandardFonts.Helvetica is WinAnsi (CP1252)-encoded; characters outside
 * its repertoire throw "WinAnsi cannot encode" at draw time, and the
 * per-section error path would then drop the whole section. Sanitising
 * up-front keeps that path for genuine bugs.
 *
 * WinAnsi genuinely COVERS the typographic glyphs an engineering report
 * needs — ×, ÷, ±, ², ³, °, ·, §, µ, em/en dashes, ellipsis, curly quotes,
 * bullets — so those pass through untouched and print as themselves (the
 * pre-v0.5.4 ASCII fallbacks "m^2", "--", "1.96 x" are gone). Only glyphs
 * WinAnsi truly lacks are mapped: comparison operators to ASCII, Greek to
 * names, and Latin-Extended letters from cited author names to their base
 * letters. Anything else becomes '?' so the substitution stays visible.
 *
 * Exported for the glyph-substitution unit tests.
 */
export function sanitiseForPdf(input: string): string {
  return (
    input
      // Operators WinAnsi genuinely lacks.
      .replaceAll('≥', '>=')
      .replaceAll('≤', '<=')
      .replaceAll('≠', '!=')
      .replaceAll('√', 'sqrt')
      .replaceAll('Δ', 'd')
      .replaceAll('σ', 'sigma')
      // Latin-Extended letters that appear in cited author names
      // (e.g. "Ruzgienė") — transliterated to their base letter rather
      // than degraded to '?'. This list covers the Latin-Extended-A
      // letters realistically seen in survey/remote-sensing citations.
      .replaceAll(/[ĀĄ]/g, 'A').replaceAll(/[āą]/g, 'a')
      .replaceAll(/[ĆĈĊČ]/g, 'C').replaceAll(/[ćĉċč]/g, 'c')
      .replaceAll(/[ĒĖĘĚ]/g, 'E').replaceAll(/[ēėęě]/g, 'e')
      .replaceAll(/[ĜĞĠĢ]/g, 'G').replaceAll(/[ĝğġģ]/g, 'g')
      .replaceAll(/[ĨĪĮİ]/g, 'I').replaceAll(/[ĩīįı]/g, 'i')
      .replaceAll(/[ĹĻĽŁ]/g, 'L').replaceAll(/[ĺļľł]/g, 'l')
      .replaceAll(/[ŃŅŇ]/g, 'N').replaceAll(/[ńņň]/g, 'n')
      .replaceAll(/[ŌŐ]/g, 'O').replaceAll(/[ōő]/g, 'o')
      .replaceAll(/[ŔŖŘ]/g, 'R').replaceAll(/[ŕŗř]/g, 'r')
      .replaceAll(/[ŚŜŞ]/g, 'S').replaceAll(/[śŝş]/g, 's')
      .replaceAll(/[ŢŤ]/g, 'T').replaceAll(/[ţť]/g, 't')
      .replaceAll(/[ŨŪŬŮŰŲ]/g, 'U').replaceAll(/[ũūŭůűų]/g, 'u')
      .replaceAll(/[ŹŻ]/g, 'Z').replaceAll(/[źż]/g, 'z')
      // Fallback: any remaining codepoint outside pdf-lib Helvetica's
      // WinAnsi repertoire — printable ASCII, the Latin-1 supplement, and
      // the CP1252 punctuation block (dashes, ellipsis, quotes, bullet,
      // €, ‰, ™, Š/š, Ž/ž, Œ/œ, Ÿ, ƒ, †, ‡, ‹›, ‚„, ˆ, ˜) — is
      // replaced with '?'. The section keeps rendering and the
      // substitution stays visible so the user can clean up the source.
      .replace(/[^\x20-\x7E\xA0-\xFF€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/g, '?')
  );
}

/**
 * v0.3.6 — Acceptance Checklist section. Renders a pass/fail table over
 * user-supplied thresholds, then a Methods appendix that cites the
 * literature behind every metric.
 *
 * The colour signalling is deliberately restrained: the headline reads
 * green when every row passes and red when any row fails, but the
 * per-row indicator is a small dot in the theme's accent (pass) or a
 * muted red (fail) — the report stays scannable on the
 * `dark-inspection` and `minimal-engineering` themes.
 */
async function renderAcceptanceChecklist(
  cursor: PageCursor,
  inputs: ReportInputs,
  doc: PDFDocument,
  accent: ParsedColor,
  theme: ReportThemePalette,
  body: PDFFont,
  bold: PDFFont,
  organisation: string | undefined,
): Promise<PageCursor> {
  const checks = inputs.acceptanceChecks ?? [];
  if (checks.length === 0) return cursor;

  cursor = ensureSpace(cursor, 80, doc, accent, theme, organisation);
  cursor = drawSectionHeader(cursor, 'Acceptance', accent, bold);

  // Headline summary — "5 of 6 checks passed" or "All 6 checks passed".
  const failed = checks.filter((c) => !c.pass).length;
  const passed = checks.length - failed;
  const headline = failed === 0
    ? `All ${checks.length} ${checks.length === 1 ? 'check' : 'checks'} passed`
    : `${passed} of ${checks.length} checks passed — ${failed} ${failed === 1 ? 'failure' : 'failures'}`;
  cursor.page.drawText(headline, {
    x: MARGIN, y: cursor.y - BODY_FONT_SIZE,
    size: BODY_FONT_SIZE, font: bold,
    color: failed === 0
      ? rgb(accent.r, accent.g, accent.b)
      : rgb(0.78, 0.22, 0.22),
  });
  cursor = { page: cursor.page, y: cursor.y - BODY_FONT_SIZE - 10 };

  // The check rows themselves. Layout uses the 12-column print grid:
  //   - col 1        — status marker (dot + redundant P/F letter for
  //                    grayscale + colorblind disambiguation)
  //   - cols 2-5     — label
  //   - cols 6-8     — threshold
  //   - cols 9-12    — actual value (bold + red on fail)
  // The redundant P/F letter is the scientific-visualization principle of
  // "never rely on colour alone" applied to the QA semantic.
  const COL_LABEL_X = gridX(2);
  const COL_THRESHOLD_X = gridX(6);
  const COL_ACTUAL_X = gridX(9);
  for (const row of checks) {
    cursor = ensureSpace(cursor, 18, doc, accent, theme, organisation);
    const dotColor = row.pass
      ? rgb(accent.r, accent.g, accent.b)
      : rgb(0.78, 0.22, 0.22);
    // Status dot.
    cursor.page.drawCircle({
      x: gridX(1) + 3, y: cursor.y - BODY_FONT_SIZE + 3,
      size: 3,
      color: dotColor,
    });
    // Redundant letter — small "P" / "F" centred over the dot. The
    // letter encodes pass/fail independently of the dot's colour, so
    // colorblind readers and grayscale printouts retain the meaning.
    cursor.page.drawText(row.pass ? 'P' : 'F', {
      x: gridX(1) + 1.4, y: cursor.y - BODY_FONT_SIZE + 0.5,
      size: 5, font: bold,
      color: rgb(
        theme.pageBackground.r,
        theme.pageBackground.g,
        theme.pageBackground.b,
      ),
    });
    // Label.
    cursor.page.drawText(sanitiseForPdf(row.label), {
      x: COL_LABEL_X, y: cursor.y - BODY_FONT_SIZE,
      size: BODY_FONT_SIZE, font: body,
      color: rgb(theme.bodyText.r, theme.bodyText.g, theme.bodyText.b),
    });
    // Threshold.
    cursor.page.drawText(sanitiseForPdf(row.threshold), {
      x: COL_THRESHOLD_X, y: cursor.y - BODY_FONT_SIZE,
      size: BODY_FONT_SIZE - 0.5, font: body,
      color: rgb(theme.mutedText.r, theme.mutedText.g, theme.mutedText.b),
    });
    // Actual.
    cursor.page.drawText(sanitiseForPdf(row.actual), {
      x: COL_ACTUAL_X, y: cursor.y - BODY_FONT_SIZE,
      size: BODY_FONT_SIZE, font: row.pass ? body : bold,
      color: row.pass
        ? rgb(theme.bodyText.r, theme.bodyText.g, theme.bodyText.b)
        : rgb(0.78, 0.22, 0.22),
    });
    cursor = { page: cursor.page, y: cursor.y - BODY_FONT_SIZE - 4 };

    // Optional explanation line for failed rows.
    if (row.note) {
      cursor = ensureSpace(cursor, 12, doc, accent, theme, organisation);
      cursor.page.drawText(`- ${sanitiseForPdf(row.note)}`, {
        x: COL_LABEL_X, y: cursor.y - BODY_FONT_SIZE + 2,
        size: BODY_FONT_SIZE - 1.5, font: body,
        color: rgb(theme.mutedText.r, theme.mutedText.g, theme.mutedText.b),
      });
      cursor = { page: cursor.page, y: cursor.y - BODY_FONT_SIZE - 1 };
    }
  }

  // Methods appendix — every Scan Acceptance template carries it. The
  // citations are the actual source the user can hand to a reviewer.
  cursor = ensureSpace(cursor, 80, doc, accent, theme, organisation);
  cursor = { page: cursor.page, y: cursor.y - 10 };
  cursor = drawSectionHeader(cursor, 'Methods', accent, bold);
  const methodsLines = [
    'Thresholds shown above were supplied by the report author. The viewer',
    'reports measured values; the pass/fail decision is the author\'s.',
    '',
    'Metadata-row methodology:',
    '  - Point count, classification / intensity / RGB presence: read directly',
    '    from the LAS / LAZ / COPC / EPT header without sampling.',
    '  - CRS: parsed from the LASF_Projection VLR (LAS / LAZ) or the',
    '    ept.json srs.wkt field (EPT).',
    '  - File hash: SHA-256 over the source bytes for chain-of-custody.',
    '  - Capture date: read from the LAS public header GPS time field',
    '    when present.',
    '',
    'Cloud-sampled methodology (out of scope for this report):',
    '  - Density / NPS heatmap / void test: Lohani & Ghosh 2017 §6',
    '    (Springer NASI A, peer-reviewed). Void area threshold = (4 × NPS)²;',
    '    spatial distribution test = ≥ 90 % of (2 × NPS)² cells contain',
    '    ≥ 1 first return.',
    '  - NVA / VVA from GCPs: NVA = 1.96 × RMSEz (open ground, normal',
    '    distribution); VVA = 95th percentile of |ΔZ| (vegetated).',
    '    Lohani & Ghosh 2017 §6.',
    '  - Civil tolerance bands: planimetric ≤ 1.0 / 1.6 × GSD,',
    '    elevation ≤ 1.6 / 2.5 × GSD. Ruzgienė 2025 §4.',
    '  - iPhone-LiDAR empirical envelope: 0.115 m H-RMSE with re-anchoring,',
    '    0.16 m V-RMSE at 20 m GCP spacing. Krausková 2025 (Sensors).',
    '',
    'None of the above implies survey-grade accuracy without independent',
    'GCP validation. See OpenLiDARViewer\'s positioning notes in the docs.',
  ];
  for (const line of methodsLines) {
    cursor = ensureSpace(cursor, 13, doc, accent, theme, organisation);
    // Sanitised so the diacritics in the cited author names (Ruzgienė,
    // Krausková) transliterate instead of throwing at draw time; the ≥ / ≤ /
    // × / ² glyphs above are WinAnsi-native and pass through as themselves.
    cursor.page.drawText(sanitiseForPdf(line), {
      x: MARGIN, y: cursor.y - BODY_FONT_SIZE + 1,
      size: BODY_FONT_SIZE - 1.5, font: body,
      color: rgb(theme.mutedText.r, theme.mutedText.g, theme.mutedText.b),
    });
    cursor = { page: cursor.page, y: cursor.y - BODY_FONT_SIZE - 1 };
  }

  return cursor;
}

async function renderTechnicalNotes(
  cursor: PageCursor,
  inputs: ReportInputs,
  doc: PDFDocument,
  accent: ParsedColor,
  theme: ReportThemePalette,
  body: PDFFont,
  bold: PDFFont,
  organisation: string | undefined,
): Promise<PageCursor> {
  // Keep-with-next (see renderMeasurements): the empty block reserves
  // exactly heading + placeholder, and a short notes body reserves its
  // first line with the heading.
  const nPlaceholder =
    'No technical notes provided. Pass a notes string when generating the report to fill this section.';
  cursor = ensureSpace(
    cursor,
    inputs.technicalNotes ? 60 : sectionKeepTogetherSpace(nPlaceholder, body),
    doc, accent, theme, organisation,
  );
  cursor = drawSectionHeader(cursor, 'Technical notes', accent, bold);
  if (!inputs.technicalNotes) {
    cursor = drawBodyLine(cursor, nPlaceholder, body, theme);
    return { page: cursor.page, y: cursor.y - 10 };
  }
  // no full paragraph reflow; we split on newlines and
  // render each line. A real text-wrapping pass lands in a follow-up
  // when the notes section grows enough to warrant it.
  for (const line of inputs.technicalNotes.split('\n')) {
    cursor = ensureSpace(cursor, 14, doc, accent, theme, organisation);
    cursor = drawBodyLine(cursor, line, body, theme);
  }
  return cursor;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function embedVisual(doc: PDFDocument, asset: ReportVisualAsset): Promise<PDFImage | null> {
  try {
    const bytes = new Uint8Array(await asset.blob.arrayBuffer());
    // PNG is the Studio's exclusive output format; pdf-lib's
    // embedPng is the right call.
    return await doc.embedPng(bytes);
  } catch {
    return null;
  }
}

async function embedDataUrl(doc: PDFDocument, dataUrl: string): Promise<PDFImage> {
  const match = /^data:image\/(png|jpeg|jpg);base64,(.+)$/i.exec(dataUrl);
  if (!match) throw new Error('Branding logo: only PNG / JPEG data URLs are supported.');
  const isPng = match[1].toLowerCase() === 'png';
  const bytes = base64ToBytes(match[2]);
  return isPng ? doc.embedPng(bytes) : doc.embedJpg(bytes);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Pass over every page after the document is built, stamping the page
 * number + total count in the footer. Done in a second pass so the total
 * is known.
 *
 * accepts a theme so the footer text colour matches the page
 * palette (dark themes need light footer text), and an optional
 * `footerNote` that's rendered above the standard line for compliance /
 * footer / project-code annotations.
 */
function stampFooterPageNumbers(
  doc: PDFDocument,
  body: PDFFont,
  theme: ReportThemePalette,
  footerNote: string | undefined,
): void {
  const pages = doc.getPages();
  const total = pages.length;
  for (let i = 0; i < total; i++) {
    const standardLine = `OpenLiDARViewer · ${i + 1} of ${total}`;
    pages[i].drawText(sanitiseForPdf(standardLine), {
      x: MARGIN, y: 12,
      size: 9, font: body,
      color: rgb(theme.mutedText.r, theme.mutedText.g, theme.mutedText.b),
    });
    if (footerNote) {
      pages[i].drawText(sanitiseForPdf(footerNote), {
        x: MARGIN, y: 22,
        size: 8, font: body,
        color: rgb(theme.mutedText.r, theme.mutedText.g, theme.mutedText.b),
      });
    }
  }
}
