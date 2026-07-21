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
   * A label for the project's CRS, surfaced on the frame. This is presentation
   * only — it does NOT decide alignment (see {@link alignedToProject}).
   */
  readonly crsKey?: string | null;
  /**
   * False when this layer shares the horizontal frame but its VERTICAL
   * reference is unproven. Such a layer is placed in X/Y and is excluded from
   * choosing the project's Z origin. Omitted counts as verified, so callers
   * that predate the distinction behave as before.
   */
  readonly alignsVertically?: boolean;
  /**
   * False when the caller has determined this layer does not share the
   * project's coordinate frame.
   *
   * The decision lives with the caller on purpose. Comparing CRSs means
   * weighing the horizontal CRS *and* the vertical datum — heights do not align
   * across datums even when the horizontal frame matches — and the layer model's
   * `detectCrsMismatch` already implements exactly that rule for the layer
   * panel. An earlier version of this module compared horizontal keys itself,
   * which let the panel flag a pair as mismatched while the frame quietly folded
   * both their Z origins into one anchor. One authority, not two.
   *
   * Defaults to true, so a caller that has no CRS information at all still gets
   * a shared frame.
   */
  readonly alignedToProject?: boolean;
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
   * The layers the current anchor was chosen from, as `id → source origin`.
   * Lets the anchor persist while it still describes the set (see below); a
   * layer re-registered at a different origin, or a wholesale set change,
   * no longer matches and re-anchors.
   */
  let anchoredFrom = new Map<string, string>();
  const originKey = (o: readonly [number, number, number]): string => `${o[0]},${o[1]},${o[2]}`;

  /**
   * The project's CRS LABEL: the most common key among the layers that belong to
   * the frame, ties broken by first registration. Presentation only — which
   * layers belong is the caller's decision (see `alignedToProject`).
   */
  function frameCrsLabel(aligned: readonly ProjectFrameLayer[]): string | null {
    const counts = new Map<string, number>();
    const firstSeen: string[] = [];
    for (const layer of aligned) {
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

    const aligned: ProjectFrameLayer[] = [];
    for (const layer of state.sources.values()) {
      // A layer with no declared CRS is still noted, because the UI discloses
      // it — but absence of evidence is not disagreement, so it stays in the
      // frame. Excluding it would mean two meshes from one capture (PLY/OBJ
      // declare no CRS) could never share a frame: the ordinary case.
      if (!layer.crsKey) state.unknownCrs.push(layer.id);
      if (layer.alignedToProject === false) state.unaligned.push(layer.id);
      else aligned.push(layer);
    }

    if (aligned.length === 0) {
      // Every layer disagrees with the project, so there is no shared frame to
      // anchor. Each still mounts in its own frame below.
      state.frame = null;
      for (const layer of state.sources.values()) {
        state.transforms.set(
          layer.id,
          layerTransform(createProjectFrame(layer.sourceOrigin), layer.sourceOrigin),
        );
      }
      return;
    }

    // The shared anchor is derived ONLY from layers that belong to the frame; a
    // foreign CRS's easting would otherwise drag the origin somewhere that
    // describes neither layer.
    //
    // The anchor persists while it still DESCRIBES this set — that is, while
    // some layer it was chosen from is still here, unchanged. Layers are seeded
    // from their FILE origins, so recomputing the minimum on every change would
    // walk the anchor whenever a sibling closed, and nothing compensates the
    // camera for a rebase: already-mounted data would visibly jump for no
    // reason the user caused. A layer re-registered at a new origin, or a set
    // replaced wholesale, matches nothing and re-anchors as it should.
    const stillDescribed = aligned.some(
      (l) => anchoredFrom.get(l.id) === originKey(l.sourceOrigin),
    );
    // X/Y and Z are anchored from DIFFERENT sets. Every aligned layer shares
    // the horizontal frame, so all of them may set the horizontal origin. Only
    // a vertically-verified layer may set the Z origin: a horizontal-only
    // layer is one we have explicitly said we cannot trust in height, and
    // letting it choose the datum that verified layers are then rebased onto
    // inverts the whole point of the distinction. With nothing verified, no
    // layer's Z is rebased at all, so the value falls back to the aligned set
    // and goes unused rather than being invented.
    const verticallyVerified = aligned.filter((l) => l.alignsVertically !== false);
    const zSource = verticallyVerified.length > 0 ? verticallyVerified : aligned;
    const horizontal = chooseProjectOrigin(aligned.map((l) => l.sourceOrigin));
    const vertical = chooseProjectOrigin(zSource.map((l) => l.sourceOrigin));
    const origin =
      stillDescribed && state.frame
        ? state.frame.projectOrigin
        : ([horizontal[0], horizontal[1], vertical[2]] as Vec3);
    if (!stillDescribed) {
      anchoredFrom = new Map(aligned.map((l) => [l.id, originKey(l.sourceOrigin)]));
    }
    state.frame = createProjectFrame(origin, { crs: frameCrsLabel(aligned) ?? undefined });

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
