/**
 * fadeDither.ts
 *
 * Pure mathematics of the streaming node fade — an OPAQUE screen-door dissolve.
 *
 * Why a dissolve and not an alpha fade
 * ────────────────────────────────────
 * A streaming LOD transition cross-fades a coarse parent out while its finer
 * child fades in. Doing that with `transparent: true` + material opacity forces
 * two overlapping point layers into the transparent pass; with `depthWrite: true`
 * (required so EDL still sees depth) they z-fight, and every refining region
 * flickers. Instead, each node stays fully OPAQUE and dissolves by discarding a
 * per-point fraction of its sprites: a point is kept once its stable per-instance
 * hash falls at or below the node's `fadeProgress` (0 → 1 in, 1 → 0 out). No
 * transparency, no sort, no z-fight — and EDL/depth stay exact.
 *
 * Same contract as `splatShader.ts`: the maths lives here and is unit-tested in
 * Node, then mirrored EXACTLY in the TSL size-graph node in `Viewer.ts` (a point
 * whose keep is 0 has its sprite size multiplied by 0, collapsing it to nothing —
 * the same discard the class/elevation masks use).
 */

/**
 * A low-discrepancy (Weyl) hash of a point's instance index into `[0, 1)`.
 * `fract(i · φ⁻¹)` spreads consecutive indices evenly across the unit interval,
 * so a `fadeProgress` sweep reveals a well-distributed subset at every step
 * rather than a spatially-clustered block. Deterministic and allocation-free;
 * the TSL mirror is `float(instanceIndex).mul(PHI_CONJUGATE).fract()`.
 */
export const PHI_CONJUGATE = 0.618033988749895;

/** The per-instance dissolve hash in `[0, 1)`. Mirrored in the Viewer TSL graph. */
export function fadeHashUnit(instanceIndex: number): number {
  const x = instanceIndex * PHI_CONJUGATE;
  return x - Math.floor(x);
}

/**
 * Whether a point is visible at the given fade progress: `1` (keep) when its
 * hash is at or below `fadeProgress`, else `0` (discard → sprite size × 0).
 *
 * At `fadeProgress >= 1` every point is kept (fully materialised); at
 * `fadeProgress <= 0` none are (fully dissolved). Monotonic in `fadeProgress`,
 * so a fade-in only ever ADDS points and a fade-out only ever removes them —
 * no point flickers on and off within a single sweep.
 */
export function fadeDitherKeep(instanceIndex: number, fadeProgress: number): 0 | 1 {
  return fadeHashUnit(instanceIndex) <= fadeProgress ? 1 : 0;
}
