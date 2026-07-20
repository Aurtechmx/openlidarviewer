/**
 * projectFrame.ts — ownership of the project's shared spatial frame.
 *
 * Step 1 of the wiring plan in `docs/architecture/project-spatial-frame.md`.
 *
 * Every cloud is recentred about its OWN `floor(min)` origin, so two
 * georeferenced scans a kilometre apart both land near local zero and render
 * overlaid. This service owns the ONE origin every layer maps into, and derives
 * each layer's translation into it. It is pure state management — no scene, no
 * three.js — so the seed / recompute / clear behaviour is unit-tested directly;
 * mounting layers through the transforms is step 2.
 *
 * The degenerate case carries the compatibility guarantee: a single layer
 * anchors the frame at its own origin, so its transform is the identity and the
 * existing single-scan path is unchanged. That is what lets the frame be wired
 * in underneath the app before anything renders differently.
 *
 * Mixed CRS is flagged, never reprojected — reprojection stays a downstream
 * tool's job (PDAL / GDAL / proj4). A layer whose declared CRS disagrees with
 * the project's is excluded from the shared origin and mounts in its own frame,
 * so it sits where it always did rather than being asserted into a frame it
 * does not belong to.
 */

import {
  chooseProjectOrigin,
  createProjectFrame,
  layerTransform,
  type ProjectSpatialFrame,
  type LayerSpatialTransform,
} from '../geo/ProjectSpatialFrame';
import type { AppContext } from './appContext';

type Vec3 = readonly [number, number, number];

/** What a layer contributes to the frame. */
export interface ProjectFrameLayer {
  readonly id: string;
  /** The layer's own `floor(min)` origin, in source-CRS units (Float64). */
  readonly sourceOrigin: Vec3;
  /**
   * An opaque key identifying the layer's horizontal CRS. Two layers are
   * comparable when their keys are equal; `null`/absent means the source
   * declared none. The caller decides how to build it (see `layerModel`), so
   * this module never parses a CRS.
   */
  readonly crsKey?: string | null;
}

export interface ProjectFrameService {
  /** Add or replace a layer, then recompute the frame. */
  register(layer: ProjectFrameLayer): void;
  /**
   * Replace the whole layer set in one pass — the reconciliation the app drives
   * on every layer-set change. Preferred over register/unregister at call sites
   * that already know the full set, because it cannot leave a removed layer's
   * transform behind the way a missed `unregister` would.
   */
  reconcile(layers: readonly ProjectFrameLayer[]): void;
  /** Remove a layer (a no-op when absent), then recompute the frame. */
  unregister(id: string): void;
  /** Drop every layer and the frame (scan close / reset). */
  clear(): void;
  /** The shared frame, or null when no layer is registered. */
  readonly frame: ProjectSpatialFrame | null;
  /** A layer's transform into the frame, or null when it is not registered. */
  transformFor(id: string): LayerSpatialTransform | null;
  /** Layers excluded from the frame because their declared CRS disagrees. */
  readonly unaligned: string[];
  /** Registered layers that declared no CRS at all. */
  readonly unknownCrs: string[];
}

export function createProjectFrameService(context: AppContext): ProjectFrameService {
  const state = context.projectFrame;

  /**
   * The project's reference CRS: the most common declared key, ties broken by
   * first registration. This mirrors `detectCrsMismatch` in the layer model
   * deliberately — two different answers to "which CRS is this project in?"
   * would let the layer panel and the scene disagree about the same scans.
   */
  function referenceCrs(): string | null {
    const counts = new Map<string, number>();
    const firstSeen: string[] = [];
    for (const layer of state.sources.values()) {
      const key = layer.crsKey;
      if (!key) continue;
      if (!counts.has(key)) firstSeen.push(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if (firstSeen.length === 0) return null;
    let best = firstSeen[0];
    for (const key of firstSeen) {
      if ((counts.get(key) ?? 0) > (counts.get(best) ?? 0)) best = key;
    }
    return best;
  }

  /** Rebuild the frame and every transform from the registered layers. */
  function recompute(): void {
    state.transforms.clear();
    state.unaligned = [];
    state.unknownCrs = [];

    if (state.sources.size === 0) {
      state.frame = null;
      return;
    }

    const reference = referenceCrs();
    const aligned: ProjectFrameLayer[] = [];
    for (const layer of state.sources.values()) {
      if (!layer.crsKey) {
        // No declared CRS: absence of evidence is not disagreement. Excluding
        // these would mean two meshes from one capture (PLY/OBJ declare no CRS)
        // could never share a frame — the ordinary case, not the exotic one.
        state.unknownCrs.push(layer.id);
        aligned.push(layer);
      } else if (reference === null || layer.crsKey === reference) {
        aligned.push(layer);
      } else {
        state.unaligned.push(layer.id);
      }
    }

    // The shared anchor is derived ONLY from layers that belong to the frame; a
    // foreign CRS's easting would otherwise drag the origin somewhere that
    // describes neither layer.
    const origin = chooseProjectOrigin(aligned.map((l) => l.sourceOrigin));
    state.frame = createProjectFrame(origin, { crs: reference ?? undefined });

    for (const layer of state.sources.values()) {
      // An unaligned layer is not reprojected, so it keeps its own frame: its
      // transform is the identity, leaving it exactly where it already was
      // rather than displaced by an offset computed in the wrong CRS.
      state.transforms.set(
        layer.id,
        state.unaligned.includes(layer.id)
          ? layerTransform(createProjectFrame(layer.sourceOrigin), layer.sourceOrigin)
          : layerTransform(state.frame, layer.sourceOrigin),
      );
    }
  }

  return {
    register(layer) {
      state.sources.set(layer.id, layer);
      recompute();
    },
    reconcile(layers) {
      state.sources.clear();
      for (const layer of layers) state.sources.set(layer.id, layer);
      recompute();
    },
    unregister(id) {
      if (state.sources.delete(id)) recompute();
    },
    clear() {
      state.sources.clear();
      recompute();
    },
    get frame() {
      return state.frame;
    },
    transformFor(id) {
      return state.transforms.get(id) ?? null;
    },
    get unaligned() {
      return state.unaligned;
    },
    get unknownCrs() {
      return state.unknownCrs;
    },
  };
}
