/**
 * The frame budget governor, wired into the render loop (`?governor=on`).
 *
 * Holds the recent frame times and the last applied policy, resolves
 * `frameBudgetPolicy` once per frame, and answers the three places that apply
 * it: the adaptive DPR step (`dprPressure`, capped by `renderScale`), the GPU
 * upload queue's per-frame node and byte limits (`gpuCommitScale`), the EDL
 * gate (`allowEdl`) and the drawn instance count of each point mesh
 * (`pointBudgetFraction`).
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

/** The duck-typed slice of a three.js instanced point mesh the point budget touches. */
interface DrawnGeometry {
  readonly isInstancedBufferGeometry?: boolean;
  instanceCount: number;
  readonly attributes?: { readonly aPos?: { readonly count: number } };
}
interface SceneNode {
  readonly children?: readonly SceneNode[];
  readonly geometry?: DrawnGeometry;
}

/** The ratio after `renderScale`, never below `RENDER_SCALE_FLOOR` of `maxDpr`. */
export function scaledDpr(ratio: number, maxDpr: number, renderScale: number): number {
  if (!(renderScale < 1)) return ratio;
  return Math.min(ratio, Math.round(maxDpr * renderScale * 100) / 100);
}

export class GovernorWiring implements GovernorSink {
  private readonly _ring = new Float64Array(GOVERNOR_WINDOW);
  private readonly _sorted = new Float64Array(GOVERNOR_WINDOW);
  private _count = 0;
  private _write = 0;
  private _pending = 0;
  private _policy: FrameBudgetPolicy = UNLOADED_POLICY;
  private _stationary = 0;
  /** Geometries drawn below their full count: geometry -> [full count, count set]. */
  private readonly _reduced = new Map<DrawnGeometry, [number, number]>();
  /** Changes of the two v2 outputs, for the A/B record. */
  renderScaleChanges = 0;
  pointBudgetChanges = 0;

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
    const prev = this._policy;
    this._stationary = tweening || phase === 'moving' ? 0 : this._stationary + 1;
    this._policy = frameBudgetPolicy({
      phase: (PHASES.includes(phase) ? phase : 'full-refine') as RefinementPhase,
      tweening,
      recentMedianMs: median,
      recentHighMs: s[this._count - 1],
      pendingGpuNodes: this._pending,
      streamingBacklog: 0,
      continuityPending: false,
      mobileTier: this._mobileTier,
      stationaryFrames: this._stationary,
    }, prev);
    if (this._policy.renderScale !== prev.renderScale) this.renderScaleChanges++;
    if (this._policy.pointBudgetFraction !== prev.pointBudgetFraction) this.pointBudgetChanges++;
  }

  dpr(target: number, floor: number, maxDpr: number): number {
    return scaledDpr(governedDpr(target, floor, maxDpr, this._policy.dprPressure), maxDpr, this._policy.renderScale);
  }

  /**
   * Draw each instanced point mesh under `root` at the policy's fraction of
   * its full count, or restore it. Only the draw count changes; a mesh whose
   * count someone else set below full (a growing preview) is left alone, and
   * a count changed by its owner since is not restored over.
   */
  points(root: object): void {
    const f = this._policy.pointBudgetFraction;
    if (f >= 1) {
      if (this._reduced.size === 0) return;
      for (const [g, [full, set]] of this._reduced) if (g.instanceCount === set) g.instanceCount = full;
      this._reduced.clear();
      return;
    }
    const visit = (n: SceneNode): void => {
      const g = n.geometry;
      const full = g?.isInstancedBufferGeometry ? g.attributes?.aPos?.count : undefined;
      if (g && full !== undefined && full > 0) {
        const held = this._reduced.get(g);
        const want = Math.max(1, Math.floor(full * f));
        if (held ? g.instanceCount === held[1] : g.instanceCount === full) {
          g.instanceCount = want;
          this._reduced.set(g, [full, want]);
        }
      }
      if (n.children) for (const c of n.children) visit(c);
    };
    visit(root as SceneNode);
  }

  /** The two v2 outputs, for a settled-state check. */
  presentation(): { renderScale: number; pointBudgetFraction: number; reducedMeshes: number } {
    return { renderScale: this._policy.renderScale, pointBudgetFraction: this._policy.pointBudgetFraction, reducedMeshes: this._reduced.size };
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
