/**
 * spatialBootstrap.ts
 *
 * Resampling that respects spatial correlation.
 *
 * Why the module exists. Neighbouring cells and neighbouring checkpoints are
 * not independent: they share a flight line, a stand of trees, a survey session,
 * a ground-control geometry. A bootstrap that resamples individual observations
 * treats each one as fresh information, so it counts the same information many
 * times over and returns an interval that is far too narrow. Resampling whole
 * blocks keeps the correlated observations together, so the interval reflects
 * how many independent places were actually visited rather than how many cells
 * were exported. `tests/spatialBootstrap.test.ts` demonstrates the gap on
 * correlated input; if that test ever stops showing it, this module is broken.
 *
 * Determinism. Every resampling entry point takes an integer seed and uses a
 * seeded generator, never `Math.random`. The seed is echoed in every result and
 * in every refusal detail, so a reported interval can be recomputed exactly and
 * a failure can be reproduced from its message alone.
 *
 * Refusals are typed results. A single block cannot support a block interval,
 * and returning a zero-width one would be worse than returning nothing.
 *
 * Pure arithmetic over plain arrays. No I/O, no DOM.
 */

/** One observation and the spatial block (tile, plot, site) it belongs to. */
export interface BlockSample {
  readonly value: number;
  readonly blockId: string;
}

/** Any statistic over a set of observations. Defaults to the mean. */
export type Statistic = (values: readonly number[]) => number;

export interface BootstrapOptions {
  /** Non-negative integer. Echoed in the result and in refusal details. */
  readonly seed: number;
  readonly iterations: number;
  /** Two-sided coverage as a fraction, for example 0.95. */
  readonly confidence: number;
  readonly statistic?: Statistic;
  /** Refuse below this many blocks. Default `MIN_BLOCKS_FOR_INTERVAL`. */
  readonly minBlocks?: number;
}

export interface JackknifeOptions {
  readonly statistic?: Statistic;
  /** Refuse below this many sites. Default `MIN_SITES_FOR_LOSO`. */
  readonly minSites?: number;
}

/**
 * Fewest blocks a block interval may be built from.
 *
 * With one block there is no between-block variation left to resample: every
 * replicate is the original sample, the interval collapses to zero width, and a
 * zero-width interval reads as infinite precision. Two is the arithmetic floor,
 * not a recommendation; an interval from two blocks is extremely coarse and the
 * block count is reported so a reader can see that.
 */
export const MIN_BLOCKS_FOR_INTERVAL = 2;

/** Leaving one site out requires at least two sites to have anything left. */
export const MIN_SITES_FOR_LOSO = 2;

/**
 * Fewest resamples a percentile interval may be built from.
 *
 * Below roughly this many replicates the interval endpoints are dominated by
 * resampling noise rather than by the data, so two runs with different seeds
 * disagree more than the underlying uncertainty. Frozen here so it cannot be
 * lowered to make a slow test faster.
 */
export const MIN_BOOTSTRAP_ITERATIONS = 200;

export type BootstrapRefusalReason =
  | 'no-samples'
  | 'non-finite-value'
  | 'invalid-seed'
  | 'invalid-iterations'
  | 'invalid-confidence'
  | 'invalid-min-blocks'
  | 'too-few-blocks'
  | 'too-few-sites'
  | 'non-finite-statistic';

export interface BootstrapRefusal {
  readonly status: 'refused';
  readonly reason: BootstrapRefusalReason;
  /** Includes the seed, so the run can be reproduced from the message. */
  readonly detail: string;
  /** null for `leaveOneSiteOut`, which draws no random numbers. */
  readonly seed: number | null;
}

export type BootstrapMethod = 'naive' | 'block' | 'cluster';

export interface BootstrapEstimate {
  readonly status: 'estimated';
  readonly method: BootstrapMethod;
  readonly seed: number;
  readonly iterations: number;
  readonly confidence: number;
  readonly n: number;
  /** Distinct blocks resampled. null for the naive per-observation method. */
  readonly blocks: number | null;
  /** The statistic on the observed sample, not the mean of the replicates. */
  readonly estimate: number;
  readonly lower: number;
  readonly upper: number;
  readonly width: number;
  /** Standard deviation of the replicate statistics. */
  readonly standardError: number;
}

export interface SiteOmission {
  readonly siteId: string;
  /** Observations dropped with this site. */
  readonly omitted: number;
  /** The statistic recomputed on everything else. */
  readonly statistic: number;
}

export interface LeaveOneSiteOutResult {
  readonly status: 'estimated';
  readonly method: 'leave-one-site-out';
  /** No randomness is involved, so there is no seed to report. */
  readonly seed: null;
  readonly n: number;
  readonly sites: number;
  readonly estimate: number;
  readonly perSite: readonly SiteOmission[];
  readonly min: number;
  readonly max: number;
  readonly range: number;
  /** Jackknife standard error over sites. */
  readonly standardError: number;
  /** Jackknife bias estimate: (sites − 1) × (mean of omissions − estimate). */
  readonly bias: number;
}

export type BootstrapResult = BootstrapEstimate | BootstrapRefusal;
export type LeaveOneSiteOutOutcome = LeaveOneSiteOutResult | BootstrapRefusal;

function refuse(
  reason: BootstrapRefusalReason,
  detail: string,
  seed: number | null,
): BootstrapRefusal {
  const withSeed = seed === null ? detail : `${detail} (seed=${seed})`;
  return { status: 'refused', reason, detail: withSeed, seed };
}

function mean(values: readonly number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/**
 * mulberry32. A small, fast, fully specified 32-bit generator.
 *
 * Chosen because the whole algorithm is visible here: a reader can reproduce a
 * published interval in another language from these four lines, which is not
 * true of a platform generator.
 */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Nearest-rank quantile, so an endpoint is always an observed replicate. */
function quantileSorted(sorted: readonly number[], p: number): number {
  const idx = Math.max(0, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function standardDeviation(values: readonly number[]): number {
  const m = mean(values);
  let ss = 0;
  for (const v of values) {
    const d = v - m;
    ss += d * d;
  }
  return Math.sqrt(ss / (values.length - 1));
}

/** Option checks shared by the three resampling methods. */
function checkOptions(options: BootstrapOptions): BootstrapRefusal | null {
  const { seed, iterations, confidence } = options;
  if (!Number.isInteger(seed) || seed < 0) {
    return refuse('invalid-seed', `seed must be a non-negative integer, got ${seed}`, null);
  }
  if (!Number.isInteger(iterations) || iterations < MIN_BOOTSTRAP_ITERATIONS) {
    return refuse(
      'invalid-iterations',
      `iterations must be an integer >= ${MIN_BOOTSTRAP_ITERATIONS}, got ${iterations}`,
      seed,
    );
  }
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    return refuse(
      'invalid-confidence',
      `confidence must be a fraction strictly between 0 and 1, got ${confidence}`,
      seed,
    );
  }
  const minBlocks = options.minBlocks ?? MIN_BLOCKS_FOR_INTERVAL;
  if (!Number.isInteger(minBlocks) || minBlocks < MIN_BLOCKS_FOR_INTERVAL) {
    return refuse(
      'invalid-min-blocks',
      `minBlocks must be an integer >= ${MIN_BLOCKS_FOR_INTERVAL}, got ${minBlocks}`,
      seed,
    );
  }
  return null;
}

/** Group observations by block, preserving first-seen block order. */
function groupByBlock(samples: readonly BlockSample[]): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const s of samples) {
    let bucket = groups.get(s.blockId);
    if (!bucket) {
      bucket = [];
      groups.set(s.blockId, bucket);
    }
    bucket.push(s.value);
  }
  return groups;
}

function firstNonFinite(values: readonly number[]): number {
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) return i;
  }
  return -1;
}

/** Turn a set of replicate statistics into a percentile interval. */
function intervalOf(
  replicates: readonly number[],
  confidence: number,
): { lower: number; upper: number; width: number; standardError: number } {
  const sorted = [...replicates].sort((a, b) => a - b);
  const tail = (1 - confidence) / 2;
  const lower = quantileSorted(sorted, tail);
  const upper = quantileSorted(sorted, 1 - tail);
  return { lower, upper, width: upper - lower, standardError: standardDeviation(replicates) };
}

/**
 * Per-observation bootstrap. Present for comparison only.
 *
 * On spatially correlated data this interval is too narrow, because it assumes
 * every observation is independent information. It is exported so a study can
 * show the size of that error rather than assert it.
 */
export function naiveBootstrap(
  values: readonly number[],
  options: BootstrapOptions,
): BootstrapResult {
  const bad = checkOptions(options);
  if (bad) return bad;
  const { seed, iterations, confidence } = options;
  if (values.length === 0) {
    return refuse('no-samples', 'no observations supplied', seed);
  }
  const badIdx = firstNonFinite(values);
  if (badIdx >= 0) {
    return refuse(
      'non-finite-value',
      `observation ${badIdx} is not finite (${values[badIdx]})`,
      seed,
    );
  }
  const statistic = options.statistic ?? mean;
  const rng = makeRng(seed);
  const n = values.length;
  const replicates: number[] = [];
  const draw = new Array<number>(n);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) draw[i] = values[Math.floor(rng() * n)];
    const s = statistic(draw);
    if (!Number.isFinite(s)) {
      return refuse(
        'non-finite-statistic',
        `statistic returned ${s} on replicate ${it}`,
        seed,
      );
    }
    replicates.push(s);
  }
  const observed = statistic(values);
  if (!Number.isFinite(observed)) {
    return refuse('non-finite-statistic', `statistic returned ${observed} on the observed sample`, seed);
  }
  return {
    status: 'estimated',
    method: 'naive',
    seed,
    iterations,
    confidence,
    n,
    blocks: null,
    estimate: observed,
    ...intervalOf(replicates, confidence),
  };
}

/**
 * Spatial-block bootstrap: resample whole blocks with replacement, pooling the
 * observations of the drawn blocks and applying the statistic to the pool.
 *
 * As many blocks are drawn as the sample has, so a replicate holds roughly as
 * many observations as the original. Pooling means a large block carries more
 * weight than a small one, matching how the observed statistic was computed.
 * Use `clusterBootstrap` when every site should count equally instead.
 */
export function blockBootstrap(
  samples: readonly BlockSample[],
  options: BootstrapOptions,
): BootstrapResult {
  const bad = checkOptions(options);
  if (bad) return bad;
  const { seed, iterations, confidence } = options;
  if (samples.length === 0) {
    return refuse('no-samples', 'no observations supplied', seed);
  }
  const values = samples.map((s) => s.value);
  const badIdx = firstNonFinite(values);
  if (badIdx >= 0) {
    return refuse(
      'non-finite-value',
      `observation ${badIdx} (block ${samples[badIdx].blockId}) is not finite (${values[badIdx]})`,
      seed,
    );
  }
  const groups = [...groupByBlock(samples).values()];
  const minBlocks = options.minBlocks ?? MIN_BLOCKS_FOR_INTERVAL;
  if (groups.length < minBlocks) {
    return refuse(
      'too-few-blocks',
      `${groups.length} block(s) present, ${minBlocks} required; ` +
        'a single block leaves no between-block variation to resample',
      seed,
    );
  }

  const statistic = options.statistic ?? mean;
  const rng = makeRng(seed);
  const k = groups.length;
  const replicates: number[] = [];
  for (let it = 0; it < iterations; it++) {
    const pool: number[] = [];
    for (let d = 0; d < k; d++) {
      const block = groups[Math.floor(rng() * k)];
      for (const v of block) pool.push(v);
    }
    const s = statistic(pool);
    if (!Number.isFinite(s)) {
      return refuse('non-finite-statistic', `statistic returned ${s} on replicate ${it}`, seed);
    }
    replicates.push(s);
  }
  const observed = statistic(values);
  if (!Number.isFinite(observed)) {
    return refuse('non-finite-statistic', `statistic returned ${observed} on the observed sample`, seed);
  }
  return {
    status: 'estimated',
    method: 'block',
    seed,
    iterations,
    confidence,
    n: samples.length,
    blocks: k,
    estimate: observed,
    ...intervalOf(replicates, confidence),
  };
}

/**
 * Cluster bootstrap: resample clusters with replacement, and weight every
 * cluster equally by taking the statistic WITHIN each drawn cluster and then
 * averaging those.
 *
 * This is the difference from `blockBootstrap`, and it changes the quantity
 * being estimated, not just the interval: here the target is the average over
 * sites, so a site with 1000 cells does not outvote a site with 20. That is the
 * right target when sites were sampled and cell counts are an artefact of
 * survey effort; it is the wrong target when the cells themselves are the
 * population. The observed estimate reported here is the same cluster-averaged
 * quantity, so estimate and interval describe one thing.
 */
export function clusterBootstrap(
  samples: readonly BlockSample[],
  options: BootstrapOptions,
): BootstrapResult {
  const bad = checkOptions(options);
  if (bad) return bad;
  const { seed, iterations, confidence } = options;
  if (samples.length === 0) {
    return refuse('no-samples', 'no observations supplied', seed);
  }
  const values = samples.map((s) => s.value);
  const badIdx = firstNonFinite(values);
  if (badIdx >= 0) {
    return refuse(
      'non-finite-value',
      `observation ${badIdx} (cluster ${samples[badIdx].blockId}) is not finite (${values[badIdx]})`,
      seed,
    );
  }
  const groups = [...groupByBlock(samples).values()];
  const minBlocks = options.minBlocks ?? MIN_BLOCKS_FOR_INTERVAL;
  if (groups.length < minBlocks) {
    return refuse(
      'too-few-blocks',
      `${groups.length} cluster(s) present, ${minBlocks} required`,
      seed,
    );
  }

  const statistic = options.statistic ?? mean;
  const perCluster = groups.map((g) => statistic(g));
  const badCluster = firstNonFinite(perCluster);
  if (badCluster >= 0) {
    return refuse(
      'non-finite-statistic',
      `statistic returned ${perCluster[badCluster]} on cluster index ${badCluster}`,
      seed,
    );
  }

  const rng = makeRng(seed);
  const k = groups.length;
  const replicates: number[] = [];
  const draw = new Array<number>(k);
  for (let it = 0; it < iterations; it++) {
    for (let d = 0; d < k; d++) draw[d] = perCluster[Math.floor(rng() * k)];
    replicates.push(mean(draw));
  }
  return {
    status: 'estimated',
    method: 'cluster',
    seed,
    iterations,
    confidence,
    n: samples.length,
    blocks: k,
    estimate: mean(perCluster),
    ...intervalOf(replicates, confidence),
  };
}

/**
 * Leave-one-site-out: recompute the statistic with each site removed in turn.
 *
 * No randomness, so no seed. This answers a different question from the
 * bootstrap intervals: not "how uncertain is the estimate" but "does one site
 * carry the result". A wide `range` means the pooled figure is a statement
 * about one place, whatever its interval says.
 */
export function leaveOneSiteOut(
  samples: readonly BlockSample[],
  options: JackknifeOptions = {},
): LeaveOneSiteOutOutcome {
  if (samples.length === 0) {
    return refuse('no-samples', 'no observations supplied', null);
  }
  const values = samples.map((s) => s.value);
  const badIdx = firstNonFinite(values);
  if (badIdx >= 0) {
    return refuse(
      'non-finite-value',
      `observation ${badIdx} (site ${samples[badIdx].blockId}) is not finite (${values[badIdx]})`,
      null,
    );
  }
  const groups = groupByBlock(samples);
  const minSites = options.minSites ?? MIN_SITES_FOR_LOSO;
  if (groups.size < minSites) {
    return refuse(
      'too-few-sites',
      `${groups.size} site(s) present, ${minSites} required; ` +
        'omitting the only site leaves nothing to recompute',
      null,
    );
  }

  const statistic = options.statistic ?? mean;
  const estimate = statistic(values);
  if (!Number.isFinite(estimate)) {
    return refuse('non-finite-statistic', `statistic returned ${estimate} on the full sample`, null);
  }

  // A comparator rather than a bare sort(), and deliberately NOT localeCompare.
  // Static analysis asks for localeCompare here; it is wrong for this file.
  // localeCompare depends on the runtime locale and the ICU build, so the same
  // keys can order differently on two machines and a study record stops being
  // reproducible. Comparing by code unit is fixed by the language spec, which
  // is what a deterministic record needs. Same rule as the benchmark artifact
  // ordering.
  const siteIds = [...groups.keys()].sort((a, b) => {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
  const perSite: SiteOmission[] = [];
  for (const siteId of siteIds) {
    const kept: number[] = [];
    for (const s of samples) {
      if (s.blockId !== siteId) kept.push(s.value);
    }
    const s = statistic(kept);
    if (!Number.isFinite(s)) {
      return refuse(
        'non-finite-statistic',
        `statistic returned ${s} with site ${siteId} omitted`,
        null,
      );
    }
    perSite.push({ siteId, omitted: groups.get(siteId)!.length, statistic: s });
  }

  const stats = perSite.map((p) => p.statistic);
  const m = mean(stats);
  let ss = 0;
  for (const v of stats) ss += (v - m) * (v - m);
  const sites = perSite.length;
  // Standard jackknife SE: ((k-1)/k) × Σ(θ_(i) − mean θ_(i))², square-rooted.
  const standardError = Math.sqrt(((sites - 1) / sites) * ss);
  return {
    status: 'estimated',
    method: 'leave-one-site-out',
    seed: null,
    n: samples.length,
    sites,
    estimate,
    perSite,
    min: Math.min(...stats),
    max: Math.max(...stats),
    range: Math.max(...stats) - Math.min(...stats),
    standardError,
    bias: (sites - 1) * (m - estimate),
  };
}
