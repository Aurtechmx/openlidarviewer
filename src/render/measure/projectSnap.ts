/**
 * projectSnap.ts
 *
 * Snapping and support grading in the PROJECT frame, across every eligible
 * layer.
 *
 * Measurement vertices live in the project frame, but each layer's positions
 * stay in its own source-local frame and reach the project frame through a
 * translation (the layer placement). The grid index built by
 * {@link buildPointSnapIndex} is therefore kept per layer, over the layer's
 * untouched positions, and the frame change happens at the query boundary:
 * the query is mapped into the layer's frame (`query - offset`, in float64),
 * the layer's index answers, and the hit is mapped back (`local + offset`).
 * Nothing is copied or re-quantised, so a large offset costs no float32
 * precision and a placement change only swaps an offset; the grid is reused.
 *
 * Grids are cached by the identity of the positions array, so adding a layer
 * builds one grid, and a visibility, lock or placement change builds none.
 *
 * The layer set is pulled lazily from a provider on the first query after
 * {@link ProjectSnapIndex.invalidate}; callers invalidate on the events that
 * change it. Results do not depend on load order or on which layer is active:
 * ties resolve by layer id, then point index, and support counts are sums.
 */

import type { PointCloud } from '../../model/PointCloud';
import { sourcePositions } from '../../model/pointFrames';
import {
  buildPointSnapIndex,
  countPointsWithinRadius,
  isOnMeasuredReturn,
  POINT_PREFERENCE_MARGIN,
  snapBest,
  snapToNearestPoint,
  type PointSnapIndex,
  type Segments,
  type SnapResult,
  type Vec3,
} from './snap';

/** One layer offered for snapping: its source-local xyz and placement offset. */
export interface SnapLayerSource {
  readonly id: string;
  readonly local: Float32Array;
  /** Source-local to project translation (zero for an unplaced layer). */
  readonly offset: Vec3;
}

/** A snap hit with the layer it came from (`position` is in the project frame). */
export type ProjectSnapResult = SnapResult & { layerId: string };

/** Per-vertex support signals, as consumed by the measurement trust grade. */
export interface VertexSupport {
  snappedToPoint: boolean;
  pointsWithinRadius: number;
}

interface ReadyLayer {
  readonly id: string;
  readonly index: PointSnapIndex;
  readonly offset: Vec3;
}

export class ProjectSnapIndex {
  private _layers: ReadyLayer[] | null = null;
  private _provider: (() => readonly SnapLayerSource[]) | null = null;
  private readonly _grids = new WeakMap<Float32Array, PointSnapIndex>();
  private _warmQueued = false;

  /**
   * @param defer Optional task scheduler. When given, grids for newly offered
   *   layers are built one per task after a change, so the build runs between
   *   frames instead of inside the first click that needs it.
   */
  private readonly _defer: ((task: () => void) => void) | undefined;

  constructor(defer?: (task: () => void) => void) {
    this._defer = defer;
  }

  /** Set where the eligible layers come from (visible, unlocked, static). */
  setProvider(provider: (() => readonly SnapLayerSource[]) | null): void {
    this._provider = provider;
    this.invalidate();
  }

  /** The eligible layer set, a visibility/lock state or a placement changed. */
  invalidate(): void {
    this._layers = null;
    if (this._defer && this._provider && !this._warmQueued) {
      this._warmQueued = true;
      this._defer(() => this._warmStep());
    }
  }

  /** Build at most one missing grid, then yield and continue with the next. */
  private _warmStep(): void {
    this._warmQueued = false;
    const missing = (this._provider?.() ?? []).find(
      (src) => src.local.length >= 3 && !this._grids.has(src.local),
    );
    if (!missing) return;
    this._grids.set(missing.local, buildPointSnapIndex(missing.local));
    this._warmQueued = true;
    this._defer?.(() => this._warmStep());
  }

  /** True when at least one layer has points to snap to. */
  get available(): boolean {
    return this._ready().length > 0;
  }

  /** Nearest real return across all layers within `maxDistance` of `query`. */
  nearest(query: Vec3, maxDistance: number): ProjectSnapResult | null {
    let best: ProjectSnapResult | null = null;
    for (const layer of this._ready()) {
      const hit = snapToNearestPoint(layer.index, toLayer(query, layer.offset), maxDistance);
      if (!hit) continue;
      if (best === null || hit.distance < best.distance) {
        const p = hit.position;
        best = {
          ...hit,
          position: [p[0] + layer.offset[0], p[1] + layer.offset[1], p[2] + layer.offset[2]],
          layerId: layer.id,
        };
      }
    }
    return best;
  }

  /**
   * Closest snap of any kind: a real return from any layer, or constructed
   * geometry from existing measurements. A real return wins a near-tie, the
   * same rule {@link snapBest} applies within one cloud.
   */
  best(segments: Segments, query: Vec3, maxDistance: number): SnapResult | null {
    const geometry = snapBest(EMPTY_GRID, segments, query, maxDistance);
    const point = this.nearest(query, maxDistance);
    if (!point) return geometry;
    if (!geometry) return point;
    return point.distance <= geometry.distance + POINT_PREFERENCE_MARGIN ? point : geometry;
  }

  /**
   * Support under one vertex: whether it sits on a real return (within half a
   * nominal point spacing) and how many returns lie within four spacings. A
   * layer's spacing is its own grid cell size, so each layer is judged on its
   * own density; the counts add. A layer with no usable cell size (one point,
   * no extent) keeps the single-layer behaviour when it is the only layer, and
   * otherwise contributes only when the vertex sits on its point.
   */
  support(p: Vec3): VertexSupport {
    const layers = this._ready();
    let snapped = false;
    let within = 0;
    for (const layer of layers) {
      const q = toLayer(p, layer.offset);
      const idx = layer.index;
      const useGrid = Number.isFinite(idx.cellSize) && idx.cellSize > 0;
      // On a real return by the bounded local-spacing rule, per layer.
      const onPoint = isOnMeasuredReturn(idx, q);
      if (onPoint) snapped = true;
      if (useGrid) within += countPointsWithinRadius(idx, q, idx.cellSize * 4);
      else if (layers.length === 1) within += idx.count;
      else if (onPoint) within += 1;
    }
    return { snappedToPoint: snapped, pointsWithinRadius: within };
  }

  private _ready(): ReadyLayer[] {
    if (this._layers) return this._layers;
    const out: ReadyLayer[] = [];
    for (const src of this._provider?.() ?? []) {
      if (src.local.length < 3) continue;
      let index = this._grids.get(src.local);
      if (!index) {
        index = buildPointSnapIndex(src.local);
        this._grids.set(src.local, index);
      }
      out.push({ id: src.id, index, offset: src.offset });
    }
    // Id order makes cross-layer ties independent of load order.
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this._layers = out;
    return out;
  }
}

const EMPTY_GRID = buildPointSnapIndex(new Float32Array(0));

function toLayer(q: Vec3, off: Vec3): Vec3 {
  return off[0] === 0 && off[1] === 0 && off[2] === 0 ? q : [q[0] - off[0], q[1] - off[1], q[2] - off[2]];
}

/** The slice of a viewer layer entry that decides snap eligibility. */
export interface SnapLayerEntry {
  readonly cloud: PointCloud;
  readonly mesh: { readonly visible: boolean };
  readonly locked?: boolean;
  readonly placement?: { readonly sourceToProject: Vec3 } | null;
}

/**
 * Layers offered to snapping: visible, unlocked static layers with their
 * project-frame offset. A streaming scan has no resident array, so it turns
 * snapping off for the whole scene.
 */
export function eligibleSnapLayers(
  entries: Iterable<readonly [string, SnapLayerEntry]>,
  streaming: boolean,
): SnapLayerSource[] {
  const out: SnapLayerSource[] = [];
  if (streaming) return out;
  for (const [id, e] of entries) {
    if (!e.mesh.visible || e.locked) continue;
    out.push({ id, local: sourcePositions(e.cloud), offset: e.placement?.sourceToProject ?? [0, 0, 0] });
  }
  return out;
}
