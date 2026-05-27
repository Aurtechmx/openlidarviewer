/**
 * IntensityExporter.ts
 *
 * Live-view intensity raster. The runtime is forced into the `intensity`
 * colour mode for the render; the view, EDL, and measurement / annotation
 * overlays are all baked through `viewer.snapshot()`. WYSIWYG with the
 * on-screen view.
 *
 * Availability: requires at least one loaded cloud to carry per-point
 * intensity. Sources without intensity (RGB-only PLY, some PCD layouts,
 * GLTF) gate off with an explicit reason surfaced to the Studio UI.
 */

import type {
  ExportContext,
  ExportFactory,
  ExportResult,
  IntensityOptions,
} from './types';
import { runStudioExport } from './BaseExportMode';

export const intensityExporter: ExportFactory = {
  mode: 'intensity',
  label: 'Intensity',

  isAvailable(context: ExportContext): boolean {
    if (!context.adapter.hasIntensity()) return false;
    return context.adapter.localBoundsAabb() !== null;
  },

  unavailableReason(context: ExportContext): string {
    if (!context.adapter.hasIntensity()) {
      return 'This cloud has no intensity channel.';
    }
    if (context.adapter.localBoundsAabb() === null) {
      return 'No cloud is loaded.';
    }
    return 'Intensity export is unavailable on this cloud.';
  },

  async render(
    context: ExportContext,
    options: IntensityOptions,
  ): Promise<ExportResult> {
    return runStudioExport(
      context,
      'intensity',
      'Intensity',
      'intensity',
      options,
      [
        { label: 'Normalize', value: options.normalize !== false ? 'On' : 'Off' },
        { label: 'Invert',    value: options.invert ? 'On' : 'Off' },
      ],
      {
        normalize: options.normalize !== false ? 'on' : 'off',
        invert: options.invert ? 'on' : 'off',
      },
    );
  },
};
