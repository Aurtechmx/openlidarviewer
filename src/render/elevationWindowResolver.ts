/**
 * elevationWindowResolver.ts
 *
 * Which elevation window does a given layer get? (v0.5.6-gate2 Stage B.)
 *
 * Point positions are stored origin-shifted — a large origin is subtracted so the
 * float attribute keeps precision — so a world-space elevation window is only
 * meaningful once converted with the origin that shifted THAT cloud. The filter
 * used to convert once, with a single scene origin and up-axis, and hand the
 * result to every layer. With one cloud that is right. With two layers recentred
 * on different origins it is right for one and quietly wrong for the other, and
 * a Z-up survey beside a Y-up phone scan reads the wrong position component
 * entirely.
 *
 * This module holds that decision as pure functions so it is unit-testable
 * without a GPU or a Viewer: the caller passes the layers it knows about, and
 * gets back the window each one should use.
 */

import { elevationFilterUniform, type UpAxis } from './elevationFilterUniform';

/**
 * One layer's elevation window in ATTRIBUTE space. `axisIsZ` is 1 for a Z-up
 * cloud (the shader reads `pos.z`) and 0 for Y-up (`pos.y`).
 */
export interface ElevMaterialWindow {
  readonly min: number;
  readonly max: number;
  readonly axisIsZ: number;
}

/** A layer's identity plus the two facts that decide its conversion. */
export interface ElevLayer<M> {
  readonly material: M;
  /** The origin subtracted from this cloud's positions along its up-axis. */
  readonly originAlongAxis: number;
  /** This cloud's own up-axis (2 = Z-up, 1 = Y-up). */
  readonly axis: UpAxis;
}

/** How to convert when a material has no known layer. */
export interface ElevFallback {
  readonly originAlongAxis: number;
  readonly axis: UpAxis;
}

/**
 * Convert a world-space window into one cloud's attribute space.
 *
 * `undefined` (the filter is off) still returns a window, because the shader
 * reads the uniforms unconditionally and gates on `enabled` instead; the values
 * are simply never consulted.
 */
export function elevWindowFor(
  world: readonly [number, number] | undefined,
  originAlongAxis: number,
  axis: UpAxis,
): ElevMaterialWindow {
  const u = elevationFilterUniform(world, axis, originAlongAxis);
  return { min: u.min, max: u.max, axisIsZ: axis === 2 ? 1 : 0 };
}

/**
 * The window for `material`, converted with its own layer's origin and up-axis.
 *
 * A material with no matching layer (an orphaned or not-yet-registered mesh)
 * converts with `fallback`, which reproduces the old single-origin behaviour.
 * That is possibly wrong for that one mesh but never worse than before, and it
 * keeps this total: the caller runs inside a node-graph build, where throwing
 * would cost the whole scene rather than one layer.
 */
export function elevWindowForMaterial<M>(
  world: readonly [number, number] | undefined,
  layers: Iterable<ElevLayer<M>>,
  material: M,
  fallback: ElevFallback,
): ElevMaterialWindow {
  for (const layer of layers) {
    if (layer.material === material) {
      return elevWindowFor(world, layer.originAlongAxis, layer.axis);
    }
  }
  return elevWindowFor(world, fallback.originAlongAxis, fallback.axis);
}
