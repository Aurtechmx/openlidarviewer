/**
 * index.ts
 *
 * The framework's public surface. A benchmark suite imports from here and
 * nowhere else, so the modules underneath can be reorganised without touching
 * three suites — and so the honesty contract has exactly one front door: there
 * is no exported way to build a metric that carries a number it did not measure.
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
export { captureEnvironment } from './env';
export type { CaptureEnvironmentOptions } from './env';
export {
  assertHashable,
  hashArtifact,
  stripVolatile,
  AMBIGUOUS_CLOCK_KEYS,
  VOLATILE_RULES,
  VOLATILE_PLACEHOLDER,
  RAW_BYTES_NO_STRIP_REASON,
} from './artifacts';
export type { StripResult, VolatileKind, VolatileRule } from './artifacts';

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
