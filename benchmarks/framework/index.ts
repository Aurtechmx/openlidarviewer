/**
 * index.ts
 *
 * The framework's runtime-neutral public surface. A benchmark suite imports the
 * schema, the instruments and the reporters from here, so the modules underneath
 * can be reorganised without touching three suites — and so the honesty contract
 * has exactly one front door: there is no exported way to build a metric that
 * carries a number it did not measure.
 *
 * NOTHING reachable from this file may import a `node:` builtin. The schema
 * advertises browser-taken metrics and `clock.ts`/`memory.ts` both have browser
 * branches, so a browser-side suite has to be able to bundle this. Anything that
 * needs a filesystem, a subprocess or `node:crypto` lives in `./node.ts`, and a
 * source guard in the test suite keeps it that way.
 */

export {
  BENCHMARK_SCHEMA_VERSION,
  measured,
  unavailable,
  isMeasured,
  isUnavailable,
  capturedEnv,
  unavailableEnv,
} from './types';
export type {
  ArtifactRecord,
  BenchmarkEnvironment,
  CapturedEnvValue,
  EnvValue,
  MeasuredMetric,
  Metric,
  MetricProvenance,
  MetricRuntime,
  FailedStageResult,
  OkStageResult,
  RunReport,
  StageResult,
  StrippedArtifactRecord,
  UnavailableEnvValue,
  UnavailableMetric,
  UnstrippedArtifactRecord,
} from './types';

export { startStageClock, elapsedMs, readMonotonicNs, CLOCK_UNAVAILABLE_REASON } from './clock';
export { startMemorySampler, readProcessRss, MEMORY_UNAVAILABLE_REASON } from './memory';
export type { MemorySampler, MemorySamplerOptions } from './memory';
export { runStage, runStageAsync } from './stage';
export type { RunStageOptions, StageOutcome } from './stage';
// `captureEnvironment` is deliberately NOT here — see the header. Import it from
// `./node.ts`, together with the fast `node:crypto` digest.
export {
  assertHashable,
  hashArtifact,
  stripVolatile,
  AMBIGUOUS_CLOCK_KEYS,
  MAX_ARTIFACT_DEPTH,
  PORTABLE_DIGEST_MIB_PER_SEC,
  VOLATILE_RULES,
  VOLATILE_PLACEHOLDER,
  RAW_BYTES_NO_STRIP_REASON,
} from './artifacts';
export type {
  DigestFn,
  HashArtifactOptions,
  StripResult,
  VolatileKind,
  VolatileRule,
} from './artifacts';

export { toJson } from './reporters/json';
export { toCsv } from './reporters/csv';
export { toMarkdown } from './reporters/markdown';
export { toHtml } from './reporters/html';
export {
  formatMetric,
  formatEnvValue,
  describeHashExclusions,
  UNAVAILABLE_LABEL,
} from './reporters/metricText';
