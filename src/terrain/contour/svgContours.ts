/**
 * svgContours.ts
 *
 * Standalone print/GIS-less deliverable: renders the contour feature model as a
 * proper topographic SHEET — a scaled map panel framed by the cartographic
 * marginalia a field deliverable is expected to carry: a neat-line, a graphic
 * scale bar (in real ground units), a north arrow, a line-grade legend, and a
 * title block (source, interval, datum, CRS, vertical RMSEz, survey-grade
 * caveat, date). Each contour run is styled by its evidence grade (solid /
 * dashed for interpolated / faint dashed for gap) and index contours are
 * weighted heavier. World +Y maps to up so north stays up.
 *
 * Earlier versions sized the canvas in raw source units (an 80 m field rendered
 * as an 80 px postage stamp with no map furniture). This scales the map into a
 * sensible pixel canvas and keeps stroke/label sizes in pixels, so the drawing
 * is legible at its intrinsic size and reads as a real contour map.
 *
 * Pure data: no DOM, no three.js, no I/O. Returns an SVG string.
 */

import type { ContourFeature, ContourFeatureModel } from './contourFeatureModel';
import { decimalsForInterval, type ContourLabel } from './labelPlacement';
import { contourShapeStyleLabel } from './contourShapeStyle';
import { provenanceLines, type ExportProvenance } from '../export/exportProvenance';

/** Options for {@link svgContours}. */
export interface SvgContourParams {
  /** Stroke width for index contours, in pixels. Default 1.3. */
  readonly indexWeight?: number;
  /** Stroke width for intermediate contours, in pixels. Default 0.55. */
  readonly baseWeight?: number;
  /** Stroke colour. Default "#5a3a1e" (sepia topo). */
  readonly stroke?: string;
  /** Margin around the map panel, in pixels. Default 28. */
  readonly padding?: number;
  /** Elevation labels to draw along index contours (with a halo). */
  readonly labels?: ReadonlyArray<ContourLabel>;
  /** Label font size in pixels. Default 11. */
  readonly labelSize?: number;
  /**
   * Unified export provenance. When supplied, the full provenance block is
   * emitted in a leading `<metadata>` element (the lines inside an XML comment)
   * AND drives the visible title block. Without it, a minimal title block is
   * built from the model and the lone shape-style comment is kept for back-compat.
   */
  readonly provenance?: ExportProvenance;
  /**
   * Abbreviation of the drawing's linear unit ('m', 'ft', 'ftUS') for the scale
   * bar and title block. Default 'm'.
   */
  readonly unitLabel?: string;
}

/** Target pixel size for the map panel's longer dimension. */
const MAP_TARGET_PX = 880;

/** Escape the three XML-significant characters for safe text / `<metadata>`. */
function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function strokeStyle(f: ContourFeature, stroke: string, indexW: number, baseW: number): string {
  const width = f.isIndex ? indexW : baseW;
  let dash = '';
  let opacity = 1;
  if (f.grade === 'dashed') dash = ` stroke-dasharray="${(width * 6).toFixed(2)} ${(width * 4).toFixed(2)}"`;
  else if (f.grade === 'gap') {
    dash = ` stroke-dasharray="${(width * 2).toFixed(2)} ${(width * 5).toFixed(2)}"`;
    opacity = 0.45;
  }
  return `stroke="${stroke}" stroke-width="${width}" fill="none" stroke-opacity="${opacity}"${dash}`;
}

/** Largest 1 / 2 / 5 × 10ⁿ that is ≤ v — for a round graphic-scale-bar length. */
function niceRound(v: number): number {
  if (!(v > 0)) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / pow;
  const n = f >= 5 ? 5 : f >= 2 ? 2 : 1;
  return n * pow;
}

/** A graphic scale bar: 4 alternating segments over a round ground distance. */
function scaleBar(x: number, y: number, scale: number, worldW: number, unit: string, stroke: string): string {
  const D = niceRound(Math.max(worldW / 4, 1e-6));
  const segs = 4;
  const segPx = (D * scale) / segs;
  const h = 6;
  const parts: string[] = [];
  for (let i = 0; i < segs; i++) {
    const fill = i % 2 === 0 ? stroke : '#ffffff';
    parts.push(
      `<rect x="${(x + i * segPx).toFixed(2)}" y="${y.toFixed(2)}" width="${segPx.toFixed(2)}" height="${h}" ` +
        `fill="${fill}" stroke="${stroke}" stroke-width="0.5"/>`,
    );
  }
  const dec = D < 1 ? 1 : 0;
  const tick = (px: number, label: string): string =>
    `<text x="${px.toFixed(2)}" y="${(y - 3).toFixed(2)}" font-size="9" text-anchor="middle" ` +
    `fill="${stroke}" font-family="sans-serif">${label}</text>`;
  parts.push(tick(x, '0'));
  parts.push(tick(x + (D * scale) / 2, (D / 2).toFixed(dec)));
  parts.push(tick(x + D * scale, `${D.toFixed(dec)} ${unit}`));
  return parts.join('');
}

/** A simple north arrow (north is up after the world-Y flip). */
function northArrow(cx: number, top: number, stroke: string): string {
  const bot = top + 26;
  return (
    `<polygon points="${cx.toFixed(1)},${top.toFixed(1)} ${(cx - 6).toFixed(1)},${bot.toFixed(1)} ` +
    `${cx.toFixed(1)},${(bot - 7).toFixed(1)} ${(cx + 6).toFixed(1)},${bot.toFixed(1)}" fill="${stroke}"/>` +
    `<text x="${cx.toFixed(1)}" y="${(bot + 11).toFixed(1)}" font-size="11" text-anchor="middle" ` +
    `fill="${stroke}" font-family="sans-serif">N</text>`
  );
}

/** Legend rows: one line sample per evidence grade + index weight. */
function legend(x: number, y: number, stroke: string, indexW: number, baseW: number): string {
  const rows: Array<[string, string]> = [
    [`stroke="${stroke}" stroke-width="${indexW}"`, 'Index contour'],
    [`stroke="${stroke}" stroke-width="${baseW}"`, 'Intermediate'],
    [`stroke="${stroke}" stroke-width="${baseW}" stroke-dasharray="${(baseW * 6).toFixed(1)} ${(baseW * 4).toFixed(1)}"`, 'Interpolated'],
    [`stroke="${stroke}" stroke-width="${baseW}" stroke-opacity="0.45" stroke-dasharray="${(baseW * 2).toFixed(1)} ${(baseW * 5).toFixed(1)}"`, 'Gap / uncertain'],
  ];
  return rows
    .map(([attrs, label], i) => {
      const ry = y + i * 16;
      return (
        `<line x1="${x.toFixed(1)}" y1="${ry.toFixed(1)}" x2="${(x + 34).toFixed(1)}" y2="${ry.toFixed(1)}" ${attrs}/>` +
        `<text x="${(x + 42).toFixed(1)}" y="${(ry + 3.5).toFixed(1)}" font-size="10" fill="${stroke}" font-family="sans-serif">${label}</text>`
      );
    })
    .join('');
}

/** The visible title-block lines (right-aligned). Includes the interval line. */
function titleLines(model: ContourFeatureModel, prov: ExportProvenance | undefined, unit: string, intervalDec: number): string[] {
  const lines: string[] = [];
  const src = prov?.source ?? null;
  if (src) lines.push(`Source: ${src}`);
  if (Number.isFinite(model.intervalM) && model.intervalM > 0) {
    lines.push(`Contour interval ${model.intervalM.toFixed(intervalDec)} ${unit}`);
  }
  if (prov) {
    lines.push(`Vertical datum: ${prov.datumKnown ? prov.verticalDatum : 'unknown'}`);
    lines.push(`Horizontal CRS: ${prov.crsKnown ? prov.horizontalCrs : 'not georeferenced'}`);
    if (prov.accuracy && prov.accuracy.rmseZM != null) {
      // rmseZM is metre-denominated (the *M contract) whatever the sheet's
      // linear unit, and the provenance carries no unit factor to convert it
      // with — so stamp it 'm', matching the <metadata> block. Labelling a
      // 0.10 m figure "0.10 ft" on a foot-CRS sheet would overstate the
      // deliverable's accuracy 3.28×.
      lines.push(`Vertical RMSEz: ${prov.accuracy.rmseZM.toFixed(2)} m`);
    }
    lines.push(`Surface quality: ${prov.surfaceQuality}`);
    lines.push(prov.notSurveyGrade);
    if (prov.generated) lines.push(`Generated: ${prov.generated.slice(0, 10)}`);
  } else {
    lines.push('Not survey-grade unless validated against ground-truth control.');
  }
  return lines;
}

/** Render the contour model as a topographic SVG sheet. */
export function svgContours(model: ContourFeatureModel, params: SvgContourParams = {}): string {
  const stroke = params.stroke ?? '#5a3a1e';
  const indexW = params.indexWeight ?? 1.3;
  const baseW = params.baseWeight ?? 0.55;
  const labelSize = params.labelSize ?? 11;
  const margin = params.padding ?? 28;
  const unit = params.unitLabel ?? 'm';
  const prov = params.provenance;

  const provStamp = prov
    ? `<metadata><!--\n${provenanceLines(prov).map(xmlEscape).join('\n')}\n--></metadata>`
    : `<!-- contour style: ${contourShapeStyleLabel(model.contourStyle)} -->`;

  if (!model.bbox || model.features.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1">${provStamp}</svg>`;
  }

  const { minX, minY, maxX, maxY } = model.bbox;
  const worldW = Math.max(maxX - minX, 1e-6);
  const worldH = Math.max(maxY - minY, 1e-6);
  // Scale the map into a legible pixel canvas; stroke/label sizes stay in px.
  const scale = MAP_TARGET_PX / Math.max(worldW, worldH);
  const mapW = worldW * scale;
  const mapH = worldH * scale;

  // World → sheet. North up: svgY grows downward, world +Y is up.
  const sx = (x: number): number => margin + (x - minX) * scale;
  const sy = (y: number): number => margin + (maxY - y) * scale;

  // ── contour paths ─────────────────────────────────────────────────────────
  const paths: string[] = [];
  for (const f of model.features) {
    let d = '';
    for (let i = 0; i < f.coordinates.length; i++) {
      const [x, y] = f.coordinates[i];
      d += `${i === 0 ? 'M' : 'L'}${sx(x).toFixed(2)} ${sy(y).toFixed(2)}`;
      if (i < f.coordinates.length - 1) d += ' ';
    }
    if (f.closed) d += ' Z';
    paths.push(`  <path d="${d}" ${strokeStyle(f, stroke, indexW, baseW)} data-elevation="${f.value}" data-grade="${f.grade}"/>`);
  }

  // ── haloed elevation labels ───────────────────────────────────────────────
  const labelDecimals = decimalsForInterval(model.intervalM);
  const labels: string[] = [];
  for (const lab of params.labels ?? []) {
    const lx = sx(lab.x).toFixed(2);
    const ly = sy(lab.y).toFixed(2);
    let deg = (-lab.angleRad * 180) / Math.PI; // world CCW → SVG flipped-Y
    if (deg > 90) deg -= 180;
    else if (deg < -90) deg += 180;
    const halo = (labelSize * 0.3).toFixed(2);
    labels.push(
      `  <text x="${lx}" y="${ly}" transform="rotate(${deg.toFixed(2)} ${lx} ${ly})" ` +
        `font-size="${labelSize.toFixed(2)}" text-anchor="middle" dominant-baseline="middle" ` +
        `style="paint-order:stroke;stroke:#ffffff;stroke-width:${halo};fill:${stroke};` +
        `font-family:sans-serif">${lab.value.toFixed(labelDecimals)}</text>`,
    );
  }

  // ── marginalia layout ─────────────────────────────────────────────────────
  const tLines = titleLines(model, prov, unit, labelDecimals);
  const footerTop = margin + mapH + 18;
  const legendBottom = footerTop + 44 + 3 * 16 + 6;
  const titleBottom = footerTop + 12 + tLines.length * 14;
  const footerBottom = Math.max(legendBottom, titleBottom);
  const W = mapW + margin * 2;
  const H = footerBottom + margin;

  const neatLine = `<rect x="${margin}" y="${margin}" width="${mapW.toFixed(2)}" height="${mapH.toFixed(2)}" fill="none" stroke="${stroke}" stroke-width="0.8"/>`;
  const north = northArrow(margin + mapW - 22, margin + 10, stroke);
  const bar = scaleBar(margin, footerTop + 24, scale, worldW, unit, stroke);
  const leg = legend(margin, footerTop + 44, stroke, indexW, baseW);
  const xRight = (W - margin).toFixed(1);
  const title = tLines
    .map((ln, i) => {
      const weight = i === 0 && prov?.source ? ' font-weight="600"' : '';
      return `<text x="${xRight}" y="${(footerTop + 12 + i * 14).toFixed(1)}" font-size="10" text-anchor="end" fill="${stroke}" font-family="sans-serif"${weight}>${xmlEscape(ln)}</text>`;
    })
    .join('');

  const caption =
    Number.isFinite(model.interpolatedFraction) && model.interpolatedFraction > 0
      ? `<!-- ${Math.round(model.interpolatedFraction * 100)}% of contour length is interpolated/uncertain; not survey-grade unless validated -->`
      : '<!-- not survey-grade unless validated -->';

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W.toFixed(2)}" height="${H.toFixed(2)}" viewBox="0 0 ${W.toFixed(2)} ${H.toFixed(2)}">`,
    provStamp,
    caption,
    `<rect x="0" y="0" width="${W.toFixed(2)}" height="${H.toFixed(2)}" fill="#ffffff"/>`,
    ...paths,
    ...labels,
    neatLine,
    north,
    bar,
    leg,
    title,
    '</svg>',
  ].join('\n');
}
