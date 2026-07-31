/**
 * elevationFilterGpu.ts
 *
 * The GPU-side state for the elevation filter, extracted from `Viewer.ts` so the
 * render monolith does not grow to hold it (and shrinks as a result). The pure
 * world→attribute conversion still lives in `elevationFilterUniform.ts`; this
 * module owns the stateful "hold the uniforms and build the mask node" side that
 * used to be four `Viewer` fields plus three methods.
 *
 * WHY PER MATERIAL (v0.5.6-gate2, Stage A). The window used to be three SHARED
 * uniforms, so every cloud filtered against a single origin + up-axis. Two static
 * layers recentred by different origins, or a mix of Z-up and Y-up layers, then
 * clipped against the wrong reference. Here the window bounds and up-axis are held
 * PER material, so a later stage can convert the one world window into each
 * cloud's own attribute space. In THIS stage every material is seeded from the
 * same window record, so a single-cloud scene is numerically identical to the
 * shared-uniform version this replaces — the change is structure, not behaviour.
 *
 * `enabled` stays shared: it gates the whole fold (`mix(1, …, enabled)`), and the
 * on/off transition changes the compiled size graph's shape, which the Viewer
 * handles by rebuilding pipelines — a per-material concern would not help.
 */

import { float, mix, step, uniform, attribute } from 'three/tsl';

import type * as THREE from 'three/webgpu';

/** The dynamically-typed TSL node chain, matching the `Viewer` convention. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TslNode = any;

/** A material's own elevation window, in ATTRIBUTE space (origin-shifted). */
interface ElevMaterialUniforms {
  readonly min: ReturnType<typeof uniform>;
  readonly max: ReturnType<typeof uniform>;
  readonly axisIsZ: ReturnType<typeof uniform>;
}

export class ElevationFilterGpu {
  /** Shared gate: 0 → identity (pass every point), 1 → filter active. */
  private readonly _enabled = uniform(0);
  /**
   * Per-material window. A material folds its elevation mask the first time
   * `_applySizeMode` runs with the filter active; `maskMultiplier` seeds the
   * material here from the current record, so a material built while a window is
   * active is filtered at that window immediately. Mirrors `Viewer`'s
   * `_fadeUniforms` per-material pattern.
   */
  private readonly _perMaterial = new WeakMap<THREE.PointsNodeMaterial, ElevMaterialUniforms>();

  // Current-window RECORD, attribute space. Read by the CPU pick path and used to
  // seed a material's uniforms the first time it folds. `axisIsZ` is 1 for Z-up,
  // 0 for Y-up.
  private _axisIsZ = 1;
  private _min = 0;
  private _max = 0;

  /** True while the filter is active (its fold is present in the size graph). */
  isActive(): boolean {
    return (this._enabled.value as number) !== 0;
  }

  /** Current up-axis flag (1 = Z-up, 0 = Y-up), for the CPU pick window. */
  get axisIsZ(): number {
    return this._axisIsZ;
  }

  /** Current inclusive lower bound in attribute space, for the CPU pick window. */
  get min(): number {
    return this._min;
  }

  /** Current inclusive upper bound in attribute space, for the CPU pick window. */
  get max(): number {
    return this._max;
  }

  /**
   * The per-point elevation-mask multiplier node for one material: reads the
   * up-axis component of the instanced position (`aPos`), tests it against that
   * material's inclusive `[min, max]` window, and resolves to `1` (in range or
   * filter off) or `0` (out of range) — multiplying an out-of-range point's size
   * by 0 collapses its sprite, exactly like the class mask.
   *
   * Built from `step` + `mix` only (no boolean nodes): `lo = step(min, elev)` is
   * 1 when `elev >= min`; `hi = step(elev, max)` is 1 when `elev <= max`; their
   * product is the inclusive in-range flag. `mix(1, inRange, enabled)` is the
   * identity `1` when disabled, so the graph is a no-op until a window is set.
   * `axisIsZ` picks z (Z-up) or y (Y-up) without a rebuild.
   */
  maskMultiplier(material: THREE.PointsNodeMaterial): TslNode {
    const u = this._seed(material);
    const pos: TslNode = attribute('aPos');
    const axisIsZ: TslNode = u.axisIsZ;
    const elev: TslNode = pos.z.mul(axisIsZ).add(pos.y.mul(axisIsZ.oneMinus()));
    const lo: TslNode = step(u.min as TslNode, elev); // elev >= min
    const hi: TslNode = step(elev, u.max as TslNode); // elev <= max
    const inRange: TslNode = lo.mul(hi);
    return mix(float(1), inRange, this._enabled as TslNode);
  }

  /**
   * Set the window and push it into every already-folded material. `enabled`
   * toggles the shared gate; the bounds/axis update the record and every material
   * that has folded (so has uniforms). Materials not yet folded seed from the
   * record when they first fold, so they still match. `materials` is the live set
   * the Viewer enumerates (static clouds + streaming nodes).
   *
   * Stage A: one window for all. Stage B converts the world window per cloud
   * before calling this (or replaces this with a per-material seed).
   */
  writeWindow(
    enabled: 0 | 1,
    axisIsZ: number,
    min: number,
    max: number,
    materials: Iterable<THREE.PointsNodeMaterial>,
  ): void {
    this._enabled.value = enabled;
    this._axisIsZ = axisIsZ;
    this._min = min;
    this._max = max;
    for (const material of materials) {
      const u = this._perMaterial.get(material);
      if (!u) continue;
      u.min.value = min;
      u.max.value = max;
      u.axisIsZ.value = axisIsZ;
    }
  }

  /** Get-or-create a material's uniforms, seeded from the current record. */
  private _seed(material: THREE.PointsNodeMaterial): ElevMaterialUniforms {
    let u = this._perMaterial.get(material);
    if (!u) {
      u = { min: uniform(this._min), max: uniform(this._max), axisIsZ: uniform(this._axisIsZ) };
      this._perMaterial.set(material, u);
    }
    return u;
  }
}
