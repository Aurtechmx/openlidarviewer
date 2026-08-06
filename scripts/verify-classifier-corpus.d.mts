/**
 * Types for `verify-classifier-corpus.mjs`.
 *
 * The gate is plain ESM because it runs under bare `node` with no build step,
 * but `tests/classifierCorpus.test.ts` imports its reducer to prove the gate
 * actually catches a moved corpus and a dropped metric. A gate nobody tests is
 * a gate that can pass vacuously, which is worse than no gate at all.
 */

export interface CorpusExpectation {
  readonly version: number;
  readonly digest: string;
  readonly sceneIds: readonly string[];
}

export interface CorpusBaselineEntry {
  readonly macroF1: number;
  readonly groundRecall: number;
}

export interface CorpusBaseline {
  readonly scenes: Readonly<Record<string, CorpusBaselineEntry>>;
  readonly pooled: CorpusBaselineEntry;
}

export interface CorpusReading {
  readonly scope: string;
  readonly id: string;
  readonly macroF1: number | null;
  readonly groundRecall: number | null;
}

export declare const RECORD_PATH: string;
export declare const REGRESSION_TOLERANCE: number;
export declare const EXPECTED_CORPUS: CorpusExpectation;
export declare const FROZEN_BASELINE: CorpusBaseline;

/** Empty `problems` is a pass. `readings` is every metric, in a stable order. */
export declare function collectCorpusProblems(
  record: unknown,
  expected?: CorpusExpectation,
  baseline?: CorpusBaseline,
  tol?: number,
): { problems: string[]; readings: CorpusReading[] };
