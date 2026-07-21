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
import type { ExportSceneAdapter, FigureViewContext } from '../export/types';
import { linearUnitLabel } from '../io/crs';
// Provenance classifier for `captureLabel` — surfaces capture-type + confidence
// into every exported image's scan-report card. Same path the Inspector and the
// PDF report use.
import { classify as classifyProvenance } from '../diagnostics/provenance';
import {
  signalsForStaticCloud,
  signalsForStreamingCloud,
} from '../diagnostics/provenanceSignals';

/** The per-cloud slice the adapter reads — a structural subset of the Viewer's entry. */
export interface ExportAdapterCloud {
  readonly cloud: PointCloud;
  readonly mode: ColorMode;
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
export interface ExportAdapterHost {
  clouds(): ReadonlyMap<string, ExportAdapterCloud>;
  streaming(): ExportAdapterStreaming | null;
  setColorMode(id: string, mode: ColorMode): void;
  setStreamingColorMode(mode: ColorMode): void;
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

/** Build the {@link ExportSceneAdapter} the Studio exporters drive. */
export function buildExportAdapter(host: ExportAdapterHost): ExportSceneAdapter {
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
      const first = host.clouds().values().next().value;
      return first ? first.mode : 'rgb';
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
      for (const { cloud } of host.clouds().values()) {
        if (cloud.colors) return true;
      }
      return false;
    },
    hasIntensity(): boolean {
      // Streaming COPC clouds always carry intensity (PDRF 6/7/8).
      if (host.streaming()) return true;
      for (const { cloud } of host.clouds().values()) {
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
      for (const { cloud } of host.clouds().values()) {
        if (cloud.classification) return true;
      }
      return false;
    },
    hasNormals(): boolean {
      // COPC + EPT streaming sources never carry normals in
      // production (LAS reserves no field for them; EPT writers rarely
      // emit Normal X/Y/Z attrs). Static loaders (PCD, PTX, GLTF)
      // sometimes do — check the field explicitly.
      if (host.streaming()) return false;
      for (const { cloud } of host.clouds().values()) {
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
      const first = host.clouds().values().next().value;
      return first?.cloud.name ?? 'scan';
    },
    sourcePointCount(): number {
      const streaming = host.streaming();
      if (streaming) return streaming.cloud.sourcePointCount;
      // The file's declared total, back-scaled when the loader strided a huge
      // cloud for display — the honest headline the Scan Report and PDF use.
      // Summing the strided `pointCount` under-reported "Points" and inflated
      // the export card's density divisor disagreement with every other panel.
      let total = 0;
      for (const { cloud } of host.clouds().values()) {
        total += cloud.declaredPointCount !== undefined && cloud.declaredPointCount > cloud.pointCount
          ? cloud.declaredPointCount
          : cloud.pointCount;
      }
      return total;
    },
    residentPointCount(): number {
      const streaming = host.streaming();
      if (streaming) return streaming.cloud.residentPointCount;
      // Static clouds: every loaded point is resident.
      return this.sourcePointCount();
    },
    crsLabel(): { name: string; unit: string; epsg?: number } | null {
      // read off the abstract `cloud.crs()` so both COPC and
      // EPT surface consistently. COPC pulls from the LAS VLRs the
      // header parser walked; EPT pulls from `ept.json`'s `srs.wkt`.
      // Static clouds carry CRS through `CloudMetadata.crs`.
      const fromStreaming = host.streaming()?.cloud.crs();
      if (fromStreaming) {
        return {
          name: fromStreaming.name,
          unit: linearUnitLabel(fromStreaming.linearUnit),
          epsg: fromStreaming.epsg,
        };
      }
      for (const { cloud } of host.clouds().values()) {
        const crs = cloud.metadata?.crs;
        if (crs) {
          return {
            name: crs.name,
            unit: linearUnitLabel(crs.linearUnit),
            epsg: crs.epsg,
          };
        }
      }
      return null;
    },
    captureLabel(): { label: string; confidence: 'low' | 'medium' | 'high' } | null {
      // Compute the same provenance fingerprint the Inspector + PDF
      // Provenance section surface. Auto-computed, varies per scan;
      // exporters get it via `baseReportRows` without any per-mode
      // code. Wrapped because a malformed cloud shape shouldn't sink
      // the export — null is a clean no-op in the renderer.
      try {
        const streaming = host.streaming();
        if (streaming) {
          const f = classifyProvenance(
            signalsForStreamingCloud(streaming.cloud as never),
          );
          return { label: f.label, confidence: f.confidence };
        }
        const first = host.clouds().values().next().value;
        if (first) {
          const f = classifyProvenance(
            signalsForStaticCloud(first.cloud as never),
          );
          return { label: f.label, confidence: f.confidence };
        }
      } catch {
        /* defensive — null falls back to "no Capture row" */
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
      // Fold every static cloud's bounds into a combined AABB.
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      let any = false;
      for (const { cloud } of host.clouds().values()) {
        const bb = cloud.bounds();
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
        return {
          worldOrigin: origin ? { x: origin[0], y: origin[1] } : null,
          wkt: streaming.cloud.crs()?.wkt ?? null,
        };
      }
      // Static path: only assert a single, unambiguous frame. With several
      // clouds loaded the per-cloud origins can differ — a world file in
      // one cloud's frame would silently misplace the others, so we only
      // georeference when every loaded cloud shares the SAME origin.
      let worldOrigin: { x: number; y: number } | null = null;
      let wkt: string | null = null;
      let any = false;
      for (const { cloud } of host.clouds().values()) {
        any = true;
        const o = cloud.origin;
        if (!o) return null;
        if (worldOrigin === null) {
          worldOrigin = { x: o[0], y: o[1] };
        } else if (worldOrigin.x !== o[0] || worldOrigin.y !== o[1]) {
          return null; // conflicting frames — honestly not georeferenceable
        }
        if (wkt == null) wkt = cloud.metadata?.crs?.wkt ?? null;
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
