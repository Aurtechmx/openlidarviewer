/**
 * temporalPhase.ts
 *
 * Which temporal phase a point belongs to, when the renderer draws a subset of
 * points per frame and accumulates them across several.
 *
 * The partition has one hard requirement: a point must stay in the same phase
 * for as long as the display is showing the same thing. A partition that
 * re-rolled per frame would move points between phases while the image was
 * being accumulated, and the result sparkles. So the phase is a function of the
 * point's identity alone, with no frame number and no time anywhere in it.
 *
 * No new hash is introduced. `fadeHashUnit` already spreads instance indices
 * evenly over [0, 1) by a golden-ratio Weyl sequence, it is already unit-tested
 * in Node, and it is already mirrored exactly in the Viewer's TSL size graph, so
 * the CPU and the shader agree on it today. Adding a second hash beside it would
 * mean two things to keep in step instead of one.
 *
 * The seed shifts the sequence by whole steps, which is the same sequence read
 * from a different starting point, so it stays low-discrepancy. Its purpose is
 * that two nodes do not agree about which of their points are in phase 0 merely
 * because both number their points from zero.
 *
 * Display only. A phase decides when a point is drawn, never where it is or
 * what it measures, and nothing here may reach picking, measurement, terrain,
 * export or claim evidence.
 */
import { fadeHashUnit } from './fadeDither';

/**
 * How many phases the frame budget is split across. Powers of two so a phase
 * can be selected with a mask on the GPU rather than a modulo.
 */
export type PhaseCount = 2 | 4 | 8;

/**
 * The default split. Four phases quarter the per-frame point work while still
 * completing an accumulation in a handful of frames, which is short enough that
 * a camera nudge does not usually land mid-sweep.
 */
export const DEFAULT_PHASE_COUNT: PhaseCount = 4;

/**
 * The phase a point belongs to, in `[0, phaseCount)`.
 *
 * `instanceIndex` is the point's identity within its mesh and `seed` is its
 * node's, both integers. The result depends on nothing else, so it holds for as
 * long as the mesh does.
 *
 * The result needs no upper clamp, and that is a property of `phaseCount` being
 * a power of two rather than an accident. Multiplying a double by a power of two
 * only shifts its exponent, so the product is exact: `fadeHashUnit` returns
 * strictly below 1, therefore `phaseCount * hash` is strictly below `phaseCount`
 * with no rounding, and the floor cannot reach `phaseCount`. A phase equal to
 * the count would be drawn by no frame at all, so the point would be missing
 * from the image. A `phaseCount` that was not a power of two would put that back
 * on the table, which is why the type admits only 2, 4 and 8.
 */
export function temporalPhase(
  instanceIndex: number,
  seed: number,
  phaseCount: PhaseCount = DEFAULT_PHASE_COUNT,
): number {
  return Math.floor(phaseCount * fadeHashUnit(instanceIndex + seed));
}

/**
 * Whether a point is drawn on a frame rendering `activePhase`.
 *
 * Separate from {@link temporalPhase} so a caller that draws several phases at
 * once, which is what the moving-camera path wants, composes them rather than
 * reimplementing the comparison.
 */
export function drawnThisPhase(
  instanceIndex: number,
  seed: number,
  activePhase: number,
  phaseCount: PhaseCount = DEFAULT_PHASE_COUNT,
): boolean {
  return temporalPhase(instanceIndex, seed, phaseCount) === activePhase;
}
