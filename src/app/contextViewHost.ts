/**
 * contextViewHost.ts — the application-side half of the Context View seam.
 *
 * `createContextViewController(host)` asks for exactly three things: the loaded
 * layers, the resolved CRS, and a coordinate converter. This module answers all
 * three from the services the app already owns — the Viewer's cloud registry,
 * `CrsService`, and the vendored `utmConverter` that every other lat/lon path in
 * the build (`lonLatMapper`, the point Inspector) already routes through. No new
 * CRS plumbing is introduced here, and nothing is cached: each accessor reads
 * live state, so one `refresh()` after a layer or CRS change is enough.
 *
 * BOUNDS ARE REPORTED IN THE SOURCE FRAME, never the render frame. A cloud's
 * `bounds()` are recentred local coordinates; the file's own easting/northing is
 * `bounds + sourceOrigin` (`renderOrigin` for a streaming cloud, which is the
 * same quantity under the streaming path's name). Handing the context core the
 * local box instead would place every scan a few hundred kilometres from where
 * it is — near the projection's false origin — and it would look plausible,
 * which is the failure mode worth naming here.
 *
 * This module makes no eligibility decision and mints no user-facing string.
 * Whether a scan can be placed is `decideContextEligibility`'s answer, derived
 * from these facts; a layer this module cannot describe is simply not listed.
 */

import type { CoordinateConverter } from '../geo/CoordinateConverter';
import type { ResolvedCrs } from '../geo/CoordinateTypes';
import { utmConverter } from '../geo/UtmConverter';
import type { Viewer } from '../render/Viewer';
import type {
  ContextLayerDescriptor,
  ContextViewHost,
} from '../ui/contextView/contextViewMount';

export interface ContextViewHostDeps {
  /** The lazily-assigned Viewer — read through a getter, never captured. */
  readonly getViewer: () => Viewer;
  /** Whether the Viewer chunk has resolved and is safe to dereference. */
  readonly isViewerReady: () => boolean;
  /** The app's single resolved CRS (`crsService.current()`), or null. */
  readonly getCrs: () => ResolvedCrs | null;
  /** Override the converter. Exists for tests; production uses the vendored one. */
  readonly converter?: CoordinateConverter;
}

/**
 * Describe every loaded layer in its own source frame: the static clouds in the
 * Viewer's registry, plus the streaming cloud when one is attached (the two are
 * mutually exclusive in practice, but listing both keeps this free of an
 * assumption the loader could change).
 *
 * A streaming layer is described from `dataBounds()` — the LAS header's tight
 * min/max — rather than the octree cube, which is a padded power-of-two span and
 * would draw a footprint larger than the data.
 */
export function contextLayerDescriptors(viewer: Viewer): ContextLayerDescriptor[] {
  const out: ContextLayerDescriptor[] = [];
  if (!viewer) return out;
  for (const id of viewer.clouds()) {
    const cloud = viewer.getCloud(id);
    if (!cloud) continue;
    const { min, max } = cloud.bounds();
    const origin = cloud.sourceOrigin;
    out.push({
      id,
      name: cloud.name,
      bounds: {
        minX: min[0] + origin[0],
        minY: min[1] + origin[1],
        maxX: max[0] + origin[0],
        maxY: max[1] + origin[1],
      },
    });
  }
  const streaming = viewer.streamingCloud;
  if (streaming) {
    const box = streaming.dataBounds();
    const origin = streaming.renderOrigin;
    out.push({
      id: 'streaming',
      name: streaming.name,
      bounds: {
        minX: box[0] + origin[0],
        minY: box[1] + origin[1],
        maxX: box[3] + origin[0],
        maxY: box[4] + origin[1],
      },
    });
  }
  return out;
}

/** Build the host the Context View controller mounts against. */
export function createContextViewHost(deps: ContextViewHostDeps): ContextViewHost {
  const converter = deps.converter ?? utmConverter;
  return {
    listLayers: () =>
      deps.isViewerReady() ? contextLayerDescriptors(deps.getViewer()) : [],
    currentCrs: () => deps.getCrs(),
    converter: () => converter,
  };
}
