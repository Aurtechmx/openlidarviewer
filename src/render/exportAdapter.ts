/**
 * exportAdapter.ts — the narrow Viewer slice the Visual Export Studio drives.
 *
 * Each Studio exporter reads the live scene through an {@link ExportSceneAdapter}
 * rather than touching the Viewer directly, so the export path depends on a
 * handful of questions ("does this scan carry RGB?", "what is its CRS?") instead
 * of on render internals. This module owns that translation; `Viewer` keeps a
 * one-call factory that binds its own state to {@link ExportAdapterHost}.
 *
 * The host is declared structurally — a cloud map and a streaming session, plus
 * the render entry points — so nothing here imports `Viewer`, and the adapter is
 * constructible from a plain object in a unit test.
 *
 * Every accessor answers streaming-first, then folds the static clouds: a scan
 * is either one streaming source or a set of loaded files, and the streaming
 * source carries authoritative header metadata where a static set has to be
 * reconciled. Where that reconciliation can't produce one honest answer (clouds
 * disagreeing about their world origin), the adapter returns null rather than
 * picking a frame — see `georefContext`. Part of the v0.6 decomposition (see
 * `docs/architecture/architecture-map.md`).
 */

import type { ColorMode } from './colorModes';
import type { PointCloud } from '../model/PointCloud';
import type { StreamingSource } from './streaming/StreamingSource';
import type { LayerSpatialTransform } from '../geo/ProjectSpatialFrame';
import { placeAabb } from './layerPlacement';
import type { ExportSceneAdapter, FigureViewContext, ExportColorModeSnapshot } from '../export/types';
import { linearUnitLabel } from '../io/crs';
// The shared capture verdict for `captureLabel`. It surfaces capture-type plus
// confidence into every exported image's scan-report card, from the same store
// the Inspector card and the PDF report read.
import { captureProvenance } from '../diagnostics/captureProvenance';
import { classificationCoverage } from './class/classificationCoverage';

/**
 * The per-cloud slice the adapter reads — a structural subset of the Viewer's
 * entry. `visible` and `placement` were added so the adapter can answer every
 * scene question over the layers that actually render, where they render: the
 * exported image is WYSIWYG, so a HIDDEN layer must not enable a colour mode,
 * inflate a point count, or stretch the export bounds (pass-7 #4/#6), and a
 * MOUNTED layer must be framed at its placed position, not its source-local one
 * (#5). `placement` is null for an identity (unmounted) layer.
 */
export interface ExportAdapterCloud {
  readonly cloud: PointCloud;
  readonly mode: ColorMode;
  readonly visible: boolean;
  readonly placement: LayerSpatialTransform | null;
}

/** The streaming slice the adapter reads — a structural subset of the session. */
export interface ExportAdapterStreaming {
  readonly cloud: StreamingSource;
  readonly renderer: { readonly colorMode: ColorMode };
}

/**
 * What the adapter needs from the live scene. Accessors are functions, not
 * snapshots, so the adapter always reflects the CURRENT loaded clouds — the
 * property the previous inline construction had by being rebuilt per call.
 */
/** A cloud's RESOLVED export CRS: the WKT to stamp into the `.prj` (null = do not
 *  georeference), a stable equality key (null = no declared CRS, never a
 *  conflict), and the display label / unit / epsg so the export report's CRS name
 *  and scale-bar unit match the `.prj` rather than the rejected declared CRS
 *  (1C). All null for a local / unknown resolution. */
export interface ExportCloudCrs {
  readonly wkt: string | null;
  readonly key: string | null;
  readonly name: string | null;
  readonly unit: string | null;
  readonly epsg: number | null;
}

export interface ExportAdapterHost {
  clouds(): ReadonlyMap<string, ExportAdapterCloud>;
  streaming(): ExportAdapterStreaming | null;
  /**
   * The RESOLVED CRS for a static cloud (CRS authority, override applied), or
   * omitted when the host wires no resolver — then the adapter falls back to the
   * cloud's declared metadata. Wiring this is what stops a rejected/local CRS
   * override from reaching the ortho `.prj` (pass-5 C10).
   */
  resolveCloudCrs?: (cloud: PointCloud) => ExportCloudCrs;
  /**
   * The RESOLVED CRS for the ACTIVE scan (override applied), independent of any
   * static-cloud identity — this is how a STREAMING (COPC/EPT) scan reaches the
   * resolved authority, since its cloud is not a static `PointCloud` the per-cloud
   * `resolveCloudCrs` can key on. Omitted in the pure-adapter tests, where the
   * streaming paths fall back to the cloud's declared `crs()`, matching the
   * pre-wiring behaviour. Local/unknown resolves to all-null (no `.prj`, no label).
   */
  resolvedActiveCrs?: () => ExportCloudCrs;
  setColorMode(id: string, mode: ColorMode): void;
  setStreamingColorMode(mode: ColorMode): void;
  /** Toggle a static layer's render visibility (for the export scope). */
  setVisible(id: string, visible: boolean): void;
  snapshot(options: {
    measurements: boolean;
    annotations: boolean;
    inspector: boolean;
    probe: boolean;
    colorbar: boolean;
  }): Promise<Blob>;
  renderFramedTopDown(
    aabb: readonly [number, number, number, number, number, number],
    widthPx?: number,
  ): Promise<{
    blob: Blob;
    widthPx: number;
    heightPx: number;
    extent: { minX: number; minY: number; maxX: number; maxY: number };
  } | null>;
  renderFigure(options: { widthPx?: number; heightPx?: number }): Promise<{
    blob: Blob;
    widthPx: number;
    heightPx: number;
  } | null>;
  figureViewContext(): FigureViewContext;
}

/**
 * Whether a static layer carries the channel `mode` draws from. Elevation (and
 * any scalar derivable from XYZ) is always renderable; the channel modes need
 * the matching per-point attribute. An unknown mode is treated as supported so
 * a new mode never silently hides layers.
 */
function staticLayerSupportsMode(cloud: PointCloud, mode: ColorMode): boolean {
  switch (mode) {
    case 'rgb':
      return !!cloud.colors;
    case 'intensity':
      return !!cloud.intensity;
    case 'classification':
      return !!cloud.classification;
    case 'normal':
      return !!cloud.normals;
    default:
      return true;
  }
}

/**
 * Conflict-detection key for a cloud that resolves to Local/unknown (null CRS
 * key). Real keys are `epsg:…` / `name:…` (see `metadataCrsKeyWkt`), so this
 * sentinel can never equal one: a local layer therefore matches other local
 * layers but conflicts with any projected layer, forcing the georeference to be
 * refused when the two are mixed.
 */
const LOCAL_CRS_SENTINEL = '\u0000local';

/**
 * The georeference CRS derived from a cloud's DECLARED metadata — the fallback
 * when no resolver is wired. EPSG when declared, else the display name, mirroring
 * `layerCompatibility.horizontalKey`; the WKT is the file's own. Source-declared
 * provenance, so it does not honour a user override (that is what a wired
 * `resolveCloudCrs` is for) — but it never resurrects a rejected CRS on its own,
 * because with a resolver wired this helper is not consulted.
 */
function metadataCrsKeyWkt(cloud: PointCloud): ExportCloudCrs {
  const detected = cloud.metadata?.crs;
  const key =
    detected?.epsg != null && Number.isFinite(detected.epsg)
      ? `epsg:${detected.epsg}`
      : detected?.name
        ? `name:${detected.name.trim().toLowerCase()}`
        : null;
  return {
    wkt: detected?.wkt ?? null,
    key,
    name: detected?.name ?? null,
    unit: detected ? linearUnitLabel(detected.linearUnit) : null,
    epsg: detected?.epsg ?? null,
  };
}

/** Build the {@link ExportSceneAdapter} the Studio exporters drive. */
export function buildExportAdapter(host: ExportAdapterHost): ExportSceneAdapter {
  // The exported image is WYSIWYG — it shows the VISIBLE scene. So every scene
  // question (capabilities, counts, bounds, provenance) is answered over the
  // visible static clouds only, so a hidden layer cannot enable a colour mode,
  // inflate a point count, stretch the bounds, or supply provenance for pixels
  // it did not contribute (pass-7 #4/#6/#7).
  const visibleEntries = (): ExportAdapterCloud[] =>
    [...host.clouds().values()].filter((c) => c.visible);
  return {
    setExportColorMode(mode: ColorMode): void {
      // Apply to every loaded cloud + the streaming subsystem so every
      // resident mesh recolours in lockstep. Wrap each cloud's setColorMode
      // individually: if one cloud lacks the channel for `mode` (e.g.
      // classification on a PLY), `colorForMode` throws — we catch + skip
      // so the other clouds (and the streaming cloud, if any) still
      // recolour, and the export proceeds against whatever data IS valid.
      // Without this guard, a single channel-missing cloud poisoned the
      // whole export and left the UI half-recoloured.
      for (const id of host.clouds().keys()) {
        try {
          host.setColorMode(id, mode);
        } catch (err) {
          // Swallow per-cloud capability mismatches — the orchestrator's
          // `isAvailable` gate is the source of truth for whether the
          // export *should* run. This catch only protects mid-loop state.
          console.warn(`[export] setColorMode(${mode}) on cloud "${id}" skipped:`, err);
        }
      }
      try {
        host.setStreamingColorMode(mode);
      } catch (err) {
        console.warn(`[export] setStreamingColorMode(${mode}) skipped:`, err);
      }
    },
    currentColorMode(): ColorMode {
      // Prefer the streaming cloud's mode when present — otherwise the
      // first static cloud's mode, otherwise the runtime default.
      const streaming = host.streaming();
      if (streaming) return streaming.renderer.colorMode;
      const first = visibleEntries()[0];
      return first ? first.mode : 'rgb';
    },
    snapshotColorModes(): ExportColorModeSnapshot {
      // Capture EVERY registered layer's mode (not just visible — a hidden
      // layer's mode must be restored too), so restore is exact per-layer.
      const staticModes = new Map<string, ColorMode>();
      for (const [id, c] of host.clouds()) staticModes.set(id, c.mode);
      const streaming = host.streaming();
      return { staticModes, streamingMode: streaming ? streaming.renderer.colorMode : null };
    },
    restoreColorModes(snapshot: ExportColorModeSnapshot): void {
      // Restore each layer to the mode it actually held. The single-scalar
      // restore clobbered layers with distinct modes to the first layer's mode.
      for (const [id, mode] of snapshot.staticModes) {
        try {
          host.setColorMode(id, mode);
        } catch (err) {
          console.warn(`[export] restoring cloud "${id}" to ${mode} skipped:`, err);
        }
      }
      if (snapshot.streamingMode !== null) {
        try {
          host.setStreamingColorMode(snapshot.streamingMode);
        } catch (err) {
          console.warn(`[export] restoring streaming to ${snapshot.streamingMode} skipped:`, err);
        }
      }
    },
    excludeUnsupported(mode: ColorMode): readonly string[] {
      // Streaming is a single source; its own availability gate decides whether
      // the export runs at all. Only the multi-layer STATIC path can mix a
      // supported layer with one that lacks the channel and would otherwise
      // render in its stale colour under a scientific title (pass-7 #3).
      if (host.streaming()) return [];
      const hidden: string[] = [];
      for (const [id, c] of host.clouds()) {
        if (!c.visible || staticLayerSupportsMode(c.cloud, mode)) continue;
        try {
          host.setVisible(id, false);
          hidden.push(id);
        } catch (err) {
          console.warn(`[export] hiding unsupported layer "${id}" for ${mode} skipped:`, err);
        }
      }
      return hidden;
    },
    restoreVisibility(ids: readonly string[]): void {
      for (const id of ids) {
        try {
          host.setVisible(id, true);
        } catch (err) {
          console.warn(`[export] restoring visibility of "${id}" skipped:`, err);
        }
      }
    },
    hasRgb(): boolean {
      const streaming = host.streaming();
      if (streaming) {
        // read off the abstract `availableColorModes` so this
        // works uniformly for COPC + EPT. The cloud's own implementation
        // knows whether it carries RGB (COPC: PDRF 7/8; EPT: schema has
        // Red/Green/Blue attrs).
        return streaming.cloud.availableColorModes().includes('rgb');
      }
      for (const { cloud } of visibleEntries()) {
        if (cloud.colors) return true;
      }
      return false;
    },
    hasIntensity(): boolean {
      // Dispatch on the abstract `availableColorModes()` for streaming, exactly
      // as hasClassification does — COPC PDRF 6/7/8 carry intensity but an
      // arbitrary EPT may have no Intensity dimension, and the EPT source
      // already reports that. `return true` here lit the Intensity exporter for
      // an intensity-less EPT, whose recolor then silently failed (E9).
      const streaming = host.streaming();
      if (streaming) {
        return streaming.cloud.availableColorModes().includes('intensity');
      }
      for (const { cloud } of visibleEntries()) {
        if (cloud.intensity) return true;
      }
      return false;
    },
    hasClassification(): boolean {
      // dispatch on the abstract `availableColorModes()` so
      // COPC and EPT route uniformly. Static clouds fall through to
      // the explicit field check.
      const streaming = host.streaming();
      if (streaming) {
        return streaming.cloud.availableColorModes().includes('classification');
      }
      for (const { cloud } of visibleEntries()) {
        if (cloud.classification) return true;
      }
      return false;
    },
    classificationAssignedFraction(): number | null {
      // Streaming holds only the loaded nodes, so any share counted here would
      // describe the current view rather than the scan — answer "cannot count"
      // instead of publishing a moving number.
      if (host.streaming()) return null;
      let total = 0;
      let assigned = 0;
      for (const { cloud } of visibleEntries()) {
        if (!cloud.classification) continue;
        const { producer } = classificationCoverage(cloud.classification, cloud.pointCount);
        total += cloud.pointCount;
        assigned += producer;
      }
      return total > 0 ? assigned / total : null;
    },
    hasNormals(): boolean {
      // Dispatch on the abstract `availableColorModes()` for streaming, exactly
      // as hasRgb / hasIntensity / hasClassification do.
      //
      // This used to answer `false` for every streaming source, on the grounds
      // that COPC and EPT carry no normals: LAS reserves no field for them and
      // EPT writers rarely emit Normal X/Y/Z attributes. That is still true of
      // those two formats, and both still report no `normal` mode, so the gate
      // stays shut exactly where it was shut before. It is not true of a 3D
      // Tiles tileset, whose tiles state a NORMAL accessor per tile and whose
      // source offers `normal` once a tile has stated one — a measurement that
      // reaches the renderer, the resident snapshot and the profile, and was
      // then refused an export by a claim about the format rather than about
      // the data. Static loaders (PCD, PTX, GLTF) still check the field.
      const streaming = host.streaming();
      if (streaming) {
        return streaming.cloud.availableColorModes().includes('normal');
      }
      for (const { cloud } of visibleEntries()) {
        if (cloud.normals) return true;
      }
      return false;
    },
    snapshot(options: {
      measurements: boolean;
      annotations: boolean;
      inspector: boolean;
      probe: boolean;
      colorbar?: boolean;
    }): Promise<Blob> {
      // Delegate to the live snapshot pipeline so the export matches the
      // on-screen view EXACTLY — EDL, perspective camera, overlays, all
      // baked through the same code path the Save-view feature
      // uses. The inspector + probe flags add the Studio bakes:
      // active Inspect tool's marker + info card, and LiveProbe's last-
      // known readout. Together they capture every on-canvas data overlay
      // the user might have been working with when they clicked Export.
      return host.snapshot({
        measurements: options.measurements,
        annotations: options.annotations,
        inspector: options.inspector,
        probe: options.probe,
        // Colorbar legend for continuous scalar exports; self-gating
        // inside snapshot(), so categorical modes are untouched.
        colorbar: options.colorbar === true,
      });
    },
    sourceName(): string {
      const streaming = host.streaming();
      if (streaming) return streaming.cloud.name;
      // Every other figure on the scan-report card is answered over the visible
      // entries: Points sums them, the extent is their union, the CRS is the
      // first that declares one. The name was the exception, and named only the
      // first visible layer, so a card covering three scans read as a card
      // about one of them. Naming the count alongside it keeps the name useful
      // for identification while saying the figures cover more.
      const visible = visibleEntries();
      if (visible.length === 0) return 'scan';
      const first = visible[0]!.cloud.name;
      return visible.length === 1 ? first : `${first} + ${visible.length - 1} more`;
    },
    sourcePointCount(): number | null {
      const streaming = host.streaming();
      if (streaming) return streaming.cloud.sourcePointCount;
      // The file's declared total, back-scaled when the loader strided a huge
      // cloud for display — the honest headline the Scan Report and PDF use.
      // Summing the strided `pointCount` under-reported "Points" and inflated
      // the export card's density divisor disagreement with every other panel.
      let total = 0;
      for (const { cloud } of visibleEntries()) {
        total += cloud.declaredPointCount !== undefined && cloud.declaredPointCount > cloud.pointCount
          ? cloud.declaredPointCount
          : cloud.pointCount;
      }
      return total;
    },
    residentPointCount(): number {
      const streaming = host.streaming();
      if (streaming) return streaming.cloud.residentPointCount;
      // The ACTUALLY-loaded points, not sourcePointCount() — that back-scales to
      // the file's declared total, so a strided load (declared 100M, resident
      // 5M) reported 100M resident (E8). Sum the real per-cloud pointCount,
      // matching Viewer.residentPointTotal().
      let total = 0;
      for (const { cloud } of visibleEntries()) total += cloud.pointCount;
      return total;
    },
    crsLabel(): { name: string; unit: string; epsg?: number } | null {
      // read off the abstract `cloud.crs()` so both COPC and
      // EPT surface consistently. COPC pulls from the LAS VLRs the
      // header parser walked; EPT pulls from `ept.json`'s `srs.wkt`.
      // Static clouds carry CRS through `CloudMetadata.crs`.
      // Streaming: the RESOLVED active CRS (override applied) via the wired
      // accessor, so a COPC/EPT scan's export report names the CRS the user chose
      // rather than the file's declared one, and a Local/unknown resolution yields
      // a null name (no CRS row) instead of the rejected declaration. Falls back to
      // the source `crs()` only when no accessor is wired (pure-adapter tests).
      if (host.streaming() && host.resolvedActiveCrs) {
        const rc = host.resolvedActiveCrs();
        return rc.name ? { name: rc.name, unit: rc.unit ?? 'units', epsg: rc.epsg ?? undefined } : null;
      }
      const fromStreaming = host.streaming()?.cloud.crs();
      if (fromStreaming) {
        return {
          name: fromStreaming.name,
          unit: linearUnitLabel(fromStreaming.linearUnit),
          epsg: fromStreaming.epsg,
        };
      }
      // Static clouds: the RESOLVED CRS (override applied) via the wired resolver,
      // so the export report's CRS name and scale-bar unit match the .prj rather
      // than the rejected declared CRS (1C). A local resolution yields a null name
      // and is skipped — a local scan reports no CRS, not the rejected one. Falls
      // back to declared metadata only when no resolver is wired (pure tests).
      for (const { cloud } of visibleEntries()) {
        const rc = host.resolveCloudCrs ? host.resolveCloudCrs(cloud) : metadataCrsKeyWkt(cloud);
        if (rc.name) {
          return { name: rc.name, unit: rc.unit ?? 'units', epsg: rc.epsg ?? undefined };
        }
      }
      return null;
    },
    captureLabel(): { label: string; confidence: 'low' | 'medium' | 'high' } | null {
      // The verdict the Inspector card and the PDF Provenance section are
      // showing, read from the shared store rather than re-classified here.
      // Re-classifying from the cloud alone dropped both the shape router's
      // verdict and the user's capture-type override, so an exported image could
      // stamp a capture type the panel and the PDF both contradicted.
      //
      // The store describes the ACTIVE scan; this row describes the pixels. The
      // two diverge because static layers are additive and the newest open
      // becomes active: hiding the active layer, or removing it while an older
      // one stays, leaves the store describing a scan the image does not show.
      // So the row is emitted only when the scene has exactly one visible source
      // AND the store describes that source. Several visible sources, a hidden
      // owner, or a removed owner all emit nothing, which renders as no Capture
      // row (the same path a null fingerprint takes). Per-source capture rows
      // are a separate feature; this returns to the file's own rule that scene
      // questions are answered over the visible entries.
      //
      // Wrapped because a throw must not sink the export.
      try {
        const streamingSource = host.streaming();
        const visible = [...host.clouds()].filter(([, c]) => c.visible);
        if (streamingSource) {
          // A streaming open closes the static layers, so a static layer still
          // visible beside the streaming source is a second source. The
          // streaming source itself owns the store under a null layer id.
          if (visible.length > 0 || !captureProvenance.ownedBy(null)) return null;
        } else if (visible.length !== 1 || !captureProvenance.ownedBy(visible[0]![0])) {
          return null;
        }
        const f = captureProvenance.fingerprint();
        if (f) return { label: f.label, confidence: f.confidence };
      } catch {
        /* defensive: null falls back to "no Capture row" */
      }
      return null;
    },
    dataBoundsAabb(): readonly [number, number, number, number, number, number] | null {
      // Tight data extent for the report metadata: for streaming the octree
      // cube (localBounds) inflates height ~7× and deflates density, so the
      // printed Width/Height/Density use dataBounds instead — matching the
      // Scan Report panel and the PDF. Static clouds already report tight.
      const streaming = host.streaming();
      if (streaming) return streaming.cloud.dataBounds();
      return this.localBoundsAabb();
    },
    localBoundsAabb(): readonly [number, number, number, number, number, number] | null {
      // Streaming first — it has authoritative bounds from the COPC header.
      const streaming = host.streaming();
      if (streaming) {
        return streaming.cloud.localBounds();
      }
      // Fold every VISIBLE static cloud's bounds into a combined AABB, each
      // shifted by its Float64 placement so a mounted layer contributes the
      // extent it actually RENDERS at (pass-7 #5). Reading raw cloud.bounds()
      // framed the top-down export camera on the unplaced source-local box, so
      // a layer mounted +1000 away was cropped out of its own export.
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      let any = false;
      for (const { cloud, placement } of visibleEntries()) {
        const bb = placeAabb(cloud.bounds(), placement);
        any = true;
        if (bb.min[0] < minX) minX = bb.min[0];
        if (bb.min[1] < minY) minY = bb.min[1];
        if (bb.min[2] < minZ) minZ = bb.min[2];
        if (bb.max[0] > maxX) maxX = bb.max[0];
        if (bb.max[1] > maxY) maxY = bb.max[1];
        if (bb.max[2] > maxZ) maxZ = bb.max[2];
      }
      return any ? [minX, minY, minZ, maxX, maxY, maxZ] : null;
    },
    georefContext(): {
      worldOrigin: { x: number; y: number } | null;
      wkt: string | null;
    } | null {
      // Mirrors main.ts's `getMapContext` (the contour/DEM seam): the
      // streaming cloud's recentre offset lives on `renderOrigin` and its
      // CRS on `crs()`; static clouds carry both on the cloud record.
      const streaming = host.streaming();
      if (streaming) {
        const origin = streaming.cloud.renderOrigin;
        // The RESOLVED active WKT (override applied) drives the streaming `.prj` /
        // world file, so a rejected/Local CRS never lands a false frame on the
        // ortho (C10, now for streaming too). Falls back to the source WKT only
        // when no resolver is wired (pure-adapter tests).
        const wkt = host.resolvedActiveCrs
          ? host.resolvedActiveCrs().wkt
          : (streaming.cloud.crs()?.wkt ?? null);
        return {
          worldOrigin: origin ? { x: origin[0], y: origin[1] } : null,
          wkt,
        };
      }
      // Static path: only assert a single, unambiguous frame. With several
      // clouds loaded the per-cloud origins can differ — a world file in
      // one cloud's frame would silently misplace the others, so we only
      // georeference when every loaded cloud shares the SAME origin AND the
      // SAME declared CRS. Sharing an origin is not sharing a coordinate
      // system: two layers on the same local grid but declaring different
      // EPSG codes would otherwise pass, and the ortho's .prj would stamp the
      // first cloud's CRS over the whole combined raster (pass-5 C9). A stable
      // key per cloud — EPSG when declared, else the display name — mirrors
      // layerCompatibility.horizontalKey; a conflict refuses the georeference.
      let worldOrigin: { x: number; y: number } | null = null;
      let wkt: string | null = null;
      let crsKey: string | null = null;
      let any = false;
      for (const { cloud } of visibleEntries()) {
        any = true;
        const o = cloud.sourceOrigin;
        if (!o) return null;
        if (worldOrigin === null) {
          worldOrigin = { x: o[0], y: o[1] };
        } else if (worldOrigin.x !== o[0] || worldOrigin.y !== o[1]) {
          return null; // conflicting frames — honestly not georeferenceable
        }
        // The RESOLVED CRS (CRS authority, override applied) when the host wires
        // a resolver — so a user who rejected the file's declared CRS (chose
        // Local, or a different one) can never have the rejected CRS stamped into
        // the .prj (pass-5 C10). A local resolution yields a null wkt AND a null
        // key; it still PARTICIPATES in conflict detection under a sentinel key,
        // because a visible local/unknown layer beside a projected one is a
        // genuine conflict — the user declared its pixels are NOT in the projected
        // frame, so stamping that frame's .prj over the combined raster would
        // misgeoreference them (pass-6 C10). An all-local scene shares the
        // sentinel with no wkt, so it still refuses to georeference rather than
        // being falsely flagged as a conflict. When no resolver is wired (the
        // pure-adapter tests) we fall back to the file's declared metadata — the
        // same source-declared provenance as before.
        const rc = host.resolveCloudCrs
          ? host.resolveCloudCrs(cloud)
          : metadataCrsKeyWkt(cloud);
        const conflictKey = rc.key ?? LOCAL_CRS_SENTINEL;
        if (crsKey === null) crsKey = conflictKey;
        else if (crsKey !== conflictKey) return null; // conflicting CRS — not georeferenceable
        wkt ??= rc.wkt;
      }
      return any ? { worldOrigin, wkt } : null;
    },
    async framedTopDownSnapshot(options: { widthPx?: number }): Promise<{
      blob: Blob;
      widthPx: number;
      heightPx: number;
      extent: { minX: number; minY: number; maxX: number; maxY: number };
    } | null> {
      const aabb = this.localBoundsAabb();
      if (!aabb) return null;
      return host.renderFramedTopDown(aabb, options.widthPx);
    },
    renderFigure(options: { widthPx?: number; heightPx?: number }): Promise<{
      blob: Blob;
      widthPx: number;
      heightPx: number;
    } | null> {
      // The honest-resolution seam: `runStudioExport` routes explicit
      // width/height requests here so "2048 px" means 2048 rendered
      // pixels, not an upscaled copy of the live canvas.
      return host.renderFigure(options);
    },
    figureViewContext(): FigureViewContext {
      return host.figureViewContext();
    },
  };
}
