/**
 * syntheticCloud.ts
 *
 * Deterministic, seeded point clouds for the benchmark suites.
 *
 * Every number a benchmark reports is only as reproducible as the data it ran
 * on, so the generator takes an explicit seed and drives an explicit PRNG that
 * lives in this file. `Math.random()` is banned outright (a source guard in
 * `tests/benchmark/fixtures.test.ts` enforces it, mirroring the framework's own
 * guard): a single call would still produce a plausible-looking cloud, and the
 * damage would surface weeks later as a reproducibility hash that never matches
 * and no way to say which run was wrong.
 *
 * THE SURFACE. A uniform random cube is the obvious fixture and the wrong one —
 * it has no bare earth, so a DTM is meaningless, contours are noise and the
 * terrain descriptors (VRM, TPI) measure the sampler rather than the ground.
 * The ground here is an analytic surface, sampled at scattered horizontal
 * positions:
 *
 *   z(x, y) = TILT · u                        regional grade across the tile
 *           + HILL · exp(−((u−0.45)² + (v−0.55)²) / (2·0.18²))
 *                                             one broad hill (relief + curvature)
 *           + WAVE_A · sin(2π · 3 · u)        two superposed sinusoids, giving
 *           + WAVE_B · cos(2π · 2 · v)        ridges/valleys across both axes
 *           + MICRO · sin(2πx / λ) · cos(2πy / λ)
 *                                             micro-relief at a fixed metre
 *                                             wavelength, so VRM and TPI have
 *                                             real cell-scale ruggedness
 *           + ε,  ε ~ U(−h, +h)               bounded sensor noise
 *
 * with u = x / extent, v = y / extent, and the four LANDFORM amplitudes
 * expressed as FRACTIONS of the tile extent. That choice is deliberate:
 * fixed-metre amplitudes make the surface effectively vertical on a small tile
 * (a 6 m hill across a 30 m tile is a cliff) and effectively flat on a large
 * one, so the ladder would be comparing different landscapes at each tier
 * instead of the same landscape sampled more densely. Scaling with the extent
 * keeps the slope distribution — and therefore the science the pipeline has to
 * do — comparable across 100k and 5M points.
 *
 * The micro-relief and the noise are the exceptions and stay in absolute
 * METRES, because they are properties of the ground and the sensor rather than
 * of the tile. A tile-relative micro-relief wavelength would be 1.4 grid cells
 * wide on the smallest tier and 50 cells wide on the largest, so VRM and TPI —
 * whose whole job is cell-scale ruggedness — would measure the point count.
 *
 * On top of that: flat-roofed buildings and scattered canopy returns, so the
 * ground filter has genuine non-ground to reject rather than classifying 100 %
 * of the cloud as bare earth.
 *
 * PORTABILITY. The PRNG is integer arithmetic (`Math.imul`, shifts, `>>> 0`),
 * exact on any JS engine. The surface uses `Math.sin`/`Math.exp`, which are
 * implementation-defined in the spec but come from V8's bundled fdlibm port and
 * are stable across the platforms this project builds on; the results are then
 * rounded into a Float32Array, which absorbs the last bits either way.
 *
 * Pure data: no DOM, no I/O, no `node:` builtins — a browser-side suite can
 * generate the identical cloud.
 */

/** One rung of the size ladder. */
export interface LadderTier {
  /** Stable short id a report keys a scaling curve off. */
  readonly id: string;
  readonly pointCount: number;
  /** True when the tier is too slow for a default run and must be asked for. */
  readonly optIn: boolean;
}

/**
 * The size ladder. The three large tiers are opt-in because a 5M-point run
 * takes the ground filter and the hold-out validation into the minutes, which
 * is a deliberate scaling experiment and not something a CI check should do on
 * every commit.
 */
export const FIXTURE_LADDER: readonly LadderTier[] = [
  { id: '100k', pointCount: 100_000, optIn: false },
  { id: '250k', pointCount: 250_000, optIn: false },
  { id: '500k', pointCount: 500_000, optIn: false },
  { id: '1m', pointCount: 1_000_000, optIn: true },
  { id: '2m', pointCount: 2_000_000, optIn: true },
  { id: '5m', pointCount: 5_000_000, optIn: true },
];

/** The single tier a smoke run uses when it wants one number, not a curve. */
export const CI_DEFAULT_TIER: LadderTier = FIXTURE_LADDER[0];

/** The tiers a default (CI) run measures. */
export function defaultLadder(): readonly LadderTier[] {
  return FIXTURE_LADDER.filter((t) => !t.optIn);
}

/** Every tier, including the opt-in ones. For a deliberate scaling run. */
export function fullLadder(): readonly LadderTier[] {
  return FIXTURE_LADDER;
}

/** Axis-aligned extent of a generated cloud, in source units (metres here). */
export interface CloudBounds {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

/** The analytic surface constants a run was generated with (provenance). */
export interface SurfaceModel {
  /** Regional grade across the tile, as a fraction of the extent. */
  readonly tiltFraction: number;
  /** Hill amplitude, as a fraction of the extent. */
  readonly hillFraction: number;
  /** Hill standard deviation, as a fraction of the extent. */
  readonly hillSigmaFraction: number;
  /** Amplitude of the along-X sinusoid, as a fraction of the extent. */
  readonly waveAFraction: number;
  /** Cycles of the along-X sinusoid across the tile. */
  readonly waveACycles: number;
  /** Amplitude of the along-Y sinusoid, as a fraction of the extent. */
  readonly waveBFraction: number;
  /** Cycles of the along-Y sinusoid across the tile. */
  readonly waveBCycles: number;
  /** Micro-relief amplitude in METRES — see the header for why not a fraction. */
  readonly microAmplitudeM: number;
  /** Micro-relief wavelength in METRES, on both axes. */
  readonly microWavelengthM: number;
}

export interface SyntheticCloudParams {
  /** PRNG seed. The same seed always produces the same bytes. */
  readonly seed: number;
  readonly pointCount: number;
  /**
   * Returns per square metre, which sets the tile extent for a given count.
   * Default 4 — the USGS 3DEP QL2 density, so the pipeline's density-derived
   * Quality Level grades a realistic scan rather than an artificially sparse
   * or impossibly dense one.
   */
  readonly densityPerM2?: number;
  /** Fraction of returns that land on canopy rather than ground. Default 0.08. */
  readonly canopyFraction?: number;
  /** Half-width of the uniform ground noise, metres. Default 0.05. */
  readonly noiseHalfWidthM?: number;
}

export interface SyntheticCloud {
  readonly seed: number;
  readonly pointCount: number;
  /** XYZ triples, length 3N — the form the terrain pipeline prefers. */
  readonly positions: Float32Array;
  /** The real extremes of the emitted points, for a caller-supplied grid. */
  readonly bounds: CloudBounds;
  /** Side length of the square tile, source units. */
  readonly extentM: number;
  /** Returns that sample bare earth (ground + noise). */
  readonly groundPointCount: number;
  /** Returns on a roof or in canopy — what the ground filter must reject. */
  readonly aboveGroundPointCount: number;
  readonly noiseHalfWidthM: number;
  readonly densityPerM2: number;
  readonly surface: SurfaceModel;
  /** Stable identifier for a report row, e.g. `synthetic-4000-seed42`. */
  readonly datasetId: string;
}

/**
 * The default surface. Fractions of the extent — see the header for why.
 *
 * Exported so a second fixture can evaluate the SAME landscape through
 * {@link groundElevationAt} instead of restating these nine amplitudes. Two
 * copies of the constants would let the two fixtures drift apart while both
 * still claimed to be sampling "the synthetic tile".
 */
export const SURFACE: SurfaceModel = {
  tiltFraction: 0.025,
  hillFraction: 0.04,
  hillSigmaFraction: 0.18,
  waveAFraction: 0.008,
  waveACycles: 3,
  waveBFraction: 0.005,
  waveBCycles: 2,
  // Micro-relief: four cells per wavelength on the default 2 m grid. Without
  // it the surface is smooth to within the noise floor at cell scale, and VRM
  // — which measures ruggedness independently of steepness — has nothing to
  // find. In METRES, unlike the terms above, for the reason in the header: a
  // tile-relative wavelength would be 1.4 cells wide on a small tier and 50
  // cells wide on a large one, so the ruggedness a descriptor measured would
  // depend on the point count and no two tiers would be comparable.
  microAmplitudeM: 0.25,
  microWavelengthM: 8,
};

/**
 * Buildings, in normalised tile coordinates: [u0, v0] corner plus a side
 * length that is capped in metres further down. Three of them, so the ground
 * filter meets more than one occlusion and the DTM has real voids to fill.
 */
const BUILDINGS: ReadonlyArray<readonly [number, number]> = [
  [0.18, 0.66],
  [0.62, 0.24],
  [0.74, 0.71],
];
/** Building side as a fraction of the tile… */
const BUILDING_SIDE_FRACTION = 0.08;
/**
 * …capped in metres. Uncapped, a 5M-point tile grows an 89 m building, which
 * is far wider than the SMRF filter's largest window (8 cells) and so survives
 * as "ground" — the big tiers would then be measuring a different scene from
 * the small ones. The cap keeps every tier's structure filterable.
 */
const BUILDING_MAX_SIDE_M = 12;
/** Roof height above the ground at the building's own corner, metres. */
const BUILDING_HEIGHT_M = 6;
/** Canopy returns sit this far above bare earth, metres. */
const CANOPY_MIN_M = 1.5;
const CANOPY_SPAN_M = 8;

/**
 * mulberry32 — a 32-bit PRNG in four integer ops.
 *
 * Chosen over an LCG because the low bits of a plain LCG are strongly
 * correlated, and this generator uses consecutive draws for x and y: an LCG
 * would lay the points on visible lattice lines, which the ground filter and
 * the density metrics would both read as structure that is not there.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The analytic bare-earth height at a horizontal position, noise excluded. */
export function groundElevationAt(
  cloud: Pick<SyntheticCloud, 'extentM' | 'surface'>,
  x: number,
  y: number,
): number {
  return surfaceZ(cloud.surface, cloud.extentM, x / cloud.extentM, y / cloud.extentM);
}

function surfaceZ(s: SurfaceModel, extent: number, u: number, v: number): number {
  const du = u - 0.45;
  const dv = v - 0.55;
  const sigma = s.hillSigmaFraction;
  return (
    extent *
    (s.tiltFraction * u +
      s.hillFraction * Math.exp(-(du * du + dv * dv) / (2 * sigma * sigma)) +
      s.waveAFraction * Math.sin(2 * Math.PI * s.waveACycles * u) +
      s.waveBFraction * Math.cos(2 * Math.PI * s.waveBCycles * v)) +
    // In metres, on the absolute coordinates — not scaled with the extent.
    s.microAmplitudeM *
      Math.sin((2 * Math.PI * u * extent) / s.microWavelengthM) *
      Math.cos((2 * Math.PI * v * extent) / s.microWavelengthM)
  );
}

/**
 * Generate the cloud. Deterministic in `seed` and every parameter.
 *
 * Each point consumes exactly five draws, taken UNCONDITIONALLY even when a
 * branch does not need them. A branch-dependent draw count makes the stream
 * position depend on the geometry, so changing one building's footprint would
 * silently reshuffle every point after it and no two versions of the fixture
 * would be comparable — the same trap as reusing a shared RNG across stages.
 */
export function generateSyntheticCloud(params: SyntheticCloudParams): SyntheticCloud {
  const { seed, pointCount } = params;
  if (!Number.isInteger(pointCount) || pointCount <= 0) {
    throw new Error(`synthetic cloud: pointCount must be a positive integer, got ${pointCount}`);
  }
  if (!Number.isFinite(seed)) {
    throw new Error(`synthetic cloud: seed must be finite, got ${String(seed)}`);
  }
  const densityPerM2 = params.densityPerM2 ?? 4;
  const canopyFraction = params.canopyFraction ?? 0.08;
  const noiseHalfWidthM = params.noiseHalfWidthM ?? 0.05;
  const extentM = Math.sqrt(pointCount / densityPerM2);
  const buildingSide = Math.min(BUILDING_SIDE_FRACTION * extentM, BUILDING_MAX_SIDE_M);

  const rnd = mulberry32(seed);
  const positions = new Float32Array(pointCount * 3);
  let ground = 0;
  let aboveGround = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let i = 0; i < pointCount; i++) {
    // Five draws, always, in this fixed order — see the doc comment.
    const u = rnd();
    const v = rnd();
    const noise = rnd();
    const kind = rnd();
    const canopyDepth = rnd();

    const x = u * extentM;
    const y = v * extentM;
    const earth = surfaceZ(SURFACE, extentM, u, v);

    let z: number;
    const roof = roofOf(x, y, extentM, buildingSide);
    if (roof !== null) {
      // A flat roof at an absolute height, not a copy of the terrain: a roof
      // that follows the ground is exactly the shape a morphological ground
      // filter keeps, so it would never be rejected and the scene would have
      // no real occlusion in it.
      z = roof + BUILDING_HEIGHT_M;
      aboveGround++;
    } else if (kind < canopyFraction) {
      z = earth + CANOPY_MIN_M + canopyDepth * CANOPY_SPAN_M;
      aboveGround++;
    } else {
      z = earth + (noise * 2 - 1) * noiseHalfWidthM;
      ground++;
    }

    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
  }

  // Bounds are read back off the STORED float32 values, not the float64 ones
  // computed above: the pipeline sees what the array holds, and a declared box
  // computed at higher precision can sit a rounding step inside the real data,
  // which silently clips the outermost returns out of a caller-supplied grid.
  for (let i = 0; i < pointCount; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  return {
    seed,
    pointCount,
    positions,
    bounds: { minX, minY, minZ, maxX, maxY, maxZ },
    extentM,
    groundPointCount: ground,
    aboveGroundPointCount: aboveGround,
    noiseHalfWidthM,
    densityPerM2,
    surface: SURFACE,
    datasetId: `synthetic-${pointCount}-seed${seed}`,
  };
}

/** Ground height at the corner of the building covering (x, y), or null. */
function roofOf(x: number, y: number, extentM: number, side: number): number | null {
  for (const [u0, v0] of BUILDINGS) {
    const x0 = u0 * extentM;
    const y0 = v0 * extentM;
    if (x >= x0 && x < x0 + side && y >= y0 && y < y0 + side) {
      return surfaceZ(SURFACE, extentM, u0, v0);
    }
  }
  return null;
}
