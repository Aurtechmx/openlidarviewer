/**
 * types.ts
 *
 * The schema every benchmark suite and every reporter shares.
 *
 * The one rule the whole framework exists to enforce: a measurement that was not
 * taken is never written down as a number. Reports produced here are meant to be
 * read as evidence, and a `0` standing in for "we could not measure this" is
 * indistinguishable from a genuine 0 once it reaches a table or a plot. So the
 * metric type is a discriminated union in which the unavailable branch pins
 * `value` to `null` and REQUIRES a reason — `{ status: 'unavailable', value: 12 }`
 * does not typecheck, and neither does an unavailable metric with a unit.
 *
 * Every metric also carries the runtime it can be taken in and whether it is
 * reproducible, because the suites mix Node-side measurements (decode time, RSS)
 * with browser-only ones (GPU frame time). Without those two flags a reader
 * cannot tell a fixed property of the software from a number that moves between
 * runs and machines.
 *
 * Pure data + guards. No I/O, no clock, no randomness — safe to import anywhere.
 */

/** Where a metric can physically be taken. */
export type MetricRuntime = 'node' | 'browser';

/** Bumped whenever a field changes meaning, so an old report is never misread. */
export const BENCHMARK_SCHEMA_VERSION = 1;

/** The two facts every metric declares regardless of whether it was measured. */
export interface MetricProvenance {
  readonly runtime: MetricRuntime;
  /** True only if an identical re-run must produce the identical value. */
  readonly deterministic: boolean;
}

/** A measurement that was actually taken. Always has a value AND a unit. */
export interface MeasuredMetric extends MetricProvenance {
  readonly status: 'measured';
  readonly value: number;
  readonly unit: string;
  /** Structurally forbids a measured metric from carrying an excuse. */
  readonly reason?: never;
}

/** A measurement that could not be taken. Never has a value, always has a why. */
export interface UnavailableMetric extends MetricProvenance {
  readonly status: 'unavailable';
  readonly value: null;
  readonly reason: string;
  /** Structurally forbids an unavailable metric from carrying a unit. */
  readonly unit?: never;
}

export type Metric = MeasuredMetric | UnavailableMetric;

/**
 * Build a measured metric.
 *
 * Rejects a non-finite value because `JSON.stringify(NaN)` is `null`: a NaN that
 * slipped through would serialise as a null value under status 'measured' — the
 * precise contradiction the schema is built to make impossible. Rejects an empty
 * unit for the same class of reason: a bare number is not a measurement.
 */
export function measured(value: number, unit: string, p: MetricProvenance): MeasuredMetric {
  if (!Number.isFinite(value)) {
    throw new Error(`benchmark metric: value must be finite, got ${String(value)}`);
  }
  if (unit.trim() === '') throw new Error('benchmark metric: unit must not be empty');
  return { status: 'measured', value, unit, runtime: p.runtime, deterministic: p.deterministic };
}

/**
 * Build an unavailable metric.
 *
 * The reason is mandatory and must be non-empty: "unavailable" on its own tells
 * a reviewer nothing about whether the number is missing because the runtime
 * cannot supply it or because the run went wrong.
 */
export function unavailable(reason: string, p: MetricProvenance): UnavailableMetric {
  if (reason.trim() === '') throw new Error('benchmark metric: unavailable needs a reason');
  return { status: 'unavailable', value: null, reason, runtime: p.runtime, deterministic: p.deterministic };
}

export function isMeasured(m: Metric): m is MeasuredMetric {
  return m.status === 'measured';
}

export function isUnavailable(m: Metric): m is UnavailableMetric {
  return m.status === 'unavailable';
}

/**
 * An environment field. Strings rather than numbers, but the same contract: a
 * field the framework could not determine says so and explains why, instead of
 * defaulting to '' or 'unknown' — both of which read as data further downstream.
 */
export interface CapturedEnvValue {
  readonly status: 'captured';
  readonly value: string;
  readonly reason?: never;
}

export interface UnavailableEnvValue {
  readonly status: 'unavailable';
  readonly value: null;
  readonly reason: string;
}

export type EnvValue = CapturedEnvValue | UnavailableEnvValue;

export function capturedEnv(value: string): CapturedEnvValue {
  if (value.trim() === '') throw new Error('benchmark env: captured value must not be empty');
  return { status: 'captured', value };
}

export function unavailableEnv(reason: string): UnavailableEnvValue {
  if (reason.trim() === '') throw new Error('benchmark env: unavailable needs a reason');
  return { status: 'unavailable', value: null, reason };
}

/** The provenance block: everything a reader needs to place a run in context. */
export interface BenchmarkEnvironment {
  /** OS platform and release, e.g. "darwin 24.0.0". */
  readonly os: EnvValue;
  readonly cpuModel: EnvValue;
  readonly arch: EnvValue;
  readonly nodeVersion: EnvValue;
  readonly gitCommitShort: EnvValue;
  readonly gitCommitFull: EnvValue;
  /** The `version` field of package.json — the release the run belongs to. */
  readonly releaseVersion: EnvValue;
}

/** One timed stage of a suite. Duration is ms, peak memory is bytes. */
export interface StageResult {
  readonly name: string;
  readonly duration: Metric;
  readonly peakMemory: Metric;
  readonly status: 'ok' | 'failed';
  /** Present only when `status` is 'failed'; the message, never a stack. */
  readonly error?: string;
}

/**
 * The hash record of one scientific artifact.
 *
 * `strippedFields` is part of the record on purpose: it names the fields that
 * were removed before hashing, so a reviewer comparing two hashes can see what
 * the comparison deliberately ignores without reading the framework source.
 */
interface ArtifactRecordBase {
  readonly name: string;
  readonly kind: 'json' | 'bytes';
  readonly algorithm: 'sha256';
  /** Lowercase hex SHA-256 of the canonical, volatility-stripped form. */
  readonly hash: string;
  /** Short FNV-1a fingerprint of the same canonical form, for compact tables. */
  readonly fingerprint: string;
  readonly byteLength: number;
  /** Dotted paths excluded from the hash, sorted. Empty for byte artifacts. */
  readonly strippedFields: readonly string[];
}

/** An artifact whose contents could be inspected, so the strip actually ran. */
export interface StrippedArtifactRecord extends ArtifactRecordBase {
  readonly volatilityStripped: true;
  /** Nothing to explain when the strip ran — structurally unsayable. */
  readonly unstrippedReason?: never;
}

/** An artifact hashed raw, which is a caveat on the hash and must be explained. */
export interface UnstrippedArtifactRecord extends ArtifactRecordBase {
  readonly volatilityStripped: false;
  readonly unstrippedReason: string;
}

/**
 * Split on `volatilityStripped` for the same reason `Metric` is split on
 * `status`: `strippedFields: []` is ambiguous on its own — it reads as "nothing
 * volatile in here" when the truth may be "nothing could be inspected" — and a
 * disclosure that a gap exists WITHOUT saying why is the one thing this
 * framework must never emit. `hashArtifact` is not the only constructor (suites
 * and fixtures hand-build records), so the guarantee has to be structural: an
 * unexplained gap and a contradictory explanation are both compile errors.
 */
export type ArtifactRecord = StrippedArtifactRecord | UnstrippedArtifactRecord;

/** The whole result of one suite run against one dataset. */
export interface RunReport {
  readonly schemaVersion: number;
  readonly suiteId: string;
  readonly datasetId: string;
  readonly environment: BenchmarkEnvironment;
  readonly stages: readonly StageResult[];
  readonly artifacts: readonly ArtifactRecord[];
  /** Suite-level headline numbers, keyed by name (e.g. `pointsPerSecond`). */
  readonly metrics: Readonly<Record<string, Metric>>;
}
