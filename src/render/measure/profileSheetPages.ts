/**
 * profileSheetPages.ts: the sheets behind sheet one of a Light or Dark profile
 * set: the technical notes, the station schedule, and the method and sources.
 *
 * Each opens with its name, the section itself as a running mark, and closes
 * with a footer that carries the profile, the scan, the CRS, the status and
 * the suitability note, so a sheet that leaves the set keeps its caveats. The
 * general notes are printed once in full, on the method sheet. Content is
 * worked out by profilePdf.ts; this module only draws.
 */
import type { PDFDocument, PDFFont, PDFPage } from 'pdf-lib';
import type { SheetFonts } from '../../export/sheetKit/fonts';
import { drawPaper, pdfColor, sheetText, sheetTextRight, sheetTextWidth, wrapSheetText } from '../../export/sheetKit/primitives';
import type { SheetRgb } from '../../export/sheetKit/tokens';
import { PROFILE_TYPE as T, STEEP_PERCENT, type ProfilePalette } from './profileSheetPalette';
import { drawDisplay, fitLine, type ProfileStationSample } from './profileSheetStyled';

const M = 60;

/** What every sheet of the set says about itself. */
export interface ProfileSetContext {
  readonly doc: PDFDocument;
  readonly size: readonly [number, number];
  readonly tokens: ProfilePalette;
  readonly fonts: SheetFonts;
  readonly profileName: string;
  readonly project: string;
  readonly crs: string | null;
  readonly suitability: string;
  readonly generated: string;
  readonly stations: ReadonlyArray<{ readonly chainage: number; readonly elevation: number | null; readonly gradeToNext: number | null }>;
  readonly lengthM: number;
  /** Every page drawn, in order, for the footers. */
  readonly pages: PDFPage[];
}

interface Ink { readonly page: PDFPage; readonly c: ProfileSetContext }

function put(i: Ink, s: string, x: number, y: number, size: number, o: { color?: SheetRgb; font?: PDFFont; right?: boolean } = {}): void {
  const a = { font: o.font ?? i.c.fonts.sans, size, color: o.color ?? i.c.tokens.ink };
  if (o.right) sheetTextRight(i.page, s, x, y, a, i.c.fonts);
  else sheetText(i.page, s, x, y, a, i.c.fonts);
}
function rule(i: Ink, x0: number, x1: number, y: number, color: SheetRgb, thickness = 0.6): void {
  i.page.drawLine({ start: { x: x0, y }, end: { x: x1, y }, thickness, color: pdfColor(color) });
}

/** Open a sheet: paper, name, the section as a mark. Returns the y under the head rule. */
function open(c: ProfileSetContext, title: string, sub: string): { i: Ink; y: number; x1: number } {
  const page = c.doc.addPage([c.size[0], c.size[1]]);
  c.pages.push(page);
  drawPaper(page, c.tokens);
  const i: Ink = { page, c }, [PW, PH] = c.size, x1 = PW - M;
  drawDisplay(page, title, M - 1, PH - 82, T.sheet, c.fonts, c.tokens.ink);
  put(i, sub, M, PH - 104, T.body, { color: c.tokens.dim });
  drawMark(i, 700, x1, PH - 104, 44);
  rule(i, M, x1, PH - 118, c.tokens.ink, 1.1);
  return { i, y: PH - 118, x1 };
}

/** The sampled section as a small filled outline. Its height is not to scale and it carries no figures. */
function drawMark(i: Ink, x0: number, x1: number, y0: number, h: number): void {
  const { stations, lengthM, tokens } = i.c;
  const known = stations.filter((s) => s.elevation != null && Number.isFinite(s.elevation) && Number.isFinite(s.chainage)) as Array<{ chainage: number; elevation: number }>;
  if (!(Number.isFinite(lengthM) && lengthM > 0) || known.length < 2) return;
  const lo = Math.min(...known.map((s) => s.elevation)), hi = Math.max(...known.map((s) => s.elevation));
  const X = (q: number): number => x0 + (q / lengthM) * (x1 - x0);
  const Y = (q: number): number => y0 + 8 + (hi > lo ? ((q - lo) / (hi - lo)) * (h - 12) : 0);
  let run: Array<[number, number]> = [];
  const PH = i.c.size[1];
  const flush = (): void => {
    if (run.length > 1) {
      const d = run.map(([x, y]) => `L${x.toFixed(1)} ${(PH - y).toFixed(1)}`).join(' ');
      i.page.drawSvgPath(`M${run[0]![0].toFixed(1)} ${(PH - y0).toFixed(1)} ${d} L${run[run.length - 1]![0].toFixed(1)} ${(PH - y0).toFixed(1)} Z`, { x: 0, y: PH, color: pdfColor(tokens.earth) });
      i.page.drawSvgPath(`M${d.slice(1)}`, { x: 0, y: PH, borderColor: pdfColor(tokens.surface), borderWidth: 1.5 });
    }
    run = [];
  };
  for (const s of stations) {
    if (s.elevation == null || !Number.isFinite(s.elevation) || !Number.isFinite(s.chainage)) flush();
    else run.push([X(s.chainage), Y(s.elevation)]);
  }
  flush();
  put(i, 'A', x0, y0 + h + 4, T.figure, { font: i.c.fonts.sansBold });
  put(i, 'B', x1, y0 + h + 4, T.figure, { font: i.c.fonts.sansBold, right: true });
}

/** Stamp the footers once the page count is known. `first` is the number of the first page in `pages`. */
export function drawSetFooters(c: ProfileSetContext, first: number, total: number): void {
  const [PW] = c.size, f = c.fonts, t = c.tokens;
  c.pages.forEach((page, n) => {
    const i: Ink = { page, c };
    const y = 18, right = `SHEET ${first + n} / ${total}`, m = first + n === 1 ? 48 : M;
    if (first + n > 1) rule(i, m, PW - m, y + 16, t.ink, 1);
    put(i, right, PW - m, y, T.small, { color: t.dim, right: true });
    const name = fitLine(c.profileName, f.sansBold, T.small, 220, f);
    put(i, name, m, y, T.small, { font: f.sansBold });
    const x = m + sheetTextWidth(name, f.sansBold, T.small, f) + 14;
    const parts = first + n === 1
      ? [`OpenLiDARViewer - terrain profile`, `Generated ${c.generated}`]
      : ['PRELIMINARY', c.suitability, c.crs ?? 'not georeferenced', c.project];
    put(i, fitLine(parts.join('  ·  '), f.sans, T.small, PW - m - 80 - x, f), x, y, T.small, { color: t.dim });
  });
}

/** The lowest y content may reach, over the footer. */
const FLOOR = 50;

export interface NotesRow {
  readonly group: string;
  readonly item: string;
  readonly value: string;
  readonly remark: string;
  readonly limit?: boolean;
}

/** What was recorded, its value, and how to read it, in groups. Set as large as one sheet allows. */
export function drawNotesSheet(c: ProfileSetContext, all: readonly NotesRow[]): void {
  // Each group once, in the order the rows first name it.
  const order = [...new Set(all.map((r) => r.group))];
  const rows = [...all].sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
  const f = c.fonts, t = c.tokens;
  const xi = 160, xv = 346, xr = 668;
  const layout = (k: number) => rows.map((r) => {
    const v = wrapSheetText(r.value, f.sansBold, T.figure * k, xr - xv - 24, f);
    const m = wrapSheetText(r.remark, f.sans, T.label * k, c.size[0] - M - xr, f);
    const it = wrapSheetText(r.item, f.sans, T.figure * k, xv - xi - 16, f);
    return { r, v, m, it, h: Math.max(v.length * 15 * k, m.length * 13.5 * k, it.length * 15 * k) + 9 * k };
  });
  const groupGap = 12;
  const groups = order.length;
  const room = c.size[1] - 118 - 10 - FLOOR;
  let k = 1.12;
  while (k > 0.92 && layout(k).reduce((a, q) => a + q.h, 0) + groups * groupGap > room) k -= 0.02;
  // The smallest step keeps every size at the set's floor or above.
  let o = open(c, 'Technical notes', 'What was recorded, and how to read it.');
  let y = o.y - 10, group = '';
  for (const q of layout(k)) {
    if (y - q.h < FLOOR) {
      o = open(c, 'Technical notes (continued)', 'What was recorded, and how to read it.');
      y = o.y - 10;
      group = '';
    }
    if (q.r.group !== group) {
      if (group !== '') y -= groupGap;
      put(o.i, q.r.group, M, y - 16 * k, T.head, { font: f.sansBold });
      group = q.r.group;
    }
    q.it.forEach((ln, n) => put(o.i, ln, xi, y - 16 * k - n * 15 * k, T.figure * k, { color: t.dim }));
    q.v.forEach((ln, n) => put(o.i, ln, xv, y - 16 * k - n * 15 * k, T.figure * k, { font: f.sansBold, color: q.r.limit ? t.warn : t.ink }));
    q.m.forEach((ln, n) => put(o.i, ln, xr, y - 16 * k - n * 13.5 * k, T.label * k, { color: t.dim }));
    y -= q.h;
    rule(o.i, xi, o.x1, y, t.rule);
  }
}

/** Chainage, height and grade at every sampled station, with the grade drawn beside its figure. */
export function drawScheduleSheets(c: ProfileSetContext, p: {
  readonly formatStation: (m: number) => string;
  readonly k: number;
  readonly unit: string;
  readonly heightHead: string;
}): void {
  const f = c.fonts, t = c.tokens, COLS = 3, GAP = 44;
  const st = c.stations;
  const roomy = st.length <= 66;
  const rowH = roomy ? 27 : 18.6, size = roomy ? T.body : T.label;
  const bodyTop = c.size[1] - 118 - 40, perCol = Math.floor((bodyTop - FLOOR - 22) / rowH);
  const cw = (c.size[0] - 2 * M - (COLS - 1) * GAP) / COLS;
  const staW = Math.max(78, ...[0, c.lengthM].map((v) => sheetTextWidth(p.formatStation(v), f.sans, size, f))) + 10;
  const hx = Math.min(staW + 74, cw - 150), gx = hx + 74;
  const steepest = Math.max(1, ...st.map((s) => Math.abs((s.gradeToNext ?? 0) * 100)).filter(Number.isFinite));
  // The bars share one scale on every sheet; one steep pair does not flatten the rest.
  const cap = Math.min(steepest, 60), half = (cw - gx - 16) / 2;
  let idx = 0, page = 0;
  do {
    const o = open(c, page === 0 ? 'Station schedule' : 'Station schedule (continued)', 'Chainage, height and the grade to the next station.');
    page++;
    for (let col = 0; col < COLS && idx < st.length; col++) {
      const x = M + col * (cw + GAP);
      put(o.i, 'Station', x, bodyTop + 14, T.label, { font: f.sansBold });
      put(o.i, `${p.heightHead}, ${p.unit}`, x + hx, bodyTop + 14, T.label, { font: f.sansBold, right: true });
      put(o.i, 'Grade, %', x + gx, bodyTop + 14, T.label, { font: f.sansBold, right: true });
      rule(o.i, x, x + cw, bodyTop + 6, t.ink, 0.9);
      const ax = x + gx + 12 + half, n = Math.min(perCol, st.length - idx);
      o.i.page.drawLine({ start: { x: ax, y: bodyTop + 2 }, end: { x: ax, y: bodyTop - n * rowH + 4 }, thickness: 0.6, color: pdfColor(t.rule) });
      for (let r = 0; r < n; r++, idx++) {
        const s = st[idx]!, y = bodyTop - (r + 0.72) * rowH;
        const g = s.gradeToNext == null ? null : s.gradeToNext * 100, steep = g != null && Math.abs(g) >= STEEP_PERCENT;
        put(o.i, p.formatStation(s.chainage), x, y, size, { color: t.dim });
        if (s.elevation == null) put(o.i, 'gap', x + hx, y, size, { color: t.warn, right: true });
        else put(o.i, (s.elevation * p.k).toFixed(2), x + hx, y, size, { font: f.sansBold, right: true });
        put(o.i, g == null ? '-' : g.toFixed(2), x + gx, y, size, { right: true, ...(steep ? { font: f.sansBold } : {}) });
        if (g != null && Number.isFinite(g) && g !== 0) {
          const w = Math.max(0.6, (Math.min(Math.abs(g), cap) / cap) * half);
          o.i.page.drawRectangle({ x: g < 0 ? ax - w : ax, y: y - 1, width: w, height: Math.min(11, rowH * 0.5), color: pdfColor(steep ? t.hot : t.solid) });
        }
        if (r < n - 1 && roomy) rule(o.i, x, x + cw, bodyTop - (r + 1) * rowH + 1, t.rule, 0.5);
      }
    }
    put(o.i, `Gap: no return at the station. Dash: grade not available. Grade is the slope from a station to the next. Bars end at ${cap.toFixed(0)} %; yellow is ${STEEP_PERCENT} % or steeper.`, M, FLOOR + 2, T.small, { color: t.dim });
  } while (idx < st.length);
}

export interface SourceRow {
  readonly name: string;
  readonly id: string;
  readonly classification: string;
  readonly read: string;
  readonly accepted: string;
  readonly contributed: string;
  readonly residency: string;
}

/** A layer id cut in the middle to `w`, so its start and end both show. */
export function shortId(id: string, font: PDFFont, size: number, w: number, f: SheetFonts): string {
  if (sheetTextWidth(id, font, size, f) <= w) return id;
  for (let keep = id.length - 1; keep > 5; keep--) {
    const a = Math.ceil(keep * 0.65);
    const s = `${id.slice(0, a)}...${id.slice(id.length - (keep - a))}`;
    if (sheetTextWidth(s, font, size, f) <= w) return s;
  }
  return id.slice(0, 5);
}

/** How the section was derived, what the heights are measured from, what was read, and the issues table. */
export function drawMethodSheets(c: ProfileSetContext, p: {
  readonly sections: ReadonlyArray<{ readonly head: string; readonly lines: readonly string[] }>;
  readonly notes: readonly string[];
  /** Null when no record of the sources was attached. */
  readonly sources: readonly SourceRow[] | null;
  readonly noSources: string;
  readonly totalAccepted: string | null;
  readonly station: ProfileStationSample | null;
  readonly formatStation: (m: number) => string;
  readonly k: number;
  readonly unit: string;
}): void {
  const f = c.fonts, t = c.tokens, SUB = 'How the section was derived, what the heights are measured from, and what was read.';
  let o = open(c, 'Method and sources', SUB);
  let y = o.y - 28;
  const more = (h: number): void => {
    if (y - h >= FLOOR) return;
    o = open(c, 'Method and sources (continued)', SUB);
    y = o.y - 28;
  };
  // ── prose, in three columns, with the general notes first ────
  const GAP = 34, cw = (c.size[0] - 2 * M - 2 * GAP) / 3, step = 14.6;
  const blocks = [{ head: 'General notes', lines: p.notes.map((n, i) => `${i + 1}. ${n}`) }, ...p.sections].map((b) => ({
    head: b.head, paras: b.lines.map((ln) => wrapSheetText(ln, f.sans, T.figure, cw, f)),
  }));
  const hOf = (b: { paras: string[][] }): number => 22 + b.paras.reduce((a, q) => a + q.length * step + 4, 0) + 10;
  let col = [0, 0, 0], top = y;
  // Each block goes to the shortest column.
  for (const b of blocks) {
    let n = col.indexOf(Math.min(...col));
    if (col[n]! > 0 && top - col[n]! - hOf(b) < FLOOR) { more(Infinity); top = y; col = [0, 0, 0]; n = 0; }
    const x = M + n * (cw + GAP), y0 = top - col[n]!;
    put(o.i, b.head, x, y0, T.head, { font: f.sansBold });
    let ly = y0 - 22;
    for (const para of b.paras) { for (const ln of para) { put(o.i, ln, x, ly, T.figure); ly -= step; } ly -= 4; }
    col[n]! += hOf(b);
  }
  y = top - Math.max(...col) - 8;

  if (p.station) { more(160); y = drawStation(o.i, p.station, p, y, o.x1); }

  // ── sources ──────────────────────────────────────────────────────────────
  more(70);
  put(o.i, 'Sources read', M, y, T.head, { font: f.sansBold });
  y -= 24;
  if (p.sources == null) {
    for (const ln of wrapSheetText(p.noSources, f.sans, T.figure, o.x1 - M, f)) { put(o.i, ln, M, y, T.figure); y -= step; }
    y -= 10;
  } else {
    const xs = [M, 320, 560, 690, 780, 880, 1000], ends = [...xs.slice(1), o.x1 + 12];
    const head = (): void => {
      ['Scan', 'Layer ID', 'Classification', 'Read', 'Accepted', 'Contributed', 'Residency'].forEach((h, n) => put(o.i, h, xs[n]!, y, T.label, { color: t.dim }));
      rule(o.i, M, o.x1, y - 7, t.ink, 0.9);
      y -= 24;
    };
    head();
    for (const s of p.sources) {
      if (y - 20 < FLOOR) { more(Infinity); head(); }
      const cells = [s.name, s.id, s.classification, s.read, s.accepted, s.contributed, s.residency];
      cells.forEach((v, n) => {
        const w = ends[n]! - xs[n]! - 12, font = n === 0 ? f.sansBold : f.sans;
        put(o.i, n === 1 ? shortId(v, font, T.figure, w, f) : fitLine(v, font, T.figure, w, f), xs[n]!, y, T.figure, { font });
      });
      rule(o.i, M, o.x1, y - 7, t.rule);
      y -= 24;
    }
    if (p.totalAccepted) { put(o.i, `Total accepted returns: ${p.totalAccepted}.`, M, y, T.label, { color: t.dim }); y -= 28; }
  }

  // ── issues ───────────────────────────────────────────────────────────────
  more(98);
  put(o.i, 'Issues', M, y, T.head, { font: f.sansBold });
  put(o.i, 'Drawing no. Not assigned.  Rev. -', o.x1, y, T.label, { color: t.dim, right: true });
  y -= 24;
  const xs = [M, 180, 760, 900, 1010];
  ['Issue', 'Description', 'Date', 'By', 'Checked'].forEach((h, n) => put(o.i, h, xs[n]!, y, T.label, { color: t.dim }));
  rule(o.i, M, o.x1, y - 7, t.ink, 0.9);
  for (let n = 1; n <= 3; n++) rule(o.i, M, o.x1, y - 7 - n * 20, t.rule);
}

/** One station's accepted returns as a dot plot, and the height the percentile keeps. */
function drawStation(i: Ink, s: ProfileStationSample, p: { formatStation: (m: number) => string; k: number; unit: string }, y: number, x1: number): number {
  const f = i.c.fonts, t = i.c.tokens, n = s.heightsM.length;
  const lo = s.heightsM[0]! * p.k, hi = s.heightsM[n - 1]! * p.k;
  put(i, 'One station, drawn', M, y, T.head, { font: f.sansBold });
  const of = s.accepted > n ? `${n.toLocaleString('en-US')} of the ${s.accepted.toLocaleString('en-US')}` : `The ${s.accepted.toLocaleString('en-US')}`;
  put(i, `${of} returns accepted at ${p.formatStation(s.chainageM)}, by height, and the height kept for them.`, M, y - 18, T.figure, { color: t.dim });
  const by = y - 118, span = hi - lo;
  if (!(span > 0)) return y - 40;
  const step = niceStep(span / 8), z0 = Math.floor(lo / step) * step, z1 = Math.ceil(hi / step) * step;
  const X = (v: number): number => M + ((v - z0) / (z1 - z0)) * (x1 - M);
  const pitch = 4, bins = new Map<number, number>();
  for (let q = 0; q < n; q++) { const b = Math.round(X(s.heightsM[q]! * p.k) / pitch); bins.set(b, (bins.get(b) ?? 0) + 1); }
  // Dots stack by bin; the pitch tightens so the tallest stack fits.
  const tall = Math.max(...bins.values()), dy = Math.min(3.4, 60 / tall), r = Math.min(1.5, dy * 0.44);
  for (const [b, m] of [...bins.entries()].sort((a, q) => a[0] - q[0])) {
    const below = b * pitch <= X(s.keptM * p.k) + 0.01;
    if (dy < 1.4) i.page.drawRectangle({ x: b * pitch - 1.6, y: by + 4, width: 3.2, height: m * dy, color: pdfColor(below ? t.ink : t.otherDot) });
    else for (let q = 0; q < m; q++) i.page.drawCircle({ x: b * pitch, y: by + 5 + q * dy, size: r, color: pdfColor(below ? t.ink : t.otherDot) });
  }
  rule(i, M, x1, by, t.ink, 0.9);
  const dec = Math.max(0, Math.min(3, Math.ceil(-Math.log10(step) - 1e-9)));
  for (let q = 0; q <= Math.round((z1 - z0) / step) && q < 40; q++) {
    const v = z0 + q * step, label = v.toFixed(dec), w = sheetTextWidth(label, f.sans, T.small, f);
    i.page.drawLine({ start: { x: X(v), y: by }, end: { x: X(v), y: by - 4 }, thickness: 0.7, color: pdfColor(t.ink) });
    put(i, label, Math.min(Math.max(M, X(v) - w / 2), x1 - w), by - 16, T.small, { color: t.dim });
  }
  const kx = X(s.keptM * p.k), label = `${s.percentile} % of them are at or below ${(s.keptM * p.k).toFixed(2)} ${p.unit}`;
  const lw = sheetTextWidth(label, f.sansBold, T.figure, f);
  i.page.drawLine({ start: { x: kx, y: by }, end: { x: kx, y: by + 76 }, thickness: 1.2, color: pdfColor(t.ink) });
  i.page.drawCircle({ x: kx, y: by, size: 4.6, color: pdfColor(t.hot), borderColor: pdfColor(t.ink), borderWidth: 1.1 });
  put(i, label, kx + 8 + lw > x1 ? kx - 8 - lw : kx + 8, by + 70, T.figure, { font: f.sansBold });
  return by - 44;
}

function niceStep(raw: number): number {
  const mag = 10 ** Math.floor(Math.log10(raw)), n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}
