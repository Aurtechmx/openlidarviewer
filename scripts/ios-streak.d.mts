/** Types for ios-streak.mjs, which tests import. */
import type { SignatureList, Verdict } from './lib/iosRunClassifier.mjs';
export declare const WORKFLOW: string;
export declare function loadSignatureList(): SignatureList;
export declare function ghExec(args: string[]): string;
export interface StreakResult {
  runs: { id: number; createdAt: string; branch: string; verdict: Verdict; signature: string | null; reason: string }[];
  streak: number; infraCount: number; attempts: number;
  infraRuns: (string | number | undefined)[]; excludedRuns: (string | number | undefined)[]; unreliable: boolean; eligibleToBlock: boolean;
}
export type JobMeta = (run: { id: number; jobId: number | null }) => { image: string | null };
export declare function ghJobMeta(gh: (args: string[]) => string): JobMeta;
export declare function evaluate(opts?: { gh?: (args: string[]) => string; jobMeta?: JobMeta; limit?: number; list?: SignatureList }): StreakResult;
export declare function format(result: StreakResult): string;
