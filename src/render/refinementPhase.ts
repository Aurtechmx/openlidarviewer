/**
 * refinementPhase.ts
 *
 * Pure state machine + weighting maths for the P6 refinement phases (program
 * §P6). As the camera moves and then settles, the renderer walks a small,
 * ordered set of phases:
 *
 *   moving → coverage → center-refine → full-refine
 *
 * Each phase says "how much effort, and where": while MOVING, render coarse and
 * cheap; on settle, first drive coarse viewport COVERAGE, then refine the CENTER,
 * then the FULL viewport. The program's key rule (§4.5) is that adaptive DPR is a
 * function of these DISCRETE phases — not a per-frame continuous knob — so the
 * backing-store resolution steps up as refinement progresses instead of jittering.
 *
 * Two consumers:
 *   • Adaptive DPR (live today): `phaseDprScale` maps a phase to a resolution
 *     fraction, driven from the Viewer render loop.
 *   • The streaming scheduler (arrives with P4): `centerWeight` and
 *     `phaseSelectionFactor` feed node prioritisation + the selection budget.
 *     Those primitives are pinned here so the scheduler wiring is a lookup, not
 *     new maths.
 *
 * Everything is pure and deterministic — no three.js, no DOM — and unit-tested
 * in Node. The Viewer owns the stateful "which phase are we in" bookkeeping and
 * the (proxy, until P4) readiness signals.
 */

/** The ordered refinement phases. `moving` is coarsest, `full-refine` is sharpest. */
export type RefinementPhase = 'moving' | 'coverage' | 'center-refine' | 'full-refine';

/** Canonical order — index gives a coarse→fine rank. */
export const REFINEMENT_PHASE_ORDER: readonly RefinementPhase[] = [
  'moving',
  'coverage',
  'center-refine',
  'full-refine',
];

/** Inputs to one phase transition. */
export interface PhaseInput {
  /** Is the camera moving this frame? Any motion drops straight back to `moving`. */
  readonly moving: boolean;
  /** Milliseconds since the camera parked (0 while moving). */
  readonly msSinceSettle: number;
  /** Settle window (reuse the viewer's `SETTLE_MS`); a lower bound before advancing. */
  readonly settleMs: number;
  /** Coarse visible coverage has reached its threshold (scheduler signal; proxy allowed). */
  readonly coverageComplete: boolean;
  /** Central projected-spacing target has been met. */
  readonly centralRefined: boolean;
}

/**
 * The next phase. Motion always resets to `moving` (coarse-first on any nudge).
 * When parked, the machine enters at `coverage` and advances ONLY on the
 * readiness signals — never on elapsed time alone — with the settle window as a
 * lower bound so a brief pause cannot skip coverage. Monotonic while parked: it
 * never steps backward without motion.
 */
export function nextRefinementPhase(current: RefinementPhase, input: PhaseInput): RefinementPhase {
  if (input.moving) return 'moving';
  let phase: RefinementPhase = current === 'moving' ? 'coverage' : current;
  const pastSettle = input.msSinceSettle >= Math.max(0, input.settleMs);
  if (phase === 'coverage' && pastSettle && input.coverageComplete) phase = 'center-refine';
  if (phase === 'center-refine' && input.centralRefined) phase = 'full-refine';
  return phase;
}

/**
 * Resolution fraction for a phase, in `(0, 1]` — the DPR driver. Coarse while
 * moving / building coverage, stepping up through center-refine to full at rest.
 * The Viewer multiplies this by `maxDpr` and floors it so it never renders below
 * one device pixel.
 */
export const PHASE_DPR_SCALE: Readonly<Record<RefinementPhase, number>> = {
  moving: 0.66,
  coverage: 0.66,
  'center-refine': 0.85,
  'full-refine': 1.0,
};

/** Resolution fraction for the given phase (see {@link PHASE_DPR_SCALE}). */
export function phaseDprScale(phase: RefinementPhase): number {
  return PHASE_DPR_SCALE[phase];
}

/**
 * Selection-budget multiplier per phase for the streaming scheduler (arrives
 * with P4): fewer nodes while moving, full budget once refining the whole view.
 * In `(0, 1]`.
 */
export const PHASE_SELECTION_FACTOR: Readonly<Record<RefinementPhase, number>> = {
  moving: 0.5,
  coverage: 0.75,
  'center-refine': 0.9,
  'full-refine': 1.0,
};

/** Selection-budget multiplier for the given phase (see {@link PHASE_SELECTION_FACTOR}). */
export function phaseSelectionFactor(phase: RefinementPhase): number {
  return PHASE_SELECTION_FACTOR[phase];
}

/**
 * Center weighting for a node's projected position (§P6). `projX/projY` are the
 * node's NDC position; `aspectWx/aspectWy` scale the axes so "center distance"
 * accounts for the viewport aspect. Returns `clamp(1 − centerDistance, 0, 1)`:
 * 1 at the exact center, 0 at/after the edge. A large node crossing the center
 * still scores high because the caller passes the box-extent-adjusted position.
 */
export function centerWeight(
  projX: number,
  projY: number,
  aspectWx: number,
  aspectWy: number,
): number {
  const wx = Number.isFinite(aspectWx) && aspectWx > 0 ? aspectWx : 1;
  const wy = Number.isFinite(aspectWy) && aspectWy > 0 ? aspectWy : 1;
  const dx = projX / wx;
  const dy = projY / wy;
  const d = Math.sqrt(dx * dx + dy * dy);
  const w = 1 - d;
  return w < 0 ? 0 : w > 1 ? 1 : w;
}
