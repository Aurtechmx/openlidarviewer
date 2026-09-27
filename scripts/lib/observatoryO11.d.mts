export interface O11Run { readonly ok: boolean; readonly p95Ms?: number; readonly uploadBytes?: number; readonly error?: string }
export interface O11Arm { readonly ok: boolean; readonly p95Ms?: number; readonly uploadBytes?: number; readonly error?: string }
export const O11_PROTOCOL: string;
export const O11_SCENARIOS: readonly string[];
export const O11_BUDGET_FACTOR: number;
export const O11_FRAME_FACTOR: number;
export const O11_UPLOAD_FACTOR: number;
export function summariseArm(runs: readonly O11Run[]): O11Arm;
export function budgetsFromSlicing(slicing: Record<string, O11Arm>): Record<string, { frameMs: number; uploadMiB: number }>;
export function decideO11(slicing: Record<string, O11Arm>, instancing: Record<string, O11Arm>): {
  chosen: 'instancing' | 'slicing';
  scenarios: Record<string, { frameRatio: number | null; uploadRatio: number | null; frameTest: boolean; uploadTest: boolean; pass: boolean; note?: string }>;
};
