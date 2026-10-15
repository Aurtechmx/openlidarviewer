export interface CiJobDef { name: string | null; needs: string[] }
export interface CiRun { id: number; status: string; conclusion: string | null; html_url?: string }
export interface CiJob { name: string; status: string; conclusion: string | null }
export type CiState = 'ready' | 'pending' | 'failed' | 'missing';
export function parseCiJobs(yml: string): Map<string, CiJobDef>;
export function requiredJobNames(jobs: Map<string, CiJobDef>): string[];
export function evaluateCiRuns(runs: CiRun[], jobsByRun: Map<number, CiJob[]>, required: string[]): { state: CiState; detail: string };
