/**
 * svgContours.ts
 *
 * print path for clients without GIS. Renders the contour
 * feature model as a standalone SVG, styling each run by its evidence
 * grade (solid line, dashed for interpolated, faint dashed for gap) and
 * weighting index contours heavier. World Y is flipped to SVG's
 * Y-down space so north stays up.
 *
 * Pure data: no DOM, no three.js, no I/O. Returns an SVG string.
 */

import type { ContourFeature, ContourFeatureModel } from './contourFeatureModel';
import type { ContourLabel } from './labelPlacement';
import { contourShapeStyleLabel } from './contourShapeStyle';

/** Options for {@link svgContours}. */
export interface SvgContourParams {
  /** Stroke width for index contours (user units). Default 1.4. */
  readonly indexWeight?: number;
  /** Stroke width for intermediate contours. Default 0.6. */
  readonly baseWeight?: number;
  /** Stroke colour. Default "#5a3a1e" (sepia topo). */
  readonly stroke?: string;
  /** Padding around the bbox, in world units. Default 2. */
  readonly padding?: number;
  /** Elevation labels to draw along index contours (with a halo). */
  readonly labels?: ReadonlyArray<ContourLabel>;
  /** Label font size in world units. Default = 3×indexWeight. */
  readonly labelSize?: number;
}

/** Resolved style values (all defaults applied). */
interface ResolvedStyle {
  indexWeight: number;
  baseWeight: number;
  stroke: string;
  padding: number;
  labelSize: number;
}

function strokeStyle(f: ContourFeature, p: ResolvedStyle): string {
  const width = f.isIndex ? p.indexWeight : p.baseWeight;
  let dash = '';
  let opacity = 1;
  if (f.grade === 'dashed') dash = ` stroke-dasharray="${(width * 6).toFixed(2)} ${(width * 4).toFixed(2)}"`;
  else if (f.grade === 'gap') {
    dash = ` stroke-dasharray="${(width * 2).toFixed(2)} ${(width * 5).toFixed(2)}"`;
    opacity = 0.45;
  }
  return `stroke="${p.stroke}" stroke-width="${width}" fill="none" stroke-opacity="${opacity}"${dash}`;
}

/** Render the model as an SVG document string. */
export function svgContours(model: ContourFeatureModel, params: SvgContourParams = {}): string {
  const indexWeight = params.indexWeight ?? 1.4;
  const p: ResolvedStyle = {
    indexWeight,
    baseWeight: params.baseWeight ?? 0.6,
    stroke: params.stroke ?? '#5a3a1e',
    padding: params.padding ?? 2,
    labelSize: params.labelSize ?? indexWeight * 3,
  };

  // Self-describing stamp: an XML comment naming the shape style applied to the
  // geometry (honest about whether the lines are raw or smoothed/generalized).
  const styleComment = `<!-- contour style: ${contourShapeStyleLabel(model.contourStyle)} -->`;

  if (!model.bbox || model.features.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1">${styleComment}</svg>`;
  }
  const { minX, minY, maxX, maxY } = model.bbox;
  const w = maxX - minX + 2 * p.padding;
  const h = maxY - minY + 2 * p.padding;
  // Map world (x,y) → svg (x flipped-y). North up: svgY = (maxY - y).
  const sx = (x: number) => x - minX + p.padding;
  const sy = (y: number) => maxY - y + p.padding;

  const paths: string[] = [];
  for (const f of model.features) {
    let d = '';
    for (let i = 0; i < f.coordinates.length; i++) {
      const [x, y] = f.coordinates[i];
      d += `${i === 0 ? 'M' : 'L'}${sx(x).toFixed(3)} ${sy(y).toFixed(3)}`;
      if (i < f.coordinates.length - 1) d += ' ';
    }
    if (f.closed) d += ' Z';
    paths.push(`  <path d="${d}" ${strokeStyle(f, p)} data-elevation="${f.value}" data-grade="${f.grade}"/>`);
  }

  // Elevation labels with a halo: a white stroke painted BEHIND the
  // glyph fill (paint-order: stroke) knocks the contour line out from
  // under the text — the single biggest "real topo map" cue.
  const labels: string[] = [];
  for (const lab of params.labels ?? []) {
    const lx = sx(lab.x).toFixed(3);
    const ly = sy(lab.y).toFixed(3);
    // World angle is CCW; SVG Y is flipped, so negate for display, and
    // keep text upright (avoid upside-down labels).
    let deg = (-lab.angleRad * 180) / Math.PI;
    if (deg > 90) deg -= 180;
    else if (deg < -90) deg += 180;
    const halo = (p.labelSize * 0.3).toFixed(2);
    labels.push(
      `  <text x="${lx}" y="${ly}" transform="rotate(${deg.toFixed(2)} ${lx} ${ly})" ` +
        `font-size="${p.labelSize.toFixed(2)}" text-anchor="middle" dominant-baseline="middle" ` +
        `style="paint-order:stroke;stroke:#ffffff;stroke-width:${halo};fill:${p.stroke};` +
        `font-family:sans-serif">${Math.round(lab.value)}</text>`,
    );
  }

  const caption =
    Number.isFinite(model.interpolatedFraction) && model.interpolatedFraction > 0
      ? `<!-- ${Math.round(model.interpolatedFraction * 100)}% of contour length is interpolated/uncertain; not survey-grade unless validated -->`
      : '<!-- not survey-grade unless validated -->';

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(2)}" height="${h.toFixed(2)}" viewBox="0 0 ${w.toFixed(2)} ${h.toFixed(2)}">`,
    styleComment,
    caption,
    ...paths,
    ...labels,
    '</svg>',
  ].join('\n');
}
