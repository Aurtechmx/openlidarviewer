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
  composeScanReportOntoBlob,
  formatInt,
  formatMetres,
  formatTimestamp,
} from './ScanReportRenderer';
import type { ScanReportData, ScanReportRow } from './ScanReportRenderer';

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
  const rows: ScanReportRow[] = [
    { label: 'Points', value: formatInt(adapter.sourcePointCount()) },
  ];
  if (aabb) {
    const w = aabb[3] - aabb[0];
    const d = aabb[4] - aabb[1];
    const h = aabb[5] - aabb[2];
    rows.push({ label: 'Width',  value: formatMetres(w) });
    rows.push({ label: 'Depth',  value: formatMetres(d) });
    rows.push({ label: 'Height', value: formatMetres(h) });
    // Density — points per square metre on the XY footprint.
    if (w > 0 && d > 0) {
      const density = adapter.sourcePointCount() / (w * d);
      rows.push({ label: 'Density', value: `${density.toFixed(0)} pts/m²` });
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
): ScanReportData {
  const aabb = adapter.localBoundsAabb();
  const rows: ScanReportRow[] = [...baseReportRows(adapter, aabb), ...extraRows];
  return {
    title,
    scanName: adapter.sourceName(),
    rows,
    footer: `OpenLiDARViewer v${STUDIO_VERSION} · ${formatTimestamp(new Date())}`,
  };
}

/**
 * The shared "WYSIWYG snapshot + scan report" pipeline every Studio mode
 * uses. Each exporter only declares its mode, its report title, and any
 * mode-specific rows; this function does the rest:
 *
 *   1. Force the runtime colour mode via `withColorMode` (finally-restored).
 *   2. Call `adapter.snapshot()` to capture the live view through the live
 *      camera + EDL pipeline, with optional measurement and annotation
 *      overlays baked in. This is the "match the on-screen view" guarantee.
 *   3. Compose the scan-report card into the bottom-right corner.
 *   4. Return the final `ExportResult` Blob with mode + metadata.
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

  const blob = await withColorMode(context.adapter, colorMode, async () => {
    return context.adapter.snapshot({
      measurements: includeMeasurements,
      annotations: includeAnnotations,
      // Inspect tool + LiveProbe both bake by default — if the user is
      // looking at point data when they click Export, that data ships in
      // the PNG. The contract is "whatever's on screen ships in the
      // export"; this is the implementation.
      inspector: true,
      probe: true,
    });
  });

  const report = buildScanReport(reportTitle, context.adapter, extraReportRows);
  const final = await composeScanReportOntoBlob(blob, report, 'bottom-right');

  return {
    blob: final,
    mode,
    // The snapshot pipeline captures at the live canvas size; we report
    // those dimensions back so the caller has accurate output info.
    width: context.canvas.width,
    height: context.canvas.height,
    mimeType: 'image/png',
    metadata: extraResultMeta,
  };
}
