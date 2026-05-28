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
  ReportVisualAsset,
} from './types';
import {
  effectiveBranding,
  parseAccentColor,
  resolveTheme,
  type ParsedColor,
  type ReportThemePalette,
} from './ReportBranding';

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
  doc.setTitle(inputs.cover.title);
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

  for (const section of template.sections) {
    cursor = await renderSection(
      section, inputs, cursor, doc, accent, theme,
      helvetica, helveticaBold, logoImage, branding.organisation,
    );
  }

  // Stamp page numbers in the footer of every page that was added. The
  // optional footer note (confidentiality, project code, etc.) is appended
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
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section dispatcher
// ─────────────────────────────────────────────────────────────────────────────

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
    case 'dataset-summary':
      return renderDatasetSummary(cursor, inputs, doc, accent, theme, body, bold, organisation);
    case 'visuals':
      return renderVisuals(cursor, inputs, doc, accent, theme, body, bold, organisation);
    case 'annotations':
      return renderAnnotations(cursor, inputs, doc, accent, theme, body, bold, organisation);
    case 'measurements':
      return renderMeasurements(cursor, inputs, doc, accent, theme, body, bold, organisation);
    case 'technical-notes':
      return renderTechnicalNotes(cursor, inputs, doc, accent, theme, body, bold, organisation);
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

function drawSectionHeader(
  cursor: PageCursor,
  text: string,
  accent: ParsedColor,
  bold: PDFFont,
): PageCursor {
  cursor.page.drawText(text, {
    x: MARGIN, y: cursor.y - HEADER_FONT_SIZE,
    size: HEADER_FONT_SIZE, font: bold,
    color: rgb(accent.r, accent.g, accent.b),
  });
  cursor.page.drawRectangle({
    x: MARGIN, y: cursor.y - HEADER_FONT_SIZE - 4,
    width: 40, height: 1.5,
    color: rgb(accent.r, accent.g, accent.b),
  });
  return { page: cursor.page, y: cursor.y - HEADER_FONT_SIZE - 14 };
}

function drawBodyLine(
  cursor: PageCursor,
  text: string,
  body: PDFFont,
  theme: ReportThemePalette,
): PageCursor {
  cursor.page.drawText(text, {
    x: MARGIN, y: cursor.y - BODY_FONT_SIZE,
    size: BODY_FONT_SIZE, font: body,
    color: rgb(theme.bodyText.r, theme.bodyText.g, theme.bodyText.b),
  });
  return { page: cursor.page, y: cursor.y - BODY_FONT_SIZE - 4 };
}

function drawLabelValueRow(
  cursor: PageCursor,
  label: string,
  value: string,
  body: PDFFont,
  bold: PDFFont,
  theme: ReportThemePalette,
): PageCursor {
  cursor.page.drawText(label, {
    x: MARGIN, y: cursor.y - BODY_FONT_SIZE,
    size: BODY_FONT_SIZE, font: bold,
    color: rgb(theme.mutedText.r, theme.mutedText.g, theme.mutedText.b),
  });
  cursor.page.drawText(value, {
    x: MARGIN + 120, y: cursor.y - BODY_FONT_SIZE,
    size: BODY_FONT_SIZE, font: body,
    color: rgb(theme.bodyText.r, theme.bodyText.g, theme.bodyText.b),
  });
  return { page: cursor.page, y: cursor.y - BODY_FONT_SIZE - 4 };
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
  // Logo (optional) at the top-left, scaled to a 48-pt height.
  if (logo) {
    const scale = 48 / logo.height;
    cursor.page.drawImage(logo, {
      x: MARGIN, y: cursor.y - 48,
      width: logo.width * scale, height: 48,
    });
    cursor = { page: cursor.page, y: cursor.y - 64 };
  }
  // Big title.
  cursor.page.drawText(inputs.cover.title, {
    x: MARGIN, y: cursor.y - TITLE_FONT_SIZE,
    size: TITLE_FONT_SIZE, font: bold,
    color: rgb(theme.bodyText.r, theme.bodyText.g, theme.bodyText.b),
  });
  cursor = { page: cursor.page, y: cursor.y - TITLE_FONT_SIZE - 4 };
  // Subtitle.
  if (inputs.cover.subtitle) {
    cursor.page.drawText(inputs.cover.subtitle, {
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
  if (inputs.visuals.length === 0) return cursor;
  cursor = ensureSpace(cursor, 60, doc, accent, theme, organisation);
  cursor = drawSectionHeader(cursor, 'Visuals', accent, bold);
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
    cursor.page.drawText(v.caption, {
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
  if (inputs.annotations.length === 0) return cursor;
  cursor = ensureSpace(cursor, 60, doc, accent, theme, organisation);
  cursor = drawSectionHeader(cursor, `Annotations (${inputs.annotations.length})`, accent, bold);
  for (const a of inputs.annotations) {
    cursor = ensureSpace(cursor, 36, doc, accent, theme, organisation);
    // Title + type badge.
    cursor.page.drawText(`${a.title}  [${a.type}]`, {
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
  if (inputs.measurements.length === 0) return cursor;
  cursor = ensureSpace(cursor, 60, doc, accent, theme, organisation);
  cursor = drawSectionHeader(cursor, `Measurements (${inputs.measurements.length})`, accent, bold);
  for (const m of inputs.measurements) {
    cursor = ensureSpace(cursor, 16, doc, accent, theme, organisation);
    cursor = drawLabelValueRow(cursor, `${m.kind} · ${m.name}`, m.value, body, bold, theme);
  }
  return { page: cursor.page, y: cursor.y - 10 };
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
  if (!inputs.technicalNotes) return cursor;
  cursor = ensureSpace(cursor, 60, doc, accent, theme, organisation);
  cursor = drawSectionHeader(cursor, 'Technical notes', accent, bold);
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
 * confidentiality / project-code annotations.
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
    pages[i].drawText(standardLine, {
      x: MARGIN, y: 12,
      size: 9, font: body,
      color: rgb(theme.mutedText.r, theme.mutedText.g, theme.mutedText.b),
    });
    if (footerNote) {
      pages[i].drawText(footerNote, {
        x: MARGIN, y: 22,
        size: 8, font: body,
        color: rgb(theme.mutedText.r, theme.mutedText.g, theme.mutedText.b),
      });
    }
  }
}
