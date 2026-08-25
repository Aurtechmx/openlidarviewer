/**
 * openTilesetLayer.ts — opening a remote 3D Tiles tileset as a static layer.
 *
 * The shell's URL router dispatches here for a `tileset.json`, the way it
 * dispatches to `handleRemoteEpt` for an `ept.json`. What happens after that is
 * deliberately the STATIC path, not the streaming one: `loadTilesetCloud`
 * returns one merged `PointCloud`, and `attachStaticCloud` mounts it through
 * the same attach every dropped file goes through, so the layer row, the
 * Inspector, the CRS pass and the Analyse panel all behave as they do for a
 * decoded LAS. Nothing in the viewer needs to know a tileset was involved.
 *
 * A tileset that is too large for one read is refused by the loader rather than
 * partially opened here (see `tilesetCloud.ts`). This module's whole job around
 * that is the surface: claim the one-load-at-a-time flag, wire Cancel to the
 * fetch, report a refusal as an error the user can read, and release the flag.
 *
 * Held behind `lazyChunks.loadTilesetOpen` — the tileset parser, traversal,
 * transport and PNTS decoder are a chunk nothing in the startup shell needs.
 */

import { attachStaticCloud, type OpenScanDeps } from './openScan';
import { LoadCancelledError } from '../io/loadFile';
import { describeLoadError } from '../io/loadErrors';
import { loadTilesetCloud } from '../io/tiles3d/tilesetCloud';
import { createTilesetTransport } from '../io/tiles3d/tilesetTransport';
import { isAbortError, linkAbortSignals } from './openStreaming';

/**
 * Open a remote tileset by its `tileset.json` URL and mount the merged cloud.
 *
 * `deps` is the shell's existing `openScanDeps`: the attach is the same one a
 * local file gets, so it takes the same collaborators rather than a parallel
 * set that could drift from it.
 */
export async function openRemoteTileset(
  url: string,
  signal: AbortSignal | undefined,
  deps: OpenScanDeps,
): Promise<void> {
  if (deps.isLoading()) {
    deps.showToast('Already loading — cancel the current load first.');
    return;
  }
  // Claimed synchronously, as on every other open: each await below yields to
  // the event loop, and a second open started in that window would otherwise
  // pass this guard too.
  deps.setLoading(true);
  const controller = new AbortController();
  // The URL field's Cancel and the progress toast's Cancel are separate
  // signals; either one aborts the fetches in flight.
  const unlinkAbort = linkAbortSignals(signal, controller);
  deps.dropZone.setOpening('Opening tileset…');
  deps.dropZone.setCancelHandler(() => controller.abort());
  try {
    await deps.viewerReady;
    const cloud = await loadTilesetCloud(
      url,
      createTilesetTransport(),
      {
        onTile: (done, total) =>
          deps.dropZone.setProgress(`Reading tile ${done} of ${total}…`, done / total),
      },
      controller.signal,
    );
    if (controller.signal.aborted) throw new LoadCancelledError();
    await attachStaticCloud(
      // A tileset is read in full, so what is on screen IS the source total and
      // there is no reduced display cloud to declare.
      { cloud, originalPointCount: cloud.pointCount, downsampled: false },
      // No source file: the layer came from many fetched tiles, so the Export
      // panel has nothing to re-decode at full resolution.
      { file: null, signal: controller.signal },
      deps,
    );
  } catch (err) {
    deps.dropZone.setCancelHandler(null);
    if (err instanceof LoadCancelledError || isAbortError(err)) {
      deps.dropZone.setProgress(null);
    } else {
      if (deps.debug) console.error('OpenLiDARViewer — tileset open error', err);
      deps.dropZone.setError(describeLoadError(err));
    }
  } finally {
    unlinkAbort();
    deps.setLoading(false);
  }
}
