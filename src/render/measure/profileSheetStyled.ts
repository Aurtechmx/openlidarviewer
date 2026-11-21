/**
 * profileSheetStyled.ts: sheet one of the profile drawing set in the Light
 * and Dark styles.
 *
 * Left, top to bottom: a plan strip along the line (when a terrain run gives
 * a surface to draw it from), the section with the corridor's returns under
 * the ground line, the station band, and a grade chart. All four share one
 * chainage axis. Right: the side panel with the headline figures, legend,
 * data block and the sheet's notes.
 *
 * The figures and notes are worked out by profilePdf.ts and handed in, so the
 * styled sheet states exactly what the Classic sheet states. This module only
 * draws. The page size and the notes, method and schedule sheets that follow
 * are profilePdf.ts's.
 */
import { rgb, type PDFDocument, type PDFPage, type RGB } from 'pdf-lib';
import { encodePng } from '../../export/sheetKit/png';
import { stripSheetRaster, type SheetReliefInput } from '../../export/sheetKit/contourSheetModel';
import type { SheetFonts } from '../../export/sheetKit/fonts';
import {
  drawDataBlock,
  drawLegendRow,
  drawMarker,
  drawPaper,
  drawSectionLabel,
  legendRowHeight,
  clipPolyline,
  pdfColor,
  sheetText,
  sheetTextRight,
  sheetTextWidth,
  wrapSheetText,
  type DataRow,
  type LegendKey,
} from '../../export/sheetKit/primitives';
import { SHEET_SPACE, SHEET_TYPE, type SheetRgb, type SheetTokens } from '../../export/sheetKit/tokens';
import type { ContourFeatureModel } from '../../terrain/contour/contourFeatureModel';
import type { ProfileChartSample } from './types';
import {
  buildRoundChainageBand,
  chooseProfileScales,
  interpolateStationHeight,
  verticalScaleStatement,
  formatScaleDenominator,
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
  /** The analysed contours, drawn over the relief. */
  readonly contours?: ContourFeatureModel | null;
}

/** Inputs a styled profile sheet can draw beyond the sampled ground line. */
export interface ProfileSheetExtras {
  readonly returns?: ProfileSheetReturns | null;
  readonly plan?: ProfileSheetPlan | null;
  /** Index contour heights (metres, the samples' frame), for the crossing marks. */
  readonly indexLevels?: readonly number[] | null;
}

/** Everything the styled sheet one is drawn from. Worked out by profilePdf.ts. */
export interface StyledProfileSheet {
  readonly doc: PDFDocument;
  readonly tokens: SheetTokens;
  readonly fonts: SheetFonts;
  readonly title: string;
  readonly subtitle: string;
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
  /** Four headline figures, label and value. */
  readonly kpis: ReadonlyArray<readonly [string, string]>;
  readonly data: readonly DataRow[];
  /** The sheet's notes, every one of them, in order. */
  readonly notes: readonly string[];
  readonly groundLineLabel: string;
  /** Ground-return count per metre at each station, when recorded. */
  readonly countsPerStation: ReadonlyArray<number | null>;
  /** Why the plan strip is missing, printed in its place. Null when it is drawn. */
  readonly planMissingNote: string | null;
  readonly extras: ProfileSheetExtras | null;
}

// The sheet kit parts profilePdf.ts's styled build uses, reached through this module.
export { sheetTokens, type SheetStyle } from '../../export/sheetKit/tokens';
export { embedSheetFonts } from '../../export/sheetKit/fonts';
export { drawFooter, drawPaper } from '../../export/sheetKit/primitives';

const M = 36;
const GRADE_BASE_M = 10;

/** Draw sheet one. The page footer is stamped by the caller once the page count is known. */
export async function drawStyledProfileSheet(page: PDFPage, s: StyledProfileSheet): Promise<void> {
  const t = s.tokens, f = s.fonts;
  const PW = page.getWidth(), PH = page.getHeight();
  drawPaper(page, t);
  const panelW = 300;
  const panelX = PW - M - panelW;
  const left = M + 52;
  const right = panelX - 30;
  const plotW = right - left;
  const top = PH - M - 10;
  const bottom = M + 26;
  const hasPlan = s.extras?.plan != null;
  const planH = hasPlan ? 150 : 22;
  const bandRowH = 16;
  const bandRows = 4;
  const gradeH = 82;
  const gapV = 26;
  const sectionTop = top - planH - gapV - 14;
  const gradeBottom = bottom;
  const gradeTop = gradeBottom + gradeH;
  const bandBottom = gradeTop + gapV + 6;
  const bandTop = bandBottom + bandRows * bandRowH;
  const sectionBottom = bandTop + 4;
  const sectionH = sectionTop - sectionBottom;

  const len = s.lengthM;
  // The same guard as the Classic sheet: a corrupt sample can make the length or
  // the relief non-finite, and nothing below may loop or scale on one.
  const drawable = Number.isFinite(len) && len > 0 && s.minM != null && s.maxM != null
    && Number.isFinite(s.minM) && Number.isFinite(s.maxM);
  const scales = drawable
    ? chooseProfileScales({ lengthM: len, minM: s.minM!, maxM: s.maxM!, plotWpt: plotW, plotHpt: sectionH, k: s.k, requestedExaggeration: s.requestedExaggeration })
    : null;
  const drawW = scales?.drawnWpt ?? plotW;
  const mapX = (c: number): number => left + (len > 0 ? (c / len) * drawW : 0);
  const mapY = (h: number): number =>
    scales ? sectionBottom + ((h - scales.axisLoM) / (scales.axisHiM - scales.axisLoM)) * sectionH : sectionBottom;
  const ink = pdfColor(t.ink), dim = pdfColor(t.dim), rule = pdfColor(t.rule);

  // ── plan strip ───────────────────────────────────────────────────────────
  const planBottom = top - planH;
  if (hasPlan && len > 0) {
    sheetText(page, 'PLAN', left, top + 4, { font: f.sansBold, size: SHEET_TYPE.section, color: t.dim }, f);
    await drawPlanStrip(page, s, { x: left, y: planBottom, w: drawW, h: planH }, len);
  } else {
    sheetText(page, `PLAN  ${s.planMissingNote ?? ''}`.trim(), left, top - 8, { font: f.sansBold, size: SHEET_TYPE.section, color: t.dim }, f);
  }

  // ── section ──────────────────────────────────────────────────────────────
  const heightHead = `${s.heightWord.toUpperCase()} (${s.unit})`;
  sheetText(page, `SECTION  ${heightHead} against chainage (${s.unit})`, left + 12, sectionTop + 6, { font: f.sansBold, size: SHEET_TYPE.section, color: t.dim }, f);
  page.drawRectangle({ x: left, y: sectionBottom, width: drawW, height: sectionH, color: pdfColor(t.panel) });
  if (scales) {
    // Height grid and ticks.
    for (let n = 0, eD = scales.firstTick; eD <= scales.axisHiM * s.k + 1e-9 && n < 64; n++, eD = scales.firstTick + n * scales.tickStep) {
      const y = mapY(eD / s.k);
      page.drawLine({ start: { x: left, y }, end: { x: left + drawW, y }, thickness: 0.4, color: rule, opacity: 0.6 });
      sheetTextRight(page, eD.toFixed(scales.tickStep < 0.1 ? 2 : 1), left - 5, y - 2, { font: f.mono, size: SHEET_TYPE.tick, color: t.dim }, f);
    }
    // The returns, as a raster under the ground line.
    const rets = s.extras?.returns;
    if (rets && rets.count > 0) await drawReturns(page, s, rets, { x: left, y: sectionBottom, w: drawW, h: sectionH }, mapX, mapY);
    // Fill under the ground line, then the line itself, broken over gaps.
    const runs: Array<Array<[number, number]>> = [];
    let cur: Array<[number, number]> = [];
    for (const st of s.stations) {
      if (st.elevation == null) { if (cur.length) runs.push(cur); cur = []; continue; }
      cur.push([mapX(st.chainage), mapY(st.elevation)]);
    }
    if (cur.length) runs.push(cur);
    const tint = t.tint.length ? t.tint[Math.floor(t.tint.length / 2)]! : t.rule;
    for (const run of runs) {
      if (run.length < 2) continue;
      let d = `M${run[0]![0].toFixed(2)} ${(PH - sectionBottom).toFixed(2)} `;
      for (const [x, y] of run) d += `L${x.toFixed(2)} ${(PH - y).toFixed(2)} `;
      d += `L${run[run.length - 1]![0].toFixed(2)} ${(PH - sectionBottom).toFixed(2)} Z`;
      page.drawSvgPath(d, { x: 0, y: PH, color: pdfColor(tint), opacity: Math.max(0.25, t.tintAlpha) });
    }
    // Gaps: a dashed link across each one, so the break is visible and stated.
    for (let i = 1; i < runs.length; i++) {
      const a = runs[i - 1]![runs[i - 1]!.length - 1]!, b = runs[i]![0]!;
      page.drawLine({ start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] }, thickness: 0.8, color: pdfColor(t.index), dashArray: [3, 2], opacity: 0.9 });
    }
    for (const run of runs) {
      if (run.length < 2) continue;
      let d = '';
      run.forEach(([x, y], i) => { d += `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${(PH - y).toFixed(2)} `; });
      page.drawSvgPath(d, { x: 0, y: PH, borderColor: pdfColor(t.index), borderWidth: 1.4 });
    }
    // Index contour crossings on the ground line.
    for (const c of indexCrossings(s.stations, s.extras?.indexLevels ?? [])) {
      page.drawCircle({ x: mapX(c.chainage), y: mapY(c.height), size: 2.2, color: pdfColor(t.panel), borderColor: pdfColor(t.index), borderWidth: 0.8 });
    }
    // Highest and lowest ground.
    const known = s.stations.filter((st) => st.elevation != null) as Array<{ chainage: number; elevation: number }>;
    if (known.length) {
      const hi = known.reduce((a, b) => (b.elevation > a.elevation ? b : a), known[0]!);
      const lo = known.reduce((a, b) => (b.elevation < a.elevation ? b : a), known[0]!);
      for (const [p, shape] of [[hi, 'up'], [lo, 'down']] as const) {
        drawMarker(page, shape, mapX(p.chainage), mapY(p.elevation) + (shape === 'up' ? 6 : -6), 3, t.ink);
        const lbl = (p.elevation * s.k).toFixed(1);
        const w = sheetTextWidth(lbl, f.mono, SHEET_TYPE.tick, f);
        const lx = Math.min(left + drawW - w - 2, Math.max(left + 2, mapX(p.chainage) + 6));
        sheetText(page, lbl, lx, mapY(p.elevation) + (shape === 'up' ? 9 : -14), { font: f.mono, size: SHEET_TYPE.tick, color: t.ink }, f);
      }
    }
    // Scale statement, in the top-right corner of the section.
    // The ratios a reader scales off the paper, then the stretch and the print size, as Classic states them.
    const ratios = s.scaleRatios ? s.scaleRatios(scales.horizontal, scales.vertical) : null;
    const stretch = [ratios, verticalScaleStatement(scales.exaggeration), 'print at 100% on A3'].filter(Boolean).join('  ·  ');
    const sw = sheetTextWidth(stretch, f.mono, SHEET_TYPE.tick, f);
    page.drawRectangle({ x: left + drawW - sw - 10, y: sectionBottom + sectionH - 16, width: sw + 8, height: 12, color: pdfColor(t.panel), borderColor: pdfColor(t.accent), borderWidth: 0.6 });
    sheetText(page, stretch, left + drawW - sw - 6, sectionBottom + sectionH - 12.5, { font: f.mono, size: SHEET_TYPE.tick, color: t.accent }, f);
    // A and B.
    sheetText(page, 'A', left - 2, sectionTop + 6, { font: f.sansBold, size: SHEET_TYPE.legend, color: t.accent }, f);
    sheetTextRight(page, 'B', left + drawW + 2, sectionTop + 6, { font: f.sansBold, size: SHEET_TYPE.legend, color: t.accent }, f);
  } else {
    sheetText(page, 'No ground line to draw: the profile has no sampled heights.', left + 10, sectionBottom + sectionH / 2, { font: f.sans, size: 10, color: t.dim }, f);
  }
  page.drawRectangle({ x: left, y: sectionBottom, width: drawW, height: sectionH, borderColor: pdfColor(t.outline), borderWidth: t.weight.frame });

  // ── station band ─────────────────────────────────────────────────────────
  if (scales) {
    const stationsIn = s.stations.map((st) => ({ chainage: st.chainage, height: st.elevation }));
    const colW = Math.max(sheetTextWidth(s.formatStation(len), f.mono, SHEET_TYPE.tick, f), sheetTextWidth('0000.00', f.mono, SHEET_TYPE.tick, f)) + 10;
    const band = buildRoundChainageBand({ stations: stationsIn, lengthM: len, k: s.k, mapX, columnWpt: colW });
    const rowsY = [bandTop - bandRowH, bandTop - 2 * bandRowH, bandTop - 3 * bandRowH, bandTop - 4 * bandRowH];
    const heads = ['CHAINAGE', `${s.heightWord.toUpperCase()} ${s.unit}`, 'GRADE %', 'GROUND RETURNS'];
    page.drawRectangle({ x: left, y: bandBottom, width: drawW, height: bandTop - bandBottom, color: pdfColor(t.panel), borderColor: pdfColor(t.outline), borderWidth: t.weight.frame });
    for (let r = 1; r < 4; r++) page.drawLine({ start: { x: left, y: rowsY[r - 1]! }, end: { x: left + drawW, y: rowsY[r - 1]! }, thickness: 0.4, color: rule });
    heads.forEach((h, r) => sheetTextRight(page, h, left - 5, rowsY[r]! + 5, { font: f.mono, size: SHEET_TYPE.dataKey, color: t.dim }, f));
    const o = { font: f.mono, size: SHEET_TYPE.tick, color: t.ink };
    band.columns.forEach((c, i) => {
      const x = Math.min(left + drawW - 2, c.x + 2);
      const right2 = x + colW > left + drawW;
      const put = (txt: string, row: number, color: SheetRgb = t.ink): void => {
        if (right2) sheetTextRight(page, txt, left + drawW - 3, rowsY[row]! + 5, { ...o, color }, f);
        else sheetText(page, txt, x, rowsY[row]! + 5, { ...o, color }, f);
      };
      put(s.formatStation(c.chainage), 0);
      put(c.height == null ? '-' : (c.height * s.k).toFixed(2), 1);
      const next = band.columns[i + 1];
      if (next && c.height != null && next.height != null && next.chainage > c.chainage) {
        const g = (100 * (next.height - c.height)) / (next.chainage - c.chainage);
        const gx = (c.x + next.x) / 2 - sheetTextWidth(g.toFixed(1), f.mono, SHEET_TYPE.tick, f) / 2;
        sheetText(page, g.toFixed(1), gx, rowsY[2]! + 5, { ...o, color: Math.abs(g) >= 30 ? t.warn : t.ink }, f);
      }
      if (i > 0) page.drawLine({ start: { x: c.x, y: rowsY[2]! }, end: { x: c.x, y: rowsY[2]! + bandRowH }, thickness: 0.4, color: rule });
    });
    // Ground returns per metre, as a bar per station.
    const counts = s.countsPerStation;
    const peak = Math.max(0, ...counts.map((c) => c ?? 0));
    if (peak > 0) {
      const barMax = bandRowH - 4;
      for (let i = 0; i < s.stations.length - 1; i++) {
        const c = counts[i];
        if (c == null || c <= 0) continue;
        const x0 = mapX(s.stations[i]!.chainage), x1 = mapX(s.stations[i + 1]!.chainage);
        page.drawRectangle({ x: x0, y: rowsY[3]! + 2, width: Math.max(0.3, x1 - x0 - 0.3), height: (c / peak) * barMax, color: dim, opacity: 0.6 });
      }
      // Under the band, clear of the bars it describes.
      sheetTextRight(page, `ground returns per m, tallest bar ${peak.toFixed(0)}`, left + drawW, bandBottom - 10, { font: f.mono, size: SHEET_TYPE.tick, color: t.dim }, f);
    }
  }

  // ── grade chart ──────────────────────────────────────────────────────────
  const gradeBase = s.unitsVerified === false
    ? `${GRADE_BASE_M} units of chainage (unit unverified)`
    : `${GRADE_BASE_M} ${s.unit === 'ft' ? 'm of chainage (shown in feet)' : 'm of chainage'}`;
  sheetText(page, `GRADE %  over ${gradeBase}`, left, gradeTop + 6, { font: f.sansBold, size: SHEET_TYPE.section, color: t.dim }, f);
  page.drawRectangle({ x: left, y: gradeBottom, width: drawW, height: gradeH, color: pdfColor(t.panel) });
  const grades = gradeSeries(s.stations, len);
  const known = grades.filter((g) => g.grade != null && Number.isFinite(g.grade)) as Array<{ chainage: number; grade: number }>;
  if (known.length > 1) {
    const gMax = Math.max(5, ...known.map((g) => Math.abs(g.grade)));
    const step = niceGradeStep(gMax);
    const lim = Math.ceil(gMax / step) * step;
    const gy = (g: number): number => gradeBottom + ((g + lim) / (2 * lim)) * gradeH;
    for (let v = -lim; v <= lim + 1e-9; v += step) {
      page.drawLine({ start: { x: left, y: gy(v) }, end: { x: left + drawW, y: gy(v) }, thickness: v === 0 ? 0.8 : 0.4, color: v === 0 ? ink : rule, opacity: v === 0 ? 0.7 : 0.6 });
      sheetTextRight(page, v.toFixed(0), left - 5, gy(v) - 2, { font: f.mono, size: SHEET_TYPE.tick, color: t.dim }, f);
    }
    let run: Array<[number, number]> = [];
    const flush = (): void => {
      if (run.length < 2) { run = []; return; }
      let d = `M${run[0]![0].toFixed(2)} ${(PH - gy(0)).toFixed(2)} `;
      for (const [x, y] of run) d += `L${x.toFixed(2)} ${(PH - y).toFixed(2)} `;
      d += `L${run[run.length - 1]![0].toFixed(2)} ${(PH - gy(0)).toFixed(2)} Z`;
      page.drawSvgPath(d, { x: 0, y: PH, color: pdfColor(t.index), opacity: 0.18 });
      let l = '';
      run.forEach(([x, y], i) => { l += `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${(PH - y).toFixed(2)} `; });
      page.drawSvgPath(l, { x: 0, y: PH, borderColor: pdfColor(t.index), borderWidth: 0.9 });
      run = [];
    };
    for (const g of grades) {
      if (g.grade == null) { flush(); continue; }
      run.push([mapX(g.chainage), gy(Math.max(-lim, Math.min(lim, g.grade)))]);
    }
    flush();
  }
  page.drawRectangle({ x: left, y: gradeBottom, width: drawW, height: gradeH, borderColor: pdfColor(t.outline), borderWidth: t.weight.frame });
  // Chainage ticks under the grade chart.
  if (scales) {
    const step = niceGradeStep(len * s.k / 6);
    // At most a few dozen ticks whatever the step, so a degenerate step cannot spin.
    for (let v = 0, n = 0; v <= len * s.k + 1e-9 && n < MAX_TICKS && step > 0 && Number.isFinite(step); v += step, n++) {
      const x = mapX(v / s.k);
      page.drawLine({ start: { x, y: gradeBottom }, end: { x, y: gradeBottom - 3 }, thickness: 0.5, color: ink });
      const lbl = v.toFixed(step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step) - 1e-9)));
      sheetText(page, lbl, x - sheetTextWidth(lbl, f.mono, SHEET_TYPE.tick, f) / 2, gradeBottom - 11, { font: f.mono, size: SHEET_TYPE.tick, color: t.dim }, f);
    }
  }

  // ── side panel ───────────────────────────────────────────────────────────
  drawProfilePanel(page, s, { x: panelX, y: bottom, w: panelW, h: top - bottom + 10 }, hasPlan);

}

function drawProfilePanel(page: PDFPage, s: StyledProfileSheet, box: { x: number; y: number; w: number; h: number }, hasPlan: boolean): void {
  const t = s.tokens, f = s.fonts;
  const x = box.x, w = box.w;
  let y = box.y + box.h;
  y -= SHEET_TYPE.kicker;
  sheetText(page, 'PROFILE', x, y, { font: f.sansBold, size: SHEET_TYPE.kicker, color: t.accent }, f);
  y -= 6;
  let tsz = SHEET_TYPE.title;
  while (tsz > 11 && sheetTextWidth(s.title, f.sansBold, tsz, f) > w) tsz -= 0.5;
  for (const ln of wrapSheetText(s.title, f.sansBold, tsz, w, f).slice(0, 2)) {
    y -= tsz;
    sheetText(page, ln, x, y, { font: f.sansBold, size: tsz, color: t.ink }, f);
    y -= tsz * 0.15;
  }
  for (const ln of wrapSheetText(s.subtitle, f.sans, SHEET_TYPE.subtitle, w, f)) {
    y -= SHEET_TYPE.subtitle * 1.4;
    sheetText(page, ln, x, y, { font: f.sans, size: SHEET_TYPE.subtitle, color: t.dim }, f);
  }
  y -= 10;
  page.drawLine({ start: { x, y }, end: { x: x + w, y }, thickness: t.weight.rule, color: pdfColor(t.rule) });
  // Headline figures, two by two.
  const colW = w / 2;
  // Headline figures: a small dim label, then the figure at display size, the
  // largest type in the panel after the title.
  const rowH = SHEET_SPACE.md + SHEET_TYPE.figure + SHEET_SPACE.lg;
  s.kpis.forEach(([label, value], i) => {
    const cx = x + (i % 2) * colW;
    const cy = y - SHEET_SPACE.lg - Math.floor(i / 2) * rowH;
    sheetText(page, label.toUpperCase(), cx, cy, { font: f.sansBold, size: SHEET_TYPE.dataKey, color: t.dim }, f);
    let vs: number = SHEET_TYPE.figure;
    while (vs > 11 && sheetTextWidth(value, f.sansBold, vs, f) > colW - 8) vs -= 0.5;
    sheetText(page, value, cx, cy - SHEET_SPACE.xs - vs, { font: f.sansBold, size: vs, color: t.ink }, f);
  });
  y -= SHEET_SPACE.lg + Math.ceil(s.kpis.length / 2) * rowH - SHEET_SPACE.sm;
  // Legend.
  const legend: Array<[LegendKey, string]> = [
    [{ kind: 'line', color: t.index, width: 1.4 }, s.groundLineLabel],
    [{ kind: 'line', color: t.index, width: 0.8, dash: [3, 2] }, 'Across a gap in ground returns'],
  ];
  if (s.extras?.returns?.ground) {
    legend.push([{ kind: 'marker', color: t.ink, shape: 'dot' }, 'Ground returns']);
    legend.push([{ kind: 'marker', color: t.minor, shape: 'dot' }, 'Other returns']);
  } else if (s.extras?.returns) {
    legend.push([{ kind: 'marker', color: t.minor, shape: 'dot' }, 'Returns in the corridor']);
  }
  if ((s.extras?.indexLevels?.length ?? 0) > 0) legend.push([{ kind: 'marker', color: t.index, shape: 'dot' }, 'Crosses an index contour']);
  if (hasPlan) legend.push([{ kind: 'line', color: t.accent, width: 1.2 }, 'Profile line and corridor (plan)']);
  legend.push([{ kind: 'marker', color: t.ink, shape: 'up' }, 'Highest ground']);
  legend.push([{ kind: 'marker', color: t.ink, shape: 'down' }, 'Lowest ground']);
  y = drawSectionLabel(page, 'Legend', x, y, w, t, f);
  for (const [key, label] of legend) y = drawLegendRow(page, key, label, x, y, t, f);
  y += legendRowHeight() - 6;
  // Data.
  y = drawSectionLabel(page, 'Data', x, y - 4, w, t, f);
  y = drawDataBlock(page, s.data, x, y, w, t, f, 74, 0.95);
  // Notes: every line, smaller if it must be. Past the smallest size, the
  // notes that fit are printed whole and the rest are left to the next sheet,
  // which carries every general note.
  y = drawSectionLabel(page, 'Notes', x, y + 4, w, t, f);
  const room = y - (box.y + 4);
  let nsz = SHEET_TYPE.note;
  const linesAt = (sz: number): string[][] => s.notes.map((n, i) => wrapSheetText(`${i + 1}. ${n}`, f.sans, sz, w, f));
  let wrapped = linesAt(nsz);
  const heightAt = (ls: string[][], sz: number): number => ls.reduce((a, l) => a + l.length, 0) * sz * 1.32 + ls.length * 2;
  while (nsz > 5 && heightAt(wrapped, nsz) > room) { nsz -= 0.25; wrapped = linesAt(nsz); }
  wrapped = notesForRoom(wrapped, room, (ls) => heightAt(ls, nsz));
  y += nsz;
  for (const note of wrapped) {
    for (const ln of note) {
      y -= nsz * 1.32;
      sheetText(page, ln, x, y, { font: f.sans, size: nsz, color: t.dim }, f);
    }
    y -= 2;
  }
}

/**
 * The wrapped notes that fit `room`, whole. When some do not, the last line
 * says which notes continue on the next sheet, which carries them all.
 */
export function notesForRoom(wrapped: string[][], room: number, height: (ls: string[][]) => number): string[][] {
  if (height(wrapped) <= room) return wrapped;
  const all = wrapped.length;
  const tail = (n: number): string => (n + 1 === all ? `Note ${all} continues on the next sheet.` : `Notes ${n + 1} to ${all} continue on the next sheet.`);
  let fit = all - 1;
  while (fit > 0 && height([...wrapped.slice(0, fit), [tail(fit)]]) > room) fit--;
  return [...wrapped.slice(0, fit), [tail(fit)]];
}

/** Grade over {@link GRADE_BASE_M} ahead of each station; null where a gap breaks it. */
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

/** Where the ground line crosses each index contour height. */
export function indexCrossings(
  stations: ReadonlyArray<{ readonly chainage: number; readonly elevation: number | null }>,
  levels: readonly number[],
): Array<{ chainage: number; height: number }> {
  const out: Array<{ chainage: number; height: number }> = [];
  for (let i = 1; i < stations.length; i++) {
    const a = stations[i - 1]!, b = stations[i]!;
    if (a.elevation == null || b.elevation == null) continue;
    for (const lv of levels) {
      const lo = Math.min(a.elevation, b.elevation), hi = Math.max(a.elevation, b.elevation);
      if (lv < lo || lv >= hi || hi === lo) continue;
      const u = (lv - a.elevation) / (b.elevation - a.elevation);
      out.push({ chainage: a.chainage + u * (b.chainage - a.chainage), height: lv });
    }
  }
  return out.sort((p, q) => p.chainage - q.chainage);
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

/** Most ticks one axis draws. */
const MAX_TICKS = 40;

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
  // Two pixels a point keeps returns as dots at print size without an
  // oversized image.
  const W = Math.max(1, Math.min(2000, Math.round(box.w * 2)));
  const H = Math.max(1, Math.min(2000, Math.round(box.h * 2)));
  const rgba = new Uint8Array(W * H * 4);
  const groundC = toBytes(s.tokens.ink), otherC = toBytes(s.tokens.minor);
  const sx = W / box.w, sy = H / box.h;
  for (let i = 0; i < r.count; i++) {
    const c = r.chainageM[i]!, h = r.heightM[i]!;
    if (!Number.isFinite(c) || !Number.isFinite(h)) continue;
    const px = Math.floor((mapX(c) - box.x) * sx), py = Math.floor((box.y + box.h - mapY(h)) * sy);
    if (px < 0 || py < 0 || px >= W || py >= H) continue;
    const col = r.ground && r.ground[i] ? groundC : otherC;
    const o = (py * W + px) * 4;
    rgba[o] = col[0]; rgba[o + 1] = col[1]; rgba[o + 2] = col[2];
    rgba[o + 3] = Math.min(255, rgba[o + 3]! + 150);
  }
  const png = await s.doc.embedPng(await encodePng(rgba, W, H));
  page.drawImage(png, { x: box.x, y: box.y, width: box.w, height: box.h });
}

function toBytes(c: SheetRgb): [number, number, number] {
  return [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255)];
}

async function drawPlanStrip(page: PDFPage, s: StyledProfileSheet, box: { x: number; y: number; w: number; h: number }, lengthM: number): Promise<void> {
  const plan = s.extras!.plan!;
  const t = s.tokens, f = s.fonts;
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
  page.drawRectangle({ x: box.x, y: box.y, width: box.w, height: box.h, color: pdfColor(t.panel) });
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
      let d = '';
      seg.forEach(([x, y], i) => { d += `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${(PH - y).toFixed(2)} `; });
      page.drawSvgPath(d, { x: 0, y: PH, borderColor: pdfColor(feat.isIndex ? t.index : t.minor), borderWidth: feat.isIndex ? t.weight.index * 0.8 : t.weight.minor, borderOpacity: 0.9 });
    }
  }
  // The line, its ends and its stations.
  const midY = box.y + box.h / 2;
  page.drawLine({ start: { x: box.x, y: midY }, end: { x: box.x + box.w, y: midY }, thickness: 2.2, color: pdfColor(t.halo), opacity: 0.8 });
  page.drawLine({ start: { x: box.x, y: midY }, end: { x: box.x + box.w, y: midY }, thickness: 1.2, color: pdfColor(t.accent) });
  for (const [px, label] of [[box.x, 'A'], [box.x + box.w, 'B']] as const) {
    page.drawCircle({ x: px, y: midY, size: 5, color: pdfColor(t.panel), borderColor: pdfColor(t.accent), borderWidth: 1 });
    const w = sheetTextWidth(label, f.sansBold, 6.5, f);
    sheetText(page, label, px - w / 2, midY - 2.3, { font: f.sansBold, size: 6.5, color: t.accent }, f);
  }
  // North: the grid's +Y direction in strip coordinates.
  const nU = dir[1], nV = perp[1];
  const ang = Math.atan2(nV, nU);
  const cx = box.x + box.w - 18, cy = box.y + box.h - 22;
  const ex = cx + Math.cos(ang) * 12, ey = cy + Math.sin(ang) * 12;
  page.drawLine({ start: { x: cx - Math.cos(ang) * 8, y: cy - Math.sin(ang) * 8 }, end: { x: ex, y: ey }, thickness: 1.4, color: pdfColor(t.ink) });
  page.drawSvgPath(`M ${ex} ${-ey} L ${ex - Math.cos(ang - 0.45) * 5} ${-(ey - Math.sin(ang - 0.45) * 5)} L ${ex - Math.cos(ang + 0.45) * 5} ${-(ey - Math.sin(ang + 0.45) * 5)} Z`, { x: 0, y: 0, color: pdfColor(t.ink) });
  sheetTextRight(page, 'Grid N', cx - 10, cy - 2, { font: f.sansBold, size: 6, color: t.ink }, f);
  page.drawRectangle({ x: box.x, y: box.y, width: box.w, height: box.h, borderColor: pdfColor(t.outline), borderWidth: t.weight.frame });
}

/** The profile drawing set's colours, as profilePdf.ts names them. */
export interface ProfileInk {
  readonly INK: RGB; readonly INK_DIM: RGB; readonly INK_SOFT: RGB; readonly INK_MUTED: RGB; readonly GRID: RGB;
  readonly GRID_MINOR: RGB; readonly CURVE: RGB; readonly GROUND: RGB; readonly GAP_MARK: RGB; readonly RULE: RGB;
}

/** The notes, method and schedule sheets' colours in a style's tokens. */
export function profileInkFor(t: SheetTokens): ProfileInk {
  const c = (v: readonly [number, number, number]): RGB => rgb(v[0], v[1], v[2]);
  const mid = t.tint.length ? t.tint[Math.floor(t.tint.length / 2)]! : t.rule;
  // Secondary text stays close to the ink so a remark set at table size reads on either paper.
  const mix = (a: SheetRgb, b: SheetRgb, k: number): RGB => rgb(a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k);
  return {
    INK: c(t.ink), INK_DIM: c(t.dim), INK_SOFT: mix(t.ink, t.dim, 0.35), INK_MUTED: c(t.dim), GRID: c(t.rule),
    GRID_MINOR: c(t.rule), CURVE: c(t.index), GROUND: c(mid), GAP_MARK: c(t.warn), RULE: c(t.rule),
  };
}

/** Returns per metre behind each sample, from its recorded count and the spacing to the next sample. */
export function countsPerStation(samples: ReadonlyArray<ProfileChartSample>): Array<number | null> {
  return samples.map((smp, i) => {
    const next = samples[i + 1];
    if (smp.count == null || !next) return null;
    const dx = next.distance - smp.distance;
    return dx > 0 ? smp.count / dx : null;
  });
}
