/**
 * streamingLodSize.ts — coarse-LOD display compensation for streamed nodes.
 *
 * While a view is still refining, the resident streamed nodes are the coarse
 * ones: their points sit further apart on screen, so the surface reads as
 * speckle rather than as a surface. This module makes those coarse points
 * slightly larger *while the view is coarse*, and fades that back to exactly
 * the settled sizing as refinement completes.
 *
 * It is a DISPLAY aid and nothing else. It never touches decoded values, never
 * feeds a measurement, an export or a terrain product, and the fully refined
 * view converges to a scale of exactly 1 — the same sprite size the renderer
 * produced before this module existed.
 *
 * Two halves:
 *   • pure maths ({@link relativeNodeResolution}, {@link coarseLodScale}),
 *     unit-tested in Node with no three.js import;
 *   • {@link CoarseLodSizeNodes}, the uniform bookkeeping the Viewer folds into
 *     its existing size graph. The graph SHAPE is constant, so a phase change
 *     writes a uniform value and rebuilds nothing.
 */

import type { RefinementPhase } from './refinementPhase';
import type { PointSizeMode } from './pointStyle';
import { POINT_STYLE_DEFAULTS, maxPointSize } from './pointStyle';

/** The largest multiplier a fully coarse node may take while a view moves. */
export const MAX_LOD_SCALE = 1.6;

/**
 * How much of {@link MAX_LOD_SCALE} each refinement phase is allowed to use.
 * `full-refine` is 0 by construction: a settled view renders at exactly the
 * sizing it did before this module existed.
 */
export const PHASE_LOD_GAIN: Readonly<Record<RefinementPhase, number>> = {
  moving: 1,
  coverage: 1,
  'center-refine': 0.5,
  'full-refine': 0,
};

/** userData keys carrying a streamed node's resolution and its source's root. */
export const NODE_RESOLUTION_KEY = 'olvNodeResolution';
export const ROOT_RESOLUTION_KEY = 'olvRootResolution';

/**
 * A node's resolution as a fraction of its own source's root resolution, in
 * `[0, 1]` — 1 at the root (coarsest), approaching 0 as nodes refine.
 *
 * Deliberately RELATIVE. Node resolution means different things per format
 * (COPC/EPT point spacing, a 3D Tiles geometric error, an OLV tile edge), so an
 * absolute value is not comparable across sources and is never compared here.
 * A missing, non-finite or non-positive value on either side yields 0 — no
 * compensation — rather than a guess.
 */
export function relativeNodeResolution(nodeResolution: number, rootResolution: number): number {
  if (!Number.isFinite(nodeResolution) || nodeResolution <= 0) return 0;
  if (!Number.isFinite(rootResolution) || rootResolution <= 0) return 0;
  const ratio = nodeResolution / rootResolution;
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  return Math.min(1, ratio);
}

/** The gain for a phase; an unknown phase contributes nothing. */
export function phaseLodGain(phase: RefinementPhase): number {
  return PHASE_LOD_GAIN[phase] ?? 0;
}

/**
 * The display multiplier for one node:
 *
 *   `1 + phaseGain × (MAX_LOD_SCALE − 1) × relativeResolution`
 *
 * bounded to `[1, MAX_LOD_SCALE]`. `fixed` mode returns exactly 1: a fixed
 * sprite size is an explicit user request and is never rescaled. The GPU graph
 * in {@link CoarseLodSizeNodes.apply} mirrors this expression exactly.
 */
export function coarseLodScale(
  relativeResolution: number,
  phase: RefinementPhase,
  mode: PointSizeMode,
): number {
  if (mode === 'fixed') return 1;
  const rel = relativeNodeResolution(relativeResolution, 1);
  const scale = 1 + phaseLodGain(phase) * (MAX_LOD_SCALE - 1) * rel;
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_LOD_SCALE, Math.max(1, scale));
}

/**
 * The upper size clamp once compensation has multiplied in. The adaptive node
 * is already clamped to `base × maxSizeFactor`; multiplying after that clamp
 * can exceed the visual limit, so the compensated graph re-clamps to this.
 */
export function maxCompensatedPointSize(baseSizePx: number, maxSizeFactor: number): number {
  return maxPointSize(baseSizePx, maxSizeFactor) * MAX_LOD_SCALE;
}

/** The factor the compensated clamp applies to the live base-size uniform. */
export const MAX_COMPENSATED_SIZE_FACTOR = POINT_STYLE_DEFAULTS.maxSizeFactor * MAX_LOD_SCALE;

/** Record a node's resolution and its source root's on a material's userData. */
export function markNodeResolution(
  userData: Record<string, unknown>,
  nodeResolution: number,
  rootResolution: number,
): void {
  userData[NODE_RESOLUTION_KEY] = nodeResolution;
  userData[ROOT_RESOLUTION_KEY] = rootResolution;
}

/** A live scalar uniform — structurally what `three/tsl`'s `uniform()` returns. */
interface UniformLike {
  value: number;
}

/** Broad TSL node type, matching how the render layer bridges the graph. */
type SizeNode = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The material surface this bookkeeping needs — identity plus its userData. */
interface LodMaterial {
  userData?: Record<string, unknown>;
}

/**
 * Uniform bookkeeping for the compensation fold.
 *
 * One SHARED phase-gain uniform, plus one relative-resolution uniform per
 * streaming material (a WeakMap keyed by material, the same ownership model the
 * dissolve uniforms use). Only registered materials fold anything in, so a
 * static cloud's size graph is untouched.
 *
 * `uniform` and the size nodes are injected rather than imported so the whole
 * class is testable in Node without pulling in three.js.
 */
export class CoarseLodSizeNodes {
  private readonly _uniform: (value: number) => UniformLike;
  private readonly _gain: UniformLike;
  private readonly _baseSize: SizeNode;
  private readonly _minSize: SizeNode;
  private readonly _rel = new WeakMap<LodMaterial, UniformLike>();

  constructor(uniform: (value: number) => UniformLike, baseSize: SizeNode, minSize: SizeNode) {
    this._uniform = uniform;
    this._gain = uniform(PHASE_LOD_GAIN['full-refine']);
    this._baseSize = baseSize;
    this._minSize = minSize;
  }

  /**
   * Point the shared gain uniform at a refinement phase. A value write only —
   * the graph shape does not depend on the phase, so no material is rebuilt.
   */
  setPhase(phase: RefinementPhase): void {
    this._gain.value = phaseLodGain(phase);
  }

  /** The gain currently driving every registered material. */
  get phaseGain(): number {
    return this._gain.value;
  }

  /**
   * Register a streaming material from the resolutions its builder recorded.
   * Returns true when the material was not registered before — the caller then
   * re-runs its size-mode application so the fold enters the graph. A material
   * whose resolutions are unusable registers at 0, which is the identity scale.
   */
  register(material: LodMaterial): boolean {
    const data = material.userData ?? {};
    const rel = relativeNodeResolution(
      Number(data[NODE_RESOLUTION_KEY]),
      Number(data[ROOT_RESOLUTION_KEY]),
    );
    const existing = this._rel.get(material);
    if (existing) {
      existing.value = rel;
      return false;
    }
    this._rel.set(material, this._uniform(rel));
    return true;
  }

  /** Whether this material folds compensation under the given size mode. */
  has(material: LodMaterial, mode: PointSizeMode): boolean {
    return mode !== 'fixed' && this._rel.has(material);
  }

  /** Drop a material's uniform — called when its streaming mesh is removed. */
  forget(material: LodMaterial): void {
    this._rel.delete(material);
  }

  /**
   * Fold the multiplier into a resolved size node and re-clamp the product.
   * Mirrors {@link coarseLodScale}: `size × (1 + gain × (MAX − 1) × rel)`,
   * bounded to `[minSizePx, base × maxSizeFactor × MAX_LOD_SCALE]` so a
   * malformed ratio can never produce a giant screen quad.
   */
  apply(node: SizeNode, material: LodMaterial): SizeNode {
    const rel = this._rel.get(material);
    if (!rel) return node;
    const compensated = node.add(node.mul(this._gain).mul(rel).mul(MAX_LOD_SCALE - 1));
    return compensated.clamp(this._minSize, this._baseSize.mul(MAX_COMPENSATED_SIZE_FACTOR));
  }
}
