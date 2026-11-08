/**
 * charts.ts: the hypsometric curve and the main channel profile of a
 * catchment, drawn with pdf-lib into a box the caller gives.
 *
 * Every mark and label stays inside the box: labels that would not fit are
 * set smaller or wrapped, never drawn past the edge. Text goes through the
 * page kit so symbol-only characters use the symbol font.
 *
 * Belongs to the report's lazy chunk.
 */
import { degrees, LineCapStyle, rgb } from 'pdf-lib';
import type { PDFFont, PDFPage, RGB } from 'pdf-lib';
import type { Morphometrics } from '../../simulation/flowPulse/watershed/catchmentMorphometrics';
import type { MainChannel } from '../../simulation/flowPulse/watershed/mainChannel';
import type { ReportLanguage } from '../../simulation/flowPulse/watershed/watershedReportModel';
import { formatNumber, t } from '../../simulation/flowPulse/watershed/watershedStrings';
import { withheldText } from '../../simulation/flowPulse/watershed/watershedNarrative';
import { PALETTE, drawRuns, splitRuns, widthOf } from './pageKit';
import type { Box } from './pageKit';
import type { ReportFonts } from './reportFonts';

/** Dash pattern of the profile where the ground was interpolated. */
export const PROFILE_INTERPOLATED_DASH: readonly number[] = [3, 2.5];
const SLOPE_LINE_DASH = [1.2, 1.8];

const TITLE = 12;
const CAPTION = 10.5;
const TICK = 9.1;
const MIN_TEXT = 7.5;

// --- Shared drawing helpers (also used by the map page) -------------------

/** Largest size from `size` down to MIN_TEXT at which `text` fits `maxW`. */
export function fitSize(text: string, font: PDFFont, size: number, maxW: number, fonts: ReportFonts): number {
  let s = size;
  while (s > MIN_TEXT && widthOf(text, font, s, fonts) > maxW) s -= 0.25;
  return s;
}

/** Greedy word wrap at ordinary spaces; a word wider than the line is cut by character. */
export function wrapText(text: string, font: PDFFont, size: number, maxW: number, fonts: ReportFonts): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ').filter((w) => w.length > 0)) {
    const next = line ? `${line} ${word}` : word;
    if (widthOf(next, font, size, fonts) <= maxW) { line = next; continue; }
    if (line) lines.push(line);
    line = '';
    let chunk = '';
    for (const ch of word) {
      if (chunk && widthOf(chunk + ch, font, size, fonts) > maxW) { lines.push(chunk); chunk = ''; }
      chunk += ch;
    }
    line = chunk;
  }
  if (line) lines.push(line);
  return lines;
}

/** Text reading upward with its start at (x, y); x is the left of the glyphs' extent. */
export function drawUpward(page: PDFPage, text: string, x: number, y: number, font: PDFFont, size: number, color: RGB, fonts: ReportFonts): void {
  let along = y;
  for (const r of splitRuns(text, font, fonts)) {
    page.drawText(r.text, { x: x + size * 0.8, y: along, font: r.font, size, color, rotate: degrees(90) });
    along += r.font.widthOfTextAtSize(r.text, size);
  }
}

/** A "nice" step (1, 2 or 5 × 10^k) giving about `count` intervals over `span`. */
export function niceStep(span: number, count: number): number {
  if (!(span > 0)) return 1;
  const raw = span / count;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

/** Largest 1, 2 or 5 × 10^k not above `v`. */
export function niceFloor(v: number): number {
  if (!(v > 0)) return 0;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
}

export function decimalsFor(step: number): number {
  return step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step) - 1e-9));
}

const f2 = (v: number) => v.toFixed(2);

/** An SVG path for drawSvgPath with the origin at (0, page height). */
export function svgPolyline(page: PDFPage, pts: readonly (readonly [number, number])[], close = false): string {
  const H = page.getHeight();
  let d = '';
  pts.forEach(([x, y], i) => { d += `${i === 0 ? 'M' : 'L'}${f2(x)} ${f2(H - y)} `; });
  return close ? `${d}Z` : d.trim();
}

export function strokePath(
  page: PDFPage,
  pts: readonly (readonly [number, number])[],
  o: { color: RGB; width: number; dash?: readonly number[]; opacity?: number; close?: boolean; round?: boolean },
): void {
  if (pts.length < 2) return;
  page.drawSvgPath(svgPolyline(page, pts, o.close), {
    x: 0, y: page.getHeight(), borderColor: o.color, borderWidth: o.width,
    ...(o.dash ? { borderDashArray: [...o.dash] } : {}),
    ...(o.opacity !== undefined ? { borderOpacity: o.opacity } : {}),
    ...(o.round ? { borderLineCap: LineCapStyle.Round } : {}),
  });
}

export function fillPath(page: PDFPage, pts: readonly (readonly [number, number])[], color: RGB, opacity: number): void {
  if (pts.length < 3) return;
  page.drawSvgPath(svgPolyline(page, pts, true), { x: 0, y: page.getHeight(), color, opacity, borderWidth: 0 });
}

// --- Chart frame -------------------------------------------------------------

interface Plot { x: number; y: number; w: number; h: number }

/** Title and caption at the top of the box; returns the y below them. */
function chartHeader(page: PDFPage, box: Box, title: string, caption: string, fonts: ReportFonts): number {
  const ts = fitSize(title, fonts.titleBold, TITLE, box.width, fonts);
  let y = box.y + box.height - ts;
  drawRuns(page, title, box.x, y, { font: fonts.titleBold, size: ts, color: PALETTE.ink }, fonts);
  y -= 3;
  for (const line of wrapText(caption, fonts.body, CAPTION, box.width, fonts)) {
    y -= CAPTION + 1;
    drawRuns(page, line, box.x, y, { font: fonts.body, size: CAPTION, color: PALETTE.mute }, fonts);
  }
  return y - 6;
}

function withheldNote(page: PDFPage, box: Box, top: number, text: string, fonts: ReportFonts): void {
  const h = Math.max(0, top - box.y);
  page.drawRectangle({ x: box.x, y: box.y, width: box.width, height: h, color: PALETTE.paper });
  const lines = wrapText(text, fonts.body, 10, box.width - 16, fonts);
  let y = box.y + h / 2 + ((lines.length - 1) * 13) / 2 - 3;
  for (const line of lines) {
    const w = widthOf(line, fonts.body, 10, fonts);
    drawRuns(page, line, box.x + (box.width - w) / 2, y, { font: fonts.body, size: 10, color: PALETTE.ink2 }, fonts);
    y -= 13;
  }
}

function tickLabel(page: PDFPage, text: string, cx: number, y: number, minX: number, maxX: number, fonts: ReportFonts): void {
  const w = widthOf(text, fonts.body, TICK, fonts);
  const x = Math.max(minX, Math.min(maxX - w, cx - w / 2));
  drawRuns(page, text, x, y, { font: fonts.body, size: TICK, color: PALETTE.mute }, fonts);
}

function axes(page: PDFPage, p: Plot): void {
  page.drawLine({ start: { x: p.x, y: p.y }, end: { x: p.x + p.w, y: p.y }, thickness: 0.6, color: PALETTE.ink });
  page.drawLine({ start: { x: p.x, y: p.y }, end: { x: p.x, y: p.y + p.h }, thickness: 0.6, color: PALETTE.ink });
}

function gridLine(page: PDFPage, x0: number, y0: number, x1: number, y1: number): void {
  page.drawLine({ start: { x: x0, y: y0 }, end: { x: x1, y: y1 }, thickness: 0.35, color: PALETTE.rule });
}

/** Axis titles: x centred under the plot, y reading upward at the box's left edge. */
function axisTitles(page: PDFPage, box: Box, p: Plot, xTitle: string, yTitle: string, fonts: ReportFonts): void {
  const xs = fitSize(xTitle, fonts.body, CAPTION, p.w, fonts);
  const xw = widthOf(xTitle, fonts.body, xs, fonts);
  drawRuns(page, xTitle, Math.max(box.x, p.x + (p.w - xw) / 2), box.y + 1, { font: fonts.body, size: xs, color: PALETTE.ink2 }, fonts);
  const ys = fitSize(yTitle, fonts.body, CAPTION, p.h, fonts);
  const yw = widthOf(yTitle, fonts.body, ys, fonts);
  drawUpward(page, yTitle, box.x, p.y + Math.max(0, (p.h - yw) / 2), fonts.body, ys, PALETTE.ink2, fonts);
}

// --- Hypsometric curve --------------------------------------------------------

export function drawHypsometricCurve(
  page: PDFPage,
  box: Box,
  h: Morphometrics['hypsometry'],
  lang: ReportLanguage,
  fonts: ReportFonts,
): void {
  const top = chartHeader(page, box, t(lang, 'figures.hypsometricCurve'), t(lang, 'figures.hypsometricCaption'), fonts);
  if ('withheld' in h) {
    withheldNote(page, box, top, t(lang, 'chart.withheld', { reason: withheldText(lang, h.withheld) }), fonts);
    return;
  }
  const p: Plot = { x: box.x + 26, y: box.y + 20, w: box.width - 26 - 6, h: top - box.y - 20 - 2 };
  if (p.w <= 10 || p.h <= 10) return;
  const X = (a: number) => p.x + a * p.w;
  const Y = (v: number) => p.y + v * p.h;

  page.drawRectangle({ x: p.x, y: p.y, width: p.w, height: p.h, color: PALETTE.paper });
  for (const g of [0.25, 0.5, 0.75, 1]) {
    gridLine(page, X(g), p.y, X(g), p.y + p.h);
    gridLine(page, p.x, Y(g), p.x + p.w, Y(g));
  }

  const { relArea, relHeight, integral } = h.value;
  const pts: [number, number][] = [];
  for (let k = 0; k < relArea.length; k++) pts.push([X(clamp01(relArea[k]!)), Y(clamp01(relHeight[k]!))]);
  const last = pts[pts.length - 1];
  if (!last || Math.abs(last[0] - X(0)) > 1e-6 || Math.abs(last[1] - Y(1)) > 1e-6) pts.push([X(0), Y(1)]);

  fillPath(page, [[X(0), Y(0)], ...pts, [X(0), Y(0)]], PALETTE.water2, 0.45);
  // The straight line from (0, 1) to (1, 0) is where HI = 0.5: a reading reference.
  strokePath(page, [[X(0), Y(1)], [X(1), Y(0)]], { color: PALETTE.mute, width: 0.5, dash: [1.5, 2] });
  strokePath(page, pts, { color: PALETTE.water, width: 1.6, round: true });
  axes(page, p);

  for (const v of [0, 0.5, 1]) {
    const s = formatNumber(lang, v, v === 0.5 ? 1 : 0);
    tickLabel(page, s, X(v), p.y - TICK - 2, box.x, box.x + box.width, fonts);
    const w = widthOf(s, fonts.body, TICK, fonts);
    drawRuns(page, s, p.x - 3 - w, Y(v) - TICK / 2 + 0.5, { font: fonts.body, size: TICK, color: PALETTE.mute }, fonts);
  }
  axisTitles(page, box, p, t(lang, 'chart.hypso.x'), t(lang, 'chart.hypso.y'), fonts);

  // Integral label, top right of the plot on a paper knock-out.
  const label = t(lang, 'chart.hypso.integral', { value: formatNumber(lang, integral, 2) });
  const ls = fitSize(label, fonts.bodyBold, 11.9, p.w - 8, fonts);
  const lw = widthOf(label, fonts.bodyBold, ls, fonts);
  const lx = p.x + p.w - lw - 5;
  const ly = p.y + p.h - ls - 5;
  page.drawRectangle({ x: lx - 3, y: ly - 3, width: lw + 6, height: ls + 5, color: PALETTE.paper, opacity: 0.9 });
  drawRuns(page, label, lx, ly, { font: fonts.bodyBold, size: ls, color: PALETTE.water }, fonts);
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

// --- Channel profile ----------------------------------------------------------

/** Vertical exaggeration: the largest 1-2-5 factor at which the profile fits the plot. */
export function verticalExaggeration(lengthM: number, reliefM: number, plotW: number, plotH: number): number {
  if (!(lengthM > 0) || !(reliefM > 0)) return 1;
  const raw = (plotH / reliefM) / (plotW / lengthM);
  return Math.max(niceFloor(raw), 1e-3);
}

function veText(lang: ReportLanguage, ve: number): string {
  const digits = ve >= 1 ? 0 : decimalsFor(ve);
  return formatNumber(lang, ve, digits);
}

export function drawChannelProfile(page: PDFPage, box: Box, ch: MainChannel, lang: ReportLanguage, fonts: ReportFonts): void {
  const { distanceM, elevationM, interpolated } = ch.profile;
  const n = distanceM.length;
  let ok = n >= 2;
  let zMin = Infinity;
  let zMax = -Infinity;
  for (let i = 0; i < n && ok; i++) {
    const z = elevationM[i]!;
    if (!Number.isFinite(z) || !Number.isFinite(distanceM[i]!)) ok = false;
    else { zMin = Math.min(zMin, z); zMax = Math.max(zMax, z); }
  }
  const L = ok ? distanceM[n - 1]! - distanceM[0]! : 0;
  if (!ok || !(L > 0)) {
    const top = chartHeader(page, box, t(lang, 'figures.profile'), '', fonts);
    const reason = 'withheld' in ch.lengthM ? ch.lengthM.withheld : 'vertical-unresolved';
    withheldNote(page, box, top, t(lang, 'chart.withheld', { reason: withheldText(lang, reason) }), fonts);
    return;
  }

  // Lay out with a provisional header to know the plot height, then fix the factor.
  const padL = 44;
  const padB = 28;
  const plotW = box.width - padL - 8;
  const headerProbe = (factor: string) => {
    const caption = t(lang, 'figures.profileCaption', { factor });
    const lines = wrapText(caption, fonts.body, CAPTION, box.width, fonts).length;
    return TITLE + 3 + lines * (CAPTION + 1) + 6;
  };
  const relief = zMax - zMin;
  const plotH0 = box.height - headerProbe('10') - padB - 2;
  const ve = verticalExaggeration(L, relief, plotW, plotH0);
  const top = chartHeader(page, box, t(lang, 'figures.profile'), t(lang, 'figures.profileCaption', { factor: veText(lang, ve) }), fonts);
  const p: Plot = { x: box.x + padL, y: box.y + padB, w: plotW, h: top - box.y - padB - 2 };
  if (p.w <= 10 || p.h <= 10) return;
  const xs = p.w / L;
  const ys = xs * ve;
  const used = relief * ys;
  // Sit the profile low in the plot: the axis runs at most one height tick
  // below the lowest point, and spare height goes above the profile.
  const tick = (relief > 0 ? niceStep(relief, 4) : 1) * ys;
  const base = p.y + Math.max(0, Math.min((p.h - used) / 2, tick));
  const X = (d: number) => p.x + (d - distanceM[0]!) * xs;
  const Y = (z: number) => Math.min(p.y + p.h, base + (z - zMin) * ys);

  page.drawRectangle({ x: p.x, y: p.y, width: p.w, height: p.h, color: PALETTE.paper });
  const stepX = niceStep(L, 5);
  for (let d = stepX; d < L - stepX * 0.2; d += stepX) gridLine(page, X(distanceM[0]! + d), p.y, X(distanceM[0]! + d), p.y + p.h);

  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) pts.push([X(distanceM[i]!), Y(elevationM[i]!)]);
  fillPath(page, [[pts[0]![0], p.y], ...pts, [pts[n - 1]![0], p.y]], PALETTE.water2, 0.35);

  // Solid and dashed runs. A run of interpolated cells k..m is drawn from the
  // midpoint before k to the midpoint after m, so each run is its own path.
  const mid = (a: number, b: number): [number, number] => [(pts[a]![0] + pts[b]![0]) / 2, (pts[a]![1] + pts[b]![1]) / 2];
  let i = 0;
  while (i < n) {
    const flag = interpolated[i] === 1;
    let j = i;
    while (j + 1 < n && (interpolated[j + 1] === 1) === flag) j++;
    const run: [number, number][] = [];
    run.push(i > 0 ? mid(i - 1, i) : pts[i]!);
    for (let k = i; k <= j; k++) run.push(pts[k]!);
    run.push(j < n - 1 ? mid(j, j + 1) : pts[j]!);
    strokePath(page, run, { color: PALETTE.water, width: 1.8, ...(flag ? { dash: PROFILE_INTERPOLATED_DASH } : {}), round: !flag });
    i = j + 1;
  }

  // 10 % and 85 % of the length, measured upstream from the outlet.
  const at = (dFromDivide: number) => {
    let k = 0;
    while (k + 1 < n && distanceM[k + 1]! < dFromDivide) k++;
    const k1 = Math.min(n - 1, k + 1);
    const span = distanceM[k1]! - distanceM[k]!;
    const f = span > 0 ? (dFromDivide - distanceM[k]!) / span : 0;
    return elevationM[k]! + f * (elevationM[k1]! - elevationM[k]!);
  };
  const d10 = distanceM[0]! + 0.9 * L;
  const d85 = distanceM[0]! + 0.15 * L;
  for (const [d, s] of [[d85, '85 %'], [d10, '10 %']] as const) {
    page.drawLine({ start: { x: X(d), y: p.y }, end: { x: X(d), y: p.y + p.h }, thickness: 0.45, color: PALETTE.mute, dashArray: [1, 1.5] });
    const w = widthOf(s, fonts.body, TICK, fonts);
    const lx = Math.max(p.x + 1, Math.min(p.x + p.w - w - 1, X(d) + 2));
    drawRuns(page, s, lx, p.y + p.h - TICK - 2, { font: fonts.body, size: TICK, color: PALETTE.mute }, fonts);
  }
  if ('value' in ch.slope1085) {
    strokePath(page, [[X(d85), Y(at(d85))], [X(d10), Y(at(d10))]], { color: PALETTE.ink2, width: 0.8, dash: SLOPE_LINE_DASH });
  }

  // Reach slopes, labelled just under the line at mid-reach (the 10-85 chord
  // runs above a concave profile, so this side stays clear).
  for (const r of ch.reachSlopes) {
    const dm = distanceM[0]! + (r.fromM + r.toM) / 2;
    const s = `${formatNumber(lang, r.slope * 100, 1)}\u00a0%`;
    const w = widthOf(s, fonts.bodyBold, 9.8, fonts);
    const lx = Math.max(p.x + 2, Math.min(p.x + p.w - w - 2, X(dm) - w / 2));
    const ly = Math.max(p.y + 3, Math.min(p.y + p.h - 7 - TICK - 4, Y(at(dm)) - 12));
    page.drawRectangle({ x: lx - 1.5, y: ly - 2, width: w + 3, height: 9, color: PALETTE.paper, opacity: 0.85 });
    drawRuns(page, s, lx, ly, { font: fonts.bodyBold, size: 9.8, color: PALETTE.ink }, fonts);
  }

  // Key for the 10-85 chord, top right of the plot.
  if ('value' in ch.slope1085) {
    const s = `${t(lang, 'figures.slope1085')} ${formatNumber(lang, ch.slope1085.value * 100, 1)}\u00a0%`;
    const sz = fitSize(s, fonts.body, 9.8, p.w - 40, fonts);
    const w = widthOf(s, fonts.body, sz, fonts);
    const kx = p.x + p.w - w - 6;
    const ky = p.y + p.h - TICK - 14;
    page.drawRectangle({ x: kx - 20, y: ky - 3, width: w + 24, height: sz + 5, color: PALETTE.paper, opacity: 0.9 });
    page.drawLine({ start: { x: kx - 17, y: ky + sz * 0.35 }, end: { x: kx - 4, y: ky + sz * 0.35 }, thickness: 0.8, color: PALETTE.ink2, dashArray: SLOPE_LINE_DASH });
    drawRuns(page, s, kx, ky, { font: fonts.body, size: sz, color: PALETTE.ink2 }, fonts);
  }

  // Outlet ring at the downstream end.
  const [ox, oy] = pts[n - 1]!;
  page.drawCircle({ x: Math.min(ox, p.x + p.w - 3), y: oy, size: 3, borderColor: PALETTE.earth, borderWidth: 1.3, color: rgb(1, 1, 1) });
  axes(page, p);

  // Distance ticks along the bottom, heights at the left.
  const dec = decimalsFor(stepX);
  for (let d = 0; d <= L + 1e-9; d += stepX) {
    page.drawLine({ start: { x: X(distanceM[0]! + d), y: p.y }, end: { x: X(distanceM[0]! + d), y: p.y - 2 }, thickness: 0.5, color: PALETTE.ink });
    if (L - d < stepX * 0.45 && d > 0) continue;
    tickLabel(page, formatNumber(lang, d, dec), X(distanceM[0]! + d), p.y - TICK - 3, box.x, box.x + box.width, fonts);
  }
  tickLabel(page, formatNumber(lang, L, dec), X(distanceM[0]! + L), p.y - TICK - 3, box.x, box.x + box.width, fonts);
  const stepY = relief > 0 ? niceStep(relief, 4) : 1;
  const hDec = decimalsFor(stepY);
  for (let v = 0; v <= relief + 1e-9; v += stepY) {
    const z = zMin + v;
    const s = formatNumber(lang, z, hDec);
    const sz = fitSize(s, fonts.body, TICK, padL - 14, fonts);
    const w = widthOf(s, fonts.body, sz, fonts);
    page.drawLine({ start: { x: p.x, y: Y(z) }, end: { x: p.x - 2, y: Y(z) }, thickness: 0.5, color: PALETTE.ink });
    drawRuns(page, s, p.x - 3 - w, Y(z) - sz / 2 + 0.5, { font: fonts.body, size: sz, color: PALETTE.mute }, fonts);
  }
  axisTitles(page, box, p, t(lang, 'chart.profile.x'), t(lang, 'chart.profile.y'), fonts);
}
