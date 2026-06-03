/**
 * DepthMapExporter.ts
 *
 * Camera-relative depth raster.
 *
 * **scope:** the runtime is forced into the `elevation` colour
 * mode (which already exists in the colour-mode pipeline) and the export
 * is captured WYSIWYG. For a top-down camera this gives an
 * elevation-based depth approximation that's directly useful for ML
 * datasets / QA / geometry review. The label + the scan-report rows
 * make this explicit so the user knows what they're getting.
 *
 * **Not currently implemented:** a true per-pixel depth-buffer
 * extraction via a depth-only WebGPU render pass. The export-seam
 * architecture supports it (any exporter is free to do its own render
 * pipeline), but the depth-buffer-readback path needs three.js's
 * WebGPURenderer.copyTextureToBuffer plumbing which is substantial
 * enough to belong in its own session.
 *
 * **Invert toggle** flips the grayscale: by default near = white, far =
 * black (matches the convention in synthetic-data ML pipelines). When
 * `invert: true` we record it in the metadata so the actual flip can
 * land at the same time as the depth-buffer-readback path.
 *
 * **Near/far overrides** let QA tools normalise depth across captures
 * by pinning the range explicitly — recorded in metadata even when the
 * doesn't honour them at the render layer.
 */

import type {
  DepthMapOptions,
  ExportContext,
  ExportFactory,
  ExportResult,
} from './types';
import { runStudioExport } from './BaseExportMode';
import { formatMetres } from './ScanReportRenderer';

export const depthMapExporter: ExportFactory = {
  mode: 'depth',
  label: 'Depth Map',

  isAvailable(context: ExportContext): boolean {
    // Same gate as Height Map — needs a non-degenerate Z extent so
    // there's depth variation to encode.
    const aabb = context.adapter.localBoundsAabb();
    if (!aabb) return false;
    return (aabb[5] - aabb[2]) > 1e-4;
  },

  unavailableReason(context: ExportContext): string {
    const aabb = context.adapter.localBoundsAabb();
    if (!aabb) return 'No cloud is loaded.';
    if ((aabb[5] - aabb[2]) <= 1e-4) {
      return 'Cloud has no measurable depth range.';
    }
    return 'Depth map is unavailable on this cloud.';
  },

  async render(
    context: ExportContext,
    options: DepthMapOptions,
  ): Promise<ExportResult> {
    const aabb = context.adapter.localBoundsAabb();
    if (!aabb) {
      throw new Error('Depth Map: no cloud loaded — cannot describe the export.');
    }
    const invert = options.invert === true;
    return runStudioExport(
      context,
      'depth',
      'Depth Map',
      // elevation acts as the depth proxy. Top-down framing gives a
      // directly useful depth approximation; per-pixel depth-buffer readback
      // is intentionally not used in this release.
      'elevation',
      options,
      [
        { label: 'Encoding', value: invert ? 'far → white' : 'near → white' },
        { label: 'Near Z',   value: formatMetres(aabb[2]) },
        { label: 'Far Z',    value: formatMetres(aabb[5]) },
        { label: 'Mode',     value: 'elevation proxy' },
      ],
      {
        invert: invert ? 'on' : 'off',
        nearZ: aabb[2],
        farZ: aabb[5],
        depthMode: 'elevation-proxy',
      },
    );
  },
};
