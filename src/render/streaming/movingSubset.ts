/**
 * movingSubset.ts
 *
 * How many temporal phases a frame draws while the camera is moving, and how
 * much larger each drawn point has to be to cover the gap left by the ones it
 * skipped.
 *
 * Accumulation cannot help a moving camera. The camera transform is part of the
 * display state, so every frame of a movement opens a new epoch and the previous
 * frame's work describes a different picture. Drawing a subset while moving is
 * therefore plain decimation, not accumulation, and it costs real coverage in
 * the frame the viewer is looking at. That is the reason the subset is a
 * decision with a compensation attached rather than a free saving.
 *
 * The renderer already slows down twice while moving: the backing store drops to
 * 0.85 of full resolution and the streaming scheduler takes half its node
 * budget. Phase decimation would be a third reduction on the same frames, and
 * the three multiply. The default here is therefore the whole set, which changes
 * nothing, and a caller that wants to trade coverage for frame time has to ask.
 *
 * Display only. A subset decides which points a frame draws, never where a point
 * is or what it measures.
 */
import type { RefinementPhase } from '../refinementPhase';
import type { PhaseCount } from './temporalPhase';

/**
 * How many of the `phaseCount` phases each refinement phase draws.
 *
 * Every entry is "all of them". The renderer's existing motion reductions were
 * measured and tuned; this one has not been, and a subset that looked acceptable
 * on a desktop with a dense scan can gut a sparse one. A value below the phase
 * count belongs here once a real device has been measured, not before.
 */
export const PHASES_DRAWN_WHILE: Readonly<Record<RefinementPhase, 'all'>> = {
  moving: 'all',
  coverage: 'all',
  'center-refine': 'all',
  'full-refine': 'all',
};

/**
 * How many phases to draw, clamped into `[1, phaseCount]`.
 *
 * Both ends matter. A frame drawing no phase draws no points at all, and one
 * drawing more phases than exist names phases nothing is assigned to.
 *
 * Non-finite input is caught before the clamp rather than by it. `Math.floor`
 * of a NaN is NaN and every comparison against NaN is false, so `min` and `max`
 * pass it straight through and the count silently becomes zero: a blank frame
 * from an arithmetic slip upstream, which is the failure this guard exists to
 * prevent, arriving by the route the guard looked like it covered.
 */
function drawnCount(activeCount: number, phaseCount: PhaseCount): number {
  if (!Number.isFinite(activeCount)) return phaseCount;
  return Math.min(phaseCount, Math.max(1, Math.floor(activeCount)));
}

/**
 * The phases a frame draws, in ascending order, for a refinement phase.
 */
export function activePhases(
  refinement: RefinementPhase,
  phaseCount: PhaseCount,
  activeCount: number = phaseCount,
): readonly number[] {
  void PHASES_DRAWN_WHILE[refinement];
  const n = drawnCount(activeCount, phaseCount);
  return Array.from({ length: n }, (_, i) => i);
}

/**
 * How much wider a drawn point has to be when only some phases are drawn.
 *
 * Drawing a fraction `f` of a surface's samples leaves the survivors further
 * apart. On a surface the samples are spread over two dimensions, so their mean
 * separation grows as `1 / sqrt(f)`, and a footprint scaled by that much covers
 * the same area it did before. That is full compensation, and it is the upper
 * bound rather than the default: a point wide enough to cover its neighbours'
 * ground is also wide enough to hide a real gap in the data, which is the one
 * thing a point cloud viewer must not do quietly.
 *
 * `strength` in `[0, 1]` interpolates the exponent, so 0 leaves the footprint
 * alone and 1 restores the original covered area. Anything between trades some
 * visible thinning for a smaller lie about coverage.
 */
export function footprintCompensation(
  activeCount: number,
  phaseCount: PhaseCount,
  strength = 0.5,
): number {
  const n = drawnCount(activeCount, phaseCount);
  const fraction = n / phaseCount;
  const s = Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 0;
  return Math.pow(1 / fraction, 0.5 * s);
}
