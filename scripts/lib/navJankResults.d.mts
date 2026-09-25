/** Types for navJankResults.mjs, which the nav-jank runner and tests import. */
import type { NavJankRecord } from '../../src/perf/navJankRecord';
import type { NavProbeSummary } from '../../src/perf/navProbe';

export declare const RESULTS_KIND: 'olv-nav-jank-results';
export declare const RESULTS_VERSION: 2;
export declare const SECONDARY_METRICS: readonly string[];
export declare const METRICS: ReadonlyArray<readonly [string, (summary: NavProbeSummary) => number]>;
export declare const FINGERPRINT_KEYS: readonly string[];

export interface Spread { median: number; iqr: number; n: number }

export interface NavJankTrajectoryInput {
  cold?: NavJankRecord;
  warm?: NavJankRecord;
  loads?: unknown[];
  runMeta?: unknown[];
}

export interface NavJankResults {
  kind: 'olv-nav-jank-results';
  version: 2;
  recordSchema: string;
  generatedAt: string;
  machine: string;
  commit: string;
  dataset: Record<string, unknown>;
  fingerprint: Record<string, unknown>;
  trajectories: Record<string, {
    trajectoryDigest: string;
    cold: NavJankRecord | null;
    warm: NavJankRecord | null;
    loads: unknown[];
    runMeta: unknown[];
    coldMetrics: Record<string, number> | null;
    warmMedians: Record<string, Spread> | null;
    longTasksByOwner: Record<string, { count: number; totalMs: number }>;
  }>;
  notes: string[];
}

export declare function quantile(sorted: readonly number[], q: number): number;
export declare function spread(values: readonly number[]): Spread;
export declare function runMetrics(summary: NavProbeSummary): Record<string, number>;
export declare function longTasksByOwner(summaries: readonly NavProbeSummary[]): Record<string, { count: number; totalMs: number }>;
export declare function summarizeRuns(summaries: readonly NavProbeSummary[]): Record<string, Spread>;
export declare function buildNavJankResults(input: {
  generatedAt: string;
  machine: string;
  dataset: Record<string, unknown>;
  trajectories: Record<string, NavJankTrajectoryInput>;
  notes?: string[];
}): NavJankResults;
export declare function mergeNavJankResults(files: readonly NavJankResults[]): NavJankResults;
export declare function resultFileName(date: Date, commit: string, machine: string): string;
