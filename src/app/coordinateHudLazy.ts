/**
 * coordinateHudLazy.ts — defer the coordinate HUD to the first probe hover.
 *
 * The HUD is hidden until a point is under the cursor, so its builder, the
 * cursor readout and the CRS-frame banner it renders never need to be in the
 * startup bundle. `wireCoordinateHud` (which builds and mounts on the spot)
 * therefore rides a lazy chunk; this thin wrapper is what `main.ts` holds
 * eagerly. It returns the same probe hover sink, but the real handler is built
 * only when the first non-null hover arrives — from then on every hover goes
 * straight to it.
 */

import type { CoordinateHudDeps } from './coordinateHudMount';
import type { PointInfo } from '../render/pointInfo';
import { loadCoordinateHudMount } from '../lazyChunks';

/**
 * The probe hover sink, with the HUD's construction deferred. Before the first
 * point arrives there is nothing to show, so a clear (`null`) is a no-op and no
 * chunk is fetched; the first real hover loads the mount, builds the handler,
 * and replays that hover so the readout appears without waiting for the next
 * frame. A hover that lands while the chunk is still loading is dropped — the
 * next one (probe hovers fire per frame) shows the current point.
 */
export function lazyCoordinateHud(deps: CoordinateHudDeps): (info: PointInfo | null) => void {
  let sink: ((info: PointInfo | null) => void) | null = null;
  let loading = false;
  return (info: PointInfo | null): void => {
    if (sink) {
      sink(info);
      return;
    }
    if (!info || loading) return;
    loading = true;
    void loadCoordinateHudMount().then((m) => {
      sink = m.wireCoordinateHud(deps);
      sink(info);
    });
  };
}
