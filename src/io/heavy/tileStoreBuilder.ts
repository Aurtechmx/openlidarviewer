/**
 * tileStoreBuilder.ts — one call from a LAS file to a streamable tile store.
 *
 * The out-of-core pieces each do one job: `openSlicedLasSource` reads a LAS as
 * bounded batches of packed records, `indexOutOfCore` settles those records into
 * an octree of spilled tiles, `buildTileStore` describes the result as a
 * manifest and a hierarchy, and `OlvTileSource` presents a parsed store to the
 * streaming scheduler. This module runs that sequence, so the values that have
 * to travel between the steps are threaded in one place. The recentring origin
 * is the sharpest of them: the LAS reader chooses it and the manifest must carry
 * it, or every coordinate the store later reports is short by the origin.
 *
 * Two halves that mirror each other: `buildTileStoreFromLas` produces the store
 * and its two text artifacts, and `openTileStore` takes those same two texts
 * back and returns a reader. A caller that wants the store to survive the
 * session writes the artifacts between the two; one that only wants to stream
 * what it just built skips straight to the reader it already has.
 *
 * Storage-agnostic: tiles go through the injected {@link SpillStore}, artifacts
 * through the optional {@link TileArtifactSink}. A memory pair makes the whole
 * build Node-testable; the browser passes an OPFS spill store and an OPFS text
 * sink.
 */

import type { RangeSource } from '../range/RangeSource';
import type { SpillStore } from './oocIndexer';
import { indexOutOfCore } from './oocIndexer';
import { openSlicedLasSource } from './slicedLasSource';
import type { SlicedLasOptions } from './slicedLasReader';
import {
  buildTileStore,
  parseHierarchy,
  parseTileManifest,
  TileStoreReader,
} from './tileStore';
import type { TileBytesReader } from './OlvTileSource';

/** Artifact file names, so the builder and the reopener cannot disagree. */
export const TILE_MANIFEST_NAME = 'manifest.json';
export const TILE_HIERARCHY_NAME = 'hierarchy.txt';

/** Where the store's two text artifacts are written. */
export interface TileArtifactSink {
  write(name: string, text: string): Promise<void>;
}

export interface BuildTileStoreOptions {
  /** Target points per octree node; drives the tree depth. */
  readonly pointsPerLeaf?: number;
  /** Peak bytes the bucketing pass may stage in memory before spilling. */
  readonly memoryBudgetBytes?: number;
  /** Ceiling on tree depth. */
  readonly maxDepth?: number;
  /** Written with the manifest and hierarchy when present. */
  readonly sink?: TileArtifactSink;
  /** Passed through to the sliced LAS reader (batch size, explicit origin). */
  readonly las?: SlicedLasOptions;
  readonly signal?: AbortSignal;
}

export interface BuiltTileStore {
  readonly reader: TileStoreReader;
  readonly tiles: TileBytesReader;
  readonly manifestJson: string;
  readonly hierarchy: string;
  /** High-water staging memory the build actually used, for a budget check. */
  readonly peakBufferedBytes: number;
}

/** A {@link TileBytesReader} over a spill store. */
export function tileBytesReader(spill: SpillStore): TileBytesReader {
  return { read: (key) => spill.read(key) };
}

/**
 * Build a tile store from an uncompressed LAS, reading it out of core. Throws
 * whatever the sliced reader throws on a compressed or non-LAS input, so a
 * caller routes by {@link planOutOfCore} rather than by catching.
 *
 * The returned reader is parsed back out of the manifest and hierarchy text
 * rather than built from the in-memory index, so the object handed to the
 * streaming source is the same one a later session would reopen. A build whose
 * artifacts would not survive the round trip fails here, not on next load.
 */
export async function buildTileStoreFromLas(
  range: RangeSource,
  spill: SpillStore,
  options: BuildTileStoreOptions = {},
): Promise<BuiltTileStore> {
  const las = await openSlicedLasSource(range, options.las ?? {});
  const index = await indexOutOfCore(las.source, spill, {
    pointsPerLeaf: options.pointsPerLeaf,
    memoryBudgetBytes: options.memoryBudgetBytes,
    maxDepth: options.maxDepth,
    signal: options.signal,
  });
  const { manifestJson, hierarchy } = buildTileStore(index, las.schema, las.origin);

  if (options.sink) {
    await options.sink.write(TILE_MANIFEST_NAME, manifestJson);
    await options.sink.write(TILE_HIERARCHY_NAME, hierarchy);
  }

  return {
    reader: openTileStore(manifestJson, hierarchy),
    tiles: tileBytesReader(spill),
    manifestJson,
    hierarchy,
    peakBufferedBytes: index.peakBufferedBytes,
  };
}

/**
 * Reopen a store from its two artifacts. Both parsers fail closed, so a
 * truncated or edited artifact throws here rather than producing a reader that
 * quietly describes a different tree than the tiles on disk.
 */
export function openTileStore(manifestText: string, hierarchyText: string): TileStoreReader {
  return new TileStoreReader(
    parseTileManifest(JSON.parse(manifestText) as unknown),
    parseHierarchy(hierarchyText),
  );
}
