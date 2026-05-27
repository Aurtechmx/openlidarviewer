/**
 * NormalMapExporter.ts
 *
 * RGB-encoded surface normals.
 *
 * **v0.3.3 MVP scope:** the runtime is forced into the `normal` colour
 * mode (which exists in the colour-mode pipeline for the static-cloud
 * path) and the export is captured WYSIWYG. The mode is gated on
 * `adapter.hasNormals()` because:
 *
 *   • COPC + EPT streaming sources don't carry normals — LAS reserves
 *     no field for them, and EPT writers rarely emit Normal X/Y/Z
 *     schema attributes.
 *   • Static loaders DO sometimes carry normals: PCD with `_normal_`
 *     fields, PTX (from terrestrial scanners), some GLTF + PLY files.
 *
 * When the cloud carries no normals the export gates off with an
 * explicit reason so the user gets actionable feedback instead of a
 * uniform-grey image.
 *
 * **What's planned for a later session:** a depth-gradient
 * approximation that synthesises pseudo-normals from a top-down depth
 * raster, removing the cloud-must-carry-normals requirement. The export-
 * seam architecture supports it; the v0.3.3 MVP just gates on the
 * explicit-normals path so the seam is honest about what's currently
 * implemented.
 */

import type {
  ExportContext,
  ExportFactory,
  ExportResult,
  NormalMapOptions,
} from './types';
import { runStudioExport } from './BaseExportMode';

export const normalMapExporter: ExportFactory = {
  mode: 'normal',
  label: 'Normal Map',

  isAvailable(context: ExportContext): boolean {
    return context.adapter.hasNormals();
  },

  unavailableReason(context: ExportContext): string {
    if (!context.adapter.hasNormals()) {
      return (
        'This cloud has no per-point normals. LiDAR captures rarely include ' +
        'them; PCD / PTX / GLTF scans with normals are supported.'
      );
    }
    return 'Normal Map is unavailable on this cloud.';
  },

  async render(
    context: ExportContext,
    options: NormalMapOptions,
  ): Promise<ExportResult> {
    const smooth = options.smooth !== false;
    return runStudioExport(
      context,
      'normal',
      'Normal Map',
      // The runtime's `normal` colour mode encodes normals as RGB via
      // the standard remap n = (n + 1) / 2. Sources without per-point
      // normals would hit `isAvailable === false` above, so this path
      // is only reached when normals exist.
      'normal',
      options,
      [
        { label: 'Smoothing', value: smooth ? 'on' : 'off' },
        { label: 'Encoding',  value: 'RGB · (n + 1) / 2' },
      ],
      {
        smooth: smooth ? 'on' : 'off',
        encoding: 'rgb-remap',
      },
    );
  },
};
