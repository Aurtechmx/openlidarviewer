/**
 * HeightMapExporter.ts
 *
 * Live-view elevation raster — captures whatever angle the user is looking
 * from with the runtime forced into the `elevation` colour mode for the
 * duration of the render. The view geometry, EDL, and measurement/annotation
 * overlays are all baked through `viewer.snapshot()`, so the export is
 * truly WYSIWYG with the on-screen image.
 *
 * The cut forced a top-down ortho framing; the Studio cut
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
import { formatLinear, linearUnitOf } from './ScanReportRenderer';

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

/**
 * The scan's HEIGHT extent, read off the axis that actually points up.
 *
 * The raster this exporter captures is coloured by the runtime's `elevation`
 * mode, which is axis-aware. The card beside it read `aabb[2]`/`aabb[5]`
 * regardless, so on a Y-up mesh a 40 m wide, 6 m tall scan passed the
 * availability gate on its horizontal span and printed "Min Z -20 / Max Z 20"
 * against a ramp covering the true 0-6 m. The georeferenced top-down ortho
 * path already declines on a Y-up frame for the same reason; this one drew
 * the picture correctly and mislabelled it.
 *
 * The row label follows the axis too, so "Min Y" on a Y-up mesh says which
 * number the reader is looking at rather than asserting a Z that is not one.
 */
function heightExtent(context: ExportContext): {
  readonly min: number;
  readonly max: number;
  readonly range: number;
  readonly label: (side: 'Min' | 'Max') => string;
} | null {
  const aabb = context.adapter.localBoundsAabb();
  if (!aabb) return null;
  const axis = context.adapter.worldUpAxis();
  const min = aabb[axis];
  const max = aabb[axis + 3];
  const name = axis === 0 ? 'X' : axis === 1 ? 'Y' : 'Z';
  return { min, max, range: max - min, label: (side) => `${side} ${name}` };
}

export const heightMapExporter: ExportFactory = {
  mode: 'height-map',
  label: 'Height Map',

  isAvailable(context: ExportContext): boolean {
    const h = heightExtent(context);
    return h !== null && h.range > MIN_Z_EXTENT_M;
  },

  unavailableReason(context: ExportContext): string {
    const h = heightExtent(context);
    if (h === null) return 'No cloud is loaded.';
    if (h.range <= MIN_Z_EXTENT_M) return 'Cloud has no measurable height range.';
    return 'Height map is unavailable on this cloud.';
  },

  async render(
    context: ExportContext,
    options: HeightMapOptions,
  ): Promise<ExportResult> {
    const h = heightExtent(context);
    if (h === null) {
      throw new Error('HeightMap: no cloud loaded — cannot describe the export.');
    }
    // Native CRS units — Min/Max Z must carry the real unit (ft for foot CRSs).
    const unit = linearUnitOf(context.adapter.crsLabel()?.unit);

    // Honesty: `options.ramp` is accepted for API / preset compatibility but is
    // NOT applied to the raster. The export forces the runtime into its fixed
    // `elevation` colour mode and captures that via `adapter.snapshot()`; the
    // chosen ramp never reaches the shader, so every ramp value yields
    // byte-identical pixels. Stamping a "Ramp: <x>" card row and a `ramp`
    // metadata field would describe a palette the image was never coloured
    // with — an overclaim. We therefore omit both and record only the honest
    // Min/Max Z elevation range the coloured raster genuinely spans. (Wiring
    // the ramp into the elevation palette would mean plumbing it through the
    // Viewer's colour-mode shader, out of scope for this exporter.)
    return runStudioExport(
      context,
      'height-map',
      'Height Map',
      'elevation',
      options,
      [
        { label: h.label('Min'), value: formatLinear(h.min, unit) },
        { label: h.label('Max'), value: formatLinear(h.max, unit) },
      ],
      {
        minZ: h.min,
        maxZ: h.max,
      },
    );
  },
};
