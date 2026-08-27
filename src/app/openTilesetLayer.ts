/**
 * openTilesetLayer.ts — opening a remote 3D Tiles tileset as a streaming scan.
 *
 * The shell's URL router dispatches here for a `tileset.json`, the way it
 * dispatches to `handleRemoteEpt` for an `ept.json`, and what happens after is
 * now the same STREAMING path those take. The entry document is fetched and
 * walked into a flat node store, and the scheduler fetches and decodes tile
 * bodies as the camera needs them.
 *
 * It used to read the whole tileset first and merge it into one static cloud.
 * That was honest but bounded to what one read could hold: nothing appeared
 * until every tile had been fetched, so a city-scale tileset was refused rather
 * than opened. Streaming removes that ceiling, and the refusals that remain are
 * about documents this subset cannot read rather than about size.
 *
 * The commit sequence below is the EPT path's, reusing its helpers rather than
 * a second copy: attach first because the attach is transactional, drop the
 * candidate only if a cancel lands before the static layers are retired, and
 * publish CRS and provenance to global state ONLY after the commit.
 *
 * Held behind `lazyChunks.loadTilesetOpen` — the tileset parser, traversal,
 * transport and PNTS decoder are a chunk nothing in the startup shell needs.
 */

import { LoadCancelledError } from '../io/loadFile';
import { describeLoadError } from '../io/loadErrors';
import { parseTileset } from '../io/tiles3d/tileset';
import { createTilesetTransport } from '../io/tiles3d/tilesetTransport';
import { PntsChunkDecoder } from '../io/tiles3d/pntsDecode';
import { TilesetStreamingSource } from '../render/streaming/TilesetStreamingSource';
import {
  activateCommittedStreamingCloud,
  isAbortError,
  linkAbortSignals,
  shouldDropCandidateOnPostCommitCancel,
  type OpenStreamingDeps,
} from './openStreaming';

/** The name shown for the scan, taken from the document's own URL. */
export function tilesetDisplayName(url: string): string {
  try {
    const path = new URL(url).pathname;
    const last = path.split('/').filter(Boolean).pop();
    return last ?? url;
  } catch {
    return url;
  }
}

/**
 * Open a remote tileset by its `tileset.json` URL and stream it.
 *
 * `deps` is the shell's `openStreamingDeps`: this is a streaming scan, so it
 * takes the same collaborators the COPC and EPT opens take rather than a
 * parallel set that could drift from them.
 */
export async function openRemoteTileset(
  url: string,
  signal: AbortSignal | undefined,
  deps: OpenStreamingDeps,
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
  let committed = false;
  try {
    await deps.viewerReady;
    const transport = createTilesetTransport();
    const tileset = parseTileset(await transport.fetchTilesetJson(url, controller.signal));
    if (controller.signal.aborted) throw new LoadCancelledError();

    const cloud = new TilesetStreamingSource(url, tilesetDisplayName(url), url, transport, tileset);
    if (cloud.octree.nodes().length === 0) {
      throw new Error('This tileset declares no tile with point content.');
    }
    // A tile this reader cannot serve is a piece of the scene that would be
    // missing from a viewer that looked complete. Refuse the open and say which
    // tiles, rather than drawing the rest.
    if (!cloud.octree.isComplete) {
      const first = cloud.octree.errors[0] ?? 'a tile could not be served';
      throw new Error(
        `This tileset has ${cloud.octree.errors.length} tile(s) this reader cannot ` +
          `serve, so opening it would leave part of the scene missing. First: ${first}`,
      );
    }

    const viewer = deps.getViewer();
    // Captured BEFORE the attach commits, so the post-commit cancel handling
    // below knows which scene the user would still have.
    const replacingStatic = viewer.clouds().length > 0;
    await viewer.attachStreamingCloud(
      cloud,
      new PntsChunkDecoder(),
      deps.getStreamingQuality(),
      deps.isPhone(),
      deps.getStreamingBenchmark(),
      controller.signal,
    );
    if (shouldDropCandidateOnPostCommitCancel(replacingStatic, controller.signal.aborted)) {
      deps.closeStreaming();
      throw new LoadCancelledError();
    }
    deps.clearOpenStaticLayers();
    // The candidate is the sole committed scene now, so a later throw must not
    // tear it down in the catch.
    committed = true;
    activateCommittedStreamingCloud(cloud, deps);
    viewer.setMode('orbit');
    viewer.frameAll();

    deps.streamingPanel.setColorModes([...cloud.availableColorModes()], cloud.defaultColorMode());
    deps.streamingPanel.setQuality(deps.getStreamingQuality());
    deps.streamingPanel.setSourceUrl(url);
    deps.streamingPanel.setPhase('Streaming coarse geometry…');
    deps.dropZone.setProgress(null);
    deps.dropZone.setCancelHandler(null);
    deps.startStreamingStatusPolling();
    deps.revealStreamingChrome();
  } catch (err) {
    deps.dropZone.setCancelHandler(null);
    if (err instanceof LoadCancelledError || isAbortError(err)) {
      deps.dropZone.setProgress(null);
    } else {
      if (deps.debug) console.error('OpenLiDARViewer — tileset open error', err);
      deps.dropZone.setError(describeLoadError(err));
      // Only tear down when nothing was committed: after the commit this scene
      // is the valid one, and a later failure must not blank the viewer.
      if (!committed) deps.closeStreaming();
    }
  } finally {
    unlinkAbort();
    deps.setLoading(false);
  }
}
