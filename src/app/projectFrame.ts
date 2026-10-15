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
import { isZUpFormat, type SourceFormat } from '../io/sniffFormat';
import type { SessionFrameInput } from '../io/sessionFrame';
import type { LiveLayerEvidence } from '../io/sessionOwnership';
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
  /** The origin those layers chose; outlives a pass in which none of them aligns. */
  let anchorOrigin: Vec3 | null = null;
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
      anchoredFrom = new Map();
      anchorOrigin = null;
      return;
    }

    // Layers that anchored the current origin and are still open, unchanged —
    // aligned or not. A layer demoted out of the frame still carries work drawn
    // while it was placed against this origin, so its presence holds the origin
    // as long as it shares the frame's CRS (see `holders` below).
    const survivors = new Map<string, string>();
    for (const layer of state.sources.values()) {
      const key = originKey(layer.sourceOrigin);
      if (anchoredFrom.get(layer.id) === key) survivors.set(layer.id, key);
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
      anchoredFrom = survivors;
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
    // some layer that has been in the frame is still here, unchanged, whether or
    // not it is still aligned. Layers are seeded
    // from their FILE origins, so recomputing the minimum on every change would
    // walk the anchor whenever a sibling closed, and nothing compensates the
    // camera for a rebase: already-mounted data would visibly jump for no
    // reason the user caused. A layer re-registered at a new origin, or a set
    // replaced wholesale, matches nothing and re-anchors as it should.
    //
    // A holder must share the frame's horizontal CRS. A layer demoted because
    // its CRS differs from the set that now defines the frame describes a
    // different coordinate system, so its origin would label one CRS's frame
    // with another's coordinates. Holders only count while their horizontal CRS
    // key equals the frame's; when none does, the set re-anchors. A demotion on
    // vertical grounds within the same CRS still holds the origin.
    const frameKey = frameCrsLabel(aligned);
    const holders = new Map<string, string>();
    for (const [id, key] of survivors) {
      if ((state.sources.get(id)?.crsKey ?? null) === frameKey) holders.set(id, key);
    }
    const stillDescribed = holders.size > 0 && anchorOrigin !== null;
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
      stillDescribed && anchorOrigin
        ? anchorOrigin
        : ([horizontal[0], horizontal[1], vertical[2]] as Vec3);
    // Every layer that has shared the frame describes it from then on, so the
    // origin holds while ANY of them in the frame's CRS is still open. Closing the layer that
    // chose the minimum must not move the origin: measurements, annotations,
    // the clip box, saved views and the camera all stay in the project frame
    // and nothing rebases them. Only an empty set, a wholesale replace, or a
    // CRS change of the aligned set (no surviving holder in its CRS) re-anchors.
    anchoredFrom = new Map([
      ...(stillDescribed ? holders : []),
      ...aligned.map((l) => [l.id, originKey(l.sourceOrigin)] as const),
    ]);
    anchorOrigin = origin;
    state.frame = createProjectFrame(origin, { crs: frameKey ?? undefined });

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

/** What {@link projectFrameInputFrom} reads from the running app. */
export interface ProjectFrameSources {
  readonly frame: { readonly projectOrigin: readonly [number, number, number] } | null;
  readonly layerIds: readonly string[];
  cloud(id: string): { readonly sourceOrigin?: readonly [number, number, number]; readonly sourceFormat: SourceFormat } | null | undefined;
  record(id: string): { readonly layerId: string; readonly fingerprint: string; readonly displayName: string } | null;
  placement(id: string): { readonly vertical: boolean } | null;
}

/**
 * The frame input for a session save: null unless every open static layer has
 * a source origin and a proven identity, and either two or more are open or
 * the one open layer is still placed in the project frame (its anchor closed,
 * the frame kept). A partial frame is never written; the single-origin reading
 * applies instead.
 *
 * A lone placed layer's scene coordinates are local to its scene origin, so
 * that origin is written as the project origin. A horizontal-only placement
 * then carries a zero Z offset, exactly as the scene does.
 */
export function projectFrameInputFrom(src: ProjectFrameSources, force = false): SessionFrameInput | null {
  if (src.layerIds.length === 0) return null;
  // `force`: a save that carries held work needs records to read it through,
  // so a lone layer in its own frame is written as a frame of one, its origin
  // the project origin.
  if (!src.frame && !(force && src.layerIds.length === 1)) return null;
  let p = src.frame?.projectOrigin ?? null;
  if (src.layerIds.length === 1) {
    const id = src.layerIds[0]!;
    const so = src.cloud(id)?.sourceOrigin;
    if (!so) return null;
    p = sceneOriginFor(p, so, src.placement(id));
    if (!force && p.every((c, i) => c === so[i])) return null;
  }
  if (!p) return null;
  const layers: SessionFrameInput['layers'][number][] = [];
  for (const id of src.layerIds) {
    const cloud = src.cloud(id);
    const record = src.record(id);
    if (!cloud?.sourceOrigin || !record) return null;
    const placement = src.placement(id);
    const o = cloud.sourceOrigin;
    layers.push({
      layerId: record.layerId,
      sourceFingerprint: record.fingerprint,
      sourceName: record.displayName,
      sourceOrigin: [o[0], o[1], o[2]],
      upAxis: isZUpFormat(cloud.sourceFormat) ? 'z' : 'y',
      placed: placement != null,
      placedVertically: placement?.vertical ?? true,
    });
  }
  return { projectOrigin: [p[0], p[1], p[2]], layers };
}

/**
 * The origin the active layer's scene coordinates are local to. An unplaced
 * layer is in its own file frame. A placed layer shares the project origin in
 * X/Y, and in Z only when its vertical datum is verified; otherwise its Z
 * stays on the file origin.
 */
export function sceneOriginFor(
  projectOrigin: readonly [number, number, number] | null | undefined,
  sourceOrigin: readonly [number, number, number],
  placement: { readonly vertical: boolean } | null,
): [number, number, number] {
  if (!projectOrigin || !placement) return [sourceOrigin[0], sourceOrigin[1], sourceOrigin[2]];
  return [projectOrigin[0], projectOrigin[1], placement.vertical ? projectOrigin[2] : sourceOrigin[2]];
}

/** What {@link layerSceneOrigin} reads from the running app. */
export interface LayerOriginSources {
  readonly projectOrigin: readonly [number, number, number] | null | undefined;
  readonly viewerIds: readonly string[];
  stableIdFor(viewerId: string): string | null;
  sourceOrigin(viewerId: string): readonly [number, number, number] | null | undefined;
  placement(viewerId: string): { readonly vertical: boolean } | null;
}

/** The scene origin of the open layer with stable id `layerId`, or null when it is not open. */
export function layerSceneOrigin(layerId: string, src: LayerOriginSources): [number, number, number] | null {
  const id = src.viewerIds.find((v) => src.stableIdFor(v) === layerId);
  const so = id ? src.sourceOrigin(id) : null;
  return id && so ? sceneOriginFor(src.projectOrigin, so, src.placement(id)) : null;
}

type V3 = readonly [number, number, number];

/** What {@link sessionImportOrigins} reads from the running app. */
export interface SessionImportSources {
  frame(): { readonly projectOrigin: V3 } | null;
  activeId(): string | null;
  viewerIds(): readonly string[];
  stableIdFor(viewerId: string): string | null;
  cloud(viewerId: string): {
    readonly sourceOrigin?: V3;
    readonly sourceFormat?: SourceFormat;
    readonly metadata?: { readonly crs?: { readonly epsg?: number | null } | null } | null;
  } | null | undefined;
  placement(viewerId: string): { readonly vertical: boolean } | null;
  /** The scene origin when no static scan is active. */
  fallback(): V3;
  /** The identity record bound to a viewer id: stable id and fingerprint key. */
  record?(viewerId: string): { readonly layerId: string; readonly fingerprint: string } | null;
}

/**
 * The origins a session import rebases onto: the active layer's scene origin,
 * each open layer's scene origin by stable id, and the project origin.
 */
export function sessionImportOrigins(src: SessionImportSources): {
  exportOrigin: () => V3;
  layerOrigin: (layerId: string) => V3 | null;
  projectOrigin: () => V3 | null;
  liveLayers?: () => readonly LiveLayerEvidence[];
} {
  const layerSources = (): LayerOriginSources => ({
    projectOrigin: src.frame()?.projectOrigin,
    viewerIds: src.viewerIds(),
    stableIdFor: src.stableIdFor,
    sourceOrigin: (v) => src.cloud(v)?.sourceOrigin,
    placement: src.placement,
  });
  return {
    exportOrigin: () => {
      const id = src.activeId();
      const so = id ? src.cloud(id)?.sourceOrigin : null;
      return id && so ? sceneOriginFor(src.frame()?.projectOrigin, so, src.placement(id)) : src.fallback();
    },
    layerOrigin: (layerId) => layerSceneOrigin(layerId, layerSources()),
    projectOrigin: () => src.frame()?.projectOrigin ?? null,
    ...(src.record ? { liveLayers: () => liveLayerEvidence(src) } : {}),
  };
}

/** Every open layer with a bound identity, with the source facts it is matched on. */
function liveLayerEvidence(src: SessionImportSources): LiveLayerEvidence[] {
  const out: LiveLayerEvidence[] = [];
  for (const v of src.viewerIds()) {
    const rec = src.record?.(v);
    const cloud = src.cloud(v);
    if (!rec || !cloud) continue;
    const so = cloud.sourceOrigin;
    out.push({
      layerId: rec.layerId,
      fingerprint: rec.fingerprint,
      sourceOrigin: so ? [so[0], so[1], so[2]] : null,
      upAxis: cloud.sourceFormat && isZUpFormat(cloud.sourceFormat) ? 'z' : 'y',
      epsg: cloud.metadata?.crs?.epsg ?? null,
    });
  }
  return out;
}
