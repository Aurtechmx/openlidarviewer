export interface V3Sample {
  pair: number;
  frameP95Ms: number;
  over50: number;
  qualityTransitions: number;
  fullQualityMs: number | null;
  presentation: { backingRatio: number | null; governor: Record<string, number> | null } | null;
  [k: string]: unknown;
}
export interface CI { lo: number | null; hi: number | null; resamples: number; seed: number; pairs: number }
export const CRITERIA_V3: Readonly<{
  p95MinImprovement: number;
  over50MayIncrease: boolean;
  qualityTransitionsMaxExtraOverOff: number;
  fullQualityMaxExtraMs: number;
  settledRestored: boolean;
  digestsIdentical: boolean;
  bootstrapResamples: number;
  bootstrapSeed: number;
  ciLevel: number;
}>;
export const V3_PAIRS: number;
export const V3_DATASETS: Readonly<Record<'A' | 'B', { id: string; path: string }>>;
export function plan(pairs?: number): { index: number; pair: number; cond: 'off' | 'on' }[];
export function mulberry32(seed: number): () => number;
export function pairedBootstrapCI(
  off: V3Sample[], on: V3Sample[], key: keyof V3Sample & string,
  delta: (offMedian: number, onMedian: number) => number,
  opts?: { resamples?: number; seed?: number; level?: number },
): CI;
export function judgeTrajectoryV3(off: V3Sample[], on: V3Sample[], digestsIdentical: boolean): {
  criteria: Record<string, { pass: boolean; [k: string]: any }>;
  failed: string[];
};
