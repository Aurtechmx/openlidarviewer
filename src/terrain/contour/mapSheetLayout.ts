/**
 * mapSheetLayout.ts
 *
 * Pure cartographic layout maths for the printable map sheet — no pdf-lib, no
 * DOM, so the fiddly bits (fitting the map into the frame, the scale bar's
 * round numbers, the coordinate graticule) are unit-testable on their own.
 *
 * Page units are PDF points (72 per inch). World units are the source CRS
 * linear unit (metres for a metric CRS). Y is up in both frames.
 */

export interface Box {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface Frame {
  /** Page x of the frame's left edge (points). */
  readonly x: number;
  /** Page y of the frame's bottom edge (points, y-up). */
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface FitTransform {
  /** Page points per world unit (uniform — aspect preserved). */
  readonly scale: number;
  /** Page x of world minX. */
  readonly ox: number;
  /** Page y of world minY. */
  readonly oy: number;
  /** The drawn extent inside the frame (centred). */
  readonly drawnW: number;
  readonly drawnH: number;
}

/**
 * Fit a world bbox into a page frame, preserving aspect and centring. After
 * this, page_x = ox + (worldX − bbox.minX)·scale and page_y = oy + (worldY −
 * bbox.minY)·scale (both y-up).
 */
export function fitTransform(bbox: Box, frame: Frame): FitTransform {
  const bw = bbox.maxX - bbox.minX || 1;
  const bh = bbox.maxY - bbox.minY || 1;
  const scale = Math.min(frame.w / bw, frame.h / bh);
  const drawnW = bw * scale;
  const drawnH = bh * scale;
  return {
    scale,
    ox: frame.x + (frame.w - drawnW) / 2,
    oy: frame.y + (frame.h - drawnH) / 2,
    drawnW,
    drawnH,
  };
}

/** A 1 / 2 / 5 × 10ⁿ step so `span / step` ≈ `target` gridlines. */
export function niceStep(span: number, target: number): number {
  if (!Number.isFinite(span) || span <= 0) return 1;
  const raw = span / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

/** The largest 1 / 2 / 5 × 10ⁿ value ≤ x (for a round scale-bar length). */
export function niceRoundDown(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0;
  const mag = 10 ** Math.floor(Math.log10(x));
  const norm = x / mag;
  const v = norm >= 5 ? 5 : norm >= 2 ? 2 : 1;
  return v * mag;
}

/** Round coordinate values (multiples of `step`) within [min, max]. */
export function gridTicks(min: number, max: number, step: number): number[] {
  if (!(step > 0) || !Number.isFinite(min) || !Number.isFinite(max) || max < min) return [];
  const out: number[] = [];
  const first = Math.ceil(min / step) * step;
  for (let v = first; v <= max + step * 1e-6; v += step) {
    out.push(Number(v.toFixed(6)));
  }
  return out;
}

export interface ScaleBar {
  /** Total ground length the bar represents, world units. */
  readonly totalGround: number;
  /** Ground length of each of the (4) segments. */
  readonly segGround: number;
  readonly segments: number;
  /** Page length of the whole bar, points. */
  readonly barPt: number;
}

/**
 * A clean scale bar: the largest round ground length whose page length fits
 * within `maxBarPt`, split into 4 equal segments. `scalePtPerWorld` is the
 * map's page-points-per-world-unit (from {@link fitTransform}).
 */
export function scaleBar(scalePtPerWorld: number, maxBarPt: number, segments = 4): ScaleBar {
  if (!(scalePtPerWorld > 0) || !(maxBarPt > 0)) {
    return { totalGround: 0, segGround: 0, segments, barPt: 0 };
  }
  const maxGround = maxBarPt / scalePtPerWorld;
  const totalGround = niceRoundDown(maxGround);
  return {
    totalGround,
    segGround: totalGround / segments,
    segments,
    barPt: totalGround * scalePtPerWorld,
  };
}

/**
 * Map scale as a TRUE dimensionless 1:N ratio: N units of ground length per 1
 * unit of paper length, in the SAME physical unit on both sides. Because the map
 * is drawn in the CRS's source units, the page-points-per-world-unit must be
 * converted to page-points-per-metre before comparing against the paper's metre
 * length — otherwise a foot CRS yields feet-per-paper-metre (off by ~3.28×), not
 * a dimensionless ratio. `worldUnitToMetres` is 1 for a metric CRS, ~0.3048 for
 * a foot CRS; defaults to 1 (the standing metric assumption).
 */
export function mapScaleRatio(scalePtPerWorld: number, worldUnitToMetres = 1): number {
  // Page points per ground-metre = (pt per world unit) / (metres per world unit).
  const scalePtPerMetre = worldUnitToMetres > 0 ? scalePtPerWorld / worldUnitToMetres : scalePtPerWorld;
  // 1 page point = 1/72 inch = 0.0254/72 m of paper.
  const paperMPerGroundM = (scalePtPerMetre / 72) * 0.0254;
  return paperMPerGroundM > 0 ? 1 / paperMPerGroundM : 0;
}
