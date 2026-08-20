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

/**
 * Bumped when a raw, summary or manifest file changes meaning.
 *
 * 2 — the manifest gained `forcedGc`. A version-1 manifest is silent about the
 * garbage-collection regime, which is not the same claim as "GC was not
 * controlled", and a reader must not be able to mistake one for the other.
 *
 * The `loaderComparison` suite did NOT bump this: it adds a self-contained suite
 * directory and a `suites[]` entry, and `suites[]` already tells a reader which
 * suites ran, so a version-2 tree without it is not misread — exactly as one
 * without the scaling ladder is not. No existing file changed meaning, which is
 * the only thing this number tracks.
 */
export const BENCHMARK_SCHEMA_VERSION = 2;

/**
 * The version of the benchmark package itself, independent of the OLV release.
 * A reader comparing two result sets needs to know whether the harness changed
 * as well as whether the application did.
 */
export const BENCHMARK_PACKAGE_VERSION = '1.1.0';

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

/**
 * Warm-up runs before anything is recorded.
 *
 * SIX, and the number comes from a measured trace rather than a guess. With a
 * single warm-up the first two recorded runs came in about 11 % slower than the
 * rest — a transient, not noise — which inflated the published coefficient of
 * variation by roughly 2.4x and made a steady pipeline look unstable.
 *
 * The obvious fix, "use three", does not work, and that is worth writing down
 * because it is the number anyone would reach for next. A 24-run trace of the
 * 250k analysis on this machine decays gradually rather than falling off a
 * cliff (ms, in order):
 *
 *   1181 983 995 919 976 898 | 856 899 857 886 896 889 875 894 901 859 …
 *
 * Run 1 is 37 % above the asymptote and runs 2-6 are still 5-15 % above it, so
 * three warm-ups leaves the first recorded runs sitting on the tail — exactly
 * the ~8 % first-run offset the three-warm-up configuration still showed. From
 * run 7 the series is flat to within ordinary noise, and recording there gives
 * a coefficient of variation near 0.02 instead of near 0.05.
 *
 * The cost is real and bounded: six extra runs per tier, a couple of minutes
 * across the whole ladder. That buys a repeatability figure that means what a
 * reader takes it to mean, which is the entire point of publishing one. Both
 * suites still record where run 1 sits relative to the rest, so a transient
 * that returns is visible rather than absorbed into the spread.
 */
export const WARMUP_RUNS = 6;

export const REPRODUCIBILITY_CONFIG: ReproducibilityConfig = {
  suiteId: 'reproducibility',
  seed: BENCHMARK_SEED,
  pointCount: 250_000,
  warmupRuns: WARMUP_RUNS,
  recordedRuns: 10,
  terrain: TERRAIN_CONFIG,
  scalarTolerance: 0,
};

/** One rung of the scaling ladder. */
export interface ScalingTier {
  readonly id: string;
  readonly pointCount: number;
}

/**
 * How the tiers are separated from one another.
 *
 * `'process-per-tier'` — every tier runs in a fresh child process.
 * `'single-process'`   — every tier runs in one process, in ladder order.
 *
 * WHY THIS IS A RECORDED FIELD AND NOT A DETAIL. Run in one process, tier order
 * is perfectly confounded with process history: JIT state, heap growth and
 * whatever the previous tier left behind all advance monotonically alongside the
 * point count, so the memory column measures the process rather than the
 * workload. Measured both ways on the same machine, the IDENTICAL 250k
 * workload reported peak RSS about 50 % apart depending only on what had run
 * before it. A reader has to be able to see which regime produced a curve, so
 * the mode is written into `raw.json` and into the manifest's configuration
 * block rather than being implied by the code that happened to run.
 */
export type TierIsolation = 'process-per-tier' | 'single-process';

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
  /** See {@link TierIsolation}. Recorded on every result set. */
  readonly isolation: TierIsolation;
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
  warmupRuns: WARMUP_RUNS,
  recordedRuns: 5,
  terrain: TERRAIN_CONFIG,
  acceptedTierFailures: [],
  isolation: 'process-per-tier',
};

/**
 * One file the loader comparison times both loaders on.
 *
 * A case is a LAS version and a size. The version is the whole point: the
 * competitor (loaders.gl's LASLoader) reads LAS 1.2 and refuses LAS 1.4
 * outright, and that split is a measured result, not an assumption — so a 1.2
 * case expects the competitor to decode and a 1.4 case expects it to reject.
 * `competitorReadable` records which is which, and the suite fails if reality
 * disagrees (a competitor that suddenly reads a 1.4 file, or refuses a 1.2 one).
 */
export interface LoaderCase {
  readonly id: string;
  readonly lasVersion: '1.2' | '1.4';
  readonly pointCount: number;
  readonly competitorReadable: boolean;
}

/**
 * The loader-comparison suite: OLV's `loadLas` against a standard web loader on
 * identical, deterministically generated uncompressed LAS files.
 *
 * WHY UNCOMPRESSED, AND WHY IN-PROCESS FIXTURES. laz-perf ships no encoder, so a
 * `.laz` fixture can only be made by shelling out to an external tool, and the
 * suite would then measure a machine's PDAL install as much as its loaders. The
 * two writers in `src/convert/writeLas.ts` produce byte-exact LAS 1.2 and 1.4
 * from a seeded synthetic cloud with no external tool and no entropy, so the
 * INPUT is as reproducible as the rest of the harness; only the timings vary,
 * exactly as they do for the scaling ladder.
 *
 * WHY THE COMPETITOR IS NOT NAMED AS A DEPENDENCY HERE. Every module under
 * `benchmarks/` may import only `node:` builtins and repo-relative paths (a
 * source guard enforces it, so a browser-side suite can bundle the tree). The
 * competitor decoder is therefore injected by the Node entry point, which lives
 * outside the guarded tree; this config carries only its identity, and the
 * runner records the version the entry point captured at run time.
 */
export interface LoaderComparisonConfig {
  readonly suiteId: 'loaderComparison';
  readonly seed: number;
  readonly warmupRuns: number;
  readonly recordedRuns: number;
  /** The competitor being timed. Identity only; the version is captured at run time. */
  readonly competitor: { readonly name: string; readonly packageName: string };
  readonly cases: readonly LoaderCase[];
}

export const LOADER_COMPARISON_CONFIG: LoaderComparisonConfig = {
  suiteId: 'loaderComparison',
  seed: BENCHMARK_SEED,
  warmupRuns: WARMUP_RUNS,
  recordedRuns: 5,
  competitor: { name: 'loaders.gl LASLoader', packageName: '@loaders.gl/las' },
  cases: [
    // The common ground both loaders accept: the honest head-to-head.
    { id: 'las-1.2', lasVersion: '1.2', pointCount: 1_000_000, competitorReadable: true },
    // The capability gap: OLV decodes it, the competitor refuses the version.
    { id: 'las-1.4', lasVersion: '1.4', pointCount: 1_000_000, competitorReadable: false },
  ],
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

  if (c.isolation !== 'process-per-tier' && c.isolation !== 'single-process') {
    fail(`isolation must be 'process-per-tier' or 'single-process', got ${JSON.stringify(c.isolation)}`);
  }

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
    isolation: c.isolation,
  };
}

function parseCompetitor(value: unknown): { name: string; packageName: string } {
  const c = asRecord(value, 'competitor');
  return {
    name: nonEmptyString(c.name, 'competitor.name'),
    packageName: nonEmptyString(c.packageName, 'competitor.packageName'),
  };
}

export function parseLoaderComparisonConfig(input: unknown): LoaderComparisonConfig {
  const c = asRecord(input, 'loader comparison config');
  if (c.suiteId !== 'loaderComparison') fail("suiteId must be 'loaderComparison'");
  if (!Array.isArray(c.cases) || c.cases.length === 0) fail('cases must be a non-empty array');

  const seenIds = new Set<string>();
  const cases: LoaderCase[] = c.cases.map((raw, i) => {
    const t = asRecord(raw, `cases[${i}]`);
    const id = nonEmptyString(t.id, `cases[${i}].id`);
    if (seenIds.has(id)) fail(`duplicate case id ${JSON.stringify(id)}`);
    seenIds.add(id);
    if (t.lasVersion !== '1.2' && t.lasVersion !== '1.4') {
      fail(`cases[${i}].lasVersion must be '1.2' or '1.4', got ${JSON.stringify(t.lasVersion)}`);
    }
    if (typeof t.competitorReadable !== 'boolean') {
      fail(`cases[${i}].competitorReadable must be a boolean, got ${JSON.stringify(t.competitorReadable)}`);
    }
    return {
      id,
      lasVersion: t.lasVersion,
      pointCount: positiveInt(t.pointCount, `cases[${i}].pointCount`),
      competitorReadable: t.competitorReadable,
    };
  });

  return {
    suiteId: 'loaderComparison',
    seed: finiteNumber(c.seed, 'seed'),
    warmupRuns: nonNegativeInt(c.warmupRuns, 'warmupRuns'),
    recordedRuns: positiveInt(c.recordedRuns, 'recordedRuns'),
    competitor: parseCompetitor(c.competitor),
    cases,
  };
}
