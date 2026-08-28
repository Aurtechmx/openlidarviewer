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
 * The reveals after the commit are the same ones, minus the ones this format
 * cannot honestly fill. A tileset states no point total, so nothing here prints
 * one; it carries no LAS classification, so the class legend and the reclassify
 * panel are hidden rather than offered empty; and its colour modes come from
 * what the tiles carried rather than from the format. Everything else a
 * committed streaming scan reveals — the streaming panel, the streaming
 * Inspector layout, image export, the left rail — applies unchanged.
 *
 * Held behind `lazyChunks.loadTilesetOpen` — the tileset parser, traversal,
 * transport and PNTS decoder are a chunk nothing in the startup shell needs.
 */

import { LoadCancelledError } from '../io/loadFile';
import { describeLoadError } from '../io/loadErrors';
import { expandImplicitTileset } from '../io/tiles3d/implicitExpand';
import { parseTileset } from '../io/tiles3d/tileset';
import { createTilesetTransport, pntsDeviceTransportCap } from '../io/tiles3d/tilesetTransport';
import { validateRemoteTilesetUrl } from '../io/tiles3d/tilesetUrl';
import { PntsChunkDecoder } from '../io/tiles3d/pntsDecode';
import { pntsDeviceDecodeLimits } from '../io/tiles3d/pnts';
import { TilesetStreamingSource } from '../render/streaming/TilesetStreamingSource';
import {
  describeCloudFrame,
  FRAME_UNKNOWN_NOTE,
  type CloudFrameProvenance,
} from '../geo/frame/frameProvenance';
import type { AnalysisRow } from '../analysis/ModuleApi';
import {
  activateCommittedStreamingCloud,
  enterStreamingInspectorMode,
  isAbortError,
  linkAbortSignals,
  resetClassificationUi,
  shouldDropCandidateOnPostCommitCancel,
  type OpenStreamingDeps,
  type StreamingReportInput,
} from './openStreaming';

/**
 * A refusal this reader raised on purpose, as opposed to a transport or decode
 * failure.
 *
 * `describeLoadError` maps anything it is handed to one of six canned category
 * messages, and every tileset refusal classified to `decode-failure`. So a
 * valid 1.1 document using a form this subset does not serve was reported to
 * the user as "Decoding failed, the file may be corrupt or truncated", which is
 * both wrong and unactionable: the file is fine, and the reason it was refused
 * was already written down and then discarded.
 *
 * Carrying the refusals as their own type lets the catch below show what was
 * actually wrong, while a genuine transport or decode failure still goes
 * through the classifier, where the category IS the useful thing to say.
 */
export class TilesetRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TilesetRefusal';
  }
}

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
 * The Scan Report rows that state what the tileset established about up.
 *
 * A tileset declaring no geocentric root frame draws exactly like one that
 * does: it recentres, it fits the camera, it looks like a scene. The only place
 * the difference can appear is in words, so it is said here, on the surface a
 * user consults before trusting an elevation — the same place the COPC and EPT
 * opens put their honesty rows.
 *
 * The established case is stated no more strongly than the document allows. A
 * `region` fixes the root frame as WGS84 geocentric, which makes a height an
 * ELLIPSOIDAL height; 3D Tiles carries no vertical datum, so naming an
 * orthometric one here would be a different lie from the one this fixes.
 *
 * Pure — no DOM, no viewer — so the wording is testable without an open.
 */
export function tilesetFrameReportRows(
  provenance: CloudFrameProvenance | undefined,
): AnalysisRow[] {
  // A source that states nothing gets no row. Inventing "unknown" on its behalf
  // would report a determination that was never made.
  if (provenance === undefined) return [];
  const established = provenance.basis !== 'unknown';
  const rows: AnalysisRow[] = [
    {
      label: 'Vertical frame',
      value: describeCloudFrame(provenance),
      status: established ? 'info' : 'warn',
    },
  ];
  if (established && provenance.declaredBy !== null) {
    rows.push({ label: 'Frame declared by', value: provenance.declaredBy, status: 'info' });
  }
  if (!established) {
    rows.push({ label: 'Vertical reference', value: FRAME_UNKNOWN_NOTE, status: 'warn' });
  }
  return rows;
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
    // The entry URL is the ROOT of every trust decision below it. Tile URLs are
    // validated against a base derived from this one, and part of that check is
    // that a tile stays on the entry's own origin, so an unchecked entry lets
    // every tile inherit whatever origin it named. Nothing upstream validates:
    // the router only pattern-matches a path ending in tileset.json.
    const entry = validateRemoteTilesetUrl(url);
    if (!entry.ok) throw new TilesetRefusal(entry.reason);
    // A device-sized `.pnts` transport cap from the same PNTS peak policy the
    // decode step uses: on a phone a legal-but-large tile is refused before its
    // body is fetched, not downloaded to the desktop 128 MiB ceiling and then
    // refused at decode. Desktop keeps 128 MiB.
    const transport = createTilesetTransport({
      maxTileBytes: pntsDeviceTransportCap(deps.isPhone()),
    });
    const json = await transport.fetchTilesetJson(url, controller.signal);
    let tileset;
    try {
      // Expand before parsing. `parseTileset` refuses an implicit document by
      // design, so the expander has to rewrite it into the equivalent explicit
      // one first; every existing refusal then applies to the result. A
      // document that declares no implicit tiling comes back untouched, so this
      // is safe to run unconditionally and costs an explicit tileset nothing.
      const expanded = await expandImplicitTileset(JSON.parse(json) as object, {
        entryUrl: url,
        fetchSubtreeBytes: (subtreeUrl, signal) =>
          transport.fetchSubtreeBytes(subtreeUrl, signal),
        signal: controller.signal,
      });
      tileset = parseTileset(expanded);
    } catch (err) {
      // The parser's and the expander's refusals are all deliberate and already
      // say why. A cancel is not a refusal and has to keep its own identity.
      if (err instanceof LoadCancelledError) throw err;
      throw new TilesetRefusal(err instanceof Error ? err.message : String(err));
    }
    if (controller.signal.aborted) throw new LoadCancelledError();

    const cloud = new TilesetStreamingSource(url, tilesetDisplayName(url), url, transport, tileset);
    if (cloud.octree.nodes().length === 0) {
      throw new TilesetRefusal('This tileset declares no tile with point content.');
    }
    // A tile this reader cannot serve is a piece of the scene that would be
    // missing from a viewer that looked complete. Refuse the open and say which
    // tiles, rather than drawing the rest.
    if (!cloud.octree.isComplete) {
      const first = cloud.octree.errors[0] ?? 'a tile could not be served';
      throw new TilesetRefusal(
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
      // The decoder settles this layer's colour meaning on its first tile with
      // points, so a mixed tileset stays honest on screen without this. What the
      // sink adds is the reason: a user who dropped a coloured tileset and sees a
      // grey patch is owed the explanation rather than left to guess at it. It
      // fires at most once per layer, on the first disagreeing tile, which can be
      // long after this function has returned.
      new PntsChunkDecoder({
        onColourNotice: (message) => deps.showToast(message),
        // Device-sized decode ceilings from the same phone signal the streaming
        // budget uses for concurrency. On mobile a single legal-but-large tile
        // is refused at decode on its true size rather than allocated at the
        // desktop default, which the scheduler's `ASSUMED_TILE_POINTS` estimate
        // cannot catch before the body is fetched.
        decodeLimits: pntsDeviceDecodeLimits(deps.isPhone()),
      }),
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

    // A point tile carries no LAS classification, so the legend and the
    // reclassify panel are not empty-and-waiting here the way they are on a
    // COPC stream: they are inapplicable, and they live in the left rail this
    // open is about to reveal, so a previously opened COPC's legend would
    // otherwise surface class filters over a scan that has no classes. Before
    // the report, which is scoped by the legend's filter state. Wrapped for the
    // same reason the report calls below are: the frame-honesty rows are what a
    // user consults before trusting an elevation, and a throw in the class
    // surfaces must not be what stops them being published.
    try {
      resetClassificationUi(deps);
    } catch (err) {
      if (deps.debug) console.warn('[class-legend] reset (tileset) threw', err);
    }
    // Streaming layout for the Inspector and the Export panel, plus the image
    // export gate. Wrapped because the availability map is read off the live
    // viewer: a throw there would otherwise cost the panel, the status poll and
    // the chrome reveal below, none of which depend on it.
    try {
      enterStreamingInspectorMode(deps, viewer.availableImageExportModes());
    } catch (err) {
      if (deps.debug) console.warn('[inspector] streaming mode (tileset) threw', err);
    }

    // The Scan Report for THIS scan. Nothing set it on this path, so the
    // Inspector kept whichever streaming scan was open before: a tileset opened
    // over a COPC read as that COPC, point count included. A tileset carries no
    // LAS header, so the report is what a tileset does state — its format, its
    // octree depth and node count — and an explicitly unstated point total.
    const reportCloud: StreamingReportInput = {
      kind: cloud.kind,
      name: cloud.name,
      // Null, and typed null all the way through: the report row reads "not
      // stated by the source" instead of a figure nothing measured.
      sourcePointCount: cloud.sourcePointCount,
      maxDepth: () => cloud.maxDepth(),
      octree: { nodes: () => cloud.octree.nodes() },
    };
    deps.setLastStreamingReportCloud(reportCloud);
    // One report, built once. `setReport` replaces the Inspector's rows rather
    // than appending, so two calls would leave only whatever the second one
    // published. The streaming rows are gathered separately from the frame rows
    // for a different reason: the frame statement says whether which way is up
    // was ever established, and losing it because an unrelated module threw
    // would leave a user reading heights with nothing to warn them.
    let streamingRows: AnalysisRow[] = [];
    try {
      streamingRows = deps.runStreamingModules(
        reportCloud,
        deps.classLegendPanel.getVisibility().isFiltered(),
      );
    } catch (err) {
      if (deps.debug) console.warn('[inspector] runStreamingModules (tileset) threw', err);
    }
    try {
      deps.inspector.setReport([
        ...streamingRows,
        ...tilesetFrameReportRows(cloud.frameProvenance),
      ]);
    } catch (err) {
      if (deps.debug) console.warn('[inspector] setReport (tileset) threw', err);
    }

    // The left rail. `revealAnalysePanel` is the only call that reaches the
    // shell's mobile-sheet sync and through it `workspace.setAvailable`, which
    // is what puts `olv-ws-ready` on the rail; without it
    // `.olv-left-panels:not(.olv-ws-ready) .olv-ws-body` hid Process Studio,
    // the Export panel and the Measure panel, and the Measure panel was never
    // even mounted. `false` for `settled`: a streaming open's route verdict runs
    // on a sparse coarse frame, so the soft commit waits for the settle
    // one-shot, exactly as the COPC and EPT opens pass it.
    try {
      deps.prewarmExportStudio();
      deps.revealAnalysePanel(cloud.name, false);
    } catch (err) {
      if (deps.debug) console.warn('[workspace] revealAnalysePanel (tileset) threw', err);
    }

    // The chip row, and the image-export gate that reads the same answer.
    //
    // Published here it is the EMPTY answer: a tileset states colour and
    // normals per tile, nothing has been read yet, and reading every tile to
    // find out is the one thing a streaming open must not do. Published once,
    // that empty answer was the whole session's offer, so a tileset whose tiles
    // state normals could never show a Normal chip and its Normal Map export
    // stayed shut. The source folds the answer from the chunks the scheduler
    // served and signals when the OFFER moves, which happens at most once per
    // layer, so the row is republished on that signal rather than polled or
    // redrawn per chunk.
    //
    // Registered before the first publish so a chunk that lands in between
    // still moves the row. `published` is what makes that ordering safe: the
    // first call through here always establishes this layer's own selection,
    // and only the calls after it may keep one.
    let published = false;
    const publishColorModes = (): void => {
      deps.streamingPanel.setColorModes(
        [...cloud.availableColorModes()],
        cloud.defaultColorMode(),
        published,
      );
      published = true;
    };
    cloud.onColorModesChanged(() => {
      // This notification rides a decode continuation, which can land after a
      // second scan has replaced this one. A layer that is no longer open must
      // not repaint the surfaces the layer that replaced it owns.
      const live = deps.getViewer();
      if (live.streamingCloud !== cloud) return;
      try {
        publishColorModes();
        // `hasNormals()` answers from the source, so the Normal Map gate moves
        // with the offer. Read off the LIVE viewer, exactly as the open read it.
        deps.exportPanel.setImageExportAvailability(live.availableImageExportModes());
      } catch (err) {
        if (deps.debug) console.warn('[streaming] colour-mode republish (tileset) threw', err);
      }
    });
    publishColorModes();
    deps.streamingPanel.setQuality(deps.getStreamingQuality());
    deps.streamingPanel.setSourceUrl(url);
    deps.streamingPanel.setPhase('Streaming coarse geometry…');
    // The panel's Scan section, written BEFORE the panel becomes visible. The
    // path populated everything else on the panel and never showed it; showing
    // it without a summary would have exposed the previously opened scan's
    // section instead, because `hide()` runs only on close and a
    // streaming→streaming swap never passes through it. What a tileset states
    // is its format, its extent and its octree; the point total stays null, so
    // the Source row reads as absent rather than as a figure.
    const bounds = cloud.dataBounds();
    deps.streamingPanel.setSummary({
      fileName: cloud.name,
      // No LAS header, so no point-data record format; the panel's 3dtiles
      // branch states the format and never renders this sentinel.
      pointFormat: -1,
      sourcePoints: cloud.sourcePointCount,
      width: bounds[3] - bounds[0],
      depth: bounds[4] - bounds[1],
      height: bounds[5] - bounds[2],
      // No `spacing`: a tileset declares neither COPC's root-node spacing nor
      // EPT's node budget, and the panel omits the row rather than dashing it.
      octreeDepth: cloud.maxDepth(),
      nodeCount: cloud.octree.nodes().length,
      format: '3dtiles',
      crs: cloud.crs(),
    });
    deps.streamingPanel.show();

    // A fresh saved-views list for the new scan.
    try {
      deps.bookmarks.clear();
      deps.refreshViewsUI();
    } catch (err) {
      if (deps.debug) console.warn('[views] saved-views refresh (tileset) threw', err);
    }

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
      // A deliberate refusal already says what is wrong and what would be lost.
      // Everything else goes through the classifier, where the category is the
      // useful thing to say.
      deps.dropZone.setError(
        err instanceof TilesetRefusal ? err.message : describeLoadError(err),
      );
      // Only tear down when nothing was committed: after the commit this scene
      // is the valid one, and a later failure must not blank the viewer.
      if (!committed) deps.closeStreaming();
    }
  } finally {
    unlinkAbort();
    deps.setLoading(false);
  }
}
