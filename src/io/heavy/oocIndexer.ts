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

/**
 * One batch from a re-iterable source: interleaved xyz positions used to KEY
 * each point into a leaf, and optionally the fixed-length per-point records to
 * SPILL. Without `records` the indexer stores the 12-byte xyz itself, which is
 * all the geometry an octree needs; a source that also carries intensity,
 * classification, colour and the rest hands them over as `records` so the tiles
 * are renderable, not just spatially sorted.
 */
export interface PositionBatch {
  readonly positions: Float32Array;
  readonly count: number;
  /** `count * recordBytes` bytes, the payload written to each point's leaf. */
  readonly records?: Uint8Array;
  /** Bytes per record in `records`. Required when `records` is present. */
  readonly recordBytes?: number;
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
  /** Bytes per point in every leaf tile. */
  readonly recordBytes: number;
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

/**
 * Target points per leaf when a caller names none. Exported so the storage
 * preflight sizes a prospective index against the same figure the build will
 * actually use; a preflight holding its own copy would go quietly wrong the day
 * this one changed.
 */
export const DEFAULT_POINTS_PER_LEAF = 100_000;
const DEFAULT_MEMORY_BUDGET = 64 * 1024 * 1024;
/** The record when the source carries no attributes: three float32 xyz. */
const POSITION_RECORD_BYTES = 12;

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
 * A growable per-leaf staging buffer of raw record bytes. Points for one leaf
 * accumulate here and are flushed to the store as a contiguous run.
 */
class LeafBuffer {
  private data = new Uint8Array(4096);
  length = 0; // bytes written

  append(src: Uint8Array): void {
    if (this.length + src.length > this.data.length) {
      let cap = this.data.length * 2;
      while (cap < this.length + src.length) cap *= 2;
      const grown = new Uint8Array(cap);
      grown.set(this.data.subarray(0, this.length));
      this.data = grown;
    }
    this.data.set(src, this.length);
    this.length += src.length;
  }

  /** The written bytes as a view, for a zero-copy append. Valid until the next append. */
  bytes(): Uint8Array {
    return this.data.subarray(0, this.length);
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
  const budget = Math.max(POSITION_RECORD_BYTES, options.memoryBudgetBytes ?? DEFAULT_MEMORY_BUDGET);

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

  // Per-cell occupancy across EVERY level, so a point can find the coarsest
  // cell with room. Counts (one number per occupied cell) must survive a spill,
  // unlike the staging bytes, but they are orders of magnitude smaller than the
  // points they describe, so the pass stays inside its budget.
  const occupancy = new Map<string, number>();
  const nodeCapacity = pointsPerLeaf;

  // Scratch for the position-only path, so packing an xyz record allocates once
  // rather than per point.
  const scratch = new Float32Array(3);
  const scratchBytes = new Uint8Array(scratch.buffer);
  let recordBytes = -1; // set from the first batch; every batch must agree

  for await (const batch of source.batches(signal)) {
    signal?.throwIfAborted();
    const p = batch.positions;
    const rb = batch.records ? batch.recordBytes ?? 0 : POSITION_RECORD_BYTES;
    if (batch.records && rb <= 0) throw new Error('oocIndexer: a records batch must set a positive recordBytes');
    if (recordBytes === -1) recordBytes = rb;
    else if (rb !== recordBytes) throw new Error('oocIndexer: recordBytes changed between batches');

    for (let i = 0; i < batch.count; i++) {
      const x = p[i * 3];
      const y = p[i * 3 + 1];
      const z = p[i * 3 + 2];
      // PYRAMID PLACEMENT. A point does not go straight to its leaf: it settles
      // at the COARSEST level whose cell still has room. That is what gives the
      // scheduler something to draw before the fine tiles arrive — with every
      // point at max depth there is no coarse representation, so showing the
      // whole scan would mean loading the whole scan, which is the memory wall
      // this indexer exists to remove.
      //
      // The octant path makes the ancestor walk free: the level-d cell of a leaf
      // path is its first d characters, so no extra geometry is computed. When
      // every level is full the deepest takes the overflow, so no point is ever
      // dropped and conservation holds exactly.
      const leafKey = grid.leafKeyFor(x, y, z);
      let key = leafKey;
      for (let d = 0; d <= grid.depth; d++) {
        const candidate = d === grid.depth ? leafKey : leafKey.slice(0, d);
        const filled = occupancy.get(candidate) ?? 0;
        if (filled < nodeCapacity || d === grid.depth) {
          occupancy.set(candidate, filled + 1);
          key = candidate;
          break;
        }
      }
      let buf = buffers.get(key);
      if (buf === undefined) {
        buf = new LeafBuffer();
        buffers.set(key, buf);
      }
      let record: Uint8Array;
      if (batch.records) {
        record = batch.records.subarray(i * rb, i * rb + rb);
      } else {
        scratch[0] = x;
        scratch[1] = y;
        scratch[2] = z;
        record = scratchBytes;
      }
      buf.append(record);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      buffered += rb;
      if (buffered > peakBufferedBytes) peakBufferedBytes = buffered;
      // Bound residency to the budget: spill everything once it is reached, so
      // the high-water mark is the budget plus at most the record that tipped it.
      if (buffered >= budget) await flush();
    }
  }
  await flush();
  if (recordBytes === -1) recordBytes = POSITION_RECORD_BYTES;

  const leaves: OocLeaf[] = [...counts.entries()]
    .map(([key, pointCount]) => ({ key, pointCount }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return {
    grid,
    depth: grid.depth,
    pointCount: count,
    bounds: { min, max },
    leaves,
    recordBytes,
    peakBufferedBytes,
  };
}
