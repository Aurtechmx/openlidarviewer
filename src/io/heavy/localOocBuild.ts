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
import { buildTileStoreFromLas } from './tileStoreBuilder';
import {
  openOpfsSpillBuild,
  writeOpfsText,
  type OpfsDirHandle,
} from './opfsSpillStore';

/** The phases the build reports, as plain strings for the streaming panel. */
export type LocalOocPhase = 'indexing' | 'finishing';

export interface LocalOocBuildOptions {
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
    const built = await buildTileStoreFromLas(range, build.store, {
      pointsPerLeaf: options.pointsPerLeaf,
      memoryBudgetBytes: options.memoryBudgetBytes,
      maxDepth: options.maxDepth,
      signal: options.signal,
      las: { batchPoints: options.batchPoints, signal: options.signal },
      // The manifest and hierarchy go into the partial directory alongside the
      // tiles, so promotion moves the whole store as one directory.
      sink: { write: (name, text) => writeOpfsText(build.dir, name, text) },
    });
    manifestJson = built.manifestJson;
    hierarchy = built.hierarchy;
    peakBufferedBytes = built.peakBufferedBytes;
    pointCount = built.reader.manifest.pointCount;
  } catch (err) {
    // Cancel, decode fault and quota failure all arrive as a throw; every one
    // must delete the partial store rather than strand its bytes on disk.
    await build.discard().catch(() => {});
    throw err;
  }
  options.onPhase?.('finishing');
  await build.promote();
  return { manifestJson, hierarchy, peakBufferedBytes, pointCount, storeName };
}
