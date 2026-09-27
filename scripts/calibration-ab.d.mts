import type { V3Sample } from './governor-ab.mjs';
export interface CalSample extends V3Sample { firstRenderMs: number | null }
export const CRITERIA_CAL_V1: Readonly<Record<string, number | boolean>>;
export function judgeTrajectory(off: CalSample[], on: CalSample[], digestsIdentical: boolean): {
  criteria: Record<string, { pass: boolean; [k: string]: any }>;
  calibratedLevels: (number | null)[];
  failed: string[];
};
export function pairRefusals(fixed: unknown, calibrated: unknown, throttle?: number): string[];
export const PRECONDITION_CAL_V2: Readonly<{ minNonzeroShare: number }>;
export function precondition(levels: (number | null)[], minShare?: number): { runs: number; nonzero: number; share: number; minShare: number; met: boolean };
