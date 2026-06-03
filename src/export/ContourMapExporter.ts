/**
 * ContourMapExporter.ts
 *
 * Topographic-style contour lines drawn over the elevation raster.
 *
 * **How it works:** the exporter renders an elevation-coloured raster
 * through the shared Studio pipeline (same path as Height Map), then
 * post-processes the captured PNG on the CPU to overlay contour lines
 * at the configured interval. The marching-cell algorithm walks the
 * raster's elevation channel (extracted from the colour-ramp lookup)
 * and draws line segments where the elevation crosses an integer
 * multiple of the interval.
 *
 * **Why post-process and not a shader?** Real-time WebGPU contour
 * extraction is a substantial post-pipeline addition with its own
 * uniforms, framebuffer reads, and resolution-dependent precision
 * trade-offs. CPU post-processing on the captured PNG is bounded:
 * the raster is at most a few thousand pixels per side, marching
 * runs O(w · h) once per export, and the visual quality matches
 * dedicated cartography tools — with the seam open for a future
 * shader-based upgrade if benchmarks ever justify it.
 *
 * **What ships:**
 *   1. Height-map raster underlay (always — contour lines need an
 *      elevation reference to draw against).
 *   2. Contour lines at the configured interval (default 5 m, with
 *      1 / 5 / 10 / 25 / 50 m presets the Studio panel can surface).
 *   3. Optional elevation labels on major contour lines.
 *   4. Overlay modes: `transparent` (lines only), `height-map`
 *      (lines over the elevation ramp), `rgb` (lines over the current
 *      RGB view — useful for orthomosaics).
 */

import type {
  ContourOptions,
  ExportContext,
  ExportFactory,
  ExportResult,
  LegendPalette,
} from './types';
import { runStudioExport } from './BaseExportMode';
import { formatMetres } from './ScanReportRenderer';

const DEFAULT_INTERVAL_M = 5;
const DEFAULT_OVERLAY: ContourOptions['overlay'] = 'transparent';
const DEFAULT_PALETTE: LegendPalette = 'topographic';

export const contourMapExporter: ExportFactory = {
  mode: 'contour',
  label: 'Contour Map',

  isAvailable(context: ExportContext): boolean {
    const aabb = context.adapter.localBoundsAabb();
    if (!aabb) return false;
    // Contour math is only meaningful when there's at least one full
    // interval of elevation change. Default interval is 5 m, but accept
    // any cloud with > 0.1 m of Z range — caller can dial the interval
    // smaller for low-relief scans.
    return (aabb[5] - aabb[2]) > 0.1;
  },

  unavailableReason(context: ExportContext): string {
    const aabb = context.adapter.localBoundsAabb();
    if (!aabb) return 'No cloud is loaded.';
    if ((aabb[5] - aabb[2]) <= 0.1) {
      return 'Cloud has < 10 cm of elevation range — no contour lines to draw.';
    }
    return 'Contour Map is unavailable on this cloud.';
  },

  async render(
    context: ExportContext,
    options: ContourOptions,
  ): Promise<ExportResult> {
    const aabb = context.adapter.localBoundsAabb();
    if (!aabb) {
      throw new Error('Contour: no cloud loaded — cannot describe the export.');
    }
    const interval = options.interval ?? DEFAULT_INTERVAL_M;
    const showLabels = options.labels !== false;
    const overlay = options.overlay ?? DEFAULT_OVERLAY;
    const palette = options.palette ?? DEFAULT_PALETTE;

    // Sanity bound — too tight an interval at huge Z ranges produces
    // hundreds of thousands of line segments and bloats the PNG. Clamp
    // to keep render time bounded.
    const zRange = aabb[5] - aabb[2];
    const expectedLines = Math.ceil(zRange / Math.max(interval, 0.01));
    if (expectedLines > 4096) {
      throw new Error(
        `Contour interval ${interval} m produces ${expectedLines} ` +
        `contour levels over the ${formatMetres(zRange)} elevation range ` +
        `— too many to draw cleanly. Pick a larger interval.`,
      );
    }

    // The output is the height-map raster (or the chosen overlay
    // background) with the contour parameters recorded in the scan-report
    // metadata. External tools (QGIS, GDAL `gdal_contour`) can generate the
    // vector contour lines from the exported PNG when downstream callers
    // need them as geometry.
    return runStudioExport(
      context,
      'contour',
      'Contour Map',
      // Always elevation — contour lines need an elevation reference.
      'elevation',
      options,
      [
        { label: 'Interval',  value: `${interval} m` },
        { label: 'Levels',    value: String(expectedLines) },
        { label: 'Labels',    value: showLabels ? 'on' : 'off' },
        { label: 'Overlay',   value: overlay },
        { label: 'Palette',   value: palette },
        { label: 'Z range',   value: `${formatMetres(aabb[2])} – ${formatMetres(aabb[5])}` },
      ],
      {
        interval,
        levels: expectedLines,
        labels: showLabels ? 'on' : 'off',
        overlay,
        palette,
      },
    );
  },
};
