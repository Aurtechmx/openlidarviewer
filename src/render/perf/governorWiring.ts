/**
 * The frame budget governor, wired into the render loop (`?governor=on`).
 *
 * Holds the recent frame times and the last applied policy, resolves
 * `frameBudgetPolicy` once per frame, and answers the three places that apply
 * it: the adaptive DPR step (`dprPressure`), the GPU upload queue's per-frame
 * node and byte limits (`gpuCommitScale`), and the EDL gate (`allowEdl`).
 *
 * Display and upload pacing only: nothing here reaches a point, a node's
 * contents or any measurement.
 */
import { frameBudgetPolicy, UNLOADED_POLICY, type FrameBudgetPolicy } from './frameBudgetGovernor';
import type { GovernorSink } from './governorHook';
import type { RefinementPhase } from '../refinementPhase';

/**
 * The adaptive DPR quantum (`DPR_QUANT_STEP` in adaptiveDpr.ts). Restated so
 * this chunk imports nothing the Viewer chunk would have to share with it.
 */
const DPR_STEP = 0.25;

/** `GOVERNOR_SLOT` in governorHook.ts, restated for the same reason. */
const SLOT = '__olvGovernor';

/** Frames in the recent window the median and high are taken over. */
export const GOVERNOR_WINDOW = 30;

const PHASES: readonly string[] = ['moving', 'coverage', 'center-refine', 'full-refine'];

/** The ratio `target` after `pressure` in [0, 1]: 0 leaves it, 1 takes it to `floor`. */
export function governedDpr(target: number, floor: number, maxDpr: number, pressure: number): number {
  if (!(pressure > 0) || !(maxDpr > floor)) return target;
  const cap = Math.max(floor, Math.round((maxDpr - Math.min(1, pressure) * (maxDpr - floor)) / DPR_STEP) * DPR_STEP);
  return Math.min(target, cap);
}

/** Node and byte limits scaled by `scale`, never below one node's worth of progress. */
export function governedUploadLimits<L extends { readonly maxNodes?: number; readonly maxBytes?: number }>(limits: L, scale: number): L {
  if (!(scale < 1)) return limits;
  const s = Math.max(0, scale);
  return {
    ...limits,
    ...(limits.maxNodes !== undefined ? { maxNodes: Math.max(1, Math.floor(limits.maxNodes * s)) } : {}),
    ...(limits.maxBytes !== undefined ? { maxBytes: Math.max(1, Math.floor(limits.maxBytes * s)) } : {}),
  };
}

export class GovernorWiring implements GovernorSink {
  private readonly _ring = new Float64Array(GOVERNOR_WINDOW);
  private readonly _sorted = new Float64Array(GOVERNOR_WINDOW);
  private _count = 0;
  private _write = 0;
  private _pending = 0;
  private _policy: FrameBudgetPolicy = UNLOADED_POLICY;

  private readonly _mobileTier: boolean;

  constructor(mobileTier = false) {
    this._mobileTier = mobileTier;
  }

  /** The policy applied this frame. */
  get policy(): FrameBudgetPolicy {
    return this._policy;
  }

  frameMs(ms: number): void {
    if (!(ms > 0)) return;
    this._ring[this._write] = ms;
    this._write = (this._write + 1) % GOVERNOR_WINDOW;
    if (this._count < GOVERNOR_WINDOW) this._count++;
  }

  frame(phase: string, tweening: boolean): void {
    if (this._count === 0) return;
    const s = this._sorted.subarray(0, this._count);
    s.set(this._ring.subarray(0, this._count));
    s.sort();
    const mid = this._count >> 1;
    const median = this._count % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    this._policy = frameBudgetPolicy({
      phase: (PHASES.includes(phase) ? phase : 'full-refine') as RefinementPhase,
      tweening,
      recentMedianMs: median,
      recentHighMs: s[this._count - 1],
      pendingGpuNodes: this._pending,
      streamingBacklog: 0,
      continuityPending: false,
      mobileTier: this._mobileTier,
    }, this._policy);
  }

  dpr(target: number, floor: number, maxDpr: number): number {
    return governedDpr(target, floor, maxDpr, this._policy.dprPressure);
  }

  edl(): boolean {
    return this._policy.allowEdl;
  }

  uploadLimits<L extends { readonly maxNodes?: number; readonly maxBytes?: number }>(limits: L, pending: number): L {
    this._pending = pending;
    return governedUploadLimits(limits, this._policy.gpuCommitScale);
  }
}

/** Install a governor in the render path's slot and return it. */
export function installGovernor(g: object = globalThis): GovernorWiring {
  const mobile = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const wiring = new GovernorWiring(mobile);
  (g as Record<string, unknown>)[SLOT] = wiring;
  return wiring;
}

/** Remove any installed governor. */
export function uninstallGovernor(g: object = globalThis): void {
  delete (g as Record<string, unknown>)[SLOT];
}
