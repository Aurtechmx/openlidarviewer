/**
 * primitives.ts: the sheet furniture every export sheet shares. Each helper
 * draws one part (section label, legend row, data block, scale bar, north
 * arrow, coordinate ticks, footer) on a pdf-lib page in page points, y up,
 * using a style's tokens and the sheet fonts.
 *
 * Helpers that stack return the y below what they drew, so a side panel can
 * be laid out top to bottom.
 */
import { degrees, rgb } from 'pdf-lib';
import type { PDFFont, PDFPage, RGB } from 'pdf-lib';
import { formatScaleTick, scaleBar } from '../../terrain/contour/mapSheetLayout';
import { drawableText, type SheetFonts } from './fonts';
import { SHEET_SPACE, SHEET_TYPE, type SheetRgb, type SheetTokens } from './tokens';

/** pdf-lib colour for a token colour. */
export function pdfColor(c: SheetRgb): RGB {
  return rgb(c[0], c[1], c[2]);
}

interface TextOpts {
  readonly font: PDFFont;
  readonly size: number;
  readonly color: SheetRgb;
}

/** Draws `s` at (x, y) with its left edge at x; returns its width. */
export function sheetText(page: PDFPage, s: string, x: number, y: number, o: TextOpts, fonts: SheetFonts): number {
  const t = drawableText(s, o.font, fonts);
  if (t.length === 0) return 0;
  page.drawText(t, { x, y, size: o.size, font: o.font, color: pdfColor(o.color) });
  return o.font.widthOfTextAtSize(t, o.size);
}

/** Draws `s` with its right edge at `right`. */
export function sheetTextRight(page: PDFPage, s: string, right: number, y: number, o: TextOpts, fonts: SheetFonts): void {
  const t = drawableText(s, o.font, fonts);
  if (t.length === 0) return;
  page.drawText(t, { x: right - o.font.widthOfTextAtSize(t, o.size), y, size: o.size, font: o.font, color: pdfColor(o.color) });
}

/** Width of `s` as it would be drawn. */
export function sheetTextWidth(s: string, font: PDFFont, size: number, fonts: SheetFonts): number {
  return font.widthOfTextAtSize(drawableText(s, font, fonts), size);
}

/** Splits `s` into lines no wider than `width`, breaking at spaces. A word longer than the line stays whole. */
export function wrapSheetText(s: string, font: PDFFont, size: number, width: number, fonts: SheetFonts): string[] {
  const out: string[] = [];
  for (const para of s.split('\n')) {
    let line = '';
    for (const word of para.split(' ').filter((w) => w.length > 0)) {
      const next = line ? `${line} ${word}` : word;
      if (line && sheetTextWidth(next, font, size, fonts) > width) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

/** A small upper-case section heading with a rule above it. Returns the y below it. */
export function drawSectionLabel(
  page: PDFPage, label: string, x: number, y: number, width: number, t: SheetTokens, f: SheetFonts, k = 1,
): number {
  page.drawLine({ start: { x, y }, end: { x: x + width, y }, thickness: t.weight.rule, color: pdfColor(t.rule) });
  const base = y - SHEET_SPACE.md * k;
  sheetText(page, label.toUpperCase(), x, base, { font: f.sansBold, size: SHEET_TYPE.section * k, color: t.dim }, f);
  return base - SHEET_SPACE.md * k;
}

/** Height {@link drawSectionLabel} uses at type scale `k`, to its returned y. */
export function sectionLabelHeight(k = 1): number {
  return 2 * SHEET_SPACE.md * k;
}

/** What a legend row's key shows. */
export type LegendKey =
  | { readonly kind: 'line'; readonly color: SheetRgb; readonly width: number; readonly dash?: readonly number[] }
  | { readonly kind: 'fill'; readonly color: SheetRgb; readonly border?: SheetRgb }
  | { readonly kind: 'hatch'; readonly color: SheetRgb; readonly background: SheetRgb }
  | { readonly kind: 'marker'; readonly color: SheetRgb; readonly shape: 'up' | 'down' | 'dot' };

const KEY_W = 26;

/** Row pitch of {@link drawLegendRow} at type scale `k`. */
export function legendRowHeight(k = 1): number {
  return SHEET_TYPE.legend * 1.8 * k;
}

/** One legend row: a key on the left, a label beside it. Returns the y of the next row. */
export function drawLegendRow(
  page: PDFPage, key: LegendKey, label: string, x: number, y: number, t: SheetTokens, f: SheetFonts, k = 1,
): number {
  const midY = y + SHEET_TYPE.legend * k * 0.32;
  switch (key.kind) {
    case 'line':
      page.drawLine({
        start: { x, y: midY }, end: { x: x + KEY_W, y: midY }, thickness: key.width, color: pdfColor(key.color),
        ...(key.dash ? { dashArray: [...key.dash] } : {}),
      });
      break;
    case 'fill':
      page.drawRectangle({
        x, y: midY - 4, width: KEY_W, height: 8, color: pdfColor(key.color),
        ...(key.border ? { borderColor: pdfColor(key.border), borderWidth: 0.5 } : {}),
      });
      break;
    case 'hatch':
      page.drawRectangle({ x, y: midY - 4, width: KEY_W, height: 8, color: pdfColor(key.background) });
      for (let hx = -8; hx < KEY_W; hx += 3) {
        const x0 = Math.max(0, hx), x1 = Math.min(KEY_W, hx + 8);
        if (x1 <= x0) continue;
        page.drawLine({
          start: { x: x + x0, y: midY - 4 + (x0 - hx) }, end: { x: x + x1, y: midY - 4 + (x1 - hx) },
          thickness: 0.4, color: pdfColor(key.color),
        });
      }
      break;
    case 'marker':
      drawMarker(page, key.shape, x + KEY_W / 2, midY, 3.2, key.color);
      break;
  }
  sheetText(page, label, x + KEY_W + 8, y, { font: f.sans, size: SHEET_TYPE.legend * k, color: t.ink }, f);
  return y - legendRowHeight(k);
}

/** A filled triangle (up or down) or dot centred on (cx, cy). */
export function drawMarker(page: PDFPage, shape: 'up' | 'down' | 'dot', cx: number, cy: number, r: number, color: SheetRgb): void {
  if (shape === 'dot') {
    page.drawCircle({ x: cx, y: cy, size: r, color: pdfColor(color) });
    return;
  }
  const s = shape === 'up' ? 1 : -1;
  // drawSvgPath flips y; draw about the origin and place with x/y.
  page.drawSvgPath(`M 0 ${-s * r} L ${r} ${s * r * 0.8} L ${-r} ${s * r * 0.8} Z`, { x: cx, y: cy, color: pdfColor(color) });
}

/** One row of a data block. */
export interface DataRow {
  readonly key: string;
  readonly value: string;
}

/**
 * Key and value rows: keys as small upper-case labels in the dim colour, so
 * they step back; values in Courier and ink, so the figures lead. A value too
 * wide for its column wraps onto further lines. Returns the y below the block.
 */
export function drawDataBlock(
  page: PDFPage, rows: readonly DataRow[], x: number, y: number, width: number, t: SheetTokens, f: SheetFonts,
  keyWidth = 64, k = 1,
): number {
  const step = SHEET_TYPE.dataValue * 1.5 * k;
  let cy = y;
  for (const r of rows) {
    sheetText(page, r.key.toUpperCase(), x, cy, { font: f.sansBold, size: SHEET_TYPE.dataKey * k, color: t.dim }, f);
    const lines = wrapSheetText(r.value, f.mono, SHEET_TYPE.dataValue * k, width - keyWidth * k, f);
    for (const ln of lines) {
      sheetText(page, ln, x + keyWidth * k, cy, { font: f.mono, size: SHEET_TYPE.dataValue * k, color: t.ink }, f);
      cy -= step;
    }
  }
  return cy;
}

/** Height {@link drawDataBlock} uses for `rows`, matching its returned y. */
export function dataBlockHeight(rows: readonly DataRow[], width: number, f: SheetFonts, keyWidth = 64, k = 1): number {
  let lines = 0;
  for (const r of rows) lines += wrapSheetText(r.value, f.mono, SHEET_TYPE.dataValue * k, width - keyWidth * k, f).length;
  return lines * SHEET_TYPE.dataValue * 1.5 * k;
}

export interface ScaleBarSpec {
  /** Page points per world (source CRS) unit. */
  readonly scalePtPerWorld: number;
  /** Longest the bar may be, points. */
  readonly maxBarPt: number;
  /**
   * The ground unit label and per-label divisor for the bar's total length.
   * Callers pass render/measure/scaleBar's `scaleBarUnit` bound to the map's
   * source linear unit, so a foot CRS reads ft and an unresolved one reads units.
   */
  readonly unitFor: (totalGround: number) => { readonly unit: string; readonly divisor: number };
}

/**
 * Alternating scale bar with tick values under it and the unit after the
 * last value. Draws nothing when the scale is unknown. Returns the y below it.
 */
export function drawScaleBar(page: PDFPage, spec: ScaleBarSpec, x: number, y: number, t: SheetTokens, f: SheetFonts): number {
  const bar = scaleBar(spec.scalePtPerWorld, spec.maxBarPt);
  if (!(bar.barPt > 0)) return y;
  const segPt = bar.barPt / bar.segments;
  const h = 5;
  for (let i = 0; i < bar.segments; i++) {
    page.drawRectangle({
      x: x + i * segPt, y: y - h, width: segPt, height: h,
      color: pdfColor(i % 2 === 0 ? t.ink : t.panel), borderColor: pdfColor(t.ink), borderWidth: 0.5,
    });
  }
  const { unit, divisor } = spec.unitFor(bar.totalGround);
  const ty = y - h - 9;
  const o = { font: f.mono, size: SHEET_TYPE.tick, color: t.ink };
  for (let i = 0; i <= bar.segments; i += 2) {
    const lbl = formatScaleTick((bar.segGround * i) / divisor);
    const w = sheetTextWidth(lbl, f.mono, o.size, f);
    sheetText(page, lbl, i === 0 ? x : x + i * segPt - w / 2, ty, o, f);
  }
  sheetText(page, unit, x + bar.barPt + 6, ty, { ...o, color: t.dim }, f);
  return ty - 6;
}

/** What the north arrow may claim. */
export type NorthSpec =
  /** Page up is the projected grid's +Y. */
  | { readonly kind: 'grid' }
  /**
   * True north, drawn `convergenceDeg` from page up: positive turns the arrow
   * clockwise (east of grid north), as the meridian convergence is signed.
   */
  | { readonly kind: 'true'; readonly convergenceDeg: number }
  /** A local frame with no known bearing. */
  | { readonly kind: 'local' };

/**
 * North arrow centred at (cx, cy), about 26 points tall, with its label above.
 * A true-north arrow also prints its angle from grid north; a local frame
 * says that north is unknown instead of drawing an arrow that implies it.
 */
export function drawNorthArrow(page: PDFPage, spec: NorthSpec, cx: number, cy: number, t: SheetTokens, f: SheetFonts): void {
  const label = { font: f.sansBold, size: SHEET_TYPE.legend, color: t.ink };
  if (spec.kind === 'local') {
    const o = { font: f.sans, size: SHEET_TYPE.note, color: t.dim };
    sheetTextCentred(page, 'Local grid up', cx, cy + 4, { ...label, color: t.dim }, f);
    sheetTextCentred(page, 'true north unknown', cx, cy - 6, o, f);
    return;
  }
  const angle = spec.kind === 'true' ? spec.convergenceDeg : 0;
  const a = (-angle * Math.PI) / 180;
  const rot = (px: number, py: number): [number, number] => [cx + px * Math.cos(a) - py * Math.sin(a), cy + px * Math.sin(a) + py * Math.cos(a)];
  const [tx, ty] = rot(0, 12);
  const [bx, by] = rot(0, -12);
  page.drawLine({ start: { x: bx, y: by }, end: { x: tx, y: ty }, thickness: 1.6, color: pdfColor(t.ink) });
  const [lx, ly] = rot(-5, 3), [rx, ry] = rot(5, 3), [hx, hy] = rot(0, 14);
  // drawSvgPath flips y about its origin; pass absolute points with y negated.
  page.drawSvgPath(`M ${hx} ${-hy} L ${lx} ${-ly} L ${rx} ${-ry} Z`, { x: 0, y: 0, color: pdfColor(t.ink) });
  const name = spec.kind === 'true' ? 'True N' : 'Grid N';
  sheetTextCentred(page, name, cx, cy + 20, label, f);
  if (spec.kind === 'true') {
    const side = angle >= 0 ? 'E' : 'W';
    const txt = `${Math.abs(angle).toFixed(2)}° ${side} of grid N`;
    sheetTextCentred(page, txt, cx, cy - 22, { font: f.mono, size: SHEET_TYPE.tick, color: t.dim }, f);
  }
}

/** Draws `s` centred on x. */
export function sheetTextCentred(page: PDFPage, s: string, cx: number, y: number, o: TextOpts, f: SheetFonts): void {
  const w = sheetTextWidth(s, o.font, o.size, f);
  sheetText(page, s, cx - w / 2, y, o, f);
}

/** A rectangle on the page, points. */
export interface SheetFrame {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A coordinate tick: its page position along the edge and its label. */
export interface CoordTick {
  readonly at: number;
  readonly label: string;
}

/**
 * Coordinate ticks around a map frame: short marks on the frame edge, eastings
 * under the bottom edge and northings beside the left edge, read bottom to
 * top. Optional `cross` draws small grid crosses inside the frame where the
 * ticks meet.
 */
export function drawCoordinateTicks(
  page: PDFPage, frame: SheetFrame, xs: readonly CoordTick[], ys: readonly CoordTick[], t: SheetTokens, f: SheetFonts,
  cross = true,
): void {
  const o = { font: f.mono, size: SHEET_TYPE.tick, color: t.dim };
  const ink = pdfColor(t.ink);
  const tick = 4;
  for (const c of xs) {
    if (c.at < frame.x || c.at > frame.x + frame.w) continue;
    page.drawLine({ start: { x: c.at, y: frame.y }, end: { x: c.at, y: frame.y + tick }, thickness: t.weight.frame, color: ink });
    page.drawLine({ start: { x: c.at, y: frame.y + frame.h }, end: { x: c.at, y: frame.y + frame.h - tick }, thickness: t.weight.frame, color: ink });
    sheetTextCentred(page, c.label, c.at, frame.y - 10, o, f);
  }
  for (const c of ys) {
    if (c.at < frame.y || c.at > frame.y + frame.h) continue;
    page.drawLine({ start: { x: frame.x, y: c.at }, end: { x: frame.x + tick, y: c.at }, thickness: t.weight.frame, color: ink });
    page.drawLine({ start: { x: frame.x + frame.w, y: c.at }, end: { x: frame.x + frame.w - tick, y: c.at }, thickness: t.weight.frame, color: ink });
    const txt = drawableText(c.label, f.mono, f);
    const w = f.mono.widthOfTextAtSize(txt, o.size);
    page.drawText(txt, { x: frame.x - 5, y: c.at - w / 2, size: o.size, font: f.mono, color: pdfColor(o.color), rotate: degrees(90) });
  }
  if (!cross) return;
  const arm = 3;
  for (const cxk of xs) {
    if (cxk.at <= frame.x + tick || cxk.at >= frame.x + frame.w - tick) continue;
    for (const cyk of ys) {
      if (cyk.at <= frame.y + tick || cyk.at >= frame.y + frame.h - tick) continue;
      page.drawLine({ start: { x: cxk.at - arm, y: cyk.at }, end: { x: cxk.at + arm, y: cyk.at }, thickness: 0.4, color: pdfColor(t.dim) });
      page.drawLine({ start: { x: cxk.at, y: cyk.at - arm }, end: { x: cxk.at, y: cyk.at + arm }, thickness: 0.4, color: pdfColor(t.dim) });
    }
  }
}

/** The sheet footer: a rule, left text and a right-aligned page label. */
export function drawFooter(
  page: PDFPage, left: string, pageLabel: string, x: number, right: number, y: number, t: SheetTokens, f: SheetFonts,
): void {
  page.drawLine({ start: { x, y: y + 12 }, end: { x: right, y: y + 12 }, thickness: t.weight.rule, color: pdfColor(t.rule) });
  const o = { font: f.sans, size: SHEET_TYPE.footer, color: t.dim };
  sheetText(page, left, x, y, o, f);
  if (pageLabel) sheetTextRight(page, pageLabel, right, y, { ...o, font: f.mono }, f);
}

/** Fills the page with the style's paper colour. Call first, before anything else is drawn. */
export function drawPaper(page: PDFPage, t: SheetTokens): void {
  const { width, height } = page.getSize();
  page.drawRectangle({ x: 0, y: 0, width, height, color: pdfColor(t.paper) });
}
