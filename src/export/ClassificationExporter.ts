/**
 * ClassificationExporter.ts
 *
 * Live-view ASPRS classification raster. The runtime is forced into the
 * `classification` colour mode for the render; the view, EDL, and
 * measurement / annotation overlays are all baked through
 * `viewer.snapshot()`. WYSIWYG with the on-screen view.
 *
 * Availability: requires at least one loaded cloud to carry per-point
 * classification. Sources without it (PLY, PCD without label channel,
 * GLTF) gate off with an explicit reason.
 *
 * Honest caveat — a cloud that has the classification *channel* but where
 * every point is class 0 ("never classified") or class 1 ("unclassified")
 * will render as uniform grey. v0.3.3 will pre-check the histogram and
 * surface "this cloud has nothing meaningfully classified" before clicking;
 * for v0.3.2 the scan-report card simply reports `Classification: Yes` and
 * the user can read the visual outcome.
 */

import type {
  ClassificationOptions,
  ExportContext,
  ExportFactory,
  ExportResult,
} from './types';
import { runStudioExport } from './BaseExportMode';

export const classificationExporter: ExportFactory = {
  mode: 'classification',
  label: 'Classification',

  isAvailable(context: ExportContext): boolean {
    if (!context.adapter.hasClassification()) return false;
    return context.adapter.localBoundsAabb() !== null;
  },

  unavailableReason(context: ExportContext): string {
    if (!context.adapter.hasClassification()) {
      return 'This cloud has no classification channel.';
    }
    if (context.adapter.localBoundsAabb() === null) {
      return 'No cloud is loaded.';
    }
    return 'Classification export is unavailable on this cloud.';
  },

  async render(
    context: ExportContext,
    options: ClassificationOptions,
  ): Promise<ExportResult> {
    return runStudioExport(
      context,
      'classification',
      'Classification',
      'classification',
      options,
      [{ label: 'Legend', value: options.legend ? 'On' : 'Off' }],
      { legend: options.legend ? 'on' : 'off' },
    );
  },
};
