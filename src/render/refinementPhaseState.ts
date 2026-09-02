/**
 * refinementPhaseState.ts
 *
 * The stateful half of the P6 refinement phase machine: "which phase are we in,
 * and when did the camera park?". `refinementPhase.ts` holds the pure transition
 * function and the weighting tables; this module holds the two mutable fields
 * that drive it and the mapping from a readiness verdict to the machine's two
 * boolean signals.
 *
 * It lives outside `Viewer` because the phase has two consumers with different
 * lifetimes. Adaptive DPR reads it only on frames that actually render, and only
 * when the `?adaptiveDpr` flag is on; the streaming scheduler reads it on every
 * scheduler tick regardless. While the bookkeeping sat inside the DPR branch,
 * disabling adaptive DPR froze the phase at `moving` forever — invisible while
 * DPR was the only reader, wrong the moment node ordering depends on it. One
 * tracker, advanced unconditionally, removes the coupling without introducing a
 * second phase state to disagree with the first.
 *
 * Pure state, no DOM and no three.js — unit-tested in Node.
 */

import { SETTLE_MS } from './orbitFeel';
import { nextRefinementPhase, phaseDprScale, type RefinementPhase } from './refinementPhase';
import type { RefinementReadinessPhase } from './streaming/refinementReadiness';

/** What one frame tells the tracker. */
export interface RefinementPhaseInput {
  /** Is the camera moving this frame? Any motion resets to `moving`. */
  readonly moving: boolean;
  /** The frame timestamp, in milliseconds. */
  readonly nowMs: number;
  /** The scheduler's wanted-set readiness verdict, or null when there is none. */
  readonly readiness: { readonly phase: RefinementReadinessPhase } | null;
}

/** Elapsed-time proxy for "the centre is refined", used only without a verdict. */
export const PHASE_CENTER_PROXY_MS = 250;

/**
 * Owns the live refinement phase and the park timestamp behind it.
 *
 * With a streaming scheduler attached, the coverage / central-refine signals
 * come from the wanted-set readiness verdict, so full resolution is reached
 * only when the requested nodes are resident rather than after a fixed time
 * over a half-loaded cloud. Without a verdict — a static cloud with nothing to
 * stream, or before the first cull — the elapsed-time proxies stand in, because
 * there is no outstanding data for a signal to describe.
 */
export class RefinementPhaseTracker {
  private _phase: RefinementPhase = 'moving';
  /** Frame timestamp when the camera last parked; null while moving. */
  private _settledAtMs: number | null = null;

  private readonly _settleMs: number;
  private readonly _centerProxyMs: number;

  constructor(settleMs: number = SETTLE_MS, centerProxyMs: number = PHASE_CENTER_PROXY_MS) {
    this._settleMs = settleMs;
    this._centerProxyMs = centerProxyMs;
  }

  /** The current phase, without advancing it. */
  get phase(): RefinementPhase {
    return this._phase;
  }

  /**
   * The adaptive-DPR resolution fraction for the current phase — the same
   * `PHASE_DPR_SCALE` lookup the pure module owns, offered here so a caller
   * that already holds the tracker does not couple to a second module for one
   * table read.
   */
  get dprScale(): number {
    return phaseDprScale(this._phase);
  }

  /** Advance one frame and return the new phase. */
  advance(input: RefinementPhaseInput): RefinementPhase {
    if (input.moving) this._settledAtMs = null;
    else this._settledAtMs ??= input.nowMs;
    const msSinceSettle =
      input.moving || this._settledAtMs === null ? 0 : input.nowMs - this._settledAtMs;
    const verdict =
      input.readiness && input.readiness.phase !== 'unknown' ? input.readiness.phase : null;
    const coverageComplete = verdict
      ? verdict === 'settling' || verdict === 'settled'
      : msSinceSettle >= this._settleMs;
    const centralRefined = verdict
      ? verdict === 'settled'
      : msSinceSettle >= this._centerProxyMs;
    this._phase = nextRefinementPhase(this._phase, {
      moving: input.moving,
      msSinceSettle,
      settleMs: this._settleMs,
      coverageComplete,
      centralRefined,
    });
    return this._phase;
  }
}
