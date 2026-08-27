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
 * What a trusted source header declares up front: the point count and the
 * axis-aligned bounds. Both MUST be expressed in the same frame and numeric
 * precision as the `positions` the batches yield (for the LAS path that is the
 * origin-relative, Float32-rounded frame), so the grid a header builds is the
 * grid a measuring pass would build. A header that is off by any amount that
 * changes the grid is caught and the build falls back to the two-pass path, so
 * an honest-but-imprecise or malformed header is still correct, only slower.
 */
export interface SourceHeader {
  readonly pointCount: number;
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/**
 * A point source the indexer can read TWICE. `batches()` must yield the same
 * points on every call — the bounds pass and the bucketing pass both consume it,
 * and a source that changed between them would place points against stale bounds.
 *
 * A source that also exposes a trusted {@link SourceHeader} lets the indexer skip
 * the bounds pass and build in ONE pass; see {@link indexOutOfCore}.
 */
export interface PointSource {
  batches(signal?: AbortSignal): AsyncGenerator<PositionBatch>;
  /** Optional trusted count and bounds that enable a single-pass build. */
  readonly header?: SourceHeader;
}

/** Where leaf tiles are spilled. A memory map in tests, an OPFS directory in the browser. */
export interface SpillStore {
  /** Append `bytes` to the tile for `key`. Called many times per key across flushes. */
  append(key: string, bytes: Uint8Array): Promise<void>;
  /** The full tile for `key`. */
  read(key: string): Promise<Uint8Array>;
  /** Every key written so far. */
  keys(): Promise<string[]>;
  /**
   * Drop every spilled tile, returning the store to empty. Optional: the
   * single-pass fast path only runs on a store that can be cleared, because a
   * header it later finds untrustworthy has to be rolled back before the two-pass
   * path re-spills. A store without `clear` always takes the two-pass path.
   */
  clear?(): Promise<void>;
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
  /**
   * Force the two-pass path even when the source header would allow one pass.
   * The build is identical either way for a valid header; this exists so a test
   * can run both paths on one fixture and compare, and as an escape hatch.
   */
  readonly forceSlowPath?: boolean;
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

/** Raised inside the fast pass when a point escapes the header's declared root. */
class HeaderBoundsExceeded extends Error {}

/**
 * A header is usable for the single-pass build only if it names a finite count
 * of at least one point and a finite, non-degenerate box. A zero-extent box (a
 * single point, or an empty cloud) has no grid to build, so it takes two passes.
 */
function usableHeader(header: SourceHeader | undefined): SourceHeader | undefined {
  if (!header) return undefined;
  if (!Number.isFinite(header.pointCount) || header.pointCount < 1) return undefined;
  for (let a = 0; a < 3; a++) {
    if (!Number.isFinite(header.min[a]) || !Number.isFinite(header.max[a])) return undefined;
    if (header.max[a] < header.min[a]) return undefined;
  }
  const extent = Math.max(
    header.max[0] - header.min[0],
    header.max[1] - header.min[1],
    header.max[2] - header.min[2],
  );
  return extent > 0 ? header : undefined;
}

/** Two grids place points identically iff their root cube and depth match. */
function gridsMatch(a: OctreeGrid, b: OctreeGrid): boolean {
  return (
    a.depth === b.depth &&
    a.root.size === b.root.size &&
    a.root.min[0] === b.root.min[0] &&
    a.root.min[1] === b.root.min[1] &&
    a.root.min[2] === b.root.min[2]
  );
}

/**
 * Index a point source into a spilled octree.
 *
 * The default build reads the source twice: pass one takes the bounds and count
 * that fix the {@link OctreeGrid}, pass two buckets every point into its leaf.
 * When the source exposes a trusted {@link PointSource.header} — a finite count
 * and a non-degenerate box — and the store can be cleared, the bounds pass is
 * skipped and the grid is built from the header, halving the decode work on a
 * large file.
 *
 * The fast path is fenced so a wrong header can never ship a wrong index. It
 * tracks the bounds it actually sees; a point outside the declared root aborts
 * the pass at once, and even a box that merely contains the cloud is rejected
 * unless the grid it builds is the same grid the measured bounds would build. On
 * any rejection the spilled tiles are cleared and the build re-enters its own
 * two-pass path from the start, so a malformed or imprecise header is still
 * correct, only slower. For a header that is exact, the one-pass and two-pass
 * indexes are byte-for-byte identical: same nodes, per-node counts, tile bytes,
 * and manifest.
 *
 * The bucketing loop lives inline here, and the fallback is a re-entry with
 * {@link IndexOptions.forceSlowPath}, so the single `.positions` read stays one
 * classified source-local site rather than splitting across a helper.
 */
export async function indexOutOfCore(
  source: PointSource,
  store: SpillStore,
  options: IndexOptions = {},
): Promise<OocIndex> {
  const signal = options.signal;
  const pointsPerLeaf = Math.max(1, options.pointsPerLeaf ?? DEFAULT_POINTS_PER_LEAF);
  const budget = Math.max(POSITION_RECORD_BYTES, options.memoryBudgetBytes ?? DEFAULT_MEMORY_BUDGET);

  // The fast path spills before it can prove the header, so it must be able to
  // undo that if the header proves false: it runs only on a clearable store.
  const header = options.forceSlowPath ? undefined : usableHeader(source.header);
  const track = !!(header && typeof store.clear === 'function');

  // The grid is fixed up front: from the header on the fast path, from a bounds
  // pass otherwise. `bounds`/`count` are what the slow path returns; the fast
  // path overwrites them with what it observes, which for an exact header equals
  // these anyway.
  let grid: OctreeGrid;
  let min: [number, number, number];
  let max: [number, number, number];
  let count: number;
  if (track && header) {
    grid = octreeGridFor(header.min, header.max, header.pointCount, pointsPerLeaf, options.maxDepth);
    min = [Infinity, Infinity, Infinity];
    max = [-Infinity, -Infinity, -Infinity];
    count = 0;
  } else {
    ({ min, max, count } = await scanBounds(source, signal));
    grid = octreeGridFor(min, max, count, pointsPerLeaf, options.maxDepth);
  }

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

  // The root cube the fast path holds every point to.
  const loX = grid.root.min[0];
  const loY = grid.root.min[1];
  const loZ = grid.root.min[2];
  const hiX = loX + grid.root.size;
  const hiY = loY + grid.root.size;
  const hiZ = loZ + grid.root.size;
  let escaped = false; // a fast-path point left the declared root

  try {
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
        if (track) {
          count++;
          if (x < min[0]) min[0] = x;
          if (x > max[0]) max[0] = x;
          if (y < min[1]) min[1] = y;
          if (y > max[1]) max[1] = y;
          if (z < min[2]) min[2] = z;
          if (z > max[2]) max[2] = z;
          // The header promised this box. A point outside it means the header
          // lied; do not let leafKeyFor clamp it into an edge leaf and ship a
          // silently misplaced point. Abort now and let the rebuild take over.
          if (x < loX || x > hiX || y < loY || y > hiY || z < loZ || z > hiZ) {
            throw new HeaderBoundsExceeded();
          }
        }
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
  } catch (err) {
    if (!(err instanceof HeaderBoundsExceeded)) throw err;
    escaped = true;
  }

  if (track) {
    // Keep the fast build only if the box held every point AND the grid the
    // observed bounds and count would build is the SAME grid — only then is this
    // layout the two-pass path's layout. A looser box or an off count builds a
    // different, still-valid tree, which is not identity, so rebuild instead.
    const measuredGrid = escaped
      ? grid
      : octreeGridFor(min, max, count, pointsPerLeaf, options.maxDepth);
    if (!escaped && gridsMatch(measuredGrid, grid)) {
      if (recordBytes === -1) recordBytes = POSITION_RECORD_BYTES;
      return assembleIndex(grid, count, min, max, counts, recordBytes, peakBufferedBytes);
    }
    // Untrustworthy header: drop the fast tiles and rebuild in two passes.
    await store.clear!();
    return indexOutOfCore(source, store, { ...options, forceSlowPath: true });
  }

  if (recordBytes === -1) recordBytes = POSITION_RECORD_BYTES;
  return assembleIndex(grid, count, min, max, counts, recordBytes, peakBufferedBytes);
}

/** Assemble the sorted leaf list and the returned index from a finished pass. */
function assembleIndex(
  grid: OctreeGrid,
  count: number,
  min: [number, number, number],
  max: [number, number, number],
  counts: Map<string, number>,
  recordBytes: number,
  peakBufferedBytes: number,
): OocIndex {
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
