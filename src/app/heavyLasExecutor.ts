/**
 * heavyLasExecutor.ts — the heavy half of the out-of-core LAS bridge.
 *
 * Everything that pulls the out-of-core cluster into the bundle lives here:
 * the storage preflight, the worker build, the OPFS reopen, `OlvTileSource`,
 * the tile decoder and the streaming attach. It is held behind
 * `lazyChunks.loadHeavyLasExecutor`, so a session that opens a small LAS, a LAZ,
 * or nothing at all never loads any of this weight. The eager decision half
 * (`openLocalHeavyLas.ts`) delegates here only after the plan has already said
 * an uncompressed LAS routes out of core.
 *
 * The browser-only seams (the OPFS root, the storage estimate reader, the index
 * worker) are an injectable {@link HeavyLasExecutorEnv} with a live default, so
 * the whole build-reopen-attach path runs in Node against a fake OPFS and an
 * in-process build. Only the worker message transport is not exercised there.
 */
import {
  storagePreflight,
  storagePreflightRefusal,
  readStorageEstimate,
} from '../io/heavy/storagePreflight';
import {
  openTileStore,
  tileBytesReader,
  TILE_MANIFEST_NAME,
  TILE_HIERARCHY_NAME,
} from '../io/heavy/tileStoreBuilder';
import {
  opfsSpillStore,
  removeOpfsStore,
  readOpfsText,
  type OpfsDirHandle,
} from '../io/heavy/opfsSpillStore';
import { fingerprintFromRange, sourceContentDigestFromRange } from '../io/heavy/fileFingerprint';
import {
  readCacheMap,
  mutateCacheMap,
  lookupEntry,
  verifiedEntry,
  upsertEntry,
  touchEntry,
  removeByStoreName,
  selectEvictions,
  cacheGeneration,
} from '../io/heavy/oocCacheMap';
import {
  resolveLockManager,
  acquireStoreResidency,
  liveStoreNames,
} from '../io/heavy/oocStoreLiveness';
import { OlvTileSource, PreviewCloudSource } from '../io/heavy/OlvTileSource';
import { buildPreviewSample } from '../io/heavy/previewSampler';
import { TileChunkDecoder } from '../io/heavy/tileChunkDecoder';
import { revealStreamingScanChrome } from '../ui/streamingScanReveal';
import {
  activateCommittedStreamingCloud,
  enterStreamingInspectorMode,
  publishStreamingDetail,
  resetClassificationUi,
  type OpenStreamingDeps,
  type StreamingReportInput,
} from './openStreaming';
import type { StreamingSource } from '../render/streaming/StreamingSource';
import { LocalOocIndexerClient } from '../io/heavy/worker/localOocIndexerWorkerClient';
import type { LocalOocPhase } from '../io/heavy/localOocBuild';
import { readLazChunkTable } from '../io/heavy/lazChunkTable';
import { sweepAbandonedOocStores, sweepPromotedOrphans } from '../io/heavy/opfsStoreJanitor';
import { LocalFileRangeSource } from '../io/range/LocalFileRangeSource';
import type { RangeSource } from '../io/range/RangeSource';
import { LoadError } from '../io/loadErrors';
import { LoadCancelledError } from '../io/loadFile';
import type {
  HeavyLasBridgeDeps,
  HeavyLasBridgeEnv,
  HeavyOpenResult,
  LasHeaderFacts,
} from './heavyLasTypes';

/** Peak staging memory the bucketing pass may hold before spilling to OPFS. */
const BUILD_MEMORY_BUDGET_BYTES = 128 * 1024 * 1024;

/**
 * Soft cap on the retained cache: after a fresh build records its store, the
 * least-recently-used stores are evicted until the retained tile bytes fit this,
 * so a session that opens many large files does not grow the cache without bound.
 * A live store (one another tab holds open) is never evicted, whatever its age.
 */
const CACHE_BUDGET_BYTES = 8 * 1024 * 1024 * 1024;

/**
 * Fingerprint the file before any decode, so a persisted index can be looked up
 * or recorded under a content-based key. Returns null when the source bounds are
 * absent (an old peek) or any window read fails — the caller reads null as "no
 * reuse and no record", never as a match, keeping the cache fail-safe.
 */
async function computeOpenFingerprint(
  file: File,
  facts: LasHeaderFacts,
  range: RangeSource,
  signal: AbortSignal,
): Promise<string | null> {
  if (!facts.min || !facts.max) return null;
  try {
    return await fingerprintFromRange(
      range,
      {
        fileBytes: facts.fileBytes,
        // A real File always carries a numeric lastModified; default defensively
        // so a synthetic File missing it still yields a well-formed digest.
        lastModified: typeof file.lastModified === 'number' ? file.lastModified : 0,
        declaredPointCount: facts.declaredPointCount,
        offsetToPointData: facts.offsetToPointData,
        min: facts.min,
        max: facts.max,
      },
      signal,
    );
  } catch {
    return null;
  }
}

const PHASE_LABELS: Record<LocalOocPhase, string> = {
  indexing: 'Indexing for streaming…',
  finishing: 'Finishing the index…',
};

/**
 * The status shown WHILE the preview sample is up. It has to say two things at
 * once: what is on screen is a sample, and the full index is still building — so
 * the user cannot mistake a spread of the cloud for the finished scan.
 */
const PREVIEW_PHASE_LABEL = 'Preview sample, building the full index…';

/**
 * The refusal sentence for a heavy LAZ the chunked out-of-core path cannot
 * randomly decode. It names the true cause — no usable chunk table — and points
 * at COPC/EPT, the same convert advice every heavy refusal ends with, so the
 * user learns why the file will not open rather than watching the tab run out of
 * memory on a whole-file decode. Carried on a `refused` result, so
 * {@link describeHeavyRefusal} surfaces it verbatim.
 */
function describeUnchunkableLaz(fileName: string, reason: string): string {
  return (
    `${fileName} is a LAZ too large to open in one piece, and it has no usable chunk table ` +
    `for random access (${reason}), so it cannot be streamed out of core. ` +
    'Convert it to COPC or EPT (with PDAL or untwine) and open that instead, which streams ' +
    'from the file and writes no local cache.'
  );
}

/**
 * A filesystem-safe store name for ONE open of ONE file.
 *
 * The name carries a per-open random id, so two opens never share a store —
 * not two tabs opening the same file, not a rapid close-then-reopen of the same
 * name and size. A shared name was a real hazard: two builds would write the
 * same `<name>.partial` and promote over each other, and closing one source
 * would delete the other's store, because the close removes the store by name.
 * The id makes each build's `.partial`, its promoted directory, the reader id
 * and the close-time removal all refer to the same private store and no other.
 */
function heavyStoreName(file: File, uniqueId: string): string {
  const base = file.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  return `ooc-${base}-${file.size}-${uniqueId}`;
}

let openIdCounter = 0;

// A crashed or force-closed session cannot delete its temporary store, so stale
// `<name>.partial` build directories accumulate. The first heavy open of a
// session sweeps those best-effort, keeping this open's own store and anything
// younger than the lease threshold. It runs where OPFS-heavy usage actually
// happens rather than at boot. Promoted `ooc-*` stores are deliberately NOT
// swept: one may be a live dataset another tab still owns, and there is no
// cross-tab ownership signal yet (see opfsStoreJanitor.ts).
let janitorSwept = false;

/**
 * A per-open id that keeps two concurrent opens on distinct store names. It is
 * a temporary directory label, not a security token, but it draws from Web
 * Crypto so its randomness is not the pseudorandom generator a scanner flags:
 * `randomUUID` where present, else `getRandomValues`. The final branch (no Web
 * Crypto at all, unreachable where OPFS exists) uses time plus a monotonic
 * counter rather than a pseudorandom source.
 */
function newOpenId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = c.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(36)}-${(openIdCounter++).toString(36)}`;
}

/**
 * Reopen a cached store from OPFS without rebuilding: read its manifest and
 * hierarchy back, present them as an {@link OlvTileSource}, and hold a shared
 * residency lock so an eviction pass in another tab cannot delete it while it is
 * open. Its `close` RETAINS the store — a reused index is never deleted. Returns
 * null when the store directory is gone (evicted) or its artifacts cannot be
 * read (a partial or corrupt store), which the caller treats as a miss.
 */
async function reopenFromCache(
  root: OpfsDirHandle,
  storeName: string,
  file: File,
): Promise<{ source: OlvTileSource; decoder: TileChunkDecoder } | null> {
  let dir: OpfsDirHandle;
  try {
    dir = await root.getDirectoryHandle(storeName);
  } catch {
    return null; // store evicted out from under the map
  }
  let manifestJson: string;
  let hierarchy: string;
  try {
    manifestJson = await readOpfsText(dir, TILE_MANIFEST_NAME);
    hierarchy = await readOpfsText(dir, TILE_HIERARCHY_NAME);
  } catch {
    return null; // artifacts missing / unreadable → rebuild
  }
  const spill = opfsSpillStore(dir);
  const reader = openTileStore(manifestJson, hierarchy);
  const locks = resolveLockManager();
  const releaseResidency = locks ? await acquireStoreResidency(locks, storeName) : null;
  const source = new OlvTileSource({
    id: `ooc-${storeName}`,
    name: file.name,
    store: reader,
    tiles: tileBytesReader(spill),
    // RETAIN: a reused store is kept for the next open. Release the tile handles
    // and the residency lock, but never delete — the map still points here.
    close: async () => {
      await spill.close();
      await releaseResidency?.();
    },
  });
  const decoder = new TileChunkDecoder(reader.schema, reader.recordBytes);
  return { source, decoder };
}

/**
 * Try to satisfy the open from the persisted cache. Returns a terminal
 * {@link HeavyOpenResult} on a hit (or a cancel mid-attach), or null to tell the
 * caller to build fresh — on a miss, a stale entry whose store is gone (cleaned
 * here), or a reopen whose attach faulted for a non-cancel reason.
 */
async function tryReopen(
  root: OpfsDirHandle,
  generation: string,
  sourceContentSha256: string,
  file: File,
  deps: HeavyLasBridgeDeps,
  signal: AbortSignal,
  locks: ReturnType<typeof resolveLockManager>,
): Promise<HeavyOpenResult | null> {
  const map = await readCacheMap(root);
  // Reuse is authorised by the whole-file content digest, not the quick locator:
  // a candidate whose stored digest differs (a file edited outside the sampled
  // windows) is not returned, so a stale source can never receive a hit.
  const entry = verifiedEntry(map, generation, sourceContentSha256);
  if (!entry) return null;
  const opened = await reopenFromCache(root, entry.storeName, file);
  if (!opened) {
    // The map named a store that is no longer usable; drop the stale entry so a
    // later open does not keep chasing it, then build fresh.
    await mutateCacheMap(locks, root, (current) =>
      removeByStoreName(current, entry.storeName),
    ).catch(() => {});
    return null;
  }
  try {
    await attachHeavyStream(opened.source, opened.decoder, deps, signal);
  } catch (err) {
    await opened.source.close().catch(() => {});
    if (signal.aborted || isCancel(err)) return { status: 'cancelled' };
    if (deps.debug) console.warn('[heavy-las] cache reopen attach failed; rebuilding', err);
    return null;
  }
  await mutateCacheMap(locks, root, (current) =>
    touchEntry(current, sourceContentSha256, generation, Date.now()),
  ).catch(() => {});
  return { status: 'attached', source: opened.source, decoder: opened.decoder };
}

/**
 * Record a freshly-built store in the cache map and evict down to the budget.
 * Best-effort: any failure returns false and the caller then leaves the store
 * uncommitted (deleted on close), so a cache-write fault never leaks an
 * unrecorded store nor fails the open. Eviction skips every live store and never
 * this one — the caller holds its residency lock, so it is in the live set.
 */
async function recordAndEvict(
  root: OpfsDirHandle,
  fingerprint: string,
  sourceContentSha256: string,
  generation: string,
  storeName: string,
  reader: { manifest: { pointCount: number }; recordBytes: number },
  locks: ReturnType<typeof resolveLockManager>,
): Promise<boolean> {
  try {
    const now = Date.now();
    const tileBytes = reader.manifest.pointCount * reader.recordBytes;
    // Record and evict as ONE locked read-modify-write. Two tabs promoting
    // stores at the same time otherwise both read the same map and the second
    // write drops the first tab's entry, orphaning a store that is retained on
    // disk but referenced by nothing. Eviction belongs inside the same lock: it
    // deletes stores, so two concurrent passes could each decide to remove what
    // the other just recorded.
    await mutateCacheMap(locks, root, async (current) => {
      let map = upsertEntry(current, {
        fingerprint,
        sourceContentSha256,
        storeName,
        generation,
        createdAt: now,
        lastUsedAt: now,
        pointCount: reader.manifest.pointCount,
        tileBytes,
      });
      const live = await liveStoreNames(locks);
      if (live) {
        for (const name of selectEvictions(map.entries, { budgetBytes: CACHE_BUDGET_BYTES, liveNames: live })) {
          await removeOpfsStore(root, name).catch(() => {});
          map = removeByStoreName(map, name);
        }
      }
      return map;
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the tile store, reopen it from OPFS, and attach it as a streaming scan.
 * Called only when the decision half has confirmed the plan routes this file out
 * of core, so every failure path here is a CONFIRMED-heavy failure: it returns a
 * non-`attached`, `heavy: true` status the caller reads as "refuse, do not fall
 * back", because the whole-file loader would face the same too-large allocation.
 * `cancelled` is the one non-heavy tag: the user stopped the open on purpose.
 */
export async function executeHeavyLasBuild(
  file: File,
  signal: AbortSignal,
  facts: LasHeaderFacts,
  deps: HeavyLasBridgeDeps,
  env: Partial<HeavyLasBridgeEnv> = {},
): Promise<HeavyOpenResult> {
  const getOpfsRoot = env.getOpfsRoot ?? defaultGetOpfsRoot;
  const readStorage = env.readStorage ?? readStorageEstimate;
  const runIndex = env.runIndex ?? ((request) => new LocalOocIndexerClient().run(request));
  const openRange = env.openRange ?? ((f: File): RangeSource => new LocalFileRangeSource(f));
  // One random id for this open, threaded through the preview id, the build's
  // store name and the reopen, so the whole lifecycle owns one private store.
  const openId = newOpenId();
  const storeName = heavyStoreName(file, openId);

  // For a heavy LAZ, decide chunkability from a bounded chunk-table read BEFORE
  // any heavy work. The out-of-core LAZ builder decodes one window of chunks at a
  // time from the chunk table, so a LAZ without a usable table (a pointwise
  // pre-2011 compressor, an interrupted writer) cannot be randomly decoded. The
  // file is already confirmed too large for one ArrayBuffer, so it must FAIL
  // CLOSED here rather than fall through to the whole-file loader that would OOM
  // on a multi-gigabyte sequential decode. The read is bounded by the point-data
  // offset, so it never pulls more than the header/VLR region, and it runs in
  // this lazily-loaded chunk so the LAZ chunk-table code stays out of the eager
  // shell. LAS never reaches this branch.
  if (facts.format === 'laz') {
    const table = await readLazChunkTable(openRange(file), signal, facts.offsetToPointData);
    if (!table.supported) {
      return {
        status: 'refused',
        heavy: true,
        error: new LoadError('memory-constraint', describeUnchunkableLaz(file.name, table.reason)),
      };
    }
  }

  const root = await getOpfsRoot();
  if (root === null) return { status: 'unavailable', heavy: true, reason: 'no OPFS root' };

  // Persistent cache. The quick locator (a sampled fingerprint) finds a
  // CANDIDATE cheaply; the authoritative whole-file source-content digest then
  // AUTHORISES reuse, so a file edited outside the sampled windows can never
  // receive a verified hit. A null locator (a peek with no bounds, or a read
  // fault) skips both reuse and recording, so the open behaves as it did before
  // the cache existed.
  const generation = cacheGeneration();
  const fingerprint = await computeOpenFingerprint(file, facts, openRange(file), signal);
  if (signal.aborted) return { status: 'cancelled' };

  // The whole-file digest is computed at most once per open, and only when it is
  // actually needed: to verify a reopen candidate, or to record a freshly built
  // store. A cold cache with no candidate never pays for it here. (Folding the
  // digest into the build's existing sequential pass is a browser-measured
  // follow-up; correctness does not depend on it.)
  let digestMemo: string | null | undefined;
  const sourceDigest = async (): Promise<string | null> => {
    if (digestMemo === undefined) {
      digestMemo = await sourceContentDigestFromRange(openRange(file), facts.fileBytes, signal);
    }
    return digestMemo;
  };

  if (fingerprint) {
    // Cheap candidate pre-filter: only hash the whole file when the locator finds
    // a same-generation candidate that could match.
    const hasCandidate = lookupEntry(await readCacheMap(root), fingerprint, generation) !== null;
    if (hasCandidate) {
      const digest = await sourceDigest();
      if (signal.aborted) return { status: 'cancelled' };
      if (digest) {
        const reopened = await tryReopen(root, generation, digest, file, deps, signal, resolveLockManager());
        if (reopened) return reopened;
      }
    }
  }

  if (!janitorSwept) {
    janitorSwept = true;
    void sweepAbandonedOocStores(root, { ownedNames: new Set([storeName]) }).catch(() => {});
    // Also reclaim promoted stores the cache no longer references and no live tab
    // holds (Phase 6). Skipped entirely when liveness is unavailable — without a
    // live-set an in-use store cannot be told from an orphan, so nothing is swept.
    void (async () => {
      const live = await liveStoreNames(resolveLockManager());
      if (!live) return;
      const map = await readCacheMap(root);
      const referenced = new Set(map.entries.map((e) => e.storeName));
      await sweepPromotedOrphans(root, { referenced, live, debug: deps.debug });
    })().catch(() => {});
  }

  // The disk guard. Sized from the declared point count and the record schema,
  // it refuses BEFORE any byte is written when the tile cache would not fit, or
  // when storage cannot even be read. The file is already confirmed heavy, so
  // this refusal reaches the user rather than falling through to a whole-file
  // load that would hit the same ceiling.
  const verdict = await storagePreflight(
    { pointCount: facts.declaredPointCount, schema: facts.schema },
    readStorage,
  );
  if (!verdict.proceed) {
    const error = storagePreflightRefusal(verdict, file.name);
    if (error) return { status: 'refused', heavy: true, error };
    return { status: 'unavailable', heavy: true, reason: 'preflight refused without a message' };
  }

  // PREVIEW FIRST. Before the long index build, put a bounded, stratified
  // sample on screen through the SAME streaming attach the real source uses, so
  // a multi-gigabyte file is not a blank wait. Best effort: any sampling fault
  // means no preview, never a failed open. The sample is honest — it reports its
  // own point count and its octree is incomplete — and it is attached WITHOUT
  // the committed-scan reveal, so nothing presents it as a finished scan. If the
  // build then completes, `attachStreamingCloud` replaces (and disposes) it.
  let previewAttached = false;
  try {
    const sample = await buildPreviewSample(openRange(file), facts, { signal });
    if (sample && !signal.aborted) {
      const previewSource = new PreviewCloudSource({
        id: `preview-${storeName}`,
        name: file.name,
        sample,
      });
      const previewDecoder = new TileChunkDecoder(sample.schema, sample.recordBytes);
      await attachStreamingScan(previewSource, previewDecoder, deps, signal);
      deps.setPhase(PREVIEW_PHASE_LABEL);
      previewAttached = true;
    }
  } catch (err) {
    if (signal.aborted || isCancel(err)) {
      teardownPreview(previewAttached, deps);
      return { status: 'cancelled' };
    }
    if (deps.debug) console.warn('[heavy-las] preview sample skipped', err);
  }

  try {
    // While a preview is on screen the phase must keep saying it is a sample and
    // the full index is still building, so the user never reads the preview as
    // the finished cloud. Without a preview it is the plain build phase.
    const phaseFor = (phase: LocalOocPhase): string =>
      previewAttached ? PREVIEW_PHASE_LABEL : PHASE_LABELS[phase];
    deps.setPhase(phaseFor('indexing'));
    const built = await runIndex({
      file,
      storeName,
      kind: facts.format,
      memoryBudgetBytes: BUILD_MEMORY_BUDGET_BYTES,
      onPhase: (phase) => deps.setPhase(phaseFor(phase)),
      signal,
    });
    // The worker has already PROMOTED the store by the time it resolves, so an
    // abort here is not free: the promoted store is on disk and nothing owns it
    // yet. Delete it before returning, or a cancel right after promotion leaks
    // the whole scan-sized store.
    if (signal.aborted) {
      teardownPreview(previewAttached, deps);
      await removeOpfsStore(root, built.storeName).catch((err) => {
        if (deps.debug) console.warn('[heavy-las] store cleanup after abort failed', err);
      });
      return { status: 'cancelled' };
    }

    const dir = await root.getDirectoryHandle(built.storeName);
    const spill = opfsSpillStore(dir);
    const reader = openTileStore(built.manifestJson, built.hierarchy);
    // Hold a shared residency lock while the store is open, so an eviction pass in
    // this or another tab cannot delete it from under a live read.
    const locks = resolveLockManager();
    const releaseResidency = locks ? await acquireStoreResidency(locks, built.storeName) : null;
    // Retained once the store is recorded in the cache map (only after a
    // successful attach, and only when this open has a fingerprint to key it by).
    // Until then — an attach fault, a build with no fingerprint — the store is
    // uncommitted and close DELETES it, exactly as before the cache existed.
    let retain = false;
    const source = new OlvTileSource({
      id: `ooc-${built.storeName}`,
      name: file.name,
      store: reader,
      tiles: tileBytesReader(spill),
      // Release the tile handles FIRST (so a close racing a read unlocks before
      // anything is touched) and the residency lock, THEN — only for an
      // uncommitted store — remove it. A committed store is kept for reuse; a
      // removal that cannot run because a read still holds the handle is
      // swallowed and the store rebuilt next open, the honest fallback.
      close: async () => {
        await spill.close();
        await releaseResidency?.();
        if (retain) return;
        try {
          await removeOpfsStore(root, built.storeName);
        } catch (err) {
          if (deps.debug) console.warn('[heavy-las] out-of-core store removal failed', err);
        }
      },
    });
    const decoder = new TileChunkDecoder(reader.schema, reader.recordBytes);

    // Between here and a successful attach the promoted store is owned by
    // `source` and by nothing else: if the attach aborts or faults, the source
    // never becomes the committed viewer cloud, so its `close()` — which
    // releases the tile handles and removes the store — is the only thing that
    // will free it. `close()` on a source that never attached is safe. Once the
    // attach resolves, ownership passes to the committed streaming session and
    // its own teardown removes the store, so this guard steps aside.
    try {
      await attachHeavyStream(source, decoder, deps, signal);
    } catch (err) {
      await source.close().catch((closeErr) => {
        if (deps.debug) console.warn('[heavy-las] store cleanup after attach failure failed', closeErr);
      });
      throw err;
    }
    // The scan is committed. If this open has a locator AND a whole-file digest,
    // record the store so a later open can verify and reuse it, and retain it on
    // close. Without the digest the store could never be authorised for reuse, so
    // it is left uncommitted (deleted on close) rather than recorded unusably.
    const recordDigest = fingerprint ? await sourceDigest() : null;
    if (
      fingerprint &&
      recordDigest &&
      (await recordAndEvict(root, fingerprint, recordDigest, generation, built.storeName, reader, locks))
    ) {
      retain = true;
    }
    return { status: 'attached', source, decoder };
  } catch (err) {
    // A cancel or a build fault must not leave the preview stranded on screen
    // labelled "building the full index" when nothing is building any more.
    teardownPreview(previewAttached, deps);
    if (signal.aborted || isCancel(err)) {
      return { status: 'cancelled' };
    }
    if (deps.debug) console.warn('[heavy-las] out-of-core open failed; refusing', err);
    return { status: 'failed', heavy: true, error: err };
  }
}

/**
 * Whether a thrown error is a cancellation on its own terms. A user cancel
 * surfaces as a {@link LoadCancelledError} or a DOM `AbortError`. An aborted read
 * can also surface as a `RangeReadError`, which is ambiguous (a genuine read
 * failure raises the same type), so that case is decided by the `signal.aborted`
 * check at the call site rather than here, and is not folded in.
 */
function isCancel(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return err instanceof LoadCancelledError || name === 'AbortError';
}

/**
 * Detach a still-attached preview scan. Called on every non-`attached` exit
 * after a preview went up: a successful full attach already replaced and
 * disposed it through `attachStreamingCloud`, but a cancel or a fault never
 * reaches that swap, so the preview would otherwise stay on screen. Detaching
 * disposes the (in-memory) preview session; a viewer with no preview is a no-op.
 */
function teardownPreview(previewAttached: boolean, deps: HeavyLasBridgeDeps): void {
  if (!previewAttached) return;
  try {
    deps.getViewer().detachStreamingCloud();
  } catch (err) {
    if (deps.debug) console.warn('[heavy-las] preview teardown failed', err);
  }
}

/**
 * Attach a built tile source through the shared streaming path, then reveal the
 * scan chrome COPC, EPT and 3D Tiles all reveal (PR #648's helper), so an
 * out-of-core scan opens with the same dock, nav bar and inspector a streamed
 * scan does rather than a bare cloud with no UI.
 */
async function attachHeavyStream(
  source: OlvTileSource,
  decoder: TileChunkDecoder,
  deps: HeavyLasBridgeDeps,
  signal: AbortSignal,
): Promise<void> {
  await attachStreamingScan(source, decoder, deps, signal);
  revealHeavyStreamingSurfaces(source, deps.streaming);
}

/**
 * Attach a streaming source and reveal the scan CHROME (dock, nav bar,
 * inspector), stopping short of the committed-scan reveal. Shared by the full
 * out-of-core open and the preview: the preview needs the cloud on screen and
 * the chrome to orbit it, but NOT `revealHeavyStreamingSurfaces`, which
 * publishes the scan report, provenance, CRS and the Analyse rail as a finished
 * scan — a claim a sample must not make. The full open calls this and then adds
 * that reveal.
 *
 * `attachStreamingCloud` is transactional: it builds the new session first and
 * aborts before its commit if `signal` fired, and on a streaming→streaming swap
 * it detaches and disposes the previous cloud only after the replacement is
 * built. So attaching the real source over the preview replaces it with no leak,
 * and a cancel mid-build keeps whatever scene was already up.
 */
async function attachStreamingScan(
  source: StreamingSource,
  decoder: TileChunkDecoder,
  deps: HeavyLasBridgeDeps,
  signal: AbortSignal,
): Promise<void> {
  await deps.viewerReady;
  const viewer = deps.getViewer();
  await viewer.ready;
  if (signal.aborted) throw new LoadCancelledError();
  await viewer.attachStreamingCloud(source, decoder, 'balanced', deps.isPhone(), null, signal);
  deps.stage.hideEmptyState();
  viewer.setMode('orbit');
  viewer.frameAll();
  revealStreamingScanChrome({
    dock: deps.dock,
    inspector: deps.inspector,
    navBar: deps.navBar,
    backend: viewer.activeBackend(),
    body: deps.body,
  });
}

/**
 * Reveal the streaming surfaces a committed out-of-core scan supports, the same
 * ones COPC, EPT and 3D Tiles reveal after their commit, routed through their
 * shared helpers so a fourth format is a call, not a transcription (PR #648's
 * `openTilesetLayer` reveal is the model for judging each call on its merits).
 *
 * KEEP, because an `OlvTileSource` genuinely supports them:
 *  - the streaming panel (`show`, `setColorModes`, `setQuality`, `setPhase`):
 *    the colour modes come from the tile store's own schema — rgb only when the
 *    source LAS carried it, plus intensity / elevation / classification, which
 *    every tile record holds by layout — not from the format.
 *  - `resetClassificationUi`: classification IS a real channel here, so this is
 *    the empty-and-waiting COPC reset (the legend seeds lazily as classified
 *    nodes become resident), NOT the inapplicable-hidden tileset case.
 *  - the streaming Inspector / Export layout and the image-export gate
 *    (`enterStreamingInspectorMode`), off the live viewer's availability.
 *  - the Inspector's streaming Detail readout and the Scan Report with the REAL
 *    total: the store states its tile total, so both show a measured count
 *    rather than the tileset's "not stated by the source". The readout states
 *    it as the SOURCE figure against the separately-counted resident set, not
 *    as the number of points on the GPU.
 *  - `activateCommittedStreamingCloud` (usage, provenance, CRS), the Analyse
 *    rail, the export pre-warm, a fresh saved-views list, the status poll.
 *
 * SKIP, because the source cannot honestly fill them:
 *  - `setSourceUrl`: the store is built from a LOCAL file with no publisher to
 *    credit (COPC guards the same call behind `http-range`).
 *  - `setSummary`: the panel's format vocabulary is `copc | ept | 3dtiles`, none
 *    of which names a decoded out-of-core LAS store; mislabelling it is worse
 *    than omitting the row, and the real point total still reaches the user
 *    through the Scan Report and the Inspector detail row.
 */
function revealHeavyStreamingSurfaces(source: OlvTileSource, s: OpenStreamingDeps): void {
  // Publish the committed scan's usage, provenance and CRS — never before the
  // commit — exactly as the COPC / EPT / tileset opens do.
  activateCommittedStreamingCloud(source, s);

  const viewer = s.getViewer();
  s.streamingPanel.setColorModes([...source.availableColorModes()], source.defaultColorMode());
  s.streamingPanel.setQuality(s.getStreamingQuality());
  s.streamingPanel.setPhase('Streaming coarse geometry…');
  resetClassificationUi(s);
  enterStreamingInspectorMode(s, viewer.availableImageExportModes());

  publishStreamingDetail(s.inspector, source, s.debug);
  const reportCloud: StreamingReportInput = {
    kind: source.kind,
    name: source.name,
    sourcePointCount: source.sourcePointCount,
    maxDepth: () => source.maxDepth(),
    octree: { nodes: () => source.octree.nodes() },
    crs: () => source.crs(),
  };
  s.setLastStreamingReportCloud(reportCloud);
  try {
    s.inspector.setReport(
      s.runStreamingModules(reportCloud, s.classLegendPanel.getVisibility().isFiltered()),
    );
  } catch (err) {
    if (s.debug) console.warn('[inspector] setReport (heavy) threw', err);
  }

  s.prewarmExportStudio();
  s.revealAnalysePanel(source.name, false);
  s.streamingPanel.show();

  try {
    s.bookmarks.clear();
    s.refreshViewsUI();
  } catch (err) {
    if (s.debug) console.warn('[views] saved-views refresh (heavy) threw', err);
  }
  s.startStreamingStatusPolling();
}

/** The live OPFS root, or null where the platform has no OPFS. */
async function defaultGetOpfsRoot(): Promise<OpfsDirHandle | null> {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') {
    return null;
  }
  try {
    return (await navigator.storage.getDirectory()) as unknown as OpfsDirHandle;
  } catch {
    return null;
  }
}
