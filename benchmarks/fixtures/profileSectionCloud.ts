/**
 * profileSectionCloud.ts
 *
 * The scene a profile-section measurement runs against, laid out the way the
 * section seam finds one: several sources, each holding a float32 buffer in
 * its own local frame, each read into the project frame through a float64
 * offset resolved once per source.
 *
 * WHY NOT `syntheticCloud.ts` DIRECTLY. That fixture emits one concatenated
 * position buffer, which is what the terrain pipeline consumes. The section
 * extractor consumes something else: a LIST of sources it walks in place,
 * each with its own point count, its own attribute channels and its own
 * conservative bounds. Handing it one buffer would measure a code path the
 * viewer never takes and would leave the multi-source bounds pre-test, the
 * per-source channel binding and the source-slot strata all unexercised. The
 * LANDSCAPE is not restated here: heights come from
 * {@link groundElevationAt} over the shipped {@link SURFACE}, so both
 * fixtures sample the same tile.
 *
 * SAMPLING. Horizontal positions come from the R4 additive recurrence on the
 * generalised golden ratio phi4 — the real root of x^5 = x + 1 — with the
 * conventional 0.5 offset, the same family the hit-test suite already samples
 * its hover positions from. Four dimensions: two place the return, one
 * chooses its class, one carries the ground noise and the canopy depth. There
 * is no PRNG and no call into a random source at all, so a given point count
 * always produces the same bytes.
 *
 * The sequence being LOW DISCREPANCY is what makes a corridor measurement
 * mean anything. A corridor keeps the returns inside a narrow strip, so the
 * accepted count is a function of how evenly the sampling filled the tile. A
 * pseudo-random stream clumps at the scale a strip is wide, so the same
 * corridor over two seeds would accept counts that differ by more than the
 * effects being measured. An R4 point set has no such clumping, and the
 * accepted count is set by the strip's area.
 *
 * Points are dealt to sources round-robin on the point index, so every source
 * spans the whole tile and none of them can be rejected by the extractor's
 * bounds pre-test. That is deliberate: a spatially tiled layout would let the
 * pre-test skip most of the scene, and the reported time would then describe
 * the pre-test rather than the scan.
 *
 * Pure data: no DOM, no I/O, no `node:` builtin, no clock.
 */

import { groundElevationAt, SURFACE } from './syntheticCloud';

/**
 * The R4 additive-recurrence alphas: successive powers of 1/phi4, where phi4
 * is the real root of x^5 = x + 1. Written out rather than solved for at
 * module load so the sequence is a fixed, quotable constant.
 */
export const R4_ALPHA: readonly [number, number, number, number] = [
  0.8566748838545029, 0.7338918566271259, 0.6287067210378086, 0.538632805021333,
];

/** Names the generator in the record, so a reader need not open this file. */
export const PROFILE_CLOUD_GENERATOR =
  'R4 additive recurrence on the generalised golden ratio phi4 (real root of x^5 = x + 1), ' +
  'offset 0.5, dimensions [x, y, class, noise]; no pseudo-random source';

/** The k-th value of dimension `d`, in [0, 1). */
export function r4(d: number, k: number): number {
  return (0.5 + R4_ALPHA[d]! * k) % 1;
}

/** ASPRS classes the fixture emits. Three, so a section has real strata. */
export const CLASS_GROUND = 2;
export const CLASS_HIGH_VEGETATION = 5;
export const CLASS_BUILDING = 6;

/** Returns per square metre. 4 is the USGS 3DEP QL2 density. */
const DEFAULT_DENSITY_PER_M2 = 4;
/** Share of returns that land in canopy rather than on bare earth. */
const DEFAULT_CANOPY_FRACTION = 0.08;
/** Half-width of the bounded ground noise, metres. */
const NOISE_HALF_WIDTH_M = 0.05;
/** Canopy returns sit this far above bare earth, metres. */
const CANOPY_MIN_M = 1.5;
const CANOPY_SPAN_M = 8;

/** Flat-roofed buildings, as [u, v] corners in normalised tile coordinates. */
const BUILDINGS: ReadonlyArray<readonly [number, number]> = [
  [0.18, 0.66],
  [0.62, 0.24],
  [0.74, 0.71],
];
const BUILDING_SIDE_FRACTION = 0.08;
/** Capped in metres, so a large tile does not grow a building the size of a hill. */
const BUILDING_MAX_SIDE_M = 12;
const BUILDING_HEIGHT_M = 6;

/**
 * The project-frame origin every source is placed against.
 *
 * Non-zero, and large, on purpose. The seam resolves a layer's placement as a
 * float64 offset added at read time, and a scene sitting at the project origin
 * would never exercise the magnitude that offset actually carries — a
 * projected easting and northing. The local buffers stay float32 and small,
 * which is the arrangement the extractor's header describes.
 */
export const PROJECT_ORIGIN: readonly [number, number, number] = [500_000, 4_500_000, 100];

/** An axis-aligned project-frame box, in the shape the extractor reads. */
export interface ProfileCloudBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** One source, as the seam would hand it over. */
export interface ProfileCloudSource {
  /** Stable slot recorded on every return this source contributes. */
  readonly slot: number;
  readonly pointCount: number;
  /** Interleaved source-local XYZ. Never written by a measurement. */
  readonly positions: Float32Array;
  readonly classification: Uint8Array;
  readonly intensity: Uint16Array;
  /** Float64 placement added at read time to reach the project frame. */
  readonly offset: readonly [number, number, number];
  /** Conservative project-frame bounds, read back off the stored floats. */
  readonly bounds: ProfileCloudBounds;
}

export interface ProfileSectionCloud {
  readonly pointCount: number;
  readonly densityPerM2: number;
  /** Side of the square tile, metres. */
  readonly extentM: number;
  readonly sources: readonly ProfileCloudSource[];
  /** Returns per emitted class, keyed by ASPRS code. */
  readonly classCounts: Readonly<Record<number, number>>;
  /** Bytes the source buffers themselves occupy. */
  readonly sourceBytes: number;
  readonly generator: string;
  readonly datasetId: string;
}

export interface ProfileSectionCloudParams {
  readonly pointCount: number;
  /** Sources to deal the returns across. Default 4. */
  readonly sourceCount?: number;
  readonly densityPerM2?: number;
  readonly canopyFraction?: number;
}

/** Ground height at the corner of the building covering (x, y), or null. */
function roofOf(x: number, y: number, extentM: number, side: number): number | null {
  for (const [u0, v0] of BUILDINGS) {
    const x0 = u0 * extentM;
    const y0 = v0 * extentM;
    if (x >= x0 && x < x0 + side && y >= y0 && y < y0 + side) {
      return groundElevationAt({ extentM, surface: SURFACE }, x0, y0);
    }
  }
  return null;
}

/** How many returns source `s` receives under round-robin dealing. */
function countForSource(pointCount: number, sourceCount: number, s: number): number {
  return Math.floor(pointCount / sourceCount) + (s < pointCount % sourceCount ? 1 : 0);
}

/**
 * Build the scene.
 *
 * Deterministic in `pointCount`, `sourceCount` and `densityPerM2` alone: there
 * is no seed, because there is no random stream to seed. The tile grows with
 * the point count at fixed density, which is the convention the shipped size
 * ladder already uses — a denser tile and a larger tile are different
 * experiments, and this one holds the survey's density fixed.
 */
export function generateProfileSectionCloud(
  params: ProfileSectionCloudParams,
): ProfileSectionCloud {
  const { pointCount } = params;
  if (!Number.isInteger(pointCount) || pointCount <= 0) {
    throw new Error(`profile section cloud: pointCount must be a positive integer, got ${pointCount}`);
  }
  const sourceCount = params.sourceCount ?? 4;
  if (!Number.isInteger(sourceCount) || sourceCount <= 0 || sourceCount > pointCount) {
    throw new Error(`profile section cloud: sourceCount must be in 1..pointCount, got ${sourceCount}`);
  }
  const densityPerM2 = params.densityPerM2 ?? DEFAULT_DENSITY_PER_M2;
  const canopyFraction = params.canopyFraction ?? DEFAULT_CANOPY_FRACTION;
  const extentM = Math.sqrt(pointCount / densityPerM2);
  const buildingSide = Math.min(BUILDING_SIDE_FRACTION * extentM, BUILDING_MAX_SIDE_M);

  const counts: number[] = [];
  for (let s = 0; s < sourceCount; s++) counts.push(countForSource(pointCount, sourceCount, s));
  const positions = counts.map((n) => new Float32Array(n * 3));
  const classification = counts.map((n) => new Uint8Array(n));
  const intensity = counts.map((n) => new Uint16Array(n));
  const write = new Uint32Array(sourceCount);
  const classCounts: Record<number, number> = {
    [CLASS_GROUND]: 0,
    [CLASS_HIGH_VEGETATION]: 0,
    [CLASS_BUILDING]: 0,
  };

  for (let i = 0; i < pointCount; i++) {
    const u = r4(0, i);
    const v = r4(1, i);
    const kind = r4(2, i);
    const jitter = r4(3, i);

    const x = u * extentM;
    const y = v * extentM;
    const earth = groundElevationAt({ extentM, surface: SURFACE }, x, y);

    let z: number;
    let cls: number;
    const roof = roofOf(x, y, extentM, buildingSide);
    if (roof !== null) {
      // A flat roof at an absolute height: a roof that followed the ground
      // would be the one shape a morphological filter always keeps, so the
      // scene would carry no genuine structure.
      z = roof + BUILDING_HEIGHT_M;
      cls = CLASS_BUILDING;
    } else if (kind < canopyFraction) {
      z = earth + CANOPY_MIN_M + jitter * CANOPY_SPAN_M;
      cls = CLASS_HIGH_VEGETATION;
    } else {
      z = earth + (jitter * 2 - 1) * NOISE_HALF_WIDTH_M;
      cls = CLASS_GROUND;
    }

    const s = i % sourceCount;
    const at = write[s]!;
    write[s] = at + 1;
    positions[s]![at * 3] = x;
    positions[s]![at * 3 + 1] = y;
    positions[s]![at * 3 + 2] = z;
    classification[s]![at] = cls;
    // Intensity is a stand-in channel, not a physical model: it exists so the
    // builder binds and copies a second attribute, which is what a real
    // section costs.
    intensity[s]![at] = Math.round(jitter * 65_535);
    classCounts[cls] = (classCounts[cls] ?? 0) + 1;
  }

  const sources: ProfileCloudSource[] = [];
  let sourceBytes = 0;
  for (let s = 0; s < sourceCount; s++) {
    const pos = positions[s]!;
    const n = counts[s]!;
    // Bounds are read back off the STORED float32 values, never off the
    // float64 originals: the extractor sees what the array holds, and a box
    // computed at higher precision can sit a rounding step inside the real
    // data — which is exactly the case the pre-test must never reject.
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const px = pos[i * 3]!;
      const py = pos[i * 3 + 1]!;
      const pz = pos[i * 3 + 2]!;
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (pz < minZ) minZ = pz;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
      if (pz > maxZ) maxZ = pz;
    }
    const [ox, oy, oz] = PROJECT_ORIGIN;
    sources.push({
      slot: s,
      pointCount: n,
      positions: pos,
      classification: classification[s]!,
      intensity: intensity[s]!,
      offset: PROJECT_ORIGIN,
      bounds: {
        min: [minX + ox, minY + oy, minZ + oz],
        max: [maxX + ox, maxY + oy, maxZ + oz],
      },
    });
    sourceBytes +=
      pos.byteLength + classification[s]!.byteLength + intensity[s]!.byteLength;
  }

  return {
    pointCount,
    densityPerM2,
    extentM,
    sources,
    classCounts,
    sourceBytes,
    generator: PROFILE_CLOUD_GENERATOR,
    datasetId: `profile-section-${pointCount}-${sourceCount}src-r4`,
  };
}

/** A section line's two endpoints, in the project frame. */
export interface ProfileSectionLine {
  readonly a: readonly [number, number, number];
  readonly b: readonly [number, number, number];
}

/**
 * The section line a measurement cuts: across the tile at mid-tile, from 2 %
 * to 98 % of the extent.
 *
 * It spans the tile on purpose. The corridor test rejects a return whose
 * chainage falls more than the half-width past either end BEFORE it computes
 * a distance, so a short line inside a large tile would leave most returns on
 * the cheap early-out and the reported cost would be the cost of rejecting
 * them. A line that spans the tile puts nearly every return through the full
 * test, which is the slower and more honest case.
 *
 * The endpoints sit on the bare-earth surface, so the frame's vertical delta
 * is the real grade of the ground under the line.
 */
export function profileSectionLine(cloud: ProfileSectionCloud): ProfileSectionLine {
  const { extentM } = cloud;
  const [ox, oy, oz] = PROJECT_ORIGIN;
  const x0 = 0.02 * extentM;
  const x1 = 0.98 * extentM;
  const y = 0.5 * extentM;
  const surface = { extentM, surface: SURFACE };
  return {
    a: [x0 + ox, y + oy, groundElevationAt(surface, x0, y) + oz],
    b: [x1 + ox, y + oy, groundElevationAt(surface, x1, y) + oz],
  };
}
