/**
 * clipGpu.ts
 *
 * The GPU side of the clip box: a per-point keep multiplier folded into the
 * point size graph, exactly as the elevation and class filters are.
 *
 * Not three.js clip planes: WebGPURenderer ignores `material.clippingPlanes`,
 * and its ClippingGroup does not apply a six-plane keep-outside box or rebuild
 * its shader when the mode changes. The box and the mode here are plain
 * uniforms, so editing the bounds or switching Inside/Outside needs no rebuild,
 * and a hidden point collapses to a zero-size sprite (the CPU rule,
 * `clipKeepsPoint`, applied per point).
 *
 * The box is in the PROJECT frame, the frame the CPU kept-count and the
 * measurements use. A point's project position is its instanced `aPos` through
 * the mesh's world matrix (the mesh sits at its layer's placement offset), so a
 * placed layer clips where it is drawn.
 */

import { attribute, float, mix, modelWorldMatrix, step, uniform, vec4 } from 'three/tsl';

import type { ClipBox } from './clipBox';

// The viewer reaches the whole clip through this one module (the pure region
// logic in `clipBox` plus the GPU fold below), keeping its import list short.
export { clipFrameBounds, clipKeepsPoint, clipPickAccept, countKept, verticalExtentOf } from './clipBox';
export type { ClipBox, VerticalExtent } from './clipBox';

/** The dynamically-typed TSL node chain, matching the `Viewer` convention. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TslNode = any;

export class ClipBoxGpu {
  /** 0 → identity (every point shown), 1 → clip active. */
  private readonly _enabled = uniform(0);
  /** 0 → keep inside the box, 1 → keep outside it. */
  private readonly _outside = uniform(0);
  private readonly _min = [uniform(0), uniform(0), uniform(0)];
  private readonly _max = [uniform(0), uniform(0), uniform(0)];

  /** True while a clip is on (its fold is present in the size graph). */
  isActive(): boolean {
    return (this._enabled.value as number) !== 0;
  }

  /** Load the clip into the uniforms. Values only: no pipeline rebuild. */
  apply(clip: ClipBox | null): void {
    const on = clip?.enabled === true;
    this._enabled.value = on ? 1 : 0;
    if (!clip) return;
    this._outside.value = clip.mode === 'keep-outside' ? 1 : 0;
    for (let i = 0; i < 3; i++) {
      this._min[i].value = clip.box.min[i];
      this._max[i].value = clip.box.max[i];
    }
  }

  /**
   * The per-point multiplier: 1 where the point is kept, 0 where it is clipped,
   * and 1 for every point while no clip is on. Box faces are inclusive, as in
   * `pointInBox`: `step(min, p)` is 1 for p >= min and `step(p, max)` is 1 for
   * p <= max.
   */
  maskMultiplier(): TslNode {
    const p: TslNode = modelWorldMatrix.mul(vec4(attribute('aPos') as TslNode, 1));
    let inside: TslNode = float(1);
    const axes = [p.x, p.y, p.z];
    for (let i = 0; i < 3; i++) {
      inside = inside.mul(step(this._min[i] as TslNode, axes[i])).mul(step(axes[i], this._max[i] as TslNode));
    }
    const keep: TslNode = mix(inside, inside.oneMinus(), this._outside as TslNode);
    return mix(float(1), keep, this._enabled as TslNode);
  }
}
