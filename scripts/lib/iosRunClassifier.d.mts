/** Types for iosRunClassifier.mjs, which tests import. */
export type Verdict = 'PASS' | 'FAILURE' | 'INFRASTRUCTURE' | 'EXCLUDED';
export interface SignatureList {
  firstAssertionStep: string;
  signatures: { id: string; note?: string; pattern: string; steps?: string; before?: string }[];
}
export interface CompiledSignature { id: string; re: RegExp; steps: RegExp | null; before: string | null }
export interface RunInput {
  steps: { name: string; conclusion: string | null }[];
  firstAssertionStep: string;
  logText?: string;
  conclusion?: string | null;
}
export declare const SCRIPT_START_MARKER: string;
export declare const FIRST_ASSERTION_MARKER: string;
export declare const REQUIRED_STREAK: number;
export declare const UNRELIABLE_INFRA_SHARE: number;
export declare function compileSignatures(list: SignatureList): CompiledSignature[];
export declare function classifyRun(
  run: RunInput,
  signatures: CompiledSignature[],
): { verdict: Verdict; signature: string | null; reason: string };
export declare function computeStreak(runs: { id?: string | number; verdict: Verdict }[]): {
  streak: number;
  infraCount: number;
  attempts: number;
  infraRuns: (string | number | undefined)[];
  excludedRuns: (string | number | undefined)[];
  unreliable: boolean;
  eligibleToBlock: boolean;
};
export declare function runnerImage(setupLog: string | null | undefined): string | null;
export declare function exclusionReason(image: string | null): string | null;
export declare function stepLog(logText: string, stepName: string): string;
