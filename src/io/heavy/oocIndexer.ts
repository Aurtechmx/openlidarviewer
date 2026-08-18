/**
 * oocIndexer.ts — the two-pass out-of-core octree build.
 *
 * A cloud too large for memory cannot be sorted into an octree in one pass, so
 * the build reads the source twice. Pass one takes only the bounds and the point
 * count, which fixes the {@link OctreeGrid} — the node structure is decided from
 * those two numbers alone, never from the points, so no tree is mutated per
 * point. Pass two streams every point into an in-memory buffer keyed by its leaf
 * and spills the buffers to a {@link SpillStore} whenever they reach a memory
 * budget, so peak residency is the budget rather than the cloud.
 *
 * The store is injected: a memory store makes the whole build Node-testable, and
 * an OPFS-backed store is what the browser build passes. This module knows only
 * `append`/`read`/`keys`, so it is agnostic to where the tiles actually live.
 *
 * The invariants the phase-1 gate rests on — every point conserved, every point
 * inside its leaf cube, peak memory within budget — are proven in
 * `tests/oocIndexer.test.ts`. Fail-closed: a source that yields nothing produces
 * an empty index rather than a fault.
 */
import { octreeGridFor, type OctreeGrid } from './octreeGrid';

/** One batch of interleaved xyz positions from a re-iterable source. */
export interface PositionBatch {
  readonly positions: Float32Array;
  readonly count: number;
}

/**
 * A point source the indexer can read TWICE. `batches()` must yield the same
 * points on every call — the bounds pass and the bucketing pass both consume it,
 * and a source that changed between them would place points against stale bounds.
 */
export interface PointSource {
  batches(signal?: AbortSignal): AsyncGenerator<PositionBatch>;
}

/** Where leaf tiles are spilled. A memory map in tests, an OPFS directory in the browser. */
export interface SpillStore {
  /** Append `bytes` to the tile for `key`. Called many times per key across flushes. */
  append(key: string, bytes: Uint8Array): Promise<void>;
  /** The full tile for `key`. */
  read(key: string): Promise<Uint8Array>;
  /** Every key written so far. */
  keys(): Promise<string[]>;
}

export interface OocLeaf {
  readonly key: string;
  readonly pointCount: number;
}

export interface OocIndex {
  readonly grid: OctreeGrid;
  readonly depth: number;
  readonly pointCount: number;
  readonly bounds: { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] };
  readonly leaves: readonly OocLeaf[];
  /** High-water mark of buffered bytes during the bucketing pass. */
  readonly peakBufferedBytes: number;
}

export interface IndexOptions {
  /** Target points per leaf; sets the grid depth. Default 100 000. */
  readonly pointsPerLeaf?: number;
  /** Bucketing-pass memory ceiling before a spill. Default 64 MB. */
  readonly memoryBudgetBytes?: number;
  readonly maxDepth?: number;
  readonly signal?: AbortSignal;
}

const DEFAULT_POINTS_PER_LEAF = 100_000;
const DEFAULT_MEMORY_BUDGET = 64 * 1024 * 1024;
/** Three float32 per point — the tile record the indexer writes. */
const RECORD_FLOATS = 3;
const RECORD_BYTES = RECORD_FLOATS * 4;

/** Pass one: the axis-aligned bounds and the point count, nothing held per point. */
async function scanBounds(
  source: PointSource,
  signal?: AbortSignal,
): Promise<{ min: [number, number, number]; max: [number, number, number]; count: number }> {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let count = 0;
  for await (const batch of source.batches(signal)) {
    signal?.throwIfAborted();
    const p = batch.positions;
    for (let i = 0; i < batch.count; i++) {
      for (let a = 0; a < 3; a++) {
        const v = p[i * 3 + a];
        if (v < min[a]) min[a] = v;
        if (v > max[a]) max[a] = v;
      }
    }
    count += batch.count;
  }
  return { min, max, count };
}

/**
 * A growable per-leaf staging buffer of float32 positions. Points for one leaf
 * accumulate here and are flushed to the store as a contiguous byte run.
 */
class LeafBuffer {
  private data = new Float32Array(RECORD_FLOATS * 256);
  length = 0; // floats written

  push(x: number, y: number, z: number): void {
    if (this.length + RECORD_FLOATS > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data[this.length++] = x;
    this.data[this.length++] = y;
    this.data[this.length++] = z;
  }

  /** The written bytes as a view, for a zero-copy append. Valid until the next push. */
  bytes(): Uint8Array {
    return new Uint8Array(this.data.buffer, 0, this.length * 4);
  }

  reset(): void {
    this.length = 0;
  }
}

export async function indexOutOfCore(
  source: PointSource,
  store: SpillStore,
  options: IndexOptions = {},
): Promise<OocIndex> {
  const signal = options.signal;
  const pointsPerLeaf = Math.max(1, options.pointsPerLeaf ?? DEFAULT_POINTS_PER_LEAF);
  const budget = Math.max(RECORD_BYTES, options.memoryBudgetBytes ?? DEFAULT_MEMORY_BUDGET);

  const { min, max, count } = await scanBounds(source, signal);
  const grid = octreeGridFor(min, max, count, pointsPerLeaf, options.maxDepth);

  const buffers = new Map<string, LeafBuffer>();
  const counts = new Map<string, number>();
  let buffered = 0; // bytes currently staged in memory
  let peakBufferedBytes = 0;

  async function flush(): Promise<void> {
    for (const [key, buf] of buffers) {
      if (buf.length === 0) continue;
      await store.append(key, buf.bytes());
      buf.reset();
    }
    buffered = 0;
  }

  for await (const batch of source.batches(signal)) {
    signal?.throwIfAborted();
    const p = batch.positions;
    for (let i = 0; i < batch.count; i++) {
      const x = p[i * 3];
      const y = p[i * 3 + 1];
      const z = p[i * 3 + 2];
      const key = grid.leafKeyFor(x, y, z);
      let buf = buffers.get(key);
      if (buf === undefined) {
        buf = new LeafBuffer();
        buffers.set(key, buf);
      }
      buf.push(x, y, z);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      buffered += RECORD_BYTES;
      if (buffered > peakBufferedBytes) peakBufferedBytes = buffered;
      // Bound residency to the budget: spill everything once it is reached, so
      // the high-water mark is the budget plus at most the record that tipped it.
      if (buffered >= budget) await flush();
    }
  }
  await flush();

  const leaves: OocLeaf[] = [...counts.entries()]
    .map(([key, pointCount]) => ({ key, pointCount }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return {
    grid,
    depth: grid.depth,
    pointCount: count,
    bounds: { min, max },
    leaves,
    peakBufferedBytes,
  };
}
