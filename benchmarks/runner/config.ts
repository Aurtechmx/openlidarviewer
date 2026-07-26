/**
 * config.ts
 *
 * The two suites' configurations, and the parser that refuses a bad one.
 *
 * WHY A PARSER AT ALL, for constants that live in this file. Every published
 * number is only meaningful next to the configuration that produced it, so the
 * configuration is written verbatim into `raw.json` and re-read by
 * `benchmark:verify`, which checks the run counts in the data against the run
 * counts in the config. That round trip means a configuration can arrive from
 * JSON, and a JSON `recordedRuns: "10"` would sail through TypeScript and make
 * the verifier compare 10 runs against a string. So the shapes below are parsed,
 * not cast.
 *
 * WHY ONE SEED, WRITTEN DOWN. Both suites are deterministic experiments: the
 * reproducibility suite's entire claim is "the same input gives the same
 * science", which says nothing at all unless the input is pinned. The seed is
 * `20260726` — the date the suites were written, chosen for no property other
 * than being a fixed integer someone can check against this file. No suite ever
 * reads system entropy, and the fixture generator's own source guard bans
 * `Math.random()` outright.
 *
 * Pure data + validation. No clock, no I/O.
 */

/** The single documented seed both suites generate every cloud from. */
export const BENCHMARK_SEED = 20260726;

/** Bumped when a raw or summary file changes meaning. */
export const BENCHMARK_SCHEMA_VERSION = 1;

/**
 * The version of the benchmark package itself, independent of the OLV release.
 * A reader comparing two result sets needs to know whether the harness changed
 * as well as whether the application did.
 */
export const BENCHMARK_PACKAGE_VERSION = '1.0.0';

/** Terrain parameters both suites hold fixed, so only the input size varies. */
export interface TerrainConfig {
  readonly cellSizeM: number;
  readonly crs: string;
  readonly verticalDatum: string;
  readonly holdoutSeed: number;
}

export const TERRAIN_CONFIG: TerrainConfig = {
  cellSizeM: 2,
  crs: 'EPSG:32610',
  verticalDatum: 'EPSG:5703',
  holdoutSeed: 1,
};

export interface ReproducibilityConfig {
  readonly suiteId: 'reproducibility';
  readonly seed: number;
  readonly pointCount: number;
  readonly warmupRuns: number;
  readonly recordedRuns: number;
  readonly terrain: TerrainConfig;
  /**
   * The tolerance applied when comparing two runs' scalar outputs.
   *
   * Zero, and it is meant to stay zero. The pipeline is deterministic
   * arithmetic over a deterministic input on one machine, so any difference at
   * all is a real finding — a tolerance here would hide exactly the bug the
   * suite exists to catch. Recorded in the output anyway, because "we compared
   * exactly" is a claim a reader is entitled to see stated rather than assumed.
   */
  readonly scalarTolerance: 0;
}

export const REPRODUCIBILITY_CONFIG: ReproducibilityConfig = {
  suiteId: 'reproducibility',
  seed: BENCHMARK_SEED,
  pointCount: 250_000,
  warmupRuns: 1,
  recordedRuns: 10,
  terrain: TERRAIN_CONFIG,
  scalarTolerance: 0,
};

/** One rung of the scaling ladder. */
export interface ScalingTier {
  readonly id: string;
  readonly pointCount: number;
}

export interface ScalingConfig {
  readonly suiteId: 'scaling';
  readonly seed: number;
  readonly tiers: readonly ScalingTier[];
  readonly warmupRuns: number;
  readonly recordedRuns: number;
  readonly terrain: TerrainConfig;
  /**
   * Tier ids whose failure is a KNOWN, deliberately accepted limitation of the
   * machine running the suite.
   *
   * Empty here, and adding an id is a deliberate act with a comment attached.
   * The point is that a tier which cannot complete never silently disappears: a
   * failed tier is preserved in `raw.json` with its exact reason and fails
   * `benchmark:quick`, and the only way to stop it failing is to write the id
   * down here — which puts the limitation in the repository, in a diff, instead
   * of in a machine nobody can inspect later.
   */
  readonly acceptedTierFailures: readonly string[];
}

export const SCALING_CONFIG: ScalingConfig = {
  suiteId: 'scaling',
  seed: BENCHMARK_SEED,
  tiers: [
    { id: '50k', pointCount: 50_000 },
    { id: '100k', pointCount: 100_000 },
    { id: '250k', pointCount: 250_000 },
    { id: '500k', pointCount: 500_000 },
    { id: '1m', pointCount: 1_000_000 },
  ],
  warmupRuns: 1,
  recordedRuns: 5,
  terrain: TERRAIN_CONFIG,
  acceptedTierFailures: [],
};

// ── validation ──────────────────────────────────────────────────────────────

function fail(message: string): never {
  throw new Error(`benchmark config: ${message}`);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * A count of repetitions. Rejects 0 as well as fractions and strings: a suite
 * configured for zero recorded runs produces a summary over an empty sample,
 * which every statistic below would then have to invent.
 */
function positiveInt(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail(`${what} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Warm-ups may legitimately be zero; everything else about them is the same. */
function nonNegativeInt(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail(`${what} must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

function finiteNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${what} must be a finite number, got ${JSON.stringify(value)}`);
  }
  return value;
}

function nonEmptyString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${what} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value;
}

function parseTerrain(value: unknown): TerrainConfig {
  const t = asRecord(value, 'terrain');
  const cellSizeM = finiteNumber(t.cellSizeM, 'terrain.cellSizeM');
  if (cellSizeM <= 0) fail(`terrain.cellSizeM must be positive, got ${String(cellSizeM)}`);
  return {
    cellSizeM,
    crs: nonEmptyString(t.crs, 'terrain.crs'),
    verticalDatum: nonEmptyString(t.verticalDatum, 'terrain.verticalDatum'),
    holdoutSeed: nonNegativeInt(t.holdoutSeed, 'terrain.holdoutSeed'),
  };
}

export function parseReproducibilityConfig(input: unknown): ReproducibilityConfig {
  const c = asRecord(input, 'reproducibility config');
  if (c.suiteId !== 'reproducibility') fail("suiteId must be 'reproducibility'");
  if (c.scalarTolerance !== 0) {
    // Not a style rule: a non-zero tolerance changes what the suite's pass
    // means, so it cannot be introduced by editing a JSON file. Widening it
    // takes changing the type above and writing down the justification.
    fail('scalarTolerance must be exactly 0 — see the field comment for why');
  }
  return {
    suiteId: 'reproducibility',
    seed: finiteNumber(c.seed, 'seed'),
    pointCount: positiveInt(c.pointCount, 'pointCount'),
    warmupRuns: nonNegativeInt(c.warmupRuns, 'warmupRuns'),
    recordedRuns: positiveInt(c.recordedRuns, 'recordedRuns'),
    terrain: parseTerrain(c.terrain),
    scalarTolerance: 0,
  };
}

export function parseScalingConfig(input: unknown): ScalingConfig {
  const c = asRecord(input, 'scaling config');
  if (c.suiteId !== 'scaling') fail("suiteId must be 'scaling'");
  if (!Array.isArray(c.tiers) || c.tiers.length === 0) fail('tiers must be a non-empty array');

  const seenIds = new Set<string>();
  let previous = 0;
  const tiers: ScalingTier[] = c.tiers.map((raw, i) => {
    const t = asRecord(raw, `tiers[${i}]`);
    const id = nonEmptyString(t.id, `tiers[${i}].id`);
    if (seenIds.has(id)) fail(`duplicate tier id ${JSON.stringify(id)}`);
    seenIds.add(id);
    const pointCount = positiveInt(t.pointCount, `tiers[${i}].pointCount`);
    // Ascending order is what makes the emitted table a curve rather than a
    // scatter, and it is also the order that keeps a run's memory high-water
    // mark monotone — an out-of-order ladder would charge a small tier with the
    // heap a larger one had just left behind.
    if (pointCount <= previous) {
      fail(`tiers must ascend by pointCount; ${id} (${pointCount}) does not exceed ${previous}`);
    }
    previous = pointCount;
    return { id, pointCount };
  });

  const acceptedRaw = c.acceptedTierFailures ?? [];
  if (!Array.isArray(acceptedRaw)) fail('acceptedTierFailures must be an array');
  const acceptedTierFailures = acceptedRaw.map((v, i) => {
    const id = nonEmptyString(v, `acceptedTierFailures[${i}]`);
    if (!seenIds.has(id)) fail(`acceptedTierFailures names unknown tier ${JSON.stringify(id)}`);
    return id;
  });

  return {
    suiteId: 'scaling',
    seed: finiteNumber(c.seed, 'seed'),
    tiers,
    warmupRuns: nonNegativeInt(c.warmupRuns, 'warmupRuns'),
    recordedRuns: positiveInt(c.recordedRuns, 'recordedRuns'),
    terrain: parseTerrain(c.terrain),
    acceptedTierFailures,
  };
}
