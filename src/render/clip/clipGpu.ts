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
 *
 * {@link ClipOutline} draws the box itself: twelve edges in the same project
 * frame (the scene's world frame), so the box sits exactly where the clip
 * cuts. It is a line object, not a point mesh, so the clip never hides it.
 */

import * as THREE from 'three/webgpu';
import { attribute, float, mix, modelWorldMatrix, step, uniform, vec4 } from 'three/tsl';

import type { ClipBox } from './clipBox';
import type { BoxBounds } from '../measure/geometry';
import type { SceneOverlayHost } from '../sceneLineOverlay';

// The viewer reaches the whole clip through this one module (the pure region
// logic in `clipBox` plus the GPU fold below), keeping its import list short.
export { clipFrameBounds, clipKeepsPoint, clipPickAccept, countKept, verticalExtentOf } from './clipBox';
export type { ClipBox, ClipLayerCount, VerticalExtent } from './clipBox';
export type { BoxBounds } from '../measure/geometry';

/** The dynamically-typed TSL node chain, matching the `Viewer` convention. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TslNode = any;

export class ClipBoxGpu {
  /** 0 → identity (every point shown), 1 → clip active. */
  private readonly _enabled = uniform(0);
  /** A clip has been on since the last {@link forget}: its fold stays in the size graph. */
  private _used = false;
  /** 0 → keep inside the box, 1 → keep outside it. */
  private readonly _outside = uniform(0);
  private readonly _min = [uniform(0), uniform(0), uniform(0)];
  private readonly _max = [uniform(0), uniform(0), uniform(0)];

  /** True while a clip is on (its fold is present in the size graph). */
  isActive(): boolean {
    return (this._enabled.value as number) !== 0;
  }

  /**
   * Whether the multiplier belongs in the size graph: while a clip is on, and
   * after that until {@link forget}. Turning the clip off then only zeroes the
   * `enabled` uniform (the multiplier is the identity), so turning it on again
   * is a uniform change, not a pipeline rebuild (about 90 ms on WebGL2).
   */
  folded(): boolean {
    return this._used || this.isActive();
  }

  /**
   * A scan is opening: unless a clip is on, take the fold out of the graph so
   * the scan opens with the plain size graph. True when that changed the fold.
   */
  forget(): boolean {
    const was = this.folded();
    // A clip that is on stays in use (and stays folded after it is turned off).
    this._used = this.isActive();
    return was !== this.folded();
  }

  /** Load the clip into the uniforms. Values only: no pipeline rebuild. */
  apply(clip: ClipBox | null): void {
    const on = clip?.enabled === true;
    this._enabled.value = on ? 1 : 0;
    if (on) this._used = true;
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

/**
 * One filter's fold in the point size graph, under the clip's rule above: in
 * the graph while the filter is on and, after its first use, while it is off
 * too (where its multiplier is exactly 1), until a scan opens with the filter
 * off. Turning the filter on or off again is then a uniform change only.
 */
export class StickyFold {
  private _active = false;
  private _used = false;

  /** Whether the fold belongs in the size graph. */
  get folded(): boolean {
    return this._used || this._active;
  }

  /** Record the filter turning on or off. True when that changed the fold. */
  set(active: boolean): boolean {
    const was = this.folded;
    this._active = active;
    if (active) this._used = true;
    return was !== this.folded;
  }

  /** A scan is opening: drop the fold unless the filter is on. True when that changed the fold. */
  forget(): boolean {
    const was = this.folded;
    this._used = this._active;
    return was !== this.folded;
  }
}

/**
 * The class, elevation and intensity filters' folds. Off, each multiplier is
 * exactly 1: the class mask is all ones, and the elevation and intensity masks
 * are `mix(1, inRange, 0)` with `inRange` a 0/1 `step` product. Size × 1.0 is
 * the size, so keeping a fold changes no drawn pixel.
 */
export class FilterFolds {
  readonly classMask = new StickyFold();
  readonly elevation = new StickyFold();
  readonly intensity = new StickyFold();

  /** A scan is opening: drop each fold whose filter is off. True when any fold changed. */
  forget(): boolean {
    const a = this.classMask.forget();
    const b = this.elevation.forget();
    const c = this.intensity.forget();
    return a || b || c;
  }
}

/** A warm amber, apart from the blue of a Box measurement, so the clip never reads as one. */
const OUTLINE_COLOUR = 0xffb547;
/** Edges hidden behind points still show, faintly, so the whole box stays legible. */
const OUTLINE_HIDDEN_OPACITY = 0.3;
/** The box while the clip is off (the Clip page is open): present but quieter. */
const OUTLINE_IDLE_SCALE = 0.55;

/** The twelve edges of an axis-aligned box as 24 line-segment endpoints. */
export function boxEdgeSegments(box: BoxBounds): Float32Array {
  const [x0, y0, z0] = box.min;
  const [x1, y1, z1] = box.max;
  const c = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  const out = new Float32Array(edges.length * 6);
  edges.forEach(([a, b], i) => out.set([...c[a], ...c[b]], i * 6));
  return out;
}

/**
 * The clip box drawn in the scene: one set of edges tested against the
 * scene's depth (an edge behind the points is hidden by them, so the box reads
 * as a solid volume), and the same edges again, faint, through the points, so
 * an edge inside a dense scan is never lost. Shown while the clip is on or the
 * Clip page is open; updated with every bound change; attached to the scene
 * only while shown.
 */
export class ClipOutline {
  private readonly _host: SceneOverlayHost;
  private readonly _geometry = new THREE.BufferGeometry();
  private readonly _front: THREE.LineBasicMaterial;
  private readonly _behind: THREE.LineBasicMaterial;
  private readonly _group = new THREE.Group();
  private _attached = false;
  private _disposed = false;
  private _hidden = 0;
  private _box: BoxBounds | null = null;

  constructor(host: SceneOverlayHost) {
    this._host = host;
    this._geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(24 * 3), 3));
    this._front = new THREE.LineBasicMaterial({ color: OUTLINE_COLOUR, transparent: true, opacity: 1, depthTest: true, depthWrite: false });
    this._behind = new THREE.LineBasicMaterial({ color: OUTLINE_COLOUR, transparent: true, opacity: OUTLINE_HIDDEN_OPACITY, depthTest: false, depthWrite: false });
    const behind = new THREE.LineSegments(this._geometry, this._behind);
    behind.renderOrder = 11;
    const front = new THREE.LineSegments(this._geometry, this._front);
    front.renderOrder = 12;
    for (const l of [behind, front]) l.frustumCulled = false;
    this._group.name = 'olv-clip-outline';
    this._group.add(behind, front);
    this._group.visible = false;
  }

  /** The box drawn now, or null when hidden. */
  get box(): BoxBounds | null {
    return this._box;
  }

  /** The scene object, for inspection. */
  get object(): THREE.Object3D {
    return this._group;
  }

  /** Draw `box` (`active`: the clip is on), or hide the outline with null. */
  show(box: BoxBounds | null, active: boolean): void {
    if (this._disposed) return;
    const ok = !!box && [...box.min, ...box.max].every(Number.isFinite);
    this._box = ok ? { min: [...box!.min], max: [...box!.max] } : null;
    if (!this._box) {
      this._group.visible = false;
      if (this._attached) { this._host.remove(this._group); this._attached = false; }
      this._host.requestFrame();
      return;
    }
    const attr = this._geometry.getAttribute('position') as THREE.BufferAttribute;
    (attr.array as Float32Array).set(boxEdgeSegments(this._box));
    attr.needsUpdate = true;
    this._geometry.computeBoundingSphere();
    const k = active ? 1 : OUTLINE_IDLE_SCALE;
    this._front.opacity = k;
    this._behind.opacity = OUTLINE_HIDDEN_OPACITY * k;
    this._group.visible = this._hidden === 0;
    if (!this._attached) { this._host.add(this._group); this._attached = true; }
    this._host.requestFrame();
  }

  /**
   * Run `fn` with the outline out of the picture (a snapshot or a figure is
   * the scan as clipped, not the editing aid). Nested calls are counted.
   */
  async without<T>(fn: () => T | Promise<T>): Promise<T> {
    this._hidden++;
    this._group.visible = false;
    try {
      return await fn();
    } finally {
      this._hidden--;
      if (this._hidden === 0) this._group.visible = this._box !== null;
    }
  }

  /** Detach and release the GPU resources. Idempotent. */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    if (this._attached) { this._host.remove(this._group); this._attached = false; }
    this._geometry.dispose();
    this._front.dispose();
    this._behind.dispose();
    this._host.requestFrame();
  }
}
