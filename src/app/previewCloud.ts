/**
 * previewCloud.ts
 *
 * The stand-in a local load shows while its chunks decode: a
 * `PreviewCloudLayer` hosted in the Viewer's scene, filled in chunk by chunk,
 * framed once, and disposed at the commit that replaces it or at the failure
 * or cancel that ends the load. The Viewer lends scene membership, its mesh
 * builder and one camera fit; nothing here reaches its layer table, so the
 * stand-in is never listed, measured or exported.
 */
import { PreviewCloudLayer, PREVIEW_MAX_POINTS } from '../render/previewCloudLayer';
import type { PreviewChunk } from '../io/loadLas';
import type { Viewer } from '../render/Viewer';

/** What the load holds while its stand-in is up. */
export interface PreviewCloudHandle {
  /** Append one chunk; the first also frames the view when the source declared no extent. */
  append(chunk: PreviewChunk): void;
  /** Take the stand-in down and release its buffers. */
  dispose(): void;
}

/** The Viewer seams the stand-in needs. */
export type PreviewCloudViewer = Pick<Viewer, 'derivedLayerHost' | 'buildPointMesh' | 'framePreviewExtent' | 'previewCloudEnded'>;

/**
 * Start a stand-in for a load whose first chunk is `first`. The mesh is sized
 * to the smaller of the decode's expected records, the device's render budget
 * and {@link PREVIEW_MAX_POINTS}, which is the same ceiling the decode sampled
 * its hand-offs against, so the chunks fit as they arrive.
 */
export function startPreviewCloud(
  viewer: PreviewCloudViewer,
  first: PreviewChunk,
  renderBudget: number,
): PreviewCloudHandle {
  const layer = new PreviewCloudLayer(
    viewer.derivedLayerHost(),
    (positions, colors) => viewer.buildPointMesh(positions, colors, null, null),
    {
      capacity: Math.max(1, Math.min(first.expectedPoints, renderBudget, PREVIEW_MAX_POINTS)),
      expectedPoints: first.expectedPoints,
      // The decoder sampled these against the same budget, so storing them as
      // they arrive is what keeps the preview at the size it was planned for.
      preThinned: true,
      frame: first.frame,
    },
  );
  let framed = false;
  if (first.frame) {
    viewer.framePreviewExtent(first.frame.min, first.frame.max);
    framed = true;
  }
  const handle: PreviewCloudHandle = {
    append(chunk) {
      layer.append(chunk);
      if (!framed) {
        const b = layer.bounds();
        if (b) {
          viewer.framePreviewExtent(b.min, b.max);
          framed = true;
        }
      }
    },
    dispose() {
      layer.dispose();
      viewer.previewCloudEnded();
    },
  };
  handle.append(first);
  return handle;
}
