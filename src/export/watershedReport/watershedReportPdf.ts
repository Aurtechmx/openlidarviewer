/**
 * watershedReportPdf.ts: lays the watershed study out page by page and saves
 * the PDF.
 *
 * Order: cover; reading guide; whole-site map; for each studied catchment its
 * summary, figures, network and timing, and detail map; data quality, method
 * and limits; appendix A. A part longer than a page continues on the next
 * page under the same spine, so the page count is at least 3 + 4 × sections
 * + 2. `renderWatershedReport` also returns which part each page belongs to.
 *
 * Every word comes from the catalog in the model's language. A withheld
 * figure is printed as its catalog reason, never as a dash. The same model,
 * with the same `generatedAt`, saves to the same bytes: the Info dates are
 * pinned to `generatedAt` and nothing reads the clock.
 *
 * Belongs to the report's lazy chunk (`loadWatershedReport`).
 */
import { PDFDocument } from 'pdf-lib';
import type { FlowGrid } from '../../simulation/flowPulse/flowTypes';
import type { Figure, WithheldReason } from '../../simulation/flowPulse/watershed/catchmentMorphometrics';
import {
  MAX_FAR_INTERPOLATED_RUN, SUPPORTED_CHANNEL_INTERPOLATED_SHARE, SUPPORTED_MEASURED_SHARE,
} from '../../simulation/flowPulse/watershed/catchmentQuality';
import type { Verdict } from '../../simulation/flowPulse/watershed/catchmentQuality';
import {
  catchmentNarrative, formatHeight, formatLength, formatPercent, headline, qualityReasons, withheldText,
} from '../../simulation/flowPulse/watershed/watershedNarrative';
import type {
  CatchmentSection, ReportLanguage, WatershedReportModel,
} from '../../simulation/flowPulse/watershed/watershedReportModel';
import { UNIT_GAP, formatArea, formatNumber, t, type StringKey } from '../../simulation/flowPulse/watershed/watershedStrings';
import { embedReportFonts, type ReportFonts } from './reportFonts';
import { clampNotes } from './watershedReportOptions';
import {
  PALETTE, callout, chip, drawRuns, kpiRow, newPage, paragraph, sectionTitle, table, widthOf,
  type PageCursor, type PageSize,
} from './pageKit';
import { drawMapPage, siteRaster, smoothLine } from './mapPage';
import { drawChannelProfile, fitSize, strokePath, wrapText } from './charts';

export interface WatershedReportOptions {
  readonly size: PageSize;
  readonly encodePng: (rgba: Uint8Array, w: number, h: number) => Promise<Uint8Array>;
  readonly loadFont?: (name: string) => Promise<Uint8Array>;
  /** Faces to use when the report fonts cannot be embedded. Omitted: the failure is thrown. */
  readonly fallbackFonts?: (doc: PDFDocument) => Promise<ReportFonts>;
  /**
   * The raster layers the maps need beyond the model: the run's flow grid,
   * the DTM coverage per cell and the run's filled-cell mask.
   */
  readonly raster: { readonly grid: FlowGrid; readonly coverage: Uint8Array; readonly filled: Uint8Array | null };
  /** Source file name for the cover; left out when not given. */
  readonly sourceName?: string | null;
  /** Free text printed under the cover title block as "Notes"; see clampNotes. */
  readonly projectNotes?: string | null;
  /** Printed on the cover signature lines when given; blank lines otherwise. */
  readonly preparedBy?: string | null;
  readonly checkedBy?: string | null;
  /** A name per section label, shown as "C1 · name". The label stays the stable key. */
  readonly catchmentNames?: Readonly<Record<string, string>>;
  /** Printed on the cover and at the right of every footer: the PREVIEW / not survey-grade line. */
  readonly status?: string | null;
  /** Pages drawn right after the site map, and right before the data quality page. */
  readonly afterSiteMap?: (hooks: ReportHooks) => Promise<void> | void;
  readonly beforeQuality?: (hooks: ReportHooks) => Promise<void> | void;
}

/** What an extra part needs to start pages in the report's own style. */
export interface ReportHooks {
  readonly doc: PDFDocument;
  readonly fonts: ReportFonts;
  readonly size: PageSize;
  /** A new page under spine `id`, labelled `section`, with the report footer. */
  readonly start: (id: string, section: string) => PageCursor;
  /** Tags every page added since the last tag with `label`. */
  readonly tag: (label: string) => void;
}

export type ReportPart = 'cover' | 'guide' | 'summary' | 'details' | 'drainage' | 'quality' | 'appendix';
export interface ReportPageTag { readonly part: ReportPart; readonly label: string | null }

const SPINE_ID = { guide: '§', quality: '§', appendix: 'A' } as const;

export function watershedReportFilename(base: string, lang: ReportLanguage): string {
  return `${base}-watershed-report-${lang}.pdf`;
}

export async function buildWatershedReportPdf(model: WatershedReportModel, opts: WatershedReportOptions): Promise<Uint8Array> {
  return (await renderWatershedReport(model, opts)).bytes;
}

// --- Formatting -----------------------------------------------------------------

/** A figure's value in words, "≥ " before a minimum, or the catalog's reason when withheld. */
function fig(lang: ReportLanguage, f: Figure<number>, fmt: (v: number) => string, approx = false): string {
  if ('withheld' in f) return withheldText(lang, f.withheld);
  return `${approx ? APPROX : ''}${f.bound === 'minimum' ? '≥\u00a0' : ''}${fmt(f.value)}`;
}

/** Marks every figure of a catchment the data do not support. */
const APPROX = '~\u00a0';

function formatDate(lang: ReportLanguage, d: Date): string {
  return new Intl.DateTimeFormat(lang === 'es' ? 'es-MX' : 'en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(d);
}

function cellText(lang: ReportLanguage, [sx, sy]: readonly [number, number]): string {
  const a = formatNumber(lang, sx, 2);
  return sx === sy ? `${a}${UNIT_GAP}m` : `${a} × ${formatNumber(lang, sy, 2)}${UNIT_GAP}m`;
}

const verdictKey = (v: Verdict) => `verdict.${v}` as StringKey;

/** Ground returns per m²; withheld with its reason when the scale is unknown or no counts were recorded. */
function densityText(lang: ReportLanguage, d: number | null): string {
  if (d === null) return t(lang, 'quality.noScale');
  if (!(d > 0)) return t(lang, 'quality.noCounts');
  return formatNumber(lang, d, 1);
}

/** Below 0.1 m a hollow's depth prints as "< 0.1 m" rather than rounding to zero. */
function depthText(lang: ReportLanguage, m: number | null): string {
  if (m === null) return withheldText(lang, 'vertical-unresolved');
  return m < 0.1 ? `< ${formatHeight(lang, 0.1)}` : formatHeight(lang, m);
}

function isOpen(s: CatchmentSection): boolean {
  const a = s.morph.areaM2;
  return !s.quality.complete || ('value' in a && a.bound === 'minimum');
}
const D8_BIAS = 0.082;

// --- Local layout helpers -----------------------------------------------------

/** Kicker, a title wrapped at 24 pt, and an optional lede. */
function pageHeading(c: PageCursor, kicker: string, title: string, lede: string | null, fonts: ReportFonts, titleSize = 18): PageCursor {
  let y = c.y - 10.5;
  drawRuns(c.page, kicker.toUpperCase(), c.left, y, { font: fonts.bodyBold, size: 10.5, color: PALETTE.water }, fonts);
  y -= 6;
  for (const line of wrapText(title, fonts.titleBold, titleSize, c.right - c.left, fonts)) {
    y -= titleSize;
    drawRuns(c.page, line, c.left, y, { font: fonts.titleBold, size: titleSize, color: PALETTE.ink }, fonts);
    y -= 4;
  }
  let cur: PageCursor = { ...c, y: y - 8 };
  if (lede) cur = paragraph(cur, lede, fonts, { size: 11 });
  return { ...cur, y: cur.y - 6 };
}

/** A numbered list starting at `first`, kept to the cursor's column. */
function numberedFrom(first: number, c: PageCursor, items: readonly string[], fonts: ReportFonts, size: number): PageCursor {
  let cur = c;
  items.forEach((text, i) => {
    drawRuns(cur.page, String(first + i), cur.left, cur.y - size - 1, { font: fonts.titleBold, size: size + 2, color: PALETTE.water }, fonts);
    const next = paragraph({ ...cur, left: cur.left + 18 }, text, fonts, { size });
    cur = { ...next, left: c.left };
  });
  return cur;
}

/** A numbered list: the number in the title face, the text indented beside it. */
function numbered(c: PageCursor, items: readonly string[], fonts: ReportFonts, size = 10.5): PageCursor {
  let cur = c;
  items.forEach((text, i) => {
    if (cur.y - 16 < cur.bottom) cur = newPage(cur.ctx.doc, cur.ctx.size, cur.ctx.spine, fonts, cur.ctx.footer);
    drawRuns(cur.page, String(i + 1), cur.left, cur.y - size - 1, { font: fonts.titleBold, size: size + 2, color: PALETTE.water }, fonts);
    const next = paragraph({ ...cur, left: cur.left + 18 }, text, fonts, { size });
    // A continuation page comes back from newPage with the page's own left margin.
    cur = { ...next, left: cur.page === next.page ? cur.left : next.left };
  });
  return cur;
}

/** A narrative step: its name as a small label in a left column, the sentences beside it. */
function stepParagraph(c: PageCursor, label: string, text: string, fonts: ReportFonts, size = 10.5): PageCursor {
  const LABEL_W = 104;
  const cur = keep(c, 30, fonts);
  const lines = wrapText(label.toUpperCase(), fonts.bodyBold, 9.8, LABEL_W - 8, fonts);
  lines.forEach((line, k) => drawRuns(cur.page, line, cur.left, cur.y - size - k * 12, { font: fonts.bodyBold, size: 9.8, color: PALETTE.water }, fonts));
  const next = paragraph({ ...cur, left: cur.left + LABEL_W }, text, fonts, { size });
  const y = Math.min(next.y, cur.page === next.page ? cur.y - lines.length * 12 - 8 : next.y);
  return { ...next, y, left: cur.page === next.page ? cur.left : next.left };
}

function caption(c: PageCursor, text: string, fonts: ReportFonts): PageCursor {
  const lines = wrapText(text, fonts.body, 10.5, c.right - c.left, fonts);
  // Like every block, a caption that would cross the bottom margin starts the next page.
  c = keep(c, lines.length * 10.5 * 1.35, fonts);
  let y = c.y;
  for (const line of lines) {
    y -= 10.5 * 1.35;
    drawRuns(c.page, line, c.left, y, { font: fonts.body, size: 10.5, color: PALETTE.mute }, fonts);
  }
  return { ...c, y: y - 6 };
}

/** Starts a continuation page unless `needed` points fit above the bottom margin. */
function keep(c: PageCursor, needed: number, fonts: ReportFonts): PageCursor {
  return c.y - needed >= c.bottom ? c : newPage(c.ctx.doc, c.ctx.size, c.ctx.spine, fonts, c.ctx.footer);
}

/** Terms in bold with their definitions beside them, ruled between rows. */
function definitions(c: PageCursor, rows: readonly (readonly [string, string])[], fonts: ReportFonts, size = 9.5): PageCursor {
  const termW = Math.floor((c.right - c.left) * 0.32);
  const step = size * 1.32;
  let cur = c;
  for (const [term, def] of rows) {
    const tl = wrapText(term, fonts.bodyBold, size, termW - 8, fonts);
    const dl = wrapText(def, fonts.body, size, c.right - c.left - termW, fonts);
    const h = Math.max(tl.length, dl.length) * step + 5;
    cur = keep(cur, h, fonts);
    tl.forEach((line, k) => drawRuns(cur.page, line, cur.left, cur.y - size - 2 - k * step, { font: fonts.bodyBold, size, color: PALETTE.ink }, fonts));
    dl.forEach((line, k) => drawRuns(cur.page, line, cur.left + termW, cur.y - size - 2 - k * step, { font: fonts.body, size, color: PALETTE.ink }, fonts));
    cur.page.drawLine({ start: { x: cur.left, y: cur.y - h + 2 }, end: { x: cur.right, y: cur.y - h + 2 }, thickness: 0.4, color: PALETTE.rule });
    cur = { ...cur, y: cur.y - h };
  }
  return { ...cur, y: cur.y - 8 };
}

/** Column widths from fractions of the text width. */
function cols(c: PageCursor, spec: readonly (readonly [string, 'left' | 'right', number])[]) {
  const w = c.right - c.left;
  return spec.map(([title, align, f]) => ({ title, align, width: Math.floor(w * f) }));
}

/** "C1 · Culvert at the north road" when the user named the catchment, else the label. */
function displayName(label: string, names: Readonly<Record<string, string>> | undefined): string {
  const name = names?.[label]?.trim();
  return name ? `${label} · ${name}` : label;
}

// --- Report -------------------------------------------------------------------

/** Type scale for one attempt at a fixed page; later attempts are tighter. */
interface Scale { readonly body: number; readonly table: number; readonly attempt: number; readonly last: boolean }
/** Later attempts shrink the maps first and the type a little (to 9 pt body), so a part keeps to one page. */
const SCALES: readonly Omit<Scale, 'last'>[] = Array.from({ length: 8 }, (_, attempt) => ({ body: Math.max(9, 11 - attempt * 0.4), table: Math.max(8.8, 10.6 - attempt * 0.4), attempt }));

/**
 * Draws a part that must stay on one page. When the content runs onto a
 * second page, the pages are removed and the part is drawn again with the
 * next, tighter type scale. The last scale is kept whatever it gives.
 */
async function onePage(doc: PDFDocument, draw: (s: Scale) => void | Promise<void>): Promise<void> {
  const start = doc.getPageCount();
  for (let k = 0; k < SCALES.length; k++) {
    const last = k === SCALES.length - 1;
    await draw({ ...SCALES[k]!, last });
    if (doc.getPageCount() <= start + 1 || last) return;
    while (doc.getPageCount() > start) doc.removePage(doc.getPageCount() - 1);
  }
}

export async function renderWatershedReport(
  model: WatershedReportModel,
  opts: WatershedReportOptions,
): Promise<{ bytes: Uint8Array; pages: readonly ReportPageTag[] }> {
  const lang = model.language;
  const doc = await PDFDocument.create();
  doc.setTitle(model.title, { showInWindowTitleBar: true });
  doc.setLanguage(lang === 'es' ? 'es-MX' : 'en-US');
  doc.setAuthor('OpenLiDARViewer');
  doc.setSubject(t(lang, 'cover.kicker'));
  doc.setCreator(model.provenance.software);
  doc.setProducer('OpenLiDARViewer');
  doc.setCreationDate(model.provenance.generatedAt);
  doc.setModificationDate(model.provenance.generatedAt);
  let fonts: ReportFonts;
  try {
    fonts = opts.loadFont ? await embedReportFonts(doc, opts.loadFont) : await embedReportFonts(doc);
  } catch (err) {
    if (!opts.fallbackFonts) throw err;
    fonts = await opts.fallbackFonts(doc);
  }

  const pages: ReportPageTag[] = [];
  const tag = (part: ReportPart, label: string | null) => {
    while (pages.length < doc.getPageCount()) pages.push({ part, label });
  };
  const footReport = t(lang, 'footer.report', { title: model.title });
  const start = (id: string, section: StringKey, footer: string) =>
    newPage(doc, opts.size, { id, section: t(lang, section), pageNo: doc.getPageCount() + 1, status: opts.status ?? null }, fonts, footer);
  const hooks: ReportHooks = {
    doc, fonts, size: opts.size,
    start: (id, section) => newPage(doc, opts.size, { id, section, pageNo: doc.getPageCount() + 1, status: opts.status ?? null }, fonts, footReport),
    tag: (label) => tag('drainage', label),
  };
  const layers = { sections: model.sections, network: model.network, grid: opts.raster.grid, coverage: opts.raster.coverage, filled: opts.raster.filled };
  const pageH = opts.size === 'a4' ? 841.89 : 792;

  await drawCover(doc, model, opts, fonts);
  tag('cover', null);
  await onePage(doc, async (sc) => {
    const c = start(SPINE_ID.guide, 'spine.guideMap', footReport);
    const below = await drawMapPage(c, doc, model, { ...layers, partition: model.partition, bottomY: pageH * (0.26 + sc.attempt * 0.035) }, fonts, opts.encodePng);
    drawGuide(below, lang, fonts, sc);
  });
  tag('guide', null);
  await opts.afterSiteMap?.(hooks);

  for (const s of model.sections) {
    const foot = t(lang, 'footer.catchment', { title: model.title, label: s.label });
    await onePage(doc, (sc) => drawSummary(start(s.label, 'spine.summary', foot), s, lang, fonts, sc, displayName(s.label, opts.catchmentNames), model.network.thresholdM2));
    tag('summary', s.label);
    await onePage(doc, async (sc) => {
      const c = start(s.label, 'spine.details', foot);
      const below = await drawMapPage(c, doc, model, { ...layers, focus: s, focusTitle: displayName(s.label, opts.catchmentNames), bottomY: pageH * (0.3 + sc.attempt * 0.05) }, fonts, opts.encodePng);
      drawDetails(below, s, model, lang, fonts, sc);
    });
    tag('details', s.label);
  }

  await opts.beforeQuality?.(hooks);
  await onePage(doc, (sc) => drawQuality(start(SPINE_ID.quality, 'spine.quality', footReport), model, lang, fonts, sc, opts.catchmentNames));
  tag('quality', null);
  await onePage(doc, (sc) => drawAppendix(start(SPINE_ID.appendix, 'spine.appendix', footReport), lang, fonts, sc));
  tag('appendix', null);

  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, pages };
}

// --- Cover ----------------------------------------------------------------------

async function drawCover(doc: PDFDocument, model: WatershedReportModel, opts: WatershedReportOptions, fonts: ReportFonts): Promise<void> {
  const lang = model.language;
  const [W, H] = opts.size === 'a4' ? [595.28, 841.89] : [612, 792];
  const page = doc.addPage([W, H]);
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: PALETTE.paper });
  const L = 56;
  const R = W - 56;
  const maxW = R - L;

  // Heading.
  let y = H - 64;
  drawRuns(page, t(lang, 'cover.kicker').toUpperCase(), L, y, { font: fonts.bodyBold, size: 10.5, color: PALETTE.water }, fonts);
  y -= 8;
  for (const line of wrapText(model.title, fonts.titleBold, 18, maxW, fonts)) {
    y -= 18;
    drawRuns(page, line, L, y, { font: fonts.titleBold, size: 18, color: PALETTE.ink }, fonts);
    y -= 3;
  }
  const watersheds = model.partition.watersheds.filter((w) => !w.minor).length;
  y -= 13;
  drawRuns(page, t(lang, 'cover.counts', { watersheds, catchments: model.sections.length }), L, y, { font: fonts.body, size: 11, color: PALETTE.ink2 }, fonts);
  if (opts.status) {
    for (const line of wrapText(opts.status, fonts.bodyBold, 11, maxW, fonts)) {
      y -= 16;
      drawRuns(page, line, L, y, { font: fonts.bodyBold, size: 11, color: PALETTE.earth }, fonts);
    }
  }

  // Site map with a hairline frame and the studied catchments outlined.
  const blockH = 4 * 40;
  const qualityH = 44;
  // Notes sit under the title block; clamped and wrapped so they never overflow.
  const notes = clampNotes(opts.projectNotes ?? '');
  const noteLines = notes ? wrapText(notes, fonts.body, 11, maxW, fonts) : [];
  const notesH = noteLines.length > 0 ? 22 + noteLines.length * 14.5 : 0;
  const base = 48 + notesH;
  const box = { x: L, y: base + blockH + qualityH + 18, w: maxW, h: y - 22 - (base + blockH + qualityH + 18) };
  const r = siteRaster(opts.raster.grid, opts.raster.coverage, model.partition, 1400);
  const k = Math.min(box.w / r.size[0], box.h / r.size[1]);
  const iw = r.size[0] * k;
  const ih = r.size[1] * k;
  const ix = box.x;
  const iy = box.y + box.h - ih;
  const img = await doc.embedPng(await opts.encodePng(r.rgba, r.w, r.h));
  page.drawImage(img, { x: ix, y: iy, width: iw, height: ih });
  page.drawRectangle({ x: ix, y: iy, width: iw, height: ih, borderColor: PALETTE.ink, borderWidth: 0.5 });
  const P = (mx: number, my: number): [number, number] => [ix + (mx - r.origin[0]) * k, iy + (my - r.origin[1]) * k];
  for (const s of model.sections) {
    const ring = s.divide.outer;
    if (s.divide.degenerate || ring.length < 6) continue;
    const pts: [number, number][] = [];
    let sx = 0, sy = 0;
    for (let i = 0; i + 1 < ring.length; i += 2) { pts.push(P(ring[i]!, ring[i + 1]!)); sx += pts[pts.length - 1]![0]; sy += pts[pts.length - 1]![1]; }
    strokePath(page, smoothLine(pts, true, 6), { color: PALETTE.ink, width: 1.2, close: true });
    const cx = sx / pts.length, cy = sy / pts.length;
    const lw = widthOf(s.label, fonts.bodyBold, 11.25, fonts);
    page.drawRectangle({ x: cx - lw / 2 - 3, y: cy - 3, width: lw + 6, height: 15, color: PALETTE.paper, opacity: 0.9 });
    drawRuns(page, s.label, cx - lw / 2, cy, { font: fonts.bodyBold, size: 11.25, color: PALETTE.ink }, fonts);
  }

  // Data quality, right under the map.
  y = iy - 26;
  const dq = drawRuns(page, t(lang, 'cover.dataQuality').toUpperCase(), L, y, { font: fonts.bodyBold, size: 10.5, color: PALETTE.mute }, fonts);
  let x = dq + 12;
  for (const s of model.sections) {
    x = drawRuns(page, displayName(s.label, opts.catchmentNames), x, y, { font: fonts.bodyBold, size: 11.25, color: PALETTE.ink }, fonts) + 5;
    x += chip(page, x, y, s.quality.verdict, t(lang, verdictKey(s.quality.verdict)), fonts) + 14;
  }
  drawRuns(page, t(lang, 'cover.measuredShare', { share: formatPercent(lang, model.site.measuredShare) }), L, y - 18, { font: fonts.body, size: 10.6, color: PALETTE.ink2 }, fonts);

  // Title block: hairlines only, a label over each value.
  const site = model.site;
  const cells: [string, string][] = [
    [t(lang, 'cover.project'), model.title],
    [t(lang, 'cover.file'), opts.sourceName ?? t(lang, 'method.notGiven')],
    [t(lang, 'cover.groundData'), t(lang, 'cover.sourceNoFile', { points: formatNumber(lang, site.pointCount, 0), area: formatArea(lang, site.analysedAreaM2), cell: cellText(lang, site.cellSizeM) })],
    [t(lang, 'method.crs'), site.crsName ?? t(lang, 'quality.crsUnknown')],
    [t(lang, 'cover.heights'), t(lang, site.elevationsRelative ? 'cover.heightsRelative' : 'cover.heightsRecorded')],
    [t(lang, 'cover.issued'), t(lang, 'cover.date', { date: formatDate(lang, model.provenance.generatedAt), software: model.provenance.software })],
    [t(lang, 'cover.preparedBy'), opts.preparedBy?.trim() ?? ''],
    [t(lang, 'cover.checkedBy'), opts.checkedBy?.trim() ?? ''],
  ];
  const colW = maxW / 2;
  const top = base + blockH;
  page.drawLine({ start: { x: L, y: top }, end: { x: R, y: top }, thickness: 0.8, color: PALETTE.ink });
  cells.forEach(([label, value], i) => {
    const row = Math.floor(i / 2);
    const cx = L + (i % 2) * colW;
    const cyTop = top - row * 40;
    drawRuns(page, label.toUpperCase(), cx, cyTop - 12, { font: fonts.bodyBold, size: 9.1, color: PALETTE.mute }, fonts);
    const vs = fitSize(value, fonts.body, 11.25, colW - 12, fonts);
    if (value) drawRuns(page, value, cx, cyTop - 29, { font: fonts.body, size: vs, color: PALETTE.ink }, fonts);
    if (i % 2 === 1) page.drawLine({ start: { x: L, y: cyTop - 40 }, end: { x: R, y: cyTop - 40 }, thickness: 0.4, color: PALETTE.rule });
  });
  page.drawLine({ start: { x: L + colW - 6, y: top }, end: { x: L + colW - 6, y: top - blockH }, thickness: 0.4, color: PALETTE.rule });
  if (noteLines.length > 0) {
    let ny = base - 12;
    drawRuns(page, t(lang, 'cover.notes').toUpperCase(), L, ny, { font: fonts.bodyBold, size: 9.1, color: PALETTE.mute }, fonts);
    ny -= 4;
    for (const line of noteLines) {
      ny -= 14.5;
      drawRuns(page, line, L, ny, { font: fonts.body, size: 11, color: PALETTE.ink }, fonts);
    }
  }
}

// --- Reading guide (under the site map) ------------------------------------------------

function drawGuide(c: PageCursor, lang: ReportLanguage, fonts: ReportFonts, sc: Scale): void {
  const mid = Math.round((c.left + c.right) / 2);
  const size = sc.body;
  let left: PageCursor = { ...c, right: mid - 10, y: c.y - 4 };
  left = sectionTitle(left, t(lang, 'guide.fiveThings'), fonts);
  left = numbered(left, (['guide.item1', 'guide.item2', 'guide.item3'] as const).map((k) => t(lang, k)), fonts, size);

  let right: PageCursor = { ...c, left: mid + 10, y: c.y - 4 };
  right = sectionTitle(right, t(lang, 'glossary.title'), fonts);
  right = definitions(right, (['catchment', 'watershed', 'divide', 'open'] as const).map((k) => [
    t(lang, `glossary.${k}.term` as StringKey), t(lang, `glossary.${k}.def` as StringKey),
  ] as const), fonts, size);
  caption(right, t(lang, 'guide.footnote'), fonts);
}

// --- Catchment page A: summary and profile ------------------------------------------------

function drawSummary(c: PageCursor, s: CatchmentSection, lang: ReportLanguage, fonts: ReportFonts, sc: Scale, name: string, thresholdM2: number): void {
  const v = s.quality.verdict;
  let cur = pageHeading(c, t(lang, 'summary.kicker', { label: name }), headline(s, lang), null, fonts);
  const x = drawRuns(cur.page, t(lang, 'verdict.title').toUpperCase(), cur.left, cur.y - 9, { font: fonts.bodyBold, size: 10.5, color: PALETTE.mute }, fonts);
  const cw = chip(cur.page, x + 8, cur.y - 9, v, t(lang, verdictKey(v)), fonts);
  // The verdict's sentence sits beside the chip, or on its own line when it is too long for that.
  const lede = t(lang, `verdict.${v}.lede` as StringKey);
  const ledeX = x + 16 + cw;
  if (ledeX + widthOf(lede, fonts.body, 11, fonts) <= cur.right) {
    drawRuns(cur.page, lede, ledeX, cur.y - 9, { font: fonts.body, size: 11, color: PALETTE.ink2 }, fonts);
    cur = { ...cur, y: cur.y - 22 };
  } else {
    cur = caption({ ...cur, y: cur.y - 14 }, lede, fonts);
  }
  // An open catchment says so once, here, with the share of its divide on the data edge.
  const open = isOpen(s);
  if (open) cur = caption({ ...cur, y: cur.y + 6 }, t(lang, 'summary.edgeShare', { share: formatPercent(lang, s.edgeInflowShare, 0) }), fonts);
  cur.page.drawLine({ start: { x: cur.left, y: cur.y + 4 }, end: { x: cur.right, y: cur.y + 4 }, thickness: 0.5, color: PALETTE.rule });
  cur = { ...cur, y: cur.y - 8 };

  const m = s.morph;
  // A value that cannot be derived shows a dash; the footnote under the row explains it.
  const dash = { value: '—', detail: '' };
  const notGiven = t(lang, 'kpi.withheld');
  const approx = v === 'not-supported';
  const area = m.areaM2;
  const areaKpi = 'value' in area
    ? { value: fig(lang, area, (x) => formatArea(lang, x), approx), detail: area.bound === 'minimum' ? t(lang, 'summary.kpi.areaOpen') : t(lang, 'summary.kpi.areaBand', { band: formatArea(lang, m.areaBandM2) }) }
    : open ? dash : { value: notGiven, detail: withheldText(lang, area.withheld) };
  const L = s.channel.lengthM;
  const S = s.channel.slope1085;
  const slopeDetail = 'value' in S ? t(lang, 'summary.kpi.channelSlope', { slope: formatPercent(lang, S.value) }) : open ? '' : withheldText(lang, S.withheld);
  const channelKpi = 'value' in L
    ? { value: fig(lang, L, (x) => formatLength(lang, x), approx), detail: slopeDetail }
    : open ? dash : { value: notGiven, detail: withheldText(lang, L.withheld) };
  const R = m.reliefM;
  const reliefKpi = 'value' in R
    ? { value: fig(lang, R, (x) => formatHeight(lang, x), approx), detail: t(lang, 'formula.relief') }
    : open ? dash : { value: notGiven, detail: withheldText(lang, R.withheld) };
  const orderKpi = open
    ? dash
    : { value: `${approx ? APPROX : ''}${s.network.maxOrder}`, detail: t(lang, 'summary.kpi.orderDetail', { length: formatLength(lang, s.network.lengthM) }) };
  cur = kpiRow(cur, [
    { ...areaKpi, label: t(lang, 'summary.kpi.area') },
    { ...channelKpi, label: t(lang, 'summary.kpi.channel') },
    { ...reliefKpi, label: t(lang, 'summary.kpi.relief') },
    { ...orderKpi, label: t(lang, 'summary.kpi.order') },
  ], fonts, { muted: v !== 'supported' });
  if (open) cur = caption({ ...cur, y: cur.y + 2 }, t(lang, 'summary.kpi.openNote'), fonts);
  if (approx) cur = caption({ ...cur, y: cur.y + 2 }, t(lang, 'figures.notSupportedNote'), fonts);

  cur = sectionTitle({ ...cur, y: cur.y - 2 }, t(lang, 'summary.flowTitle'), fonts);
  for (const p of catchmentNarrative(s, lang, thresholdM2)) cur = stepParagraph(cur, t(lang, p.lead), p.text, fonts, sc.body);

  const d = s.checkOnSite;
  if (d) {
    const body = t(lang, 'checkOnSite.body', {
      area: d.areaM2 !== null ? formatArea(lang, d.areaM2) : withheldText(lang, 'not-applicable'),
      depth: depthText(lang, d.maxFillDepth),
    });
    // The box's name sits above it as a label, so the text reads as plain sentences.
    drawRuns(cur.page, t(lang, 'checkOnSite.title').toUpperCase(), cur.left, cur.y - 11, { font: fonts.bodyBold, size: 9.8, color: PALETTE.ink }, fonts);
    cur = callout({ ...cur, y: cur.y - 16 }, body, 'warn', fonts);
  }

  // The main-channel profile fills what is left of the page, within limits.
  const room = cur.y - cur.bottom - 4;
  const MIN_CHART = 150;
  if (room < MIN_CHART && !sc.last) {
    newPage(cur.ctx.doc, cur.ctx.size, cur.ctx.spine, fonts, cur.ctx.footer);
    return;
  }
  // The chart takes the rest of the page, so the page ends filled.
  const h = Math.min(room, 380);
  if (h > 60) drawChannelProfile(cur.page, { x: cur.left, y: cur.y - 4 - h, width: cur.right - cur.left, height: h }, s.channel, lang, fonts);
}

// --- Catchment page B: map, figures, network and timing -----------------------------------

function drawDetails(c: PageCursor, s: CatchmentSection, model: WatershedReportModel, lang: ReportLanguage, fonts: ReportFonts, sc: Scale): void {
  // The figures column is the wider one; the order and hollow tables fit the narrower.
  const mid = Math.round(c.left + (c.right - c.left) * 0.54);
  const m = s.morph;
  const ch = s.channel;
  const open = isOpen(s);
  const notSupported = s.quality.verdict === 'not-supported';
  const n2 = (x: number) => formatNumber(lang, x, 2);
  const n1 = (x: number) => formatNumber(lang, x, 1);
  const n0 = (x: number) => formatNumber(lang, x, 0);
  const pct = (x: number) => formatNumber(lang, x * 100, 1);
  const hypso: Figure<number> = 'value' in m.hypsometry ? { value: m.hypsometry.value.integral } : m.hypsometry;
  const openFig: Figure<number> = { withheld: 'open-catchment' };
  const a = m.areaM2;
  const inHa = 'value' in a && a.value >= 10_000;
  // Parameter, figure, number format, unit.
  const rows: [StringKey, Figure<number>, (x: number) => string, string][] = [
    ['figures.area', a, inHa ? (x) => formatNumber(lang, x / 10_000, 2) : n0, inHa ? 'ha' : 'm²'],
    ['figures.perimeter', m.perimeterM, n0, 'm'],
    ['figures.gravelius', m.gravelius, n2, ''],
    ['figures.elongation', m.elongation, n2, ''],
    ['figures.circularity', m.circularity, n2, ''],
    ['figures.formFactor', m.formFactor, n2, ''],
    ['figures.basinLength', m.basinLengthM, n0, 'm'],
    ['figures.relief', m.reliefM, n1, 'm'],
    [m.elevationsRelative ? 'figures.meanHeightAboveOutlet' : 'figures.meanElevation', m.meanElevationM, n1, 'm'],
    ['figures.meanSlope', m.meanSlopePct, n1, '%'],
    ['figures.hypsometricIntegral', hypso, n2, ''],
    ['figures.channelLength', ch.lengthM, n0, 'm'],
    ['figures.slope1085', ch.slope1085, pct, '%'],
    ['figures.taylorSchwarz', ch.slopeTaylorSchwarz, pct, '%'],
    ['figures.maxOrder', open ? openFig : { value: s.network.maxOrder }, n0, ''],
    ['figures.networkLength', open ? openFig : { value: s.network.lengthM }, n0, 'm'],
  ];

  // Left column: the basin figures. Withheld ones are listed once under their reason.
  let left: PageCursor = { ...c, right: mid - 9, y: c.y - 2 };
  left = sectionTitle(left, t(lang, 'figures.title'), fonts);
  const shown = rows.filter(([, f]) => 'value' in f);
  left = table(left, cols(left, [[t(lang, 'table.parameter'), 'left', 0.6], [t(lang, 'table.value'), 'right', 0.17], ['', 'left', 0.03], [t(lang, 'table.unit'), 'left', 0.2]]),
    shown.map(([k, f, fmt, unit]) => [t(lang, k), fig(lang, f, fmt, notSupported), '', unit]), fonts, { size: sc.table });
  if (notSupported) left = caption(left, t(lang, 'figures.notSupportedNote'), fonts);
  const byReason = new Map<string, string[]>();
  for (const [k, f] of rows) {
    if (!('withheld' in f)) continue;
    const list = byReason.get(f.withheld) ?? [];
    list.push(t(lang, k));
    byReason.set(f.withheld, list);
  }
  if (open) {
    // One line for an open catchment instead of a list of withheld figures.
    byReason.delete('open-catchment');
    left = caption(left, t(lang, 'figures.openNote'), fonts);
  }
  for (const [reason, items] of byReason) {
    left = caption(left, t(lang, 'figures.withheldList', { items: items.join(', '), reason: withheldText(lang, reason as WithheldReason) }), fonts);
  }

  // Right column: flow lines by order, hollows, time of concentration and peak flow.
  let right: PageCursor = { ...c, left: mid + 9, y: c.y - 2 };
  const orders = [...s.network.byOrder.entries()].sort((a, b) => a[0] - b[0]);
  // An open catchment's network is not derived (see the note in the left column).
  if (!open) right = sectionTitle(right, t(lang, 'network.ordersTitle'), fonts);
  if (open) {
    // Nothing to list.
  } else if (orders.length === 0) {
    right = caption(right, t(lang, 'network.noLines', { threshold: formatArea(lang, model.network.thresholdM2) }), fonts);
  } else {
    right = table(right, cols(right, [[t(lang, 'table.order'), 'left', 0.3], [t(lang, 'table.segments'), 'right', 0.3], [`${t(lang, 'table.length')} (m)`, 'right', 0.4]]),
      orders.map(([o, v]) => [String(o), String(v.segments), formatNumber(lang, v.lengthM, 0)]), fonts, { size: sc.table });
  }

  right = sectionTitle(right, t(lang, 'network.hollowsTitle'), fonts);
  // Hollows at least 0.1 m deep (or of unknown depth) are listed; the shallower rest are counted. With none listed, the largest is.
  const hollows = [...s.depressions].sort((a, b) => b.cells - a.cells || a.rank - b.rank);
  if (hollows.length === 0) {
    right = caption(right, t(lang, 'network.noHollows'), fonts);
  } else {
    let listed = hollows.filter((d) => d.maxFillDepth === null || d.maxFillDepth >= 0.1);
    if (listed.length === 0) listed = [hollows[0]!];
    const rest = hollows.length - listed.length;
    const rows = listed.map((d) => [
      String(d.rank),
      d.areaM2 !== null ? formatNumber(lang, d.areaM2, 0) : withheldText(lang, 'not-applicable'),
      d.maxFillDepth === null ? withheldText(lang, 'vertical-unresolved') : d.maxFillDepth < 0.1 ? `< ${formatNumber(lang, 0.1, 1)}` : formatNumber(lang, d.maxFillDepth, 1),
      t(lang, d.onFlowLine ? 'table.yes' : 'table.no'),
    ]);
    // The depth column is the widest, so the count row sits there.
    if (rest > 0) rows.push(['', '', t(lang, 'network.plusShallower', { count: rest, depth: formatHeight(lang, 0.1) }), '']);
    right = table(right, cols(right, [[t(lang, 'table.rank'), 'left', 0.17], [`${t(lang, 'table.area')} (m²)`, 'right', 0.22], [`${t(lang, 'table.depth')} (m)`, 'right', 0.33], [t(lang, 'table.onChannel'), 'right', 0.28]]),
      rows, fonts, { size: sc.table });
  }
}

// --- Quality, method and limits -----------------------------------------------------------

function drawQuality(c: PageCursor, model: WatershedReportModel, lang: ReportLanguage, fonts: ReportFonts, sc: Scale, names?: Readonly<Record<string, string>>): void {
  let cur = pageHeading(c, t(lang, 'quality.kicker'), t(lang, 'quality.title'), null, fonts);
  const p = model.provenance;
  const ts = { size: sc.table };

  cur = sectionTitle(cur, t(lang, 'quality.verdictsTitle'), fonts);
  cur = paragraph(cur, t(lang, 'quality.rule', {
    measured: formatPercent(lang, SUPPORTED_MEASURED_SHARE, 0),
    channel: formatPercent(lang, SUPPORTED_CHANNEL_INTERPOLATED_SHARE, 0),
    cells: MAX_FAR_INTERPOLATED_RUN,
  }), fonts, { size: sc.body });
  cur = table(cur, cols(cur, [
    [t(lang, 'table.catchment'), 'left', 0.16], [t(lang, 'table.verdict'), 'left', 0.17],
    [`${t(lang, 'quality.measuredShare')} (%)`, 'right', 0.19], [`${t(lang, 'quality.channelInterpolated')} (%)`, 'right', 0.27],
    [t(lang, 'quality.pointDensity'), 'right', 0.21],
  ]), model.sections.map((s) => [
    displayName(s.label, names), t(lang, verdictKey(s.quality.verdict)), formatNumber(lang, s.quality.measuredShare * 100, 1),
    formatNumber(lang, s.quality.channelInterpolatedShare * 100, 1),
    densityText(lang, s.quality.groundPointsPerM2),
  ]), fonts, ts);
  for (const s of model.sections) {
    const parts = [...qualityReasons(s.quality, lang)];
    if (isOpen(s)) parts.push(t(lang, 'summary.edgeShare', { share: formatPercent(lang, s.edgeInflowShare, 0) }));
    cur = paragraph(cur, parts.join(' '), fonts, { lead: `${s.label}.`, size: sc.body });
  }

  cur = sectionTitle(cur, t(lang, 'limits.title'), fonts);
  const limits = [
    t(lang, 'limits.terrainOnly'), t(lang, 'limits.d8', { bias: formatPercent(lang, D8_BIAS, 1) }), t(lang, 'limits.filled'),
    t(lang, 'limits.interpolated'), t(lang, 'limits.open'), t(lang, 'limits.notComputed'), t(lang, 'limits.screening'),
  ];
  // Two columns of numbered limits, numbered down the left column first.
  const mid = Math.round((cur.left + cur.right) / 2);
  const half = Math.ceil(limits.length / 2);
  const colL = numberedFrom(1, { ...cur, right: mid - 10 }, limits.slice(0, half), fonts, sc.body);
  const colR = numberedFrom(half + 1, { ...cur, left: mid + 10 }, limits.slice(half), fonts, sc.body);
  cur = { ...cur, y: Math.min(colL.y, colR.y) };

  cur = sectionTitle(cur, t(lang, 'method.title'), fonts);
  table(cur, cols(cur, [[t(lang, 'table.parameter'), 'left', 0.28], [t(lang, 'table.value'), 'left', 0.72]]), [
    [t(lang, 'method.methods'), t(lang, 'method.methodsList')],
    [t(lang, 'method.threshold'), formatArea(lang, model.network.thresholdM2)],
    // The methods line already names Priority-Flood filling, so depression handling has no row of its own.
    [t(lang, 'method.vertical'), t(lang, model.site.verticalResolved ? 'method.verticalMetres' : 'method.verticalUnresolved')],
    [t(lang, 'method.runDigest'), halves(p.runDigest)],
    [t(lang, 'method.fieldDigest'), halves(p.fieldDigest)],
    ...(p.sourceSha256 ? [[t(lang, 'method.sourceSha256'), halves(p.sourceSha256)]] : []),
  ], fonts, { size: sc.table });
}

/** A long digest split in the middle, so it wraps into two even lines. */
function halves(d: string): string {
  return d.length > 32 ? `${d.slice(0, Math.ceil(d.length / 2))} ${d.slice(Math.ceil(d.length / 2))}` : d;
}

// --- Appendix A ----------------------------------------------------------------------------

const APPENDIX_ROWS = [
  'area', 'perimeter', 'gravelius', 'elongation', 'circularity', 'formFactor', 'basinLength', 'meanElevation',
  'hypsometry', 'meanSlope', 'channelLength', 'slope1085', 'taylorSchwarz', 'strahler', 'fill', 'edge',
] as const;

function drawAppendix(c: PageCursor, lang: ReportLanguage, fonts: ReportFonts, sc: Scale): void {
  const cur = pageHeading(c, t(lang, 'appendix.kicker'), t(lang, 'appendix.title'), null, fonts);
  table(cur, cols(cur, [[t(lang, 'table.term'), 'left', 0.19], [t(lang, 'table.definition'), 'left', 0.46], [t(lang, 'table.source'), 'left', 0.35]]),
    APPENDIX_ROWS.map((id) => [
      t(lang, `appendix.${id}.term` as StringKey), t(lang, `appendix.${id}.def` as StringKey), t(lang, `appendix.${id}.source` as StringKey),
    ]), fonts, { size: sc.table });
}
