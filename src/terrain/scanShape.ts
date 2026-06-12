/**
 * scanShape.ts
 *
 * Decide how to ROUTE a scan: a TERRAIN-like height field (a thin shell over a
 * wide footprint — what the DTM / contour pipeline is built for), an INTERIOR
 * space (a room / 360 / multi-room house: floor + walls, with or without a
 * clean ceiling), or a compact 3-D OBJECT (a phone scan of a sculpture). For
 * the latter two, terrain analysis is a category error that would print
 * confident-but-meaningless contours and accuracy figures.
 *
 * Pure data, deterministic, no ML. Operates on an interleaved xyz Float32Array,
 * with an OPTIONAL index-aligned per-point ASPRS classification.
 *
 * The signals (all cheap, grid-based on the detected up frame):
 *   - aspect = vertical extent / horizontal footprint. Terrain is flat-ish
 *     (low aspect); objects are compact or tall (higher aspect).
 *   - overhangFraction = fraction of occupied footprint cells whose returns
 *     span a large VERTICAL range (more than one surface stacked over the same
 *     footprint). Terrain ≈ 0; interiors AND forests are high.
 *   - wallCoverage = fraction of occupied cells whose vertical point span is a
 *     large fraction (≥ WALL_SPAN_FRAC) of the whole extent — a near-full-height
 *     column: a wall, or a floor-to-ceiling enclosure view. Interiors (esp.
 *     360) are HIGH; bare terrain ≈ 0; drone-over-roofs low.
 *   - floorCoverage / ceilingCoverage = occupied-cell fraction with a return in
 *     the bottom / top band — a floor under / a ceiling over the footprint.
 *   - topVegFraction = (classification only) fraction of TOP-band returns
 *     classified as vegetation (ASPRS 3/4/5). High over a wide footprint ⇒ a
 *     natural canopy, NOT a ceiling ⇒ terrain. This is the forest tiebreaker:
 *     a forest looks like an interior geometrically (floor + high overhang +
 *     full-height spans) and only the classification separates the two.
 *
 * Up-axis is DETECTED, not assumed (LAS is Z-up but phone / glTF scans are
 * often Y-up). A closed room reads ~1.0 overhang on EVERY axis, so least-
 * overhang can't find up; instead we pick the axis whose LOW surface (per-cell
 * zMin) is the widest + flattest coherent height field — a floor / ground —
 * with the floor+ceiling enclosure concentration as a tie-breaking hint. A
 * caller that already knows the vertical axis can override it.
 *
 * v0.4.5 GRAVITY PRIOR (live-bug fix): detection alone misread z-thin 360
 * interiors whose WALLS are densely sampled and whose floor is sparse and
 * cluttered — a dense flat wall is a *perfect* "floor field" (fill 1.0,
 * flatness ~1.0) and the enclosure hint then rewards the two opposing walls
 * as "floor + ceiling", so a horizontal axis won and every Space-panel figure
 * (H, footprint, floor plan, storeys) came out sideways. Two countermeasures:
 *   1. z is the INCUMBENT — point-cloud formats are z-up by spec (LAS/LAZ/
 *      COPC/EPT) far more often than not, so a lateral axis must now beat z's
 *      score by a clear margin (×1.25), not by an epsilon. Ties also resolve
 *      to z (the old loop took the FIRST axis on near-ties, i.e. x).
 *   2. Wall-as-floor discrimination — a candidate axis is penalised by the
 *      fraction of its footprint cells spanning near the FULL vertical extent.
 *      Seen sideways, the opposing walls + floor stack into full-span columns
 *      (wall mass masquerading as floor evidence); seen upright, only the
 *      true wall perimeter spans full height. The penalty cancels on a closed
 *      box (1.0 on every axis), where the enclosure hint still decides.
 */

import type { VerticalAxis } from './ground/groundFilter';

export type ScanKind = 'terrain' | 'object' | 'ambiguous';
/**
 * The decisive routing bucket. `terrain` is the only one the DTM / contour
 * pipeline is built for; `interior` (a room / 360 / multi-room house) and
 * `object` (a compact 3-D scan) both want the space/object analysis instead.
 */
export type SpaceKind = 'interior' | 'object' | 'terrain';
export type Axis = 'x' | 'y' | 'z';

export interface ScanShape {
  readonly kind: ScanKind;
  /**
   * Decisive routing flag: true for any scan that is NOT a terrain height
   * field — compact objects AND interior spaces. The viewer routes on this.
   */
  readonly nonTerrain: boolean;
  /** Which non-terrain (or terrain) analysis to emphasise. */
  readonly spaceKind: SpaceKind;
  /** 0..1 confidence in the routing verdict. */
  readonly confidence: number;
  /** Vertical extent / horizontal footprint, in the detected up frame. */
  readonly aspect: number;
  /** Fraction of occupied footprint cells carrying more than one surface. */
  readonly overhangFraction: number;
  /**
   * 0..1 — fraction of occupied footprint cells whose vertical point span is a
   * large fraction of the whole extent (a wall / floor-to-ceiling column).
   */
  readonly wallCoverage: number;
  /**
   * 0..1 — fraction of occupied footprint cells with a return near the TOP of
   * the vertical extent (a ceiling sitting over the footprint).
   */
  readonly ceilingCoverage: number;
  /**
   * 0..1 — fraction of occupied footprint cells with a return near the BOTTOM
   * of the vertical extent (a floor under the footprint).
   */
  readonly floorCoverage: number;
  /**
   * 0..1 — fraction of TOP-band returns classified as vegetation (ASPRS
   * 3/4/5). 0 when no classification is supplied. Drives the forest tiebreaker.
   */
  readonly topVegFraction: number;
  /** AABB extents [horizontal1, horizontal2, vertical], source units. */
  readonly extent: readonly [number, number, number];
  /** The detected (or supplied) up axis. */
  readonly up: Axis;
  /** Short human-readable basis for the verdict. */
  readonly reasons: readonly string[];
}

export interface ScanShapeParams {
  /** Force the up axis instead of detecting it. */
  readonly verticalAxis?: VerticalAxis;
  /**
   * Per-point ASPRS classification, index-aligned with the xyz triples. When
   * present, the vegetation tiebreaker can fire (a classified forest stays
   * terrain even though its geometry mimics an interior).
   */
  readonly classification?: ArrayLike<number>;
  /** Max points to sample for the test. Default 60000. */
  readonly maxSamples?: number;
  /** Grid resolution (cells per axis) for the footprint tests. Default 64. */
  readonly gridN?: number;
}

// ── Object (compact 3-D) thresholds — unchanged, for `kind` back-compat. ─────
const ASPECT_OBJECT = 0.65;
const OVERHANG_OBJECT = 0.2;

// ── Band / coverage geometry. ────────────────────────────────────────────────
/** Vertical band (fraction of vertical extent) that counts as floor / ceiling. */
const PLANE_BAND = 0.15;
/** Footprint coverage a floor AND a ceiling must each reach to read as a clean,
 *  flat enclosure (the strict signal — a real multi-room house never reaches it
 *  on the ceiling, which is why `wallCoverage` exists). */
const ENCLOSURE_COVER = 0.45;

// ── Wall / vertical-span signal. ─────────────────────────────────────────────
/** A cell whose point span (zMax−zMin) reaches this fraction of the whole
 *  vertical extent is a near-full-height column: a wall or a floor-to-ceiling
 *  enclosure view. */
const WALL_SPAN_FRAC = 0.6;

// ── Interior routing thresholds. ─────────────────────────────────────────────
/** Floor must cover this much of the footprint to read as an enclosed space. */
const FLOOR_INTERIOR = 0.5;
/** Near-full-height columns must reach this share of the footprint (a partial
 *  ceiling alone won't, so the WALLS carry the multi-room house). */
const WALL_INTERIOR = 0.25;
/** Interiors stack surfaces; require at least this much overhang too. */
const OVERHANG_INTERIOR = 0.15;

// ── Vegetation tiebreaker (classification only). ─────────────────────────────
/** ASPRS vegetation classes — low (3), medium (4), high (5) veg. */
const VEG_CLASSES: ReadonlySet<number> = new Set([3, 4, 5]);
/** Top-band returns this veg-dominated over a wide footprint ⇒ canopy, not a
 *  ceiling ⇒ terrain, even when overhang / wall coverage look interior. */
const VEG_DOMINANT = 0.55;

// ── Up-axis detection. ───────────────────────────────────────────────────────
/** Weight of the floor+ceiling enclosure concentration when scoring an axis as
 *  "up". The floor-field (fill × flatness) is primary; this only breaks ties —
 *  notably a closed box, where every axis has an equally flat low surface. */
const ENCLOSURE_HINT_WEIGHT = 1.5;
/** Penalty on multi-valued (overhung) columns when scoring an axis as "up".
 *  The true up is the most single-valued — a sloped height field still ties on
 *  the flat floor-field along the wrong axis, so this breaks toward the axis
 *  with one surface per column. Cancels for a closed room (≈1.0 on every axis,
 *  where the enclosure hint decides). */
const OVERHANG_PENALTY = 1.0;
/** Penalty on full-vertical-span (wall-like) columns when scoring an axis as
 *  "up" — the wall-as-floor discriminator. On the misread z-thin 360 interior
 *  the sideways frame stacks walls + floor into full-span columns on ~0.9 of
 *  its cells while the upright frame has them only on the wall perimeter
 *  (~0.2), so this term separates the two by ~0.5 where the raw scores
 *  differed by only ~1.3×. 0.75 chosen so the penalty dominates that gap but
 *  never outweighs a genuine floor field (max ff + hint ≈ 2.5). */
const WALL_AS_FLOOR_PENALTY = 0.75;
/** Gravity prior — z is the incumbent up axis (z-up is the point-cloud-format
 *  norm); a lateral axis must beat z's score by this factor to override it.
 *  Genuine y-up phone terrain clears it easily (y ≈ 0.93 vs z ≈ 0.40 on the
 *  flat-field suite case); the misread interior (x ≈ 1.28× z pre-penalty) did
 *  not deserve to. */
const GRAVITY_MARGIN = 1.25;
/** Absolute fallback margin used when z's score is non-positive (a
 *  multiplicative margin is meaningless across zero): a lateral axis must then
 *  beat z by this absolute gap. */
const GRAVITY_MARGIN_ABS = 0.1;
/** Roughness sensitivity for the floor-field flatness term. Higher ⇒ a rough
 *  low surface is penalised harder. */
const FLATNESS_K = 8;

const AXIS_NAME: readonly Axis[] = ['x', 'y', 'z'];
/** [vOff, h1Off, h2Off] for each axis treated as up. */
const ASSIGN: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 2], // x up
  [1, 0, 2], // y up
  [2, 0, 1], // z up
];

interface FloorField {
  /** fill × flatness of the per-cell zMin (low) surface, 0..~1. */
  score: number;
  /** Fraction of occupied cells whose column spans multiple surfaces (0..1). */
  overhang: number;
  /**
   * Fraction of occupied cells whose column spans ≥ WALL_SPAN_FRAC of the
   * whole vertical extent (0..1) — wall-like, full-height columns. High on a
   * sideways frame (walls + floor stack into every column), low on the true
   * up (only the wall perimeter is full-height). Drives the wall-as-floor
   * penalty in the up score.
   */
  wallFrac: number;
}

/** Score how good a "floor" the per-cell LOW surface (zMin) makes when `vOff`
 *  is up: the widest (fill) and flattest (low roughness) coherent height field
 *  wins. A true ground / floor scores high; a wall seen edge-on scores low.
 *  Also returns the column overhang fraction (multi-valuedness) for the up
 *  score's single-valuedness penalty. */
function floorFieldForAxis(
  positions: Float32Array | ReadonlyArray<number>,
  n: number,
  stride: number,
  gridN: number,
  vOff: number,
  h1Off: number,
  h2Off: number,
): FloorField {
  let minH1 = Infinity, maxH1 = -Infinity, minH2 = Infinity, maxH2 = -Infinity, minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < n; i += stride) {
    const b = i * 3;
    const h1 = positions[b + h1Off], h2 = positions[b + h2Off], v = positions[b + vOff];
    if (!Number.isFinite(h1) || !Number.isFinite(h2) || !Number.isFinite(v)) continue;
    if (h1 < minH1) minH1 = h1; if (h1 > maxH1) maxH1 = h1;
    if (h2 < minH2) minH2 = h2; if (h2 > maxH2) maxH2 = h2;
    if (v < minV) minV = v; if (v > maxV) maxV = v;
  }
  const ex1 = Math.max(0, maxH1 - minH1);
  const ex2 = Math.max(0, maxH2 - minH2);
  const exV = Math.max(0, maxV - minV);
  if (exV <= 0) return { score: 0, overhang: 0, wallFrac: 0 };

  const cols = gridN, rows = gridN;
  const zMin = new Float32Array(cols * rows).fill(Infinity);
  const zMax = new Float32Array(cols * rows).fill(-Infinity);
  const cellW = ex1 > 0 ? ex1 / cols : 1;
  const cellH = ex2 > 0 ? ex2 / rows : 1;
  const cellDiag = Math.hypot(cellW, cellH) || 1;
  for (let i = 0; i < n; i += stride) {
    const b = i * 3;
    const h1 = positions[b + h1Off], h2 = positions[b + h2Off], v = positions[b + vOff];
    if (!Number.isFinite(h1) || !Number.isFinite(h2) || !Number.isFinite(v)) continue;
    let c = Math.floor((h1 - minH1) / cellW); if (c < 0) c = 0; else if (c >= cols) c = cols - 1;
    let r = Math.floor((h2 - minH2) / cellH); if (r < 0) r = 0; else if (r >= rows) r = rows - 1;
    const idx = r * cols + c;
    if (v < zMin[idx]) zMin[idx] = v;
    if (v > zMax[idx]) zMax[idx] = v;
  }
  let occupied = 0, stacked = 0, wallCells = 0;
  let roughSum = 0, roughCount = 0;
  const wallSpan = WALL_SPAN_FRAC * exV;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const z = zMin[idx];
      if (z === Infinity) continue;
      occupied++;
      const span = zMax[idx] - z;
      if (span > 1.5 * cellDiag) stacked++;
      if (span >= wallSpan) wallCells++;
      if (c + 1 < cols) { const zr = zMin[idx + 1]; if (zr !== Infinity) { roughSum += Math.abs(z - zr); roughCount++; } }
      if (r + 1 < rows) { const zd = zMin[idx + cols]; if (zd !== Infinity) { roughSum += Math.abs(z - zd); roughCount++; } }
    }
  const fill = occupied / (cols * rows);
  const roughnessNorm = roughCount > 0 ? (roughSum / roughCount) / exV : 0;
  const flatness = 1 / (1 + FLATNESS_K * roughnessNorm);
  return {
    score: fill * flatness,
    overhang: occupied > 0 ? stacked / occupied : 0,
    wallFrac: occupied > 0 ? wallCells / occupied : 0,
  };
}

interface Enclosure {
  /** Point concentration in the floor + ceiling bands — used to pick the up axis. */
  score: number;
}

/** Concentration of returns in the floor + ceiling bands treating `vOff` as up.
 *  A closed room packs most points into the two big horizontal faces, so this
 *  peaks on the true up axis even when the floor-field is a flat tie. */
function enclosureForAxis(
  positions: Float32Array | ReadonlyArray<number>,
  n: number,
  stride: number,
  vOff: number,
): Enclosure {
  let minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < n; i += stride) {
    const v = positions[i * 3 + vOff];
    if (!Number.isFinite(v)) continue;
    if (v < minV) minV = v; if (v > maxV) maxV = v;
  }
  const exV = Math.max(0, maxV - minV);
  if (exV <= 0) return { score: 0 };
  const band = PLANE_BAND * exV;
  const floorHi = minV + band;
  const ceilLo = maxV - band;
  let total = 0, bandPts = 0;
  for (let i = 0; i < n; i += stride) {
    const v = positions[i * 3 + vOff];
    if (!Number.isFinite(v)) continue;
    total++;
    if (v <= floorHi || v >= ceilLo) bandPts++;
  }
  return { score: total > 0 ? bandPts / total : 0 };
}

interface AxisMetrics {
  aspect: number;
  overhangFraction: number;
  wallCoverage: number;
  floorCoverage: number;
  ceilingCoverage: number;
  topVegFraction: number;
  ex1: number;
  ex2: number;
  exV: number;
}

/** Full per-cell metrics for the CHOSEN up axis: aspect, overhang, wall (full-
 *  height span) coverage, floor / ceiling band coverage, and — when a
 *  classification is supplied — the vegetation fraction of the TOP band. */
function axisMetrics(
  positions: Float32Array | ReadonlyArray<number>,
  classification: ArrayLike<number> | undefined,
  n: number,
  stride: number,
  gridN: number,
  vOff: number,
  h1Off: number,
  h2Off: number,
): AxisMetrics {
  let minH1 = Infinity, maxH1 = -Infinity, minH2 = Infinity, maxH2 = -Infinity, minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < n; i += stride) {
    const b = i * 3;
    const h1 = positions[b + h1Off], h2 = positions[b + h2Off], v = positions[b + vOff];
    if (!Number.isFinite(h1) || !Number.isFinite(h2) || !Number.isFinite(v)) continue;
    if (h1 < minH1) minH1 = h1; if (h1 > maxH1) maxH1 = h1;
    if (h2 < minH2) minH2 = h2; if (h2 > maxH2) maxH2 = h2;
    if (v < minV) minV = v; if (v > maxV) maxV = v;
  }
  const ex1 = Math.max(0, maxH1 - minH1);
  const ex2 = Math.max(0, maxH2 - minH2);
  const exV = Math.max(0, maxV - minV);
  const footprint = Math.max(ex1, ex2, 1e-9);
  const aspect = exV / footprint;
  if (exV <= 0) {
    return { aspect, overhangFraction: 0, wallCoverage: 0, floorCoverage: 0, ceilingCoverage: 0, topVegFraction: 0, ex1, ex2, exV };
  }

  const band = PLANE_BAND * exV;
  const floorHi = minV + band;
  const ceilLo = maxV - band;
  const wallSpan = WALL_SPAN_FRAC * exV;
  const cols = gridN, rows = gridN;
  const zMin = new Float32Array(cols * rows).fill(Infinity);
  const zMax = new Float32Array(cols * rows).fill(-Infinity);
  const cellW = ex1 > 0 ? ex1 / cols : 1;
  const cellH = ex2 > 0 ? ex2 / rows : 1;
  const cellDiag = Math.hypot(cellW, cellH) || 1;
  const hasClass = !!classification && classification.length === n;
  let topBandPts = 0, topBandVeg = 0;
  for (let i = 0; i < n; i += stride) {
    const b = i * 3;
    const h1 = positions[b + h1Off], h2 = positions[b + h2Off], v = positions[b + vOff];
    if (!Number.isFinite(h1) || !Number.isFinite(h2) || !Number.isFinite(v)) continue;
    if (v >= ceilLo) {
      topBandPts++;
      if (hasClass && VEG_CLASSES.has((classification as ArrayLike<number>)[i])) topBandVeg++;
    }
    let c = Math.floor((h1 - minH1) / cellW); if (c < 0) c = 0; else if (c >= cols) c = cols - 1;
    let r = Math.floor((h2 - minH2) / cellH); if (r < 0) r = 0; else if (r >= rows) r = rows - 1;
    const idx = r * cols + c;
    if (v < zMin[idx]) zMin[idx] = v;
    if (v > zMax[idx]) zMax[idx] = v;
  }
  let occupied = 0, stacked = 0, wallCells = 0, floorCells = 0, ceilCells = 0;
  for (let i = 0; i < cols * rows; i++) {
    if (zMin[i] === Infinity) continue;
    occupied++;
    const span = zMax[i] - zMin[i];
    if (span > 1.5 * cellDiag) stacked++;
    if (span >= wallSpan) wallCells++;
    if (zMin[i] <= floorHi) floorCells++;
    if (zMax[i] >= ceilLo) ceilCells++;
  }
  return {
    aspect,
    overhangFraction: occupied > 0 ? stacked / occupied : 0,
    wallCoverage: occupied > 0 ? wallCells / occupied : 0,
    floorCoverage: occupied > 0 ? floorCells / occupied : 0,
    ceilingCoverage: occupied > 0 ? ceilCells / occupied : 0,
    topVegFraction: topBandPts > 0 ? topBandVeg / topBandPts : 0,
    ex1, ex2, exV,
  };
}

/** Classify a scan's shape from its point geometry (+ optional classification). */
export function classifyScanShape(
  positions: Float32Array | ReadonlyArray<number>,
  params: ScanShapeParams = {},
): ScanShape {
  const n = Math.floor(positions.length / 3);
  const gridN = Math.max(8, Math.floor(params.gridN ?? 64));
  const maxSamples = Math.max(100, Math.floor(params.maxSamples ?? 60000));
  const classification = params.classification && params.classification.length === n
    ? params.classification
    : undefined;

  if (n < 8) {
    return {
      kind: 'ambiguous', nonTerrain: false, spaceKind: 'terrain', confidence: 0,
      aspect: 0, overhangFraction: 0, wallCoverage: 0, ceilingCoverage: 0, floorCoverage: 0,
      topVegFraction: 0, extent: [0, 0, 0], up: 'z', reasons: ['Too few points to classify.'],
    };
  }
  const stride = Math.max(1, Math.floor(n / maxSamples));

  // ── Up-axis: supplied, or detected as the widest + flattest low surface
  //    UNDER the gravity prior — z is the incumbent (z-up is the point-cloud
  //    norm) and a lateral axis must beat z's score by a clear margin, with
  //    full-height wall-like columns penalised so dense walls can't buy a
  //    sideways frame on a 360 interior (see header). ──
  let upIdx: number;
  if (params.verticalAxis) {
    upIdx = params.verticalAxis === 'y' ? 1 : 2;
  } else {
    const scores = new Array<number>(3);
    for (let a = 0; a < 3; a++) {
      const [v, h1, h2] = ASSIGN[a];
      const ff = floorFieldForAxis(positions, n, stride, gridN, v, h1, h2);
      const enc = enclosureForAxis(positions, n, stride, v);
      scores[a] =
        ff.score +
        ENCLOSURE_HINT_WEIGHT * enc.score -
        OVERHANG_PENALTY * ff.overhang -
        WALL_AS_FLOOR_PENALTY * ff.wallFrac;
    }
    const zScore = scores[2];
    // Multiplicative margin only makes sense above zero; below it, fall back
    // to an absolute gap. Ties (e.g. a perfect cube) stay with z — the old
    // first-axis-wins loop resolved them to x, which was never right.
    const threshold = zScore > 0 ? zScore * GRAVITY_MARGIN : zScore + GRAVITY_MARGIN_ABS;
    const bestLateral = scores[0] >= scores[1] ? 0 : 1;
    upIdx = scores[bestLateral] > threshold ? bestLateral : 2;
  }
  const up = AXIS_NAME[upIdx];
  const [vOff, h1Off, h2Off] = ASSIGN[upIdx];
  const m = axisMetrics(positions, classification, n, stride, gridN, vOff, h1Off, h2Off);

  // ── Back-compat verdict (terrain | object | ambiguous) on the two original
  //    signals only, so existing `kind` callers behave exactly as before. ──
  const reasons: string[] = [];
  let objectVotes = 0;
  if (m.aspect >= ASPECT_OBJECT) { objectVotes++; reasons.push(`Compact aspect (height/footprint ${m.aspect.toFixed(2)}).`); }
  if (m.overhangFraction >= OVERHANG_OBJECT) { objectVotes++; reasons.push(`${Math.round(m.overhangFraction * 100)}% of columns stack multiple surfaces (overhangs).`); }

  let kind: ScanKind;
  if (objectVotes === 2) kind = 'object';
  else if (objectVotes === 1) kind = 'ambiguous';
  else kind = 'terrain';

  // ── Decisive routing precedence (documented):
  //   1. object   — compact 3-D scan (both legacy signals fire).
  //   2. terrain  — vegetation-dominated upper canopy over a wide footprint
  //                 (classification only). Beats interior: a forest mimics an
  //                 interior geometrically, so the classification breaks the tie.
  //   3. interior — wide floor + (near-full-height WALLS or a clean flat ceiling)
  //                 + overhang, and NOT veg-dominated. Catches the multi-room
  //                 house whose ceiling is partial (walls carry it).
  //   4. terrain  — single-surface height field (everything else / fallback).
  const wide = m.aspect < ASPECT_OBJECT;
  const vegDominated = classification !== undefined && wide && m.topVegFraction >= VEG_DOMINANT;
  const flatCeiling = m.ceilingCoverage >= ENCLOSURE_COVER && m.floorCoverage >= ENCLOSURE_COVER;
  const interiorEvidence =
    wide &&
    !vegDominated &&
    m.floorCoverage >= FLOOR_INTERIOR &&
    (m.wallCoverage >= WALL_INTERIOR || flatCeiling) &&
    m.overhangFraction >= OVERHANG_INTERIOR;

  let nonTerrain: boolean;
  let spaceKind: SpaceKind;
  let confidence: number;
  if (kind === 'object') {
    nonTerrain = true; spaceKind = 'object'; confidence = 0.9;
    reasons.unshift('Compact 3-D object — terrain analysis does not apply.');
  } else if (vegDominated) {
    nonTerrain = false; spaceKind = 'terrain'; confidence = 0.85;
    reasons.unshift(`Top band is ${Math.round(m.topVegFraction * 100)}% vegetation over a wide footprint — natural canopy, not a ceiling.`);
  } else if (interiorEvidence) {
    nonTerrain = true; spaceKind = 'interior';
    confidence = flatCeiling ? 0.9 : 0.8;
    reasons.unshift(
      flatCeiling
        ? `Floor + flat ceiling enclose ${Math.round(m.ceilingCoverage * 100)}% of the footprint — interior space.`
        : `Floor + near-full-height walls (${Math.round(m.wallCoverage * 100)}% of cells) — interior space (ceiling partial).`,
    );
  } else {
    nonTerrain = false; spaceKind = 'terrain'; confidence = 0.85;
    reasons.unshift(`Flat, single-surface geometry along ${up} (aspect ${m.aspect.toFixed(2)}, ${Math.round(m.overhangFraction * 100)}% stacked, ${Math.round(m.wallCoverage * 100)}% full-height).`);
  }

  return {
    kind,
    nonTerrain,
    spaceKind,
    confidence,
    aspect: m.aspect,
    overhangFraction: m.overhangFraction,
    wallCoverage: m.wallCoverage,
    ceilingCoverage: m.ceilingCoverage,
    floorCoverage: m.floorCoverage,
    topVegFraction: m.topVegFraction,
    extent: [m.ex1, m.ex2, m.exV],
    up,
    reasons,
  };
}
