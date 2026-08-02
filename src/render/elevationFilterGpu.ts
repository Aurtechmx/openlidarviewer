/**
 * elevationFilterGpu.ts
 *
 * The GPU-side state for the elevation filter, extracted from `Viewer.ts` so the
 * render monolith does not grow to hold it (and shrinks as a result). The pure
 * world→attribute conversion still lives in `elevationFilterUniform.ts`; this
 * module owns the stateful "hold the uniforms and build the mask node" side that
 * used to be four `Viewer` fields plus three methods.
 *
 * WHY PER MATERIAL (v0.5.6-gate2). The window used to be three SHARED uniforms,
 * so every cloud filtered against a single origin and up-axis. Points are stored
 * origin-shifted, so two layers recentred by DIFFERENT origins — or a Z-up survey
 * beside a Y-up phone scan — clipped against the wrong reference: the window was
 * correct for whichever cloud happened to supply the origin and silently wrong
 * for every other layer.
 *
 * Each material now carries its own `min`/`max`/`axisIsZ`, resolved through a
 * callback the Viewer installs. Cloud knowledge (which origin, which up-axis)
 * stays in the Viewer, the only thing that knows the cloud registry; this module
 * never learns what a cloud is. `enabled` stays shared: it gates the whole fold,
 * and toggling it changes the compiled size graph's shape, which the Viewer
 * handles by rebuilding pipelines.
 */

import { float, mix, step, uniform, attribute } from 'three/tsl';

import type * as THREE from 'three/webgpu';

import type { ElevMaterialWindow } from './elevationWindowResolver';

/** The dynamically-typed TSL node chain, matching the `Viewer` convention. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TslNode = any;

/**
 * Resolves the attribute-space window for one material. Installed by the Viewer,
 * which looks up the material's owning cloud and runs the pure conversion. A
 * material whose cloud cannot be resolved still gets a window — the Viewer falls
 * back to the scene-level origin rather than throwing, so an orphaned mesh
 * degrades to the old shared-origin behaviour instead of vanishing.
 */
export type ElevWindowResolver = (material: THREE.PointsNodeMaterial) => ElevMaterialWindow;

interface ElevMaterialUniforms {
  readonly min: ReturnType<typeof uniform>;
  readonly max: ReturnType<typeof uniform>;
  readonly axisIsZ: ReturnType<typeof uniform>;
}

/** Used before the Viewer installs a resolver; the filter is off at that point. */
const IDENTITY_WINDOW: ElevMaterialWindow = { min: 0, max: 0, axisIsZ: 1 };

export class ElevationFilterGpu {
  /** Shared gate: 0 → identity (pass every point), 1 → filter active. */
  private readonly _enabled = uniform(0);
  /**
   * Per-material window. A material folds its elevation mask the first time
   * `_applySizeMode` runs with the filter active; `maskMultiplier` seeds it from
   * the resolver at that moment, so a mesh built WHILE a window is active is
   * filtered at its OWN cloud's window immediately, rather than at whatever the
   * scene last wrote. Mirrors `Viewer`'s `_fadeUniforms` per-material pattern.
   */
  private readonly _perMaterial = new WeakMap<THREE.PointsNodeMaterial, ElevMaterialUniforms>();
  private _resolve: ElevWindowResolver = () => IDENTITY_WINDOW;

  /** Install the Viewer's per-material window resolver. */
  setWindowResolver(resolve: ElevWindowResolver): void {
    this._resolve = resolve;
  }

  /** True while the filter is active (its fold is present in the size graph). */
  isActive(): boolean {
    return (this._enabled.value as number) !== 0;
  }

  /**
   * Set the shared gate, then re-resolve every already-folded material's window.
   * Materials that have not folded hold no uniforms and are skipped; they seed
   * from the same resolver when they first fold, so they still land on their own
   * cloud's window.
   *
   * Only uniform VALUES change here, which needs no pipeline rebuild. The Viewer
   * rebuilds separately when `enabled` crosses the on/off boundary, because that
   * is what changes the compiled graph's shape.
   */
  apply(enabled: 0 | 1, materials: Iterable<THREE.PointsNodeMaterial>): void {
    this._enabled.value = enabled;
    for (const material of materials) {
      const u = this._perMaterial.get(material);
      if (!u) continue;
      const w = this._resolve(material);
      u.min.value = w.min;
      u.max.value = w.max;
      u.axisIsZ.value = w.axisIsZ;
    }
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
   * identity `1` when the filter is disabled, so the graph is a no-op until a
   * window is set. `axisIsZ` picks z (Z-up) or y (Y-up) without a rebuild.
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

  /** Get-or-create a material's uniforms, seeded from its own cloud's window. */
  private _seed(material: THREE.PointsNodeMaterial): ElevMaterialUniforms {
    let u = this._perMaterial.get(material);
    if (!u) {
      const w = this._resolve(material);
      u = { min: uniform(w.min), max: uniform(w.max), axisIsZ: uniform(w.axisIsZ) };
      this._perMaterial.set(material, u);
    }
    return u;
  }
}
