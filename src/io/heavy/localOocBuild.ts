/**
 * localOocBuild.ts — one call that indexes a local LAS into a durable OPFS store.
 *
 * `buildTileStoreFromLas` already turns an uncompressed LAS `RangeSource` into a
 * tile store, writing tiles through a spill store and the manifest / hierarchy
 * through a sink. This module is the thin glue that runs that build against an
 * OPFS directory the way the browser needs it: a partial-store build (so a
 * cancelled or faulted index leaves nothing behind), the manifest and hierarchy
 * written into the same directory the tiles go to, and a promotion to the final
 * name once the build returns.
 *
 * It runs identically in a worker (where OPFS sync access handles are available)
 * and in a Node test against `tests/support/fakeOpfs.ts`, because everything it
 * touches is the structural {@link OpfsDirHandle} rather than a real browser
 * handle. The worker owns the message transport; this owns the build.
 *
 * The reopen that turns these artifacts back into a streaming source lives on
 * the main thread (see `src/app/openLocalHeavyLas.ts`): this returns the two
 * text artifacts and the promoted store's name, and the caller reopens the tiles
 * from OPFS by that name. Nothing live crosses the worker boundary.
 */
import type { RangeSource } from '../range/RangeSource';
import { buildTileStoreFromLas, buildTileStoreFromLaz } from './tileStoreBuilder';
import {
  openOpfsSpillBuild,
  writeOpfsText,
  STORE_LEASE_FILE,
  type OpfsDirHandle,
} from './opfsSpillStore';

/** The phases the build reports, as plain strings for the streaming panel. */
export type LocalOocPhase = 'indexing' | 'finishing';

export interface LocalOocBuildOptions {
  /** Which builder to run: the sliced-LAS reader ('las', the default) or the
   *  chunked-LAZ source ('laz'). The open path sets it from the header sniff, so
   *  a compressed LAZ is decoded chunk-by-chunk rather than read as raw LAS. */
  readonly kind?: 'las' | 'laz';
  readonly pointsPerLeaf?: number;
  readonly memoryBudgetBytes?: number;
  readonly maxDepth?: number;
  /** Points per sliced LAS batch — bounds the largest single range read. */
  readonly batchPoints?: number;
  readonly signal?: AbortSignal;
  readonly onPhase?: (phase: LocalOocPhase) => void;
}

/** What the build hands back for the main thread to reopen and attach. */
export interface LocalOocBuildResult {
  readonly manifestJson: string;
  readonly hierarchy: string;
  readonly peakBufferedBytes: number;
  readonly pointCount: number;
  /** The final directory name the tiles were promoted to, under the OPFS root. */
  readonly storeName: string;
}

/**
 * Index a local LAS into an OPFS tile store named `storeName` under `root`.
 *
 * The build runs inside {@link openOpfsSpillBuild} so the tiles and artifacts
 * are written into `<storeName>.partial` and promoted in one pass only when the
 * build returns; a cancel or a fault discards the partial directory rather than
 * leaving a half-store the size of the scan behind. Throws whatever the sliced
 * reader throws on a compressed or non-LAS input, so the caller routes by the
 * load plan rather than by catching here.
 */
export async function buildLocalOocStore(
  range: RangeSource,
  root: OpfsDirHandle,
  storeName: string,
  options: LocalOocBuildOptions = {},
): Promise<LocalOocBuildResult> {
  const build = await openOpfsSpillBuild(root, storeName);
  options.onPhase?.('indexing');
  let manifestJson: string;
  let hierarchy: string;
  let peakBufferedBytes: number;
  let pointCount: number;
  try {
    // Stamp the build's start so a startup janitor can tell an abandoned store
    // from a live one by age. It rides through promotion with the manifest and
    // tiles, so both the `.partial` and the promoted store carry it. Best
    // effort: a lease that will not write only makes this store a non-candidate
    // for the sweep, never a failed build. Written here rather than in
    // `openOpfsSpillBuild` so the low-level spill primitive stays lease-free for
    // the callers (and tests) that use it directly.
    await writeOpfsText(build.dir, STORE_LEASE_FILE, JSON.stringify({ createdAt: Date.now() })).catch(
      () => {},
    );
    // The manifest and hierarchy go into the partial directory alongside the
    // tiles, so promotion moves the whole store as one directory.
    const sink = { write: (name: string, text: string) => writeOpfsText(build.dir, name, text) };
    const built =
      options.kind === 'laz'
        ? await buildTileStoreFromLaz(range, build.store, {
            pointsPerLeaf: options.pointsPerLeaf,
            memoryBudgetBytes: options.memoryBudgetBytes,
            maxDepth: options.maxDepth,
            signal: options.signal,
            laz: { signal: options.signal },
            sink,
          })
        : await buildTileStoreFromLas(range, build.store, {
            pointsPerLeaf: options.pointsPerLeaf,
            memoryBudgetBytes: options.memoryBudgetBytes,
            maxDepth: options.maxDepth,
            signal: options.signal,
            las: { batchPoints: options.batchPoints, signal: options.signal },
            sink,
          });
    manifestJson = built.manifestJson;
    hierarchy = built.hierarchy;
    peakBufferedBytes = built.peakBufferedBytes;
    pointCount = built.reader.manifest.pointCount;
    // Promotion is inside the SAME guard as the build. A quota, write or rename
    // failure while moving the finished tiles into place must discard the
    // partial exactly as a build fault does; promoting outside the catch left a
    // whole scan-sized partial stranded on any promotion failure. `discard()`
    // is a no-op once `promote()` has settled the build, so a clean promotion
    // costs nothing here.
    options.onPhase?.('finishing');
    await build.promote();
  } catch (err) {
    // Cancel, decode fault, quota failure and a promotion failure all arrive as
    // a throw; every one must delete the partial store rather than strand its
    // bytes on disk.
    await build.discard().catch(() => {});
    throw err;
  }
  return { manifestJson, hierarchy, peakBufferedBytes, pointCount, storeName };
}
