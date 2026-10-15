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
  formatElevation,
  formatInt,
  formatLinear,
  formatTimestamp,
  linearUnitLabel,
  linearUnitOf,
} from './ScanReportRenderer';
import type { LinearUnit, ScanReportData, ScanReportRow } from './ScanReportRenderer';
import { stampFigureProvenanceOntoBlob } from './figureMetadata';
import { presentationOfCapture } from './presentationMode';
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
  // Snapshot every layer's mode, not one scalar: a multi-layer scene can hold
  // A=RGB, B=Intensity, C=Classification at once, and restoring all three to a
  // single "prior" left B and C permanently on A's mode (pass-7 #2).
  const snapshot = adapter.snapshotColorModes();
  // Hide visible layers that cannot carry this channel, so a scientific export
  // shows only the layers that legitimately do (pass-7 #3). Restored in finally.
  const hidden = adapter.excludeUnsupported(mode);
  // Defensive structure: the initial swap is INSIDE the try block so a
  // throw from `setExportColorMode` (e.g. one cloud's missing channel
  // before the adapter's per-cloud try/catch landed) still hits the
  // finally and restores each layer's mode + visibility.
  let swapped = false;
  try {
    adapter.setExportColorMode(mode);
    swapped = true;
    return await fn();
  } finally {
    if (swapped) {
      try {
        adapter.restoreColorModes(snapshot);
      } catch (err) {
        // The restoration itself can in principle throw; swallow it so
        // a throw inside `fn()` still propagates (not the restoration).
        console.warn('[export] color-mode restoration failed:', err);
      }
    }
    if (hidden.length > 0) {
      try {
        adapter.restoreVisibility(hidden);
      } catch (err) {
        console.warn('[export] visibility restoration failed:', err);
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

/** What to call each component in a card row, so "Min Y" says which it is. */
const AXIS_NAME = ['X', 'Y', 'Z'] as const;

export interface SourceHeightExtent {
  /** Source heights; null when the visible layers share no vertical frame. */
  readonly min: number | null;
  readonly max: number | null;
  readonly range: number;
  /** Axis name of the up axis ("Z" for survey sources, "Y" for a Y-up mesh). */
  readonly axis: 'X' | 'Y' | 'Z';
  /** The unit up-axis values print in — the elevation colorbar's. */
  readonly unit: LinearUnit;
}

/** The row value printed in place of Min/Max when no single vertical frame exists. */
export const MIXED_VERTICAL_FRAME_NOTE = 'Omitted: visible layers are not in one vertical frame';

/**
 * The unit up-axis rows print in. A frame whose Z is not a height (geocentric,
 * depth-down) prints source units; otherwise the colorbar's vertical unit, so
 * a metre grid with US-survey-foot heights reads "ft" on both. Adapters that
 * carry no vertical unit keep the horizontal one.
 */
export function verticalUnitOf(adapter: ExportSceneAdapter): LinearUnit {
  if (adapter.groundFrame?.()?.heightUnits === false) return 'unknown';
  if (adapter.verticalUnitLabel) return linearUnitOf(adapter.verticalUnitLabel());
  return linearUnitOf(adapter.crsLabel()?.unit);
}

/**
 * The scan's height extent in SOURCE units, for card rows.
 *
 * `adapter.localBoundsAabb()` is measured in the render frame, which the
 * loaders shift by a per-cloud origin so Float32 positions stay precise. Card
 * rows that print elevations must add that origin back on the up axis, the
 * same reconstruction the elevation colorbar performs for its labels, or a
 * tile at −7.86…39.72 m loaded with a −8 m origin reads "14.0 cm … 47.7 m".
 * Shared by the height, depth and contour cards and the Height base row.
 */
export function sourceHeightExtent(adapter: ExportSceneAdapter): SourceHeightExtent | null {
  // The TIGHT data box (streaming's octree cube over-reports height), the
  // same box the Height row reads, so Min/Max and Height agree.
  const aabb = adapter.dataBoundsAabb?.() ?? adapter.localBoundsAabb();
  if (!aabb) return null;
  const axis = adapter.worldUpAxis();
  const origin = adapter.heightOrigin ? adapter.heightOrigin() : 0;
  return {
    min: origin === null ? null : aabb[axis] + origin,
    max: origin === null ? null : aabb[axis + 3] + origin,
    range: aabb[axis + 3] - aabb[axis],
    axis: AXIS_NAME[axis],
    unit: verticalUnitOf(adapter),
  };
}

/**
 * The two labelled up-axis rows (Min/Max, Near/Far), or one row saying why
 * they are omitted when the visible layers share no vertical frame.
 */
export function heightExtentRows(h: SourceHeightExtent, low: string, high: string): ScanReportRow[] {
  if (h.min === null || h.max === null) return [{ label: `${h.axis} range`, value: MIXED_VERTICAL_FRAME_NOTE }];
  return [
    { label: low, value: formatElevation(h.min, h.unit) },
    { label: high, value: formatElevation(h.max, h.unit) },
  ];
}

/** Whether the loaded points are a subset of the source (stride, voxel, or streamed LOD). */
function isDisplaySample(adapter: ExportSceneAdapter): boolean {
  const source = adapter.sourcePointCount();
  const resident = adapter.residentPointCount?.();
  return source !== null && typeof resident === 'number' && resident < source;
}

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
  // hardcoded metre. Unknown/absent unit ⇒ "units". A Web Mercator grid or a
  // geocentric frame names metres that are not ground metres: its spans stay
  // in source units and no density is printed (the scan reports' gate).
  const frame = adapter.groundFrame?.() ?? null;
  const groundRefusal = frame && !frame.groundMetres ? frame.groundRefusal : null;
  const unit: LinearUnit = groundRefusal ? 'unknown' : linearUnitOf(adapter.crsLabel()?.unit);
  const uLabel = linearUnitLabel(unit);
  const source = adapter.sourcePointCount();
  const rows: ScanReportRow[] = [
    { label: 'Points', value: source === null ? 'Unknown' : formatInt(source) },
  ];
  // The image is drawn from the LOADED points. When that is a subset of the
  // file, "Points" alone reads as if every record was rendered.
  const sampled = isDisplaySample(adapter);
  if (sampled && source !== null) {
    rows.push({
      label: 'Rendered from',
      value: `${formatInt(adapter.residentPointCount())} of ${formatInt(source)} points (display sample)`,
    });
  }
  // Extent/density use the TIGHT data AABB (streaming's octree cube inflates
  // height ~7× and deflates density); falls back to the passed AABB.
  const box = adapter.dataBoundsAabb() ?? aabb;
  if (box) {
    // Height is read on the up axis and printed as the difference of the two
    // elevations a height card prints (each rounded as printed), so Height,
    // Min and Max on one card always add up. Width/Depth are the other two axes.
    const up = adapter.worldUpAxis?.() ?? 2;
    const [ax, ay] = ([0, 1, 2] as const).filter((i) => i !== up);
    const w = box[ax + 3] - box[ax];
    const d = box[ay + 3] - box[ay];
    const origin = adapter.heightOrigin ? adapter.heightOrigin() : 0;
    const printed = (v: number) => Number((v + (origin ?? 0)).toFixed(2));
    const h = origin === null ? box[up + 3] - box[up] : printed(box[up + 3]) - printed(box[up]);
    rows.push(
      { label: 'Width',  value: formatLinear(w, unit) },
      { label: 'Depth',  value: formatLinear(d, unit) },
      { label: 'Height', value: formatElevation(h, verticalUnitOf(adapter)) },
    );
    // Density — points per square unit on the XY footprint.
    const total = adapter.sourcePointCount();
    // No total, no density. A stamped "0.0 pts/m²" reads as a measurement of an
    // empty scan rather than as an unanswered question.
    if (w > 0 && d > 0 && total !== null && !groundRefusal) {
      const density = total / (w * d);
      // One decimal, matching the Scan Report panel (`toFixed(0)` rounded
      // 2.586 pts/m² up to "3", disagreeing with the panel's "2.6").
      rows.push({ label: 'Density', value: `${density.toFixed(1)} pts/${uLabel}²` });
    }
  }
  // Capability summary — which channels the export can honour. Matches the
  // Scan Intelligence panel's RGB/Intensity/Classification rows.
  rows.push(
    { label: 'RGB',           value: adapter.hasRgb() ? 'Yes' : 'No' },
    { label: 'Intensity',     value: adapter.hasIntensity() ? 'Yes' : 'No' },
  );
  // Presence gates the classification RENDER; coverage is what a reader of the
  // report needs. An all-code-0 file has the channel and no classes, and a bare
  // "Yes" for it contradicted the Scan Report panel on the same scan. Fall back
  // to presence only when coverage genuinely cannot be counted — never invent a
  // percentage.
  const assigned = adapter.classificationAssignedFraction?.() ?? null;
  let classificationValue: string;
  if (!adapter.hasClassification()) {
    classificationValue = 'No';
  } else if (assigned === null) {
    classificationValue = 'Yes';
  } else {
    const classified = assigned > 0 ? 'classified' : 'unclassified';
    // The fraction is counted over the loaded points, so on a display sample
    // it is the sample's coverage, not the file's.
    const basis = sampled ? ' of the display sample' : '';
    classificationValue = `Present, ${classified} (${(assigned * 100).toFixed(1)} % coverage${basis})`;
  }
  rows.push({ label: 'Classification', value: classificationValue });
  // CRS provenance, when the source file declares one. This
  // is the row that makes the export research-grade: an analyst reading the
  // PNG later knows the datum and the linear unit the dimensions are in.
  const crs = adapter.crsLabel();
  if (crs) rows.push({ label: 'CRS', value: crs.name });
  if (groundRefusal) rows.push({ label: 'Units', value: `Not ground metres. ${groundRefusal}` });
  else if (crs) rows.push({ label: 'Units', value: crs.unit });
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
 * `colorMode` is the mode the export FORCED; the adapter's colour-provenance
 * note (the on-screen legend's own line) is added for every mode whose colour
 * the viewer applied rather than the scan recorded. Omitted (older callers /
 * tests) ⇒ no line, so their cards are unchanged.
 */
export function buildScanReport(
  title: string,
  adapter: ExportSceneAdapter,
  extraRows: readonly ScanReportRow[] = [],
  classScopeStamp = '',
  colorMode?: ColorMode,
): ScanReportData {
  const aabb = adapter.localBoundsAabb();
  const rows: ScanReportRow[] = [...baseReportRows(adapter, aabb), ...extraRows];
  const colourNote =
    colorMode !== undefined ? (adapter.colorProvenanceNote?.(colorMode) ?? null) : null;
  if (colourNote) {
    rows.push({ label: 'Colour', value: colourNote });
  }
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
          console.warn('[export] Figure re-render failed; falling back to the live snapshot.', err);
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
        // A quantitative export needs its labelled min/max colorbar so exported
        // colours map back to values. Requested unconditionally because the Viewer self-gates
        // on the FORCED colour mode at capture time (withColorMode has
        // already applied `colorMode` by now) — height-map / intensity /
        // depth exports gain the legend; rgb / classification stay untouched.
        colorbar: true,
      });
      return { blob: snapshot, size: null };
    },
  );
  const blob = capture.blob;
  // Provenance belongs to the moment the PIXELS were taken. Camera, clip and
  // CRS were read after the compositing awaits below, so a view change or a
  // scan swap while the report and banner were drawn stamped this image with
  // another view's camera and another scan's CRS.
  const view = context.adapter.figureViewContext?.() ?? null;
  const crs = context.adapter.crsLabel();

  // Class-filter scope stamp threaded from the call site (Viewer → main.ts).
  // Empty when no class is hidden, so the banner + card row are no-ops and the
  // export stays byte-identical to the pre-feature image.
  const classScopeStamp = context.classScopeStamp ?? '';
  const report = buildScanReport(reportTitle, context.adapter, extraReportRows, classScopeStamp, colorMode);
  const withReport = await composeScanReportOntoBlob(blob, report, 'bottom-right');
  // Draw the "showing N of M classes" caveat banner across the top of the
  // raster while a filter is active — the escape-hatch closure: a filtered
  // image can't leave the app without a class-scope stamp.
  const composed = await composeClassScopeBannerOntoBlob(withReport, classScopeStamp);

  // Figure provenance, embedded after every canvas re-encode is done, but
  // SOURCED at capture time above. The colour mode recorded is the one this
  // export FORCED — the artifact's truth — not whatever the live view happened
  // to show beforehand. Camera and clip come from the optional view-context
  // accessor; adapters that don't implement it still get build + CRS + colormap.
  // Export isolation. Every exporter here captures the live canvas, and four
  // of the raster modes encode geometry in their pixel values, so a
  // reconstructed pixel in one of them is an invented elevation in a file that
  // is read back as data. `presentationOfCapture` describes the FIGURE rather
  // than the live view, and it is given `as-is` because that is what this
  // caller did.
  //
  // `presentationMode`'s contract puts the suspension on the caller, and this
  // caller performs none: the renderer sits behind the export-to-render
  // boundary the module-graph ratchet holds shrink-only. Passing
  // `capturePolicyFor`'s verdict here would credit the figure with a
  // stand-down nobody performed and stamp an invented elevation 'source'. The
  // conservative label is the honest one, so a capture taken while
  // reconstruction runs is described as reconstructed.
  //
  // `capturePolicyFor` therefore states an obligation no caller can discharge
  // yet. It stays the right question; wiring it means first giving the export
  // path a way to stand the renderer down, not passing its answer to a
  // function that assumes someone already did.
  //
  // Absent capabilities are the source case and are answered without asking,
  // which keeps this layer free of a runtime import into the renderer.
  const capturedCaps = context.continuityCapabilities;
  const presentation = capturedCaps ? presentationOfCapture(capturedCaps, 'as-is') : 'source';

  const final = await stampFigureProvenanceOntoBlob(composed, {
    crs,
    colorMode,
    palette: paletteLabelOfOptions(options as Readonly<Record<string, unknown>>),
    camera: view?.camera ?? null,
    clip: view?.clip ?? null,
    sourceInterpretation: context.adapter.sourceInterpretation?.() ?? null,
    provenanceSource: context.adapter.provenanceSource?.() ?? null,
    presentation,
    reconstructedShare: null,
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
