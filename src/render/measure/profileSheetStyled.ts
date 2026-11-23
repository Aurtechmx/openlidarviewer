/**
 * profileSheetStyled.ts: sheet one of the profile drawing set in the Light
 * and Dark styles.
 *
 * The drawing has the whole page. Top to bottom, on one chainage axis: a plan
 * strip along the line (when a terrain run gives a surface to draw it from),
 * the section with the ground as a cut face, the station band the ground
 * stands on, the grade, and the same section at true proportion. The headline
 * figures are marked where they are on the drawing.
 *
 * The figures and notes are worked out by profilePdf.ts and handed in, so the
 * styled sheet states exactly what the Classic sheet states. This module only
 * draws. The sheets that follow are profileSheetPages.ts's.
 */
import { setCharacterSpacing, type PDFDocument, type PDFFont, type PDFPage } from 'pdf-lib';
import { encodePng } from '../../export/sheetKit/png';
import { stripSheetRaster, type SheetReliefInput } from '../../export/sheetKit/contourSheetModel';
import type { SheetFonts } from '../../export/sheetKit/fonts';
import { clipPolyline, drawPaper, pdfColor, sheetText, sheetTextRight, sheetTextWidth, wrapSheetText } from '../../export/sheetKit/primitives';
import type { SheetRgb } from '../../export/sheetKit/tokens';
import type { ContourFeatureModel } from '../../terrain/contour/contourFeatureModel';
import { PROFILE_TYPE, STEEP_PERCENT, type ProfilePalette } from './profileSheetPalette';
import type { ProfileChartSample } from './types';
import {
  buildRoundChainageBand,
  chooseProfileScales,
  formatScaleDenominator,
  interpolateStationHeight,
  lineCrossesBox,
  verticalScaleStatement,
  type ProfileScales,
} from './profileSheetLayout';

/** The corridor's returns, in metres along the line and metres of height. */
export interface ProfileSheetReturns {
  readonly count: number;
  readonly chainageM: ArrayLike<number>;
  readonly heightM: ArrayLike<number>;
  /** 1 where the return is classified ground, 0 otherwise. Absent when no class channel was read. */
  readonly ground?: ArrayLike<number> | null;
}

/** What the plan strip is drawn from, in the terrain grid's own frame. */
export interface ProfileSheetPlan {
  readonly relief: SheetReliefInput;
  /** The profile's ends in the grid frame. */
  readonly a: readonly [number, number];
  readonly b: readonly [number, number];
  /** Metres per grid unit, so the strip shares the section's chainage axis. */
  readonly unitToMetres: number;
  /** Corridor half-width, metres, drawn either side of the line. Null leaves it off. */
  readonly corridorM?: number | null;
  /** The analysed contours, drawn over the relief. */
  readonly contours?: ContourFeatureModel | null;
}

/** The returns behind one station, and the height the sampler kept for them. */
export interface ProfileStationSample {
  readonly chainageM: number;
  readonly keptM: number;
  /** Accepted heights at the station, ascending; evenly thinned when there are many. */
  readonly heightsM: ArrayLike<number>;
  /** How many returns were accepted before thinning. */
  readonly accepted: number;
  readonly percentile: number;
}

/** Inputs a styled profile sheet can draw beyond the sampled ground line. */
export interface ProfileSheetExtras {
  readonly returns?: ProfileSheetReturns | null;
  readonly plan?: ProfileSheetPlan | null;
  /** Why the returns are left out, when they are. */
  readonly returnsNote?: string | null;
  /** Where the line meets an index contour on the ground: chainage and the contour's height, in the samples' frame. */
  readonly indexCrossings?: ReadonlyArray<{ readonly chainage: number; readonly height: number }> | null;
  /** One station's returns, when its sampled height could be reproduced from them. */
  readonly station?: ProfileStationSample | null;
}

/** A headline figure: its value as printed, without a unit. */
export interface ProfileFigures {
  readonly length: string;
  readonly relief: string;
  readonly endpoint: string;
  readonly steepest: string;
}

/** Everything the styled sheet one is drawn from. Worked out by profilePdf.ts. */
export interface StyledProfileSheet {
  readonly doc: PDFDocument;
  readonly tokens: ProfilePalette;
  readonly fonts: SheetFonts;
  readonly title: string;
  readonly project: string;
  readonly subtitle: string;
  /** The suitability note, printed in the header and on every footer. */
  readonly suitability: string;
  /** Stations, ascending chainage, metres; height null over a gap. */
  readonly stations: ReadonlyArray<{ readonly chainage: number; readonly elevation: number | null }>;
  readonly lengthM: number;
  readonly minM: number | null;
  readonly maxM: number | null;
  /** Display units per metre and the unit's name. */
  readonly k: number;
  readonly unit: string;
  /** "Elevation" only over an orthometric datum; "Height" otherwise. */
  readonly heightWord: string;
  readonly requestedExaggeration: number | null;
  /**
   * The print scales as Classic states them, from the drawn scales: "Horizontal
   * 1:N · Vertical 1:N", or that the units are unknown. Null leaves the line out.
   */
  readonly scaleRatios?: ((horizontal: number, vertical: number) => string) | null;
  /** False when the ground unit is unverified: figures are in source units, not metres. */
  readonly unitsVerified?: boolean;
  readonly formatStation: (chainageM: number) => string;
  readonly figures: ProfileFigures;
  /** The steepest grade over the base length, where it is. */
  readonly steepest: { readonly fromChainage: number; readonly toChainage: number } | null;
  /** CRS, coverage and the like, one short sentence each, after the notes. */
  readonly facts: readonly string[];
  /** The sheet's notes, every one of them, in order. */
  readonly notes: readonly string[];
  readonly groundLineLabel: string;
  /** Accepted returns per metre (per source unit when the unit is unverified) at each station, when recorded. */
  readonly countsPerStation: ReadonlyArray<number | null>;
  /** Why the plan strip is missing, printed in its place. Null when it is drawn. */
  readonly planMissingNote: string | null;
  readonly extras: ProfileSheetExtras | null;
}

// The sheet kit parts profilePdf.ts's styled build uses, reached through this module.
export type { SheetStyle } from '../../export/sheetKit/tokens';
export { embedSheetFonts } from '../../export/sheetKit/fonts';
export { profilePalette } from './profileSheetPalette';

/** Left and right page margins of the furniture. */
const M = 48;
/** The drawing's left edge, and the room kept to its right for the relief dimension. */
const X0 = 124;
const RIGHT_ROOM = 112;
const GRADE_BASE_M = 10;
/** Most ticks one axis draws. */
const MAX_TICKS = 40;

/** Horizontal print scales of the styled sheet: finer steps than Classic's, and smaller ones for a short line, so the section fills the width. */
const SHEET_SCALES = [5, 10, 20, 25, 50, 75, 100, 125, 150, 200, 250, 300, 400, 500, 600, 750] as const;

interface Pen {
  readonly page: PDFPage;
  readonly f: SheetFonts;
  readonly t: ProfilePalette;
}
interface Box { x0: number; y0: number; x1: number; y1: number }

function text(p: Pen, s: string, x: number, y: number, size: number, o: { color?: SheetRgb; font?: PDFFont; align?: 'left' | 'right' | 'mid' } = {}): void {
  const font = o.font ?? p.f.sans, color = o.color ?? p.t.ink;
  if (o.align === 'right') sheetTextRight(p.page, s, x, y, { font, size, color }, p.f);
  else sheetText(p.page, s, o.align === 'mid' ? x - sheetTextWidth(s, font, size, p.f) / 2 : x, y, { font, size, color }, p.f);
}
const line = (p: Pen, x0: number, y0: number, x1: number, y1: number, color: SheetRgb, thickness = 0.7, dash?: number[]): void => {
  p.page.drawLine({ start: { x: x0, y: y0 }, end: { x: x1, y: y1 }, thickness, color: pdfColor(color), ...(dash ? { dashArray: dash } : {}) });
};
const path = (pts: ReadonlyArray<readonly [number, number]>, PH: number): string =>
  pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${(PH - y).toFixed(2)}`).join(' ');

/** The longest start of `s` that fits `w`, with a mark when it is cut. */
export function fitLine(s: string, font: PDFFont, size: number, w: number, f: SheetFonts): string {
  if (sheetTextWidth(s, font, size, f) <= w) return s;
  const chars = [...s];
  while (chars.length > 1 && sheetTextWidth(`${chars.join('')}...`, font, size, f) > w) chars.pop();
  return `${chars.join('')}...`;
}

/** A large heading set slightly tight. */
export function drawDisplay(page: PDFPage, s: string, x: number, y: number, size: number, f: SheetFonts, color: SheetRgb): void {
  page.pushOperators(setCharacterSpacing(-size * 0.02));
  sheetText(page, s, x, y, { font: f.sansBold, size, color }, f);
  page.pushOperators(setCharacterSpacing(0));
}

/** Draw sheet one. The page footer is stamped by the caller once the page count is known. */
export async function drawStyledProfileSheet(page: PDFPage, s: StyledProfileSheet): Promise<void> {
  const t = s.tokens, f = s.fonts, p: Pen = { page, f, t }, T = PROFILE_TYPE;
  drawPaper(page, t);
  const PW = page.getWidth(), PH = page.getHeight();
  const plotW = PW - X0 - RIGHT_ROOM;
  const top = (v: number): number => PH - v;
  const hasPlan = s.extras?.plan != null;

  // ── header ───────────────────────────────────────────────────────────────
  const TW = 400;
  let tsz: number = T.title;
  while (tsz > 24 && sheetTextWidth(s.title, f.sansBold, tsz, f) > TW) tsz -= 1;
  // A name too long for one line takes two, set smaller.
  let title = [s.title];
  if (sheetTextWidth(s.title, f.sansBold, tsz, f) > TW) {
    tsz = 19;
    title = wrapSheetText(s.title, f.sansBold, tsz, TW, f);
    if (title.length > 2) title = [title[0]!, title.slice(1).join(' ')];
    title = title.map((ln) => fitLine(ln, f.sansBold, tsz, TW, f));
  }
  title.forEach((ln, i) => drawDisplay(page, ln, X0 - 2, top(title.length > 1 ? 46 + i * 23 : 66), tsz, f, t.ink));
  const suit = wrapSheetText(s.suitability, f.sans, T.label, 240, f);
  text(p, 'Preliminary', PW - M, top(44), T.value, { font: f.sansBold, align: 'right' });
  suit.slice(0, 2).forEach((ln, i) => text(p, ln, PW - M, top(60 + i * 13), T.label, { color: t.dim, align: 'right' }));
  const hx = X0 + Math.max(...title.map((ln) => sheetTextWidth(ln, f.sansBold, tsz, f))) + 28;
  const hw = PW - M - 262 - hx;
  let psz: number = T.value;
  while (psz > T.small && sheetTextWidth(s.project, f.sansBold, psz, f) > hw) psz -= 0.5;
  text(p, fitLine(s.project, f.sansBold, psz, hw, f), hx, top(49), psz, { font: f.sansBold });
  text(p, fitLine(s.subtitle, f.sans, T.body, hw, f), hx, top(66), T.body, { color: t.dim });

  // ── scales ───────────────────────────────────────────────────────────────
  // Page tops, points from the top edge.
  const planTop = 90, planH = hasPlan ? 104 : 14;
  const secTop = planTop + planH + 52, secBot = 544, baseBot = 626;
  const sectionBottom = top(secBot), sectionTop = top(secTop), sectionH = sectionTop - sectionBottom;
  const len = s.lengthM;
  // The same guard as the Classic sheet: a corrupt sample can make the length or
  // the relief non-finite, and nothing below may loop or scale on one.
  const drawable = Number.isFinite(len) && len > 0 && s.minM != null && s.maxM != null
    && Number.isFinite(s.minM) && Number.isFinite(s.maxM);
  const scales: ProfileScales | null = drawable
    ? chooseProfileScales({ lengthM: len, minM: s.minM!, maxM: s.maxM!, plotWpt: plotW, plotHpt: sectionH, k: s.k, requestedExaggeration: s.requestedExaggeration, denominators: SHEET_SCALES })
    : null;
  const drawW = scales?.drawnWpt ?? plotW;
  const X1 = X0 + drawW;
  const mapX = (c: number): number => X0 + (len > 0 ? (c / len) * drawW : 0);
  const mapY = (h: number): number =>
    scales ? sectionBottom + ((h - scales.axisLoM) / (scales.axisHiM - scales.axisLoM)) * sectionH : sectionBottom;
  const side = (head: string, sub: string | null, y: number): void => {
    text(p, head, X0 - 16, y, T.label, { font: f.sansBold, align: 'right' });
    if (sub) text(p, sub, X0 - 16, y - 13, T.small, { color: t.dim, align: 'right' });
  };

  // ── plan strip ───────────────────────────────────────────────────────────
  if (hasPlan && len > 0 && scales) {
    side('Plan', s.unitsVerified === false ? null : `1:${formatScaleDenominator(scales.horizontal)}`, top(planTop + 12));
    await drawPlanStrip(page, s, { x: X0, y: top(planTop + planH), w: drawW, h: planH }, len);
  } else {
    side('Plan', null, top(planTop + 10));
    if (s.planMissingNote) text(p, s.planMissingNote, X0, top(planTop + 10), T.label, { color: t.dim });
  }

  if (!scales) {
    text(p, 'No ground line to draw: the profile has no sampled heights.', X0, (sectionTop + sectionBottom) / 2, T.head, { color: t.dim });
    drawNotes(p, s, top(748), top(812), PW);
    return;
  }

  // ── scale statement and key ──────────────────────────────────────────────
  // The ratios a reader scales off the paper, then the stretch and the print size, as Classic states them.
  const ratios = s.scaleRatios ? s.scaleRatios(scales.horizontal, scales.vertical) : null;
  const stretch = [ratios, verticalScaleStatement(scales.exaggeration), 'print at 100% on A3'].filter(Boolean).join('  ·  ');
  text(p, stretch, X0, sectionTop + 27, T.label, { font: f.sansBold });
  drawKey(p, s, X0, sectionTop + 10);
  // The unit of the height axis, over its figures.
  text(p, `${s.heightWord.replace(/ \(.*\)$/, '')}, ${s.unit}`, X0 - 16, sectionTop + 10, T.small, { color: t.dim, align: 'right' });

  // ── section ──────────────────────────────────────────────────────────────
  for (let n = 0, eD = scales.firstTick; eD <= scales.axisHiM * s.k + 1e-9 && n < 64; n++, eD = scales.firstTick + n * scales.tickStep) {
    const y = mapY(eD / s.k);
    line(p, X0, y, X1, y, t.rule, 0.5);
    if (y > sectionBottom + 4) text(p, eD.toFixed(scales.tickStep < 0.1 ? 2 : 1), X0 - 16, y - 3.6, T.label, { color: t.dim, align: 'right' });
  }
  const rets = s.extras?.returns;
  if (rets && rets.count > 0) await drawReturns(page, s, rets, { x: X0, y: sectionBottom, w: drawW, h: sectionH }, mapX, mapY);
  const runs: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> = [];
  for (const st of s.stations) {
    if (st.elevation == null) { if (cur.length) runs.push(cur); cur = []; continue; }
    cur.push([mapX(st.chainage), mapY(st.elevation)]);
  }
  if (cur.length) runs.push(cur);
  // The ground, cut along the line and standing on the station band.
  page.drawRectangle({ x: X0, y: top(baseBot), width: drawW, height: sectionBottom - top(baseBot), color: pdfColor(t.base) });
  for (const run of runs) {
    if (run.length < 2) continue;
    const d = `${path([[run[0]![0], sectionBottom], ...run, [run[run.length - 1]![0], sectionBottom]], PH)} Z`;
    page.drawSvgPath(d, { x: 0, y: PH, color: pdfColor(t.earth) });
  }
  // The end-to-end grade, from the first covered station to the last.
  const covered = s.stations.filter((st) => st.elevation != null) as Array<{ chainage: number; elevation: number }>;
  const first = covered[0], last = covered[covered.length - 1];
  if (first && last && last.chainage > first.chainage) {
    line(p, mapX(first.chainage), mapY(first.elevation), mapX(last.chainage), mapY(last.elevation), t.dim, 0.9, [2, 4]);
  }
  // Gaps: a dashed link across each one, so the break is visible and stated.
  for (let i = 1; i < runs.length; i++) {
    const a = runs[i - 1]![runs[i - 1]!.length - 1]!, b = runs[i]![0]!;
    line(p, a[0], a[1], b[0], b[1], t.surface, 1, [3, 3]);
  }
  for (const run of runs) if (run.length > 1) page.drawSvgPath(path(run, PH), { x: 0, y: PH, borderColor: pdfColor(t.surface), borderWidth: 2 });
  // The steepest reach, over the line.
  const st0 = s.steepest;
  if (st0 && s.maxM! > s.minM!) {
    const reach = reachOf(s.stations, st0.fromChainage, st0.toChainage).map((q): [number, number] => [mapX(q[0]), mapY(q[1])]);
    if (reach.length > 1) {
      page.drawSvgPath(path(reach, PH), { x: 0, y: PH, borderColor: pdfColor(t.surface), borderWidth: 7.5 });
      page.drawSvgPath(path(reach, PH), { x: 0, y: PH, borderColor: pdfColor(t.hot), borderWidth: 5 });
    }
  }
  // Where an index contour crosses the line, at the contour's height.
  for (const c of s.extras?.indexCrossings ?? []) {
    if (c.height < scales.axisLoM || c.height > scales.axisHiM) continue;
    drawDiamond(p, mapX(c.chainage), mapY(c.height));
  }
  drawCallouts(p, s, { X0, X1, sectionTop, sectionBottom, mapX, mapY, covered });
  // A and B on the section when there is no plan to carry them.
  if (!hasPlan) for (const [x, n] of [[X0, 'A'], [X1, 'B']] as const) drawEnd(p, n, x, sectionTop - 14, 10);

  // ── relief, as a dimension ───────────────────────────────────────────────
  if (covered.length > 1) {
    const hi = mapY(s.maxM!), lo = mapY(s.minM!), x = X1 + 24, mid = Math.min(Math.max((hi + lo) / 2, lo + 4), hi);
    line(p, x, lo, x, hi, t.ink, 0.9);
    for (const y of [lo, hi]) line(p, x - 5, y, x + 5, y, t.ink, 0.9);
    const w = PW - 14 - (x + 10);
    let sz: number = T.lead;
    while (sz > 11 && sheetTextWidth(s.figures.relief, f.sansBold, sz, f) > w) sz -= 0.5;
    text(p, s.figures.relief, x + 10, mid - 3, sz, { font: f.sansBold });
    text(p, `${s.unit} relief`, x + 10, mid - 17, T.small, { color: t.dim });
  }

  // ── station band, on the ground's base ───────────────────────────────────
  drawBand(p, s, { X0, X1, drawW, len, mapX, rows: [top(563), top(582), top(601), top(620)], tick: sectionBottom });

  // ── grade chart ──────────────────────────────────────────────────────────
  const gradeBase = s.unitsVerified === false
    ? `${GRADE_BASE_M} units of chainage (unit unverified)`
    : `${GRADE_BASE_M} ${s.unit === 'ft' ? 'm of chainage (shown in feet)' : 'm of chainage'}`;
  drawGrade(p, s, { X0, X1, len, mapX, y0: top(688), y1: top(650), label: `Grade % over ${gradeBase}` });

  // ── true proportion ──────────────────────────────────────────────────────
  drawTrueShape(p, s, runs, { X0, drawW, len, top: top(708), bottom: top(738), exaggeration: scales.exaggeration, mapY, PW });

  drawNotes(p, s, top(748), top(812), PW);
}

/** The sampled line between two chainages, ends interpolated; empty when a gap is in the way. */
function reachOf(stations: StyledProfileSheet['stations'], from: number, to: number): Array<[number, number]> {
  const pts = stations.map((s) => ({ chainage: s.chainage, height: s.elevation }));
  const out: Array<[number, number]> = [];
  const a = interpolateStationHeight(pts, from), b = interpolateStationHeight(pts, to);
  if (a == null || b == null) return [];
  out.push([from, a]);
  for (const s of stations) if (s.chainage > from && s.chainage < to) { if (s.elevation == null) return []; out.push([s.chainage, s.elevation]); }
  out.push([to, b]);
  return out;
}

/** The badge at one end of the line. */
function drawEnd(p: Pen, label: string, x: number, y: number, r: number): void {
  p.page.drawCircle({ x, y, size: r, color: pdfColor(p.t.ink) });
  text(p, label, x, y - r * 0.42, r * 1.17, { font: p.f.sansBold, color: p.t.paper, align: 'mid' });
}

function drawDiamond(p: Pen, x: number, y: number, r = 4): void {
  p.page.drawSvgPath(`M0 ${-r} L${r} 0 L0 ${r} L${-r} 0 Z`, { x, y, color: pdfColor(p.t.paper), borderColor: pdfColor(p.t.ink), borderWidth: 1.1 });
}

/** What the marks mean, in one line over the section: only the ones that are drawn. */
function drawKey(p: Pen, s: StyledProfileSheet, x: number, y: number): void {
  const { f, t } = p, size = PROFILE_TYPE.small, mid = y + 3.2;
  const item = (w: number, label: string, mark: (x: number) => void): void => {
    mark(x);
    text(p, label, x + w + 6, y, size, { color: t.dim });
    x += w + 6 + sheetTextWidth(label, f.sans, size, f) + 20;
  };
  item(20, s.groundLineLabel, (a) => line(p, a, mid, a + 20, mid, t.surface, 2));
  if (s.stations.some((st) => st.elevation == null)) item(20, 'Across a gap with no accepted returns', (a) => line(p, a, mid, a + 20, mid, t.surface, 1, [3, 3]));
  const dot = (c: SheetRgb) => (a: number): void => { p.page.drawCircle({ x: a + 4, y: mid, size: 2.6, color: pdfColor(c) }); };
  if (s.extras?.returns?.ground) {
    item(8, 'Ground returns', dot(t.groundDot));
    item(8, 'Other returns', dot(t.otherDot));
  } else if (s.extras?.returns) item(8, 'Returns in the corridor', dot(t.otherDot));
  if ((s.extras?.indexCrossings?.length ?? 0) > 0) item(9, 'Crosses an index contour', (a) => drawDiamond(p, a + 4.5, mid, 3.6));
}

interface Frame {
  X0: number; X1: number; sectionTop: number; sectionBottom: number;
  mapX: (c: number) => number; mapY: (h: number) => number;
  covered: ReadonlyArray<{ chainage: number; elevation: number }>;
}

/** The figures, marked where they are. Each label takes the first place clear of the line and of the labels before it. */
function drawCallouts(p: Pen, s: StyledProfileSheet, g: Frame): void {
  const { f, t } = p, T = PROFILE_TYPE;
  // A level line has no high, low or steep place to mark.
  if (g.covered.length < 2 || !(s.maxM! > s.minM!)) return;
  const poly = s.stations.map((st) => (st.elevation == null ? null : { x: g.mapX(st.chainage), y: g.mapY(st.elevation) }));
  const taken: Box[] = [];
  const hits = (a: Box, b: Box): boolean => a.x0 < b.x1 + 4 && b.x0 < a.x1 + 4 && a.y0 < b.y1 + 2 && b.y0 < a.y1 + 2;
  const leaders: Array<[{ x: number; y: number }, { x: number; y: number }]> = [];
  /** The leader from a point on the line to the nearest edge of a label. */
  const leaderTo = (x: number, y: number, b: Box): [{ x: number; y: number }, { x: number; y: number }] => {
    const up = b.y0 > y;
    return [{ x, y: y + (up ? 4 : -4) }, { x: Math.min(Math.max(x, b.x0 + 4), b.x1 - 4), y: up ? b.y0 - 3 : b.y1 + 1 }];
  };
  const place = (w: number, h: number, at: ReadonlyArray<readonly [number, number]>, above: boolean, anchor?: readonly [number, number]): Box | null => {
    for (const [x, y] of at) {
      const b: Box = { x0: x, y0: y, x1: x + w, y1: y + h };
      if (b.x0 < g.X0 + 4 || b.x1 > g.X1 - 4 || b.y0 < g.sectionBottom + 3 || b.y1 > g.sectionTop - 2) continue;
      if (lineCrossesBox(poly, b, 4) || taken.some((q) => hits(b, q))) continue;
      // A label on the air side stays above the ground at every place it covers, and the other way round.
      const ok = poly.every((q) => q == null || q.x < b.x0 - 2 || q.x > b.x1 + 2 || (above ? q.y < b.y0 : q.y > b.y1));
      if (!ok) continue;
      if (leaders.some((l) => lineCrossesBox(l, b, 3))) continue;
      if (anchor) {
        const l = leaderTo(anchor[0], anchor[1], b);
        if (taken.some((q) => lineCrossesBox(l, q, 3))) continue;
        leaders.push(l);
      }
      taken.push(b);
      return b;
    }
    return null;
  };
  /** Places around (x, y), nearest first, on one side of the line. */
  const around = (x: number, y: number, w: number, h: number, up: boolean): Array<[number, number]> => {
    const out: Array<[number, number, number]> = [];
    for (let dy = 10; dy <= 260; dy += 8) for (let dx = -300; dx <= 300; dx += 12) out.push([x + dx - w / 2, up ? y + dy : y - dy - h, Math.hypot(dx * 0.8, dy)]);
    return out.sort((a, b) => a[2] - b[2]).map(([a, b]) => [a, b]);
  };
  const plate = (b: Box): void => {
    p.page.drawRectangle({ x: b.x0 - 3, y: b.y0 - 2, width: b.x1 - b.x0 + 6, height: b.y1 - b.y0 + 2, color: pdfColor(t.paper), opacity: 0.86 });
  };
  const W = (q: string, font: PDFFont, size: number): number => sheetTextWidth(q, font, size, f);
  const fmt = (m: number): string => `${(m * s.k).toFixed(2)} ${s.unit}`;

  const hi = g.covered.reduce((a, b) => (b.elevation > a.elevation ? b : a)), lo = g.covered.reduce((a, b) => (b.elevation < a.elevation ? b : a));
  const drawLeader = (x: number, y: number, b: Box): void => { const [m, n] = leaderTo(x, y, b); line(p, m.x, m.y, n.x, n.y, t.ink, 0.8); };
  const extreme = (q: { chainage: number; elevation: number }, word: string, up: boolean): void => {
    const label = `${word} ${fmt(q.elevation)} at ${s.formatStation(q.chainage)}`;
    const w = W(label, f.sansBold, T.figure), x = g.mapX(q.chainage), y = g.mapY(q.elevation);
    const b = place(w, T.figure, around(x, y, w, T.figure, up), up, [x, y]) ?? place(w, T.figure, around(x, y, w, T.figure, !up), !up, [x, y]);
    if (!b) return;
    const onAir = b.y0 > y;
    if (onAir) plate(b);
    drawLeader(x, y, b);
    text(p, label, b.x0, b.y0 + 2, T.figure, { font: f.sansBold });
  };
  extreme(lo, 'Lowest', false);
  if (s.steepest && s.figures.steepest !== '-') {
    const c = (s.steepest.fromChainage + s.steepest.toChainage) / 2;
    const h = interpolateStationHeight(s.stations.map((st) => ({ chainage: st.chainage, height: st.elevation })), c);
    if (h != null) {
      const base = `${GRADE_BASE_M} ${s.unitsVerified === false ? 'units' : 'm'}`;
      const l1 = `Steepest over ${base}: ${s.figures.steepest} %`, l2 = `${s.formatStation(s.steepest.fromChainage)} to ${s.formatStation(s.steepest.toChainage)}`;
      const w = Math.max(W(l1, f.sansBold, T.head), W(l2, f.sans, T.label)), x = g.mapX(c), y = g.mapY(h);
      const b = place(w, 32, around(x, y + 24, w, 32, true), true, [x, y]) ?? place(w, 32, around(x, y - 8, w, 32, false), false, [x, y]);
      if (b) {
        const up = b.y0 > y;
        if (up) plate(b);
        drawLeader(x, y, b);
        text(p, l1, b.x0, b.y0 + 18, T.head, { font: f.sansBold });
        text(p, l2, b.x0, b.y0 + 3, T.label, { color: t.dim });
      }
    }
  }
  extreme(hi, 'Highest', true);
  const a = g.covered[0]!, z = g.covered[g.covered.length - 1]!;
  if (z.chainage > a.chainage && s.figures.endpoint !== '-') {
    const label = `End to end ${s.figures.endpoint} %`, w = W(label, f.sans, T.label);
    const spots: Array<[number, number]> = [];
    for (const u of [0.25, 0.75, 0.35, 0.65, 0.5, 0.15, 0.85]) {
      const x = g.mapX(a.chainage + (z.chainage - a.chainage) * u), y = g.mapY(a.elevation + (z.elevation - a.elevation) * u);
      spots.push([x - w / 2, y + 8], [x - w / 2, y + 18]);
    }
    const b = place(w, T.label, spots, true);
    if (b) { plate(b); text(p, label, b.x0, b.y0 + 2, T.label); }
  }
}

function drawBand(p: Pen, s: StyledProfileSheet, g: {
  X0: number; X1: number; drawW: number; len: number; mapX: (c: number) => number; rows: readonly number[]; tick: number;
}): void {
  const { f, t } = p, T = PROFILE_TYPE, size = T.figure;
  const stationsIn = s.stations.map((st) => ({ chainage: st.chainage, height: st.elevation }));
  // Whole chainages drop their decimals together, so more of them fit.
  const sta = (m: number): string => s.formatStation(m).replace(/\.00$/, '');
  const peakH = Math.max(Math.abs(s.minM ?? 0), Math.abs(s.maxM ?? 0)) * s.k;
  const colW = Math.max(sheetTextWidth(sta(Math.floor(g.len)), f.sansBold, size, f), sheetTextWidth(`${(s.minM ?? 0) < 0 ? '-' : ''}${peakH.toFixed(2)}`, f.sans, size, f)) + 8;
  const band = buildRoundChainageBand({ stations: stationsIn, lengthM: g.len, k: s.k, mapX: g.mapX, columnWpt: colW, startClearColumns: 1.4 });
  // The count is of every return the sampler kept, whatever its class.
  const per = s.unitsVerified === false ? 'unit' : 'm';
  // The section heading carries the reference in full; the row head has the margin's width.
  const heads = ['Chainage', `${s.heightWord.replace(/ \(.*\)$/, '')} ${s.unit}`, 'Grade %', `Returns per ${per}`];
  heads.forEach((h, r) => text(p, h, g.X0 - 16, g.rows[r]!, T.label, { color: t.dim, align: 'right' }));
  const n = band.columns.length;
  band.columns.forEach((c, i) => {
    const put = (txt: string, row: number, font: PDFFont): void => {
      if (i === 0) text(p, txt, g.X0 + 8, g.rows[row]!, size, { font });
      else if (i === n - 1) text(p, txt, g.X1 - 8, g.rows[row]!, size, { font, align: 'right' });
      else text(p, txt, c.x, g.rows[row]!, size, { font, align: 'mid' });
    };
    put(sta(c.chainage), 0, f.sansBold);
    put(c.height == null ? '-' : (c.height * s.k).toFixed(2), 1, f.sans);
    if (i > 0 && i < n - 1) line(p, c.x, g.tick, c.x, g.tick - 5, t.baseDim, 0.8);
    const next = band.columns[i + 1];
    if (next && c.height != null && next.height != null && next.chainage > c.chainage) {
      const v = (100 * (next.height - c.height)) / (next.chainage - c.chainage), txt = v.toFixed(1);
      const steep = Math.abs(v) >= STEEP_PERCENT, mid = (c.x + next.x) / 2, w = sheetTextWidth(txt, f.sansBold, size, f);
      if (steep) p.page.drawRectangle({ x: mid - w / 2 - 6, y: g.rows[2]! - 3.4, width: w + 12, height: 15, color: pdfColor(t.hot) });
      text(p, txt, mid, g.rows[2]!, size, { font: steep ? f.sansBold : f.sans, color: steep ? t.hotInk : t.baseDim, align: 'mid' });
    }
  });
  // Accepted returns per metre (or per source unit), as a bar per station.
  const counts = s.countsPerStation;
  const peak = Math.max(0, ...counts.map((c) => c ?? 0));
  if (!(peak > 0)) return;
  const y = g.rows[3]! - 3;
  for (let i = 0; i < s.stations.length - 1; i++) {
    const c = counts[i];
    if (c == null || c <= 0) continue;
    const x0 = g.mapX(s.stations[i]!.chainage), x1 = g.mapX(s.stations[i + 1]!.chainage);
    p.page.drawRectangle({ x: x0, y, width: Math.max(0.3, x1 - x0 - Math.min(0.8, (x1 - x0) * 0.2)), height: (c / peak) * 13, color: pdfColor(t.solid) });
  }
  // Beside the bars it describes.
  text(p, `accepted returns per ${per},`, g.X1 + 10, g.rows[3]! + 12, T.small, { color: t.dim });
  text(p, `tallest bar ${peak < 1 ? peak.toFixed(2) : Math.round(peak).toLocaleString('en-US')}`, g.X1 + 10, g.rows[3]!, T.small, { color: t.dim });
}

function drawGrade(p: Pen, s: StyledProfileSheet, g: {
  X0: number; X1: number; len: number; mapX: (c: number) => number; y0: number; y1: number; label: string;
}): void {
  const { page, f, t } = p, T = PROFILE_TYPE, PH = page.getHeight();
  text(p, g.label, g.X0, g.y1 + 5, T.label, { font: f.sansBold });
  const grades = gradeSeries(s.stations, g.len);
  const known = grades.filter((q) => q.grade != null && Number.isFinite(q.grade)) as Array<{ chainage: number; grade: number }>;
  const mid = (g.y0 + g.y1) / 2;
  if (known.length > 1) {
    const gMax = Math.max(5, ...known.map((q) => Math.abs(q.grade)));
    const step = niceGradeStep(gMax), lim = Math.ceil(gMax / step) * step;
    const gy = (v: number): number => mid + (v / lim) * ((g.y1 - g.y0) / 2);
    for (const v of [lim, 0, -lim]) text(p, v > 0 ? `+${v.toFixed(0)}` : v.toFixed(0), g.X0 - 16, gy(v) - 3.4, T.small, { color: t.dim, align: 'right' });
    let run: Array<[number, number]> = [];
    const flush = (): void => {
      if (run.length > 1) {
        page.drawSvgPath(`${path([[run[0]![0], gy(0)], ...run, [run[run.length - 1]![0], gy(0)]], PH)} Z`, { x: 0, y: PH, color: pdfColor(t.solid), opacity: 0.3 });
        page.drawSvgPath(path(run, PH), { x: 0, y: PH, borderColor: pdfColor(t.surface), borderWidth: 1.2 });
      }
      run = [];
    };
    for (const q of grades) {
      if (q.grade == null) { flush(); continue; }
      run.push([g.mapX(q.chainage), gy(Math.max(-lim, Math.min(lim, q.grade)))]);
    }
    flush();
  } else text(p, 'no grade: the line is shorter than the base, or a gap is in the way', g.X0 + 8, mid + 5, T.small, { color: t.dim });
  line(p, g.X0, mid, g.X1, mid, t.ink, 0.7);
  // Chainage ticks under the grade chart.
  const step = niceGradeStep(g.len * s.k / 6);
  // At most a few dozen ticks whatever the step, so a degenerate step cannot spin.
  for (let v = 0, n = 0; v <= g.len * s.k + 1e-9 && n < MAX_TICKS && step > 0 && Number.isFinite(step); v += step, n++) {
    const x = g.mapX(v / s.k);
    line(p, x, g.y0, x, g.y0 - 3, t.ink, 0.6);
    text(p, v.toFixed(step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step) - 1e-9))), x, g.y0 - 13, T.small, { color: t.dim, align: 'mid' });
  }
}

/** The section again with one scale both ways, and the length beside it. */
function drawTrueShape(p: Pen, s: StyledProfileSheet, runs: ReadonlyArray<ReadonlyArray<readonly [number, number]>>, g: {
  X0: number; drawW: number; len: number; top: number; bottom: number; exaggeration: number; mapY: (h: number) => number; PW: number;
}): void {
  const { page, f, t } = p, T = PROFILE_TYPE, PH = page.getHeight();
  const relief = s.maxM! - s.minM!, ptPerM = g.drawW / g.len, foot = 5;
  const room = g.top - g.bottom - foot;
  // Smaller than the drawing by one factor both ways, so the strip and the length beside it fit.
  const q = Math.min(0.5, relief > 0 ? room / (relief * ptPerM) : 0.5);
  const w = g.drawW * q, y0 = g.bottom;
  text(p, 'True shape', g.X0 - 16, g.bottom + 11, T.label, { font: f.sansBold, align: 'right' });
  const slope = (g.mapY(1) - g.mapY(0)) || 1;
  for (const run of runs) {
    if (run.length < 2) continue;
    const pts = run.map(([x, y]): [number, number] => [g.X0 + (x - g.X0) * q, y0 + foot + ((y - g.mapY(s.minM!)) / slope) * ptPerM * q]);
    page.drawSvgPath(`${path([[pts[0]![0], y0], ...pts, [pts[pts.length - 1]![0], y0]], PH)} Z`, { x: 0, y: PH, color: pdfColor(t.solid) });
  }
  const tx = g.X0 + Math.max(w, 8) + 20;
  let sz = 24;
  while (sz > 14 && sheetTextWidth(`${s.figures.length} ${s.unit}`, f.sansBold, sz, f) > 190) sz -= 1;
  const L = `${s.figures.length} ${s.unit}`, lw = sheetTextWidth(L, f.sansBold, sz, f);
  text(p, L, tx, y0 + 4, sz, { font: f.sansBold });
  text(p, 'long, measured along the line', tx + lw + 12, y0 + 15, T.label, { color: t.dim });
  text(p, 'The same section with no vertical exaggeration', tx + lw + 12, y0 + 2, T.label, { color: t.dim });
}

/** The notes and facts in three columns. What does not fit is on the method sheet, which carries them all. */
function drawNotes(p: Pen, s: StyledProfileSheet, yTop: number, yBot: number, PW: number): void {
  const { f, t } = p, size = PROFILE_TYPE.small, step = size * 1.26;
  line(p, M, yTop, PW - M, yTop, t.ink, 1);
  const gap = 26, cw = (PW - 2 * M - 2 * gap) / 3;
  const rows = Math.max(1, Math.floor((yTop - yBot - 4) / step));
  const blocks = [...s.notes.map((n, i) => `${i + 1}. ${n}`), ...(s.facts.length ? [s.facts.join(' ')] : [])].map((n) => wrapSheetText(n, f.sans, size, cw, f));
  const fit = fitColumns(blocks, rows, 3);
  fit.placed.forEach(({ col, row, lines }) => lines.forEach((ln, i) => text(p, ln, M + col * (cw + gap), yTop - 14 - (row + i) * step, size, { color: t.ink })));
}

/**
 * Set whole blocks of lines into columns of `rows`. When some do not fit, the
 * last line that is free says they continue on the method sheet.
 */
export function fitColumns(blocks: readonly string[][], rows: number, cols: number): { placed: Array<{ col: number; row: number; lines: string[] }>; left: number } {
  const run = (depth: number, reserve: boolean): { placed: Array<{ col: number; row: number; lines: string[] }>; left: number; col: number; row: number } => {
    const placed: Array<{ col: number; row: number; lines: string[] }> = [];
    let col = 0, row = 0, i = 0;
    for (; i < blocks.length; i++) {
      const b = blocks[i]!;
      const cap = (c: number): number => depth - (reserve && c === cols - 1 ? 1 : 0);
      if (row + b.length > cap(col)) { col++; row = 0; }
      if (col >= cols || b.length > cap(col)) break;
      placed.push({ col, row, lines: b });
      row += b.length;
    }
    return { placed, left: blocks.length - i, col, row };
  };
  const all = run(rows, false);
  // Shorter columns first, so the blocks spread across the page.
  if (all.left === 0) {
    for (let r = 1; r < rows; r++) { const q = run(r, false); if (q.left === 0) return { placed: q.placed, left: 0 }; }
    return { placed: all.placed, left: 0 };
  }
  const some = run(rows, true);
  return { placed: [...some.placed, { col: cols - 1, row: rows - 1, lines: ['Every note is on the method sheet.'] }], left: some.left };
}

/** Grade in percent over a fixed base of chainage, at the base's midpoint. Null where an end has no height. */
export function gradeSeries(
  stations: ReadonlyArray<{ readonly chainage: number; readonly elevation: number | null }>,
  lengthM: number,
): Array<{ chainage: number; grade: number | null }> {
  const pts = stations.map((s) => ({ chainage: s.chainage, height: s.elevation }));
  const out: Array<{ chainage: number; grade: number | null }> = [];
  for (const s of stations) {
    const c0 = s.chainage, c1 = c0 + GRADE_BASE_M;
    if (c1 > lengthM + 1e-9) break;
    const h0 = interpolateStationHeight(pts, c0), h1 = interpolateStationHeight(pts, c1);
    // A gap anywhere inside the base breaks the grade, as the steepest-grade figure does.
    const broken = stations.some((x) => x.chainage > c0 && x.chainage < c1 && x.elevation == null);
    out.push({ chainage: c0 + GRADE_BASE_M / 2, grade: h0 == null || h1 == null || broken ? null : (100 * (h1 - h0)) / GRADE_BASE_M });
  }
  return out;
}

/**
 * Why the plan strip is missing, or null when it is drawn. Extras with no plan
 * mean the scan has no terrain run; no extras at all mean they could not be
 * read for this export, which says nothing about a terrain run.
 */
export function planMissingNote(extras: ProfileSheetExtras | null | undefined): string | null {
  if (extras?.plan) return null;
  return extras ? 'not drawn: no terrain run gives a surface for this scan' : 'not drawn: the plan could not be read for this export';
}

/** The print-scale words Classic states, for the styled header: ratios, or that the units are unknown. */
export function profileScaleRatios(unitsUnverified: boolean): (horizontal: number, vertical: number) => string {
  return (h, v) => unitsUnverified
    ? 'Horizontal and vertical scale: units unknown'
    : `Horizontal 1:${formatScaleDenominator(h)}  ·  Vertical 1:${formatScaleDenominator(v)}`;
}

function niceGradeStep(span: number): number {
  const raw = Math.max(1e-9, span) / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

async function drawReturns(
  page: PDFPage,
  s: StyledProfileSheet,
  r: ProfileSheetReturns,
  box: { x: number; y: number; w: number; h: number },
  mapX: (c: number) => number,
  mapY: (h: number) => number,
): Promise<void> {
  // Three pixels a point: a return is a dot about a point across, or a finer
  // one when there are so many that dots would close up.
  const W = Math.max(1, Math.min(3000, Math.round(box.w * 3)));
  const H = Math.max(1, Math.min(2000, Math.round(box.h * 3)));
  const rgba = new Uint8Array(W * H * 4);
  const groundC = toBytes(s.tokens.groundDot), otherC = toBytes(s.tokens.otherDot);
  const sx = W / box.w, sy = H / box.h;
  const spread = r.count > 120_000 ? 0 : 1;
  const alpha = r.count > 120_000 ? 120 : 190;
  // A clear pixel keeps the dot colour, so a reader that smooths the image does not darken the dots' edges.
  for (let o = 0; o < rgba.length; o += 4) { rgba[o] = otherC[0]; rgba[o + 1] = otherC[1]; rgba[o + 2] = otherC[2]; }
  // Ground last, so it is on top.
  for (const pass of [0, 1]) {
    for (let i = 0; i < r.count; i++) {
      const isGround = r.ground?.[i] ? 1 : 0;
      if (isGround !== pass) continue;
      const c = r.chainageM[i]!, h = r.heightM[i]!;
      if (!Number.isFinite(c) || !Number.isFinite(h)) continue;
      const cx = Math.floor((mapX(c) - box.x) * sx), cy = Math.floor((box.y + box.h - mapY(h)) * sy);
      const col = isGround ? groundC : otherC;
      for (let dy = -spread; dy <= spread; dy++) for (let dx = -spread; dx <= spread; dx++) {
        const px = cx + dx, py = cy + dy;
        if (px < 0 || py < 0 || px >= W || py >= H) continue;
        const o = (py * W + px) * 4;
        rgba[o] = col[0]; rgba[o + 1] = col[1]; rgba[o + 2] = col[2];
        rgba[o + 3] = Math.min(255, rgba[o + 3]! + (dx !== 0 && dy !== 0 ? alpha * 0.4 : alpha));
      }
    }
  }
  const png = await s.doc.embedPng(await encodePng(rgba, W, H));
  page.drawImage(png, { x: box.x, y: box.y, width: box.w, height: box.h });
}

function toBytes(c: SheetRgb): [number, number, number] {
  return [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255)];
}

async function drawPlanStrip(page: PDFPage, s: StyledProfileSheet, box: { x: number; y: number; w: number; h: number }, lengthM: number): Promise<void> {
  const plan = s.extras!.plan!;
  const t = s.tokens, f = s.fonts, p: Pen = { page, f, t };
  const PH = page.getHeight();
  const ax = plan.a[0], ay = plan.a[1];
  const dx = plan.b[0] - ax, dy = plan.b[1] - ay;
  const lenU = Math.hypot(dx, dy);
  if (!(lenU > 0)) return;
  const dir: [number, number] = [dx / lenU, dy / lenU];
  const perp: [number, number] = [-dir[1], dir[0]];
  // Page points per grid unit along the line, matching the section's chainage axis.
  const ptPerUnit = box.w / (lengthM / plan.unitToMetres);
  const halfV = box.h / 2 / ptPerUnit;
  const raster = stripSheetRaster(plan.relief, t, [ax, ay], dir, [0, lenU], [-halfV, halfV], Math.min(2000, box.w * 2), Math.min(2000, box.h * 2));
  page.drawRectangle({ x: box.x, y: box.y, width: box.w, height: box.h, color: pdfColor(t.nodata), opacity: 0.5 });
  const img = await s.doc.embedPng(await encodePng(raster.rgba, raster.width, raster.height));
  page.drawImage(img, { x: box.x, y: box.y, width: box.w, height: box.h });
  const toPage = (x: number, y: number): [number, number] => {
    const u = (x - ax) * dir[0] + (y - ay) * dir[1];
    const v = (x - ax) * perp[0] + (y - ay) * perp[1];
    return [box.x + u * ptPerUnit, box.y + box.h / 2 + v * ptPerUnit];
  };
  // Contours, cut to the strip.
  for (const feat of plan.contours?.features ?? []) {
    const pts = feat.coordinates.map(([x, y]) => toPage(x, y));
    for (const seg of clipPolyline(pts, box)) {
      if (seg.length < 2) continue;
      page.drawSvgPath(path(seg, PH), { x: 0, y: PH, borderColor: pdfColor(feat.isIndex ? t.index : t.minor), borderWidth: feat.isIndex ? 0.9 : 0.35, borderOpacity: 0.85 });
    }
  }
  const midY = box.y + box.h / 2;
  // The corridor, when the strip is wide enough to hold it.
  const half = plan.corridorM != null ? (plan.corridorM / plan.unitToMetres) * ptPerUnit : null;
  if (half != null && half > 3 && half < box.h / 2) for (const y of [midY - half, midY + half]) line(p, box.x, y, box.x + box.w, y, t.ink, 0.6, [5, 4]);
  // The line and its ends.
  line(p, box.x, midY, box.x + box.w, midY, t.halo, 3.4);
  line(p, box.x, midY, box.x + box.w, midY, t.ink, 1.6);
  for (const [px, label] of [[box.x, 'A'], [box.x + box.w, 'B']] as const) {
    drawEnd(p, label, px, midY, 12);
  }
  // North: the grid's +Y direction in strip coordinates, beside the strip.
  const ang = Math.atan2(perp[1], dir[1]);
  const cx = box.x + box.w + 44, cy = box.y + box.h - 22;
  const R = (a: number, r: number): string => `${(cx + Math.cos(ang + a) * r).toFixed(2)} ${(PH - (cy + Math.sin(ang + a) * r)).toFixed(2)}`;
  page.drawSvgPath(`M ${R(0, 15)} L ${R(2.65, 11)} L ${R(Math.PI, 5)} L ${R(-2.65, 11)} Z`, { x: 0, y: PH, color: pdfColor(t.ink) });
  text(p, 'Grid N', cx, cy - 32, PROFILE_TYPE.small, { color: t.dim, align: 'mid' });
}

/**
 * Returns per metre behind each sample, from its recorded count and the spacing
 * to the next sample. The first and last stations have none: they also hold the
 * returns within the corridor's width beyond the ends of the line, so their
 * count is not one spacing's.
 */
export function countsPerStation(samples: ReadonlyArray<ProfileChartSample>): Array<number | null> {
  return samples.map((smp, i) => {
    const next = samples[i + 1];
    if (smp.count == null || !next || i === 0) return null;
    const dx = next.distance - smp.distance;
    return dx > 0 ? smp.count / dx : null;
  });
}
