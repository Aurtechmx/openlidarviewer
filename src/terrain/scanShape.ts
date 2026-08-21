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
 *   - aspect = vertical extent / horizontal footprint size. Terrain is flat-ish
 *     (low aspect); objects are compact or tall (higher aspect). The footprint
 *     size is the longer side of the minimum-area rectangle around the
 *     horizontal outline, so it does not depend on how the scan is oriented in
 *     its source CRS (see footprintSize).
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
  /**
   * Vertical extent / horizontal footprint size, in the detected up frame.
   * Invariant under rotation about the up axis: the denominator is the longer
   * side of the minimum-area rectangle around the horizontal outline, NOT the
   * larger side of `extent`, so this is not `extent[2] / max(extent[0],
   * extent[1])`. See footprintSize.
   */
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
  /** AABB extents [horizontal1, horizontal2, vertical], source units. The two
   *  horizontal entries stay axis-aligned and so still depend on the source CRS
   *  axes; `aspect` does not. */
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
/**
 * Compact 3-D SOLID gate — catches a scanned OBJECT that slips just under both
 * single-signal bars above. Requires a moderate aspect AND any genuine overhang
 * TOGETHER. A terrain height field is single-surface, so it reads ≈0% overhang
 * on its true up however steep it gets (an 0.8-gradient slope still measures 0%
 * stacking) — the AND can therefore never promote a slope. A scanned object
 * (statue, sculpture) stacks a few percent from limbs / folds even viewed
 * top-down.
 *
 * The load-bearing guard is OVERHANG_SOLID, NOT the aspect bar: a height field
 * reads ≈0% overhang however steep, so the AND can never promote a slope no
 * matter how low the aspect bar goes. The aspect bar only sets how COMPACT an
 * object must be. It was first tuned at 0.55 on one iPhone statue scan (Statue1:
 * aspect 0.64, 5.9% stacked) — but the SAME object captured with more ground
 * slab around it (Statue2: aspect 0.506, 4.4% stacked) widens the footprint and
 * slipped under 0.55, misrouting to terrain. Lowered to 0.45 so a moderately
 * compact object survives a captured base plane; still safe against terrain,
 * which the overhang guard rejects regardless of aspect. Both real statue scans
 * are pinned in `tests/scanShapeStatueBasePlane.test.ts`; the steepest terrain
 * fixture (slope-0.8, aspect 0.80) still reads 0% overhang and stays terrain.
 */
const ASPECT_SOLID = 0.45;
const OVERHANG_SOLID = 0.03;

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
/** Floor must cover this much of the footprint to read as an enclosed space.
 *  This is the DECISIVE terrain/interior discriminator: a terrain height field
 *  is one thin surface, so only a small band of footprint cells (~10–15%) ever
 *  carry a return in the bottom PLANE_BAND, while an interior's floor IS the
 *  bottom band and fills nearly the whole footprint (≈100%). Genuine flat AND
 *  hilly terrain both measure ~10–13% here — far below this gate. */
const FLOOR_INTERIOR = 0.5;
/** Near-full-height columns must reach this share of the footprint to read as
 *  an interior on the WALL signal alone (a fully-enclosed box, a multi-room
 *  house whose ceiling is partial — the walls carry it). */
const WALL_INTERIOR = 0.25;
/**
 * Lower wall/ceiling-structure bar for the BIG-OPEN-INTERIOR path (v0.4.6).
 *
 * A large open industrial interior scanned with a 360 scanner has a densely
 * sampled floor and full-height perimeter walls, but a HIGH, SPARSE ceiling:
 * at grazing angle a 4 m ceiling returns only a fraction of its cells, so both
 * `wallCoverage` (full-height columns) and `ceilingCoverage` land around
 * 12–22% — under WALL_INTERIOR and far under ENCLOSURE_COVER. The strict
 * gate then misread this real 125 M-pt interior as TERRAIN (floor 100 %, but
 * wall 17 % < 25 %, ceiling 21 % < 45 %), so the "Treat as" pill never
 * committed to Interior and the user had to set it by hand.
 *
 * Because `floorCoverage ≥ FLOOR_INTERIOR` (50 %) ALREADY excludes every
 * terrain case decisively (terrain ≈ 10–15 % floor), and `overhangFraction ≥
 * OVERHANG_INTERIOR` independently requires real stacked structure that a
 * single-surface height field never has (terrain ≈ 0 %), it is safe to accept
 * a much lower wall-OR-ceiling presence here: enough to prove an overhead /
 * perimeter enclosure exists, not enough to be reached by bare ground. */
const WALL_OR_CEILING_OPEN_INTERIOR = 0.1;
/** Interiors stack surfaces; require at least this much overhang too. A
 *  single-surface terrain height field measures ≈0% here (flat AND steep
 *  hilly terrain both read 0% in testing), so this is the second independent
 *  guard that keeps the relaxed open-interior path off genuine ground. */
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
    if (h1 < minH1) minH1 = h1;
    if (h1 > maxH1) maxH1 = h1;
    if (h2 < minH2) minH2 = h2;
    if (h2 > maxH2) maxH2 = h2;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
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
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
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

// ── Frame-independent horizontal footprint. ──────────────────────────────────
/**
 * `aspect` divides the vertical extent by a horizontal SIZE. That size used to
 * be the larger side of the AXIS-ALIGNED horizontal bounding box, which is a
 * property of the source CRS axes and not of the scan: rotating one scene about
 * the vertical axis moved aspect from 0.17454 to 0.12821 at 31 degrees and
 * 0.12446 at 45 degrees, a swing of about 29 per cent, so ASPECT_OBJECT and
 * ASPECT_SOLID were being applied to a number that depended on how the scan
 * happened to be oriented on disk.
 *
 * The replacement is the longer side of the MINIMUM-AREA rectangle enclosing
 * the horizontal footprint. It is defined by the point set alone, so it is
 * invariant under rotation about the vertical axis, translation and input
 * order.
 *
 * SAME SCALE AND SAME ORIENTATION as the value it replaces: still a length in
 * source units, still small-for-wide and large-for-compact, and it reproduces
 * the axis-aligned max extent exactly on the footprint shapes the thresholds
 * were tuned against. An axis-aligned rectangle a x b gives a, a square of
 * side s gives s, a disc of radius r gives 2r (both statue fixtures are discs).
 * ASPECT_OBJECT and ASPECT_SOLID therefore keep their meaning unchanged.
 *
 * Two covariance-based candidates were rejected, for different reasons.
 *
 * Covariance principal EXTENTS, i.e. sqrt(12 * eigenvalue), are weighted by
 * point density rather than by the outline, so a uniformly sampled disc reads
 * sqrt(3)*r instead of 2r (13 per cent narrow, which lifts the compact-solid
 * fixture from 0.606 across the 0.65 object bar).
 *
 * Projecting onto the covariance EIGENVECTORS and taking the min/max of the
 * projections does enclose the point set, and it does reproduce 2r on a disc,
 * but the eigenvectors of an isotropic footprint carry no direction: a square
 * and a disc both have covariance c*I, so the principal direction is fixed by
 * sampling noise. The enclosing rectangle in that arbitrary direction is up to
 * the footprint's diagonal, sqrt(2) times its side on a square, and two
 * samplings of the same room disagree. Measured on a seeded 8 x 8 m room over
 * 20 samplings, that estimator returned 8.51 to 11.31 m for the same 8.00 m
 * side; the minimum-area rectangle returns 8.00 on all 20.
 */
function footprintSize(hx: Float64Array, hy: Float64Array, k: number): number {
  return footprintRectOf(hx, hy, k).longSide;
}

/** Side lengths of the minimum-area rectangle around a horizontal footprint. */
export interface FootprintRect {
  /** Longer side, in the units the coordinates were supplied in. */
  readonly longSide: number;
  /** Shorter side, same units. Never greater than `longSide`. */
  readonly shortSide: number;
}

const ZERO_RECT: FootprintRect = { longSide: 0, shortSide: 0 };

/**
 * Both sides of the rectangle {@link footprintSize} takes its long side from.
 *
 * ONE definition of "how big is this footprint" for the terrain subsystem.
 * `aspect` divides by the long side; the space report prints both sides as a
 * space's L and W. The report used to derive its own pair from the covariance
 * eigenvectors, which is the estimator the note above rejects, so a square room
 * could be reported up to 41 per cent wider than it is.
 *
 * The two callers still measure DIFFERENT SAMPLES on purpose, and the values
 * are not interchangeable: `aspect` measures the raw strided sample in source
 * units, while the space report measures a metre-scaled sample with stray
 * returns outside the dense footprint already clipped away (the same clip the
 * floor plan applies). Only the geometry is shared.
 *
 * Non-finite coordinates are dropped. A footprint with fewer than two distinct
 * points has no rectangle and measures zero on both sides.
 */
export function footprintRect(h1: ArrayLike<number>, h2: ArrayLike<number>): FootprintRect {
  const supplied = Math.min(h1.length, h2.length);
  const hx = new Float64Array(supplied);
  const hy = new Float64Array(supplied);
  let k = 0;
  for (let i = 0; i < supplied; i++) {
    const x = h1[i], y = h2[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    hx[k] = x;
    hy[k] = y;
    k++;
  }
  return footprintRectOf(hx, hy, k);
}

/** Shared body: hull, vertex cap, rectangle scan. */
function footprintRectOf(hx: Float64Array, hy: Float64Array, k: number): FootprintRect {
  if (k < 2) return ZERO_RECT;
  return minAreaRectSides(hx, hy, thinHull(hx, hy, convexHull(hx, hy, k)));
}

/**
 * Hull vertices the rectangle scan is allowed to measure.
 *
 * minAreaRectSides is quadratic in the hull vertex count. On an area-filling
 * footprint the hull is a handful of vertices and that is free, but a densely
 * sampled CONVEX outline (a silo wall, a tunnel bore, a terrestrial scanner's
 * outer ring) puts nearly every sampled point in convex position, so the hull
 * approaches the sample cap: 27016 vertices on an 80000-point ring, 7.3e8
 * edge-vertex pairs, about 5 s on the main thread during load.
 *
 * 512 bounds the scan at 512^2 = 262144 pairs regardless of point count. On a
 * circular outline the retained vertices inscribe a regular 512-gon, whose
 * width is cos(pi/512) of the circle's, so the measured footprint is at most
 * 1 - cos(pi/512) = 1.9e-5 short. `aspect` is that same 1.9e-5 relative, i.e.
 * 1.3e-5 absolute at the 0.65 bar, against the 0.20 that separates
 * ASPECT_OBJECT (0.65) from ASPECT_SOLID (0.45), a factor of 15000. Hulls of 512 vertices or fewer are measured whole and are bit-for-
 * bit unchanged, which covers every polygonal and lattice-sampled footprint.
 */
const HULL_SCAN_CAP = 512;

/**
 * At most HULL_SCAN_CAP hull vertices, spaced uniformly by ARC POSITION around
 * the outline so the retained set still spans the whole shape. Vertex t is kept
 * when it is the nearest vertex to one of HULL_SCAN_CAP positions spaced evenly
 * along the hull perimeter, so a long edge keeps both of its endpoints, which
 * are the vertices an enclosing rectangle rests on. Keeping the first N
 * vertices instead would measure one side of the outline.
 *
 * The retained set is anchored at the hull's first vertex, which is its
 * lexicographic minimum, so it follows the frame: on a hull above the cap a
 * rotation about the vertical axis retains different vertices and moves the
 * measured size by up to the same 1.9e-5. Below the cap nothing is dropped and
 * the size is exactly rotation-invariant.
 */
function thinHull(hx: Float64Array, hy: Float64Array, hull: Int32Array): Int32Array {
  const h = hull.length;
  if (h <= HULL_SCAN_CAP) return hull;
  const cum = new Float64Array(h + 1);
  for (let t = 0; t < h; t++) {
    const a = hull[t], b = hull[(t + 1) % h];
    cum[t + 1] = cum[t] + Math.hypot(hx[b] - hx[a], hy[b] - hy[a]);
  }
  const perimeter = cum[h];
  if (!(perimeter > 0)) return hull.subarray(0, HULL_SCAN_CAP);
  const kept = new Int32Array(HULL_SCAN_CAP);
  let m = 0;
  // `cum` is non-decreasing and the targets increase, so the nearest vertex to
  // each successive target is found by advancing `t` and never rewinding.
  let t = 0;
  for (let j = 0; j < HULL_SCAN_CAP; j++) {
    const target = (j * perimeter) / HULL_SCAN_CAP;
    while (t + 1 < h && Math.abs(cum[t + 1] - target) <= Math.abs(cum[t] - target)) t++;
    if (m === 0 || kept[m - 1] !== hull[t]) kept[m++] = hull[t];
  }
  return kept.subarray(0, m);
}

/**
 * Convex hull of `k` planar points held in (hx, hy), returned as vertex indices
 * in counter-clockwise order with no repeated endpoint. Andrew monotone chain.
 * Collinear vertices are dropped, so every hull edge has non-zero length.
 */
function convexHull(hx: Float64Array, hy: Float64Array, k: number): Int32Array {
  if (k < 3) {
    const all = new Int32Array(k);
    for (let i = 0; i < k; i++) all[i] = i;
    return all;
  }
  const order = new Int32Array(k);
  const q = keepHullCandidates(hx, hy, k, order);
  const cand = order.subarray(0, q);
  cand.sort((a, b) => (hx[a] - hx[b]) || (hy[a] - hy[b]));
  const turn = (o: number, a: number, b: number): number =>
    (hx[a] - hx[o]) * (hy[b] - hy[o]) - (hy[a] - hy[o]) * (hx[b] - hx[o]);

  const stack = new Int32Array(2 * q);
  let m = 0;
  for (let i = 0; i < q; i++) {
    const p = cand[i];
    while (m >= 2 && turn(stack[m - 2], stack[m - 1], p) <= 0) m--;
    stack[m++] = p;
  }
  const lowerEnd = m + 1;
  for (let i = q - 2; i >= 0; i--) {
    const p = cand[i];
    while (m >= lowerEnd && turn(stack[m - 2], stack[m - 1], p) <= 0) m--;
    stack[m++] = p;
  }
  // The last entry repeats the first vertex.
  return stack.slice(0, Math.max(1, m - 1));
}

/**
 * Write the indices that can still be hull vertices into `out` and return how
 * many there are.
 *
 * The four axis extremes are hull vertices, so every point strictly inside the
 * quadrilateral they span lies inside the hull and cannot be one of its
 * vertices (Akl and Toussaint 1978). Dropping them leaves the comparator sort
 * in convexHull with the outline instead of the whole sample: on an
 * area-filling height field that is a few hundred points rather than the 60000
 * the sampler admits, and the sort is the largest single cost in the call.
 *
 * The hull is unchanged, not approximated. A rejected point is interior, and
 * an interior point is neither a hull vertex nor a collinear boundary point.
 *
 * The test is one-sided on purpose: a point must clear all four edges strictly
 * to be rejected. Coincident or collinear extremes therefore give edges that
 * reject nothing and the whole sample survives, which costs one linear pass and
 * changes no result.
 */
function keepHullCandidates(hx: Float64Array, hy: Float64Array, k: number, out: Int32Array): number {
  // Corner-most extreme in each direction: left, bottom, right, top. Any
  // tie-break is valid (every candidate is a point of the set); these keep the
  // quadrilateral as large as the sample allows.
  let left = 0, bottom = 0, right = 0, top = 0;
  for (let i = 1; i < k; i++) {
    const x = hx[i], y = hy[i];
    if (x < hx[left] || (x === hx[left] && y < hy[left])) left = i;
    if (y < hy[bottom] || (y === hy[bottom] && x > hx[bottom])) bottom = i;
    if (x > hx[right] || (x === hx[right] && y > hy[right])) right = i;
    if (y > hy[top] || (y === hy[top] && x < hx[top])) top = i;
  }
  const qx0 = hx[left], qy0 = hy[left];
  const qx1 = hx[bottom], qy1 = hy[bottom];
  const qx2 = hx[right], qy2 = hy[right];
  const qx3 = hx[top], qy3 = hy[top];
  // Edge vectors of that counter-clockwise quadrilateral.
  const e0x = qx1 - qx0, e0y = qy1 - qy0;
  const e1x = qx2 - qx1, e1y = qy2 - qy1;
  const e2x = qx3 - qx2, e2y = qy3 - qy2;
  const e3x = qx0 - qx3, e3y = qy0 - qy3;
  let n = 0;
  for (let i = 0; i < k; i++) {
    const x = hx[i], y = hy[i];
    if (
      e0x * (y - qy0) - e0y * (x - qx0) > 0 &&
      e1x * (y - qy1) - e1y * (x - qx1) > 0 &&
      e2x * (y - qy2) - e2y * (x - qx2) > 0 &&
      e3x * (y - qy3) - e3y * (x - qx3) > 0
    ) continue;
    out[n++] = i;
  }
  return n;
}

/**
 * Side lengths of the MINIMUM-AREA rectangle enclosing the hull. The minimum
 * always has a side flush with a hull edge (Freeman and Shapira 1975), so it is
 * enough to measure the rectangle aligned with each edge in turn and keep the
 * smallest.
 *
 * Cost is quadratic in the HULL vertex count, not in the point count: the hull
 * is the footprint outline, tens of vertices for a scan whose sample fills an
 * area. A densely sampled convex outline is the exception, and thinHull bounds
 * the count at HULL_SCAN_CAP before this runs.
 *
 * The tie-break is on the value, not on which edge the loop reached first. An
 * exact quarter turn reproduces every per-edge area bit for bit but visits the
 * edges from a different starting vertex, so first-edge-wins would return a
 * different side of two equal-area rectangles for the same scan.
 */
function minAreaRectSides(hx: Float64Array, hy: Float64Array, hull: Int32Array): FootprintRect {
  const h = hull.length;
  if (h < 2) return ZERO_RECT;
  const vx = (t: number): number => hx[hull[t % h]];
  const vy = (t: number): number => hy[hull[t % h]];
  // A hull of two vertices is a segment: it encloses no area, so its rectangle
  // is the segment itself and the short side is zero.
  if (h === 2) return { longSide: Math.hypot(vx(1) - vx(0), vy(1) - vy(0)), shortSide: 0 };

  let bestArea = Infinity;
  let bestLong = 0;
  let bestShort = 0;
  for (let i = 0; i < h; i++) {
    const ox = vx(i), oy = vy(i);
    const ex = vx(i + 1) - ox, ey = vy(i + 1) - oy;
    const len = Math.hypot(ex, ey);
    if (!(len > 0)) continue;
    // Distance from the edge line and projection along it, both scaled by
    // |edge| while they are compared, then divided out once at the end. The
    // edge origin itself scores zero on all three, which seeds the extremes.
    let maxOff = 0, maxAlong = 0, minAlong = 0;
    for (let t = 0; t < h; t++) {
      const dx = vx(t) - ox, dy = vy(t) - oy;
      const off = ex * dy - ey * dx;
      const along = ex * dx + ey * dy;
      if (off > maxOff) maxOff = off;
      if (along > maxAlong) maxAlong = along;
      if (along < minAlong) minAlong = along;
    }
    const width = (maxAlong - minAlong) / len;
    const height = maxOff / len;
    const area = width * height;
    const long = Math.max(width, height);
    if (area < bestArea || (area === bestArea && long < bestLong)) {
      bestArea = area;
      bestLong = long;
      bestShort = Math.min(width, height);
    }
  }
  return { longSide: bestLong, shortSide: bestShort };
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
  const sampled = Math.ceil(n / stride);
  const hx = new Float64Array(sampled);
  const hy = new Float64Array(sampled);
  let k = 0;
  for (let i = 0; i < n; i += stride) {
    const b = i * 3;
    const h1 = positions[b + h1Off], h2 = positions[b + h2Off], v = positions[b + vOff];
    if (!Number.isFinite(h1) || !Number.isFinite(h2) || !Number.isFinite(v)) continue;
    hx[k] = h1;
    hy[k] = h2;
    k++;
    if (h1 < minH1) minH1 = h1;
    if (h1 > maxH1) maxH1 = h1;
    if (h2 < minH2) minH2 = h2;
    if (h2 > maxH2) maxH2 = h2;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  const ex1 = Math.max(0, maxH1 - minH1);
  const ex2 = Math.max(0, maxH2 - minH2);
  const exV = Math.max(0, maxV - minV);
  // Frame-independent footprint (see footprintSize). A footprint too degenerate
  // to hull (fewer than two distinct points) falls back to the axis-aligned box.
  const invariantFootprint = footprintSize(hx, hy, k);
  const footprint = invariantFootprint > 0 ? invariantFootprint : Math.max(ex1, ex2, 1e-9);
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
  const classification =
    params.classification?.length === n ? params.classification : undefined;

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
  // A compact 3-D solid (moderate aspect AND real overhang together) is an
  // object even when neither single signal reaches its own bar — see the
  // ASPECT_SOLID / OVERHANG_SOLID note. A terrain height field reads 0% overhang
  // however steep, so this never fires on a slope.
  if (objectVotes < 2 && m.aspect >= ASPECT_SOLID && m.overhangFraction >= OVERHANG_SOLID) {
    objectVotes = 2;
    reasons.push(
      `Compact 3-D solid (aspect ${m.aspect.toFixed(2)}, ${Math.round(m.overhangFraction * 100)}% stacked) — a scanned object, not a height field.`,
    );
  }

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
  // Wall/ceiling enclosure evidence. The strict bar — full-height walls or a
  // clean flat ceiling — catches enclosed boxes and houses. The OPEN bar
  // (v0.4.6) additionally catches a big open interior with full-height
  // perimeter walls but a high, SPARSE ceiling, where both signals sit around
  // 12–22%: accepted only because floorCoverage + overhang (below) already
  // exclude terrain twice over. Either a partial ceiling OR partial
  // full-height wall presence proves an overhead/perimeter enclosure exists.
  const enclosureEvidence =
    m.wallCoverage >= WALL_INTERIOR ||
    flatCeiling ||
    m.wallCoverage >= WALL_OR_CEILING_OPEN_INTERIOR ||
    m.ceilingCoverage >= WALL_OR_CEILING_OPEN_INTERIOR;
  const interiorEvidence =
    wide &&
    !vegDominated &&
    m.floorCoverage >= FLOOR_INTERIOR &&
    enclosureEvidence &&
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
    // Strong (flat ceiling) > walls > sparse open enclosure. The open path
    // (neither full-height walls nor a flat ceiling, just partial overhead /
    // perimeter structure over a full floor) is the least certain but still
    // decisively non-terrain — it reports its own honest, lower confidence.
    const strongWalls = m.wallCoverage >= WALL_INTERIOR;
    if (flatCeiling) confidence = 0.9;
    else if (strongWalls) confidence = 0.8;
    else confidence = 0.7;
    let interiorReason: string;
    if (flatCeiling) {
      interiorReason = `Floor + flat ceiling enclose ${Math.round(m.ceilingCoverage * 100)}% of the footprint — interior space.`;
    } else if (strongWalls) {
      interiorReason = `Floor + near-full-height walls (${Math.round(m.wallCoverage * 100)}% of cells) — interior space (ceiling partial).`;
    } else {
      interiorReason = `Full floor + partial perimeter walls / sparse ceiling (${Math.round(m.wallCoverage * 100)}% full-height, ${Math.round(m.ceilingCoverage * 100)}% overhead, ${Math.round(m.overhangFraction * 100)}% stacked) — open interior space (high or sparsely-scanned ceiling).`;
    }
    reasons.unshift(interiorReason);
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
