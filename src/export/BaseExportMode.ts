/**
 * BaseExportMode.ts
 *
 * Shared lifecycle helpers every exporter uses:
 *
 *   • `captureCanvasToBlob` — wraps the brittle `canvas.toBlob` callback into
 *     a Promise with a meaningful error message.
 *   • `withColorMode` — switch the runtime colour mode, run a callback, then
 *     unconditionally restore the prior mode, even if the callback throws.
 *     Exporters never leak a colour-mode change into the live UI.
 *   • `topDownOrthoCameraForAabb` — build an OrthographicCamera that frames a
 *     world-space AABB from directly above, with aspect-preserving extents.
 *     Returns `null` when no AABB is available (caller falls back to the
 *     perspective camera, e.g. for orthographic-RGB which preserves the view).
 *
 * Pure — accepts three.js types but contains no DOM access, so the math is
 * unit-testable in Node.
 *
 * Memory-safety contract (audited):
 *   • Every exporter renders to the live on-screen canvas; no offscreen
 *     RenderTarget is allocated, so no per-export GPU buffer leak is possible.
 *   • The renderer.setSize round-trip every Studio mode performs is wrapped
 *     in `try/finally` by the exporter; a throw inside `render()` still
 *     restores the live canvas dimensions before bubbling.
 *   • `withColorMode` likewise restores the prior runtime colour mode in
 *     `finally`, so a thrown export never leaves the UI mid-recoloured.
 *   • The OrthographicCamera each exporter builds is local; three.js cameras
 *     do not own GPU resources, so they fall to GC without explicit dispose.
 *   • No event listeners are attached anywhere in the Studio code; every
 *     exporter is invoked once per click and resolves to a Blob.
 */

import * as THREE from 'three/webgpu';
import type { ColorMode } from '../render/colorModes';
import type { CommonExportOptions, ExportContext, ExportMode, ExportResult, ExportSceneAdapter } from './types';
import {
  composeClassScopeBannerOntoBlob,
  composeScanReportOntoBlob,
  formatInt,
  formatLinear,
  formatTimestamp,
  linearUnitLabel,
  linearUnitOf,
} from './ScanReportRenderer';
import type { ScanReportData, ScanReportRow } from './ScanReportRenderer';
import { stampFigureProvenanceOntoBlob } from './figureMetadata';
import { paletteLabelOfOptions } from './figureProvenance';

/** Encode a canvas to a `Blob` of the given MIME type. */
export function captureCanvasToBlob(
  canvas: HTMLCanvasElement,
  mime: string,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error(`captureCanvasToBlob: canvas.toBlob returned null for ${mime}`));
    }, mime);
  });
}

/**
 * Run `fn` with the runtime forced into `mode`, then restore the original
 * mode. Restoration runs in a `finally` so a throw inside `fn` still leaves
 * the UI in its prior colour state.
 */
export async function withColorMode<T>(
  adapter: ExportSceneAdapter,
  mode: ColorMode,
  fn: () => Promise<T>,
): Promise<T> {
  const prior = adapter.currentColorMode();
  // Defensive structure: the initial swap is INSIDE the try block so a
  // throw from `setExportColorMode` (e.g. one cloud's missing channel
  // before the adapter's per-cloud try/catch landed) still hits the
  // finally and attempts to restore the prior mode. Without this, a
  // throwing swap would leave the UI partially recoloured.
  let swapped = false;
  try {
    if (prior !== mode) {
      adapter.setExportColorMode(mode);
      swapped = true;
    }
    return await fn();
  } finally {
    if (swapped) {
      try {
        adapter.setExportColorMode(prior);
      } catch (err) {
        // The restoration itself can in principle throw; swallow it so
        // a throw inside `fn()` still propagates (not the restoration).
        console.warn('[export] color-mode restoration failed:', err);
      }
    }
  }
}

/**
 * Build a top-down `OrthographicCamera` framing the given world-space AABB.
 * The camera looks straight down (-Y in our render space is "down"; we look
 * along -Z because our render origin uses Z-up via the COPC offset). The
 * extents preserve the AABB's footprint aspect when `aspect` is not forced.
 *
 *   aabb = [minX, minY, minZ, maxX, maxY, maxZ]
 *
 * Returns the camera and the rendered (width, height) it implies given the
 * requested target dimensions. When `forceWidth`/`forceHeight` are both
 * supplied, the camera frustum is letter-boxed inside the target so the
 * footprint stays accurate; otherwise we square the longer side to the
 * shorter and the caller picks the canvas size from the AABB aspect.
 *
 * Coordinate sanity: render space is Z-up (the COPC `renderOrigin` removes
 * the world offset). "Top down" therefore means looking along -Z.
 */
export function topDownOrthoCameraForAabb(
  aabb: readonly [number, number, number, number, number, number],
  forceWidth?: number,
  forceHeight?: number,
): { camera: THREE.OrthographicCamera; width: number; height: number; aspect: number } {
  const [minX, minY, minZ, maxX, maxY, maxZ] = aabb;

  // Footprint extents (X/Y) and depth (Z) of the AABB.
  const fpW = Math.max(1e-6, maxX - minX);
  const fpH = Math.max(1e-6, maxY - minY);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  const dz = Math.max(1e-6, maxZ - minZ);
  const footprintAspect = fpW / fpH;

  // Camera sits directly above the AABB centre, looking straight down (-Z),
  // with `up` set to +Y so the rendered image has world-Y as the vertical
  // axis. The near/far span covers the whole AABB plus a small padding.
  const camera = new THREE.OrthographicCamera(
    -fpW / 2,
    fpW / 2,
    fpH / 2,
    -fpH / 2,
    0.01,
    dz * 4 + 1,
  );
  camera.position.set(cx, cy, maxZ + dz);
  camera.up.set(0, 1, 0);
  camera.lookAt(cx, cy, cz);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();

  // Decide output dimensions.
  let width = forceWidth ?? Math.max(256, Math.round(fpW * 32));
  let height = forceHeight ?? Math.max(256, Math.round(fpH * 32));
  // When the caller gave us only one dimension, derive the other from
  // footprint aspect so the image isn't squashed.
  if (forceWidth && !forceHeight) height = Math.round(forceWidth / footprintAspect);
  if (forceHeight && !forceWidth) width = Math.round(forceHeight * footprintAspect);

  return { camera, width, height, aspect: footprintAspect };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared Studio export pipeline
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build-time-injected version string for the scan-report footer. Reads from
 * the `__APP_VERSION__` global Vite stamps with the package.json version, so
 * the footer is automatically current without a manual edit per release.
 */
const STUDIO_VERSION = __APP_VERSION__;

/**
 * The standard set of scan-report rows every Studio export carries. Mode
 * exporters extend this with their own mode-specific rows (ramp choice,
 * intensity range, classification class count, etc.) by passing extra rows.
 */
export function baseReportRows(
  adapter: ExportSceneAdapter,
  aabb: readonly [number, number, number, number, number, number] | null,
): ScanReportRow[] {
  // Coordinates are stored in the scan's native CRS units, so footprint
  // dimensions and density must carry the real unit (ft for foot CRSs), not a
  // hardcoded metre. Unknown/absent unit ⇒ metre default.
  const unit = linearUnitOf(adapter.crsLabel()?.unit);
  const uLabel = linearUnitLabel(unit);
  const rows: ScanReportRow[] = [
    { label: 'Points', value: formatInt(adapter.sourcePointCount()) },
  ];
  if (aabb) {
    const w = aabb[3] - aabb[0];
    const d = aabb[4] - aabb[1];
    const h = aabb[5] - aabb[2];
    rows.push({ label: 'Width',  value: formatLinear(w, unit) });
    rows.push({ label: 'Depth',  value: formatLinear(d, unit) });
    rows.push({ label: 'Height', value: formatLinear(h, unit) });
    // Density — points per square unit on the XY footprint.
    if (w > 0 && d > 0) {
      const density = adapter.sourcePointCount() / (w * d);
      rows.push({ label: 'Density', value: `${density.toFixed(0)} pts/${uLabel}²` });
    }
  }
  // Capability summary — which channels the export can honour. Matches the
  // Scan Intelligence panel's RGB/Intensity/Classification rows.
  rows.push({ label: 'RGB',           value: adapter.hasRgb() ? 'Yes' : 'No' });
  rows.push({ label: 'Intensity',     value: adapter.hasIntensity() ? 'Yes' : 'No' });
  rows.push({ label: 'Classification', value: adapter.hasClassification() ? 'Yes' : 'No' });
  // CRS provenance, when the source file declares one. This
  // is the row that makes the export research-grade: an analyst reading the
  // PNG later knows the datum and the linear unit the dimensions are in.
  const crs = adapter.crsLabel();
  if (crs) {
    rows.push({ label: 'CRS',   value: crs.name });
    rows.push({ label: 'Units', value: crs.unit });
  }
  // Capture-type row — auto-computed from the provenance classifier so
  // every exported image carries the same Research-Derived capture
  // fingerprint the Inspector and PDF reports surface. Optional adapter
  // method: older callers / tests that don't implement it produce an
  // export without the row (no degraded behaviour).
  const capture = adapter.captureLabel?.() ?? null;
  if (capture) {
    rows.push({
      label: 'Capture',
      value: `${capture.label} (${capture.confidence})`,
    });
  }
  return rows;
}

/**
 * Build the scan-report data record an exporter feeds into the corner card.
 * Pulls common fields from the adapter and merges in mode-specific rows.
 */
export function buildScanReport(
  title: string,
  adapter: ExportSceneAdapter,
  extraRows: readonly ScanReportRow[] = [],
  classScopeStamp = '',
): ScanReportData {
  const aabb = adapter.localBoundsAabb();
  const rows: ScanReportRow[] = [...baseReportRows(adapter, aabb), ...extraRows];
  // Class-filter honesty row — appended only while a filter narrows the live
  // view, so an unfiltered export's card is byte-identical to before. Pairs
  // with the top-of-image banner; the card row makes the figures' scope
  // explicit alongside the count / density numbers (which stay full-cloud).
  const scope = classScopeStamp.trim();
  if (scope) {
    rows.push({ label: 'Class filter', value: scope });
  }
  return {
    title,
    scanName: adapter.sourceName(),
    rows,
    footer: `OpenLiDARViewer v${STUDIO_VERSION} · ${formatTimestamp(new Date())}`,
  };
}

/**
 * The shared capture + scan-report pipeline every Studio mode uses. Each
 * exporter only declares its mode, its report title, and any mode-specific
 * rows; this function does the rest:
 *
 *   1. Force the runtime colour mode via `withColorMode` (finally-restored).
 *   2. Capture. Two honest paths:
 *      a. An explicit `options.width`/`height` request routes to
 *         `adapter.renderFigure` — the TRUE offscreen re-render at the
 *         requested pixel size. This closed a live honesty bug: the presets
 *         advertised "2048 px" while this function ignored the option and
 *         shipped the canvas-sized snapshot. The re-render is a DIRECT
 *         render (no EDL, no overlay bakes) of the live perspective view.
 *      b. Otherwise (or when the adapter can't re-render / the device
 *         fails), `adapter.snapshot()` captures the live view through the
 *         live camera + EDL pipeline with optional measurement and
 *         annotation overlays baked in — the WYSIWYG guarantee.
 *   3. Compose the scan-report card into the bottom-right corner.
 *   4. Embed figure provenance (build / CRS / colormap / camera / clip) as
 *      PNG text chunks — LAST, so no later re-encode strips it.
 *   5. Return the final `ExportResult` Blob reporting the ACTUAL rendered
 *      pixel size — the re-render's size on path (a), the live canvas size
 *      on path (b) — never an unfulfilled request.
 *
 * `options.transparent` is intentionally NOT consumed here: the live
 * renderer is constructed with `alpha: false`, so transparency is
 * impossible until an offscreen render-target path exists. The presets no
 * longer advertise it (see ExportPresets.ts).
 *
 * Pure orchestration — every render-side step is delegated to the adapter,
 * so the exporters stay testable.
 */
export async function runStudioExport(
  context: ExportContext,
  mode: ExportMode,
  reportTitle: string,
  colorMode: ColorMode,
  options: CommonExportOptions,
  extraReportRows: readonly ScanReportRow[] = [],
  extraResultMeta: Readonly<Record<string, number | string>> = {},
): Promise<ExportResult> {
  const includeMeasurements = options.includeMeasurements !== false;
  const includeAnnotations = options.includeAnnotations !== false;
  const wantsExplicitSize =
    typeof options.width === 'number' || typeof options.height === 'number';

  // The capture carries the size of the pixels that actually got rendered —
  // the re-render's planned size, or null for a canvas-sized snapshot — and
  // the result reports it verbatim.
  const capture = await withColorMode(
    context.adapter,
    colorMode,
    async (): Promise<{ blob: Blob; size: { width: number; height: number } | null }> => {
      if (wantsExplicitSize && context.adapter.renderFigure) {
        // The re-render has two distinct failure shapes and both must
        // degrade to the snapshot rather than sink the export:
        //   • null return — the size request was unplannable (the framing
        //     planner refused it); the adapter knew before touching the GPU.
        //   • rejection — a REAL device failure mid-render (lost context,
        //     canvas encode that yields no blob). The adapter never converts
        //     these into null, so they surface here as a throw.
        // Either way the user asked for an image and an image exists on
        // screen, so a capture-quality problem must never become an error
        // toast — the same best-effort contract the provenance embedding
        // follows. The rejection is logged (not swallowed silently) because
        // a device failure is diagnostic gold, and the result dimensions
        // below report the snapshot's real size, not the request we failed
        // to honour.
        try {
          const figure = await context.adapter.renderFigure({
            widthPx: typeof options.width === 'number' ? options.width : undefined,
            heightPx: typeof options.height === 'number' ? options.height : undefined,
          });
          if (figure) {
            return {
              blob: figure.blob,
              size: { width: figure.widthPx, height: figure.heightPx },
            };
          }
        } catch (err) {
          console.warn('Figure re-render failed; falling back to the live snapshot.', err);
        }
      }
      const snapshot = await context.adapter.snapshot({
        measurements: includeMeasurements,
        annotations: includeAnnotations,
        // Inspect tool + LiveProbe both bake by default — if the user is
        // looking at point data when they click Export, that data ships in
        // the PNG. The contract is "whatever's on screen ships in the
        // export"; this is the implementation.
        inspector: true,
        probe: true,
      });
      return { blob: snapshot, size: null };
    },
  );
  const blob = capture.blob;

  // Class-filter scope stamp threaded from the call site (Viewer → main.ts).
  // Empty when no class is hidden, so the banner + card row are no-ops and the
  // export stays byte-identical to the pre-feature image.
  const classScopeStamp = context.classScopeStamp ?? '';
  const report = buildScanReport(reportTitle, context.adapter, extraReportRows, classScopeStamp);
  const withReport = await composeScanReportOntoBlob(blob, report, 'bottom-right');
  // Draw the "showing N of M classes" caveat banner across the top of the
  // raster while a filter is active — the escape-hatch closure: a filtered
  // image can't leave the app without a class-scope stamp.
  const composed = await composeClassScopeBannerOntoBlob(withReport, classScopeStamp);

  // Figure provenance, embedded after every canvas re-encode is done. The
  // colour mode recorded is the one this export FORCED — the artifact's
  // truth — not whatever the live view happened to show beforehand. Camera
  // and clip come from the optional view-context accessor; adapters that
  // don't implement it still get build + CRS + colormap chunks.
  const view = context.adapter.figureViewContext?.() ?? null;
  const final = await stampFigureProvenanceOntoBlob(composed, {
    crs: context.adapter.crsLabel(),
    colorMode,
    palette: paletteLabelOfOptions(options as Readonly<Record<string, unknown>>),
    camera: view?.camera ?? null,
    clip: view?.clip ?? null,
  });

  return {
    blob: final,
    mode,
    width: capture.size?.width ?? context.canvas.width,
    height: capture.size?.height ?? context.canvas.height,
    mimeType: 'image/png',
    metadata: extraResultMeta,
  };
}
