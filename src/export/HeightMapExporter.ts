/**
 * HeightMapExporter.ts
 *
 * Live-view elevation raster — captures whatever angle the user is looking
 * from with the runtime forced into the `elevation` colour mode for the
 * duration of the render. The view geometry, EDL, and measurement/annotation
 * overlays are all baked through `viewer.snapshot()`, so the export is
 * truly WYSIWYG with the on-screen image.
 *
 * The v0.3.2-Phase-4 cut forced a top-down ortho framing; the Studio cut
 * trades that for "match the user's view" — users who want the survey-grade
 * top-down can simply orbit to top-down before clicking the button.
 *
 * Availability: requires a loaded cloud with a non-degenerate Z extent
 * (so the elevation ramp has anything meaningful to bin against).
 */

import type {
  ExportContext,
  ExportFactory,
  ExportResult,
  HeightMapOptions,
  HeightMapRamp,
} from './types';
import { runStudioExport } from './BaseExportMode';
import { formatMetres } from './ScanReportRenderer';

const DEFAULT_RAMP: HeightMapRamp = 'terrain';

/** Default resolution presets used by the Studio panel. */
export const HEIGHT_MAP_RESOLUTIONS = [1024, 2048, 4096] as const;

const MIN_Z_EXTENT_M = 1e-4;

/** The four ramps the height-map exporter advertises. */
export const HEIGHT_MAP_RAMPS: readonly HeightMapRamp[] = [
  'terrain',
  'grayscale',
  'heatmap',
  'topo',
];

export const heightMapExporter: ExportFactory = {
  mode: 'height-map',
  label: 'Height Map',

  isAvailable(context: ExportContext): boolean {
    const aabb = context.adapter.localBoundsAabb();
    if (!aabb) return false;
    return (aabb[5] - aabb[2]) > MIN_Z_EXTENT_M;
  },

  unavailableReason(context: ExportContext): string {
    const aabb = context.adapter.localBoundsAabb();
    if (!aabb) return 'No cloud is loaded.';
    if (aabb[5] - aabb[2] <= MIN_Z_EXTENT_M) {
      return 'Cloud has no measurable height range.';
    }
    return 'Height map is unavailable on this cloud.';
  },

  async render(
    context: ExportContext,
    options: HeightMapOptions,
  ): Promise<ExportResult> {
    const aabb = context.adapter.localBoundsAabb();
    if (!aabb) {
      throw new Error('HeightMap: no cloud loaded — cannot describe the export.');
    }
    const ramp: HeightMapRamp = options.ramp ?? DEFAULT_RAMP;

    return runStudioExport(
      context,
      'height-map',
      'Height Map',
      'elevation',
      options,
      [
        { label: 'Ramp',  value: ramp },
        { label: 'Min Z', value: formatMetres(aabb[2]) },
        { label: 'Max Z', value: formatMetres(aabb[5]) },
      ],
      {
        ramp,
        minZ: aabb[2],
        maxZ: aabb[5],
      },
    );
  },
};
