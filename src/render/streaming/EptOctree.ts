/**
 * EptOctree.ts
 *
 * The EPT analogue of `StreamingOctree`. Builds the shared
 * {@link StreamingNodeStore} from EPT hierarchy files and exposes the
 * structural `StreamingOctreeView` interface the scheduler reads off
 * every streaming source.
 *
 * EPT hierarchy traversal:
 *   • The dataset's root hierarchy file always lives at
 *     `ept-hierarchy/0-0-0-0.json` — a JSON object keyed by `"D-X-Y-Z"`
 *     addresses, with values that are either a positive point count OR
 *     `-1` indicating "subtree continues in `ept-hierarchy/D-X-Y-Z.json`".
 *   • A small dataset fits entirely in the root file; a 100M+ dataset
 *     has hundreds of linked files reached on demand as the scheduler
 *     refines into deeper octree levels.
 *
 * Ships with a pre-loaded hierarchy walker (parallel to the COPC
 * loader): the root file plus every linked file are fetched up-front so
 * the node store is fully populated before streaming begins. This is
 * cheap (hierarchy bytes scale with node count, ~20 bytes per node) and
 * mirrors how `StreamingOctree.loadFullHierarchy()` behaves for COPC.
 *
 * Pure of three.js. Async only through the hierarchy-fetcher callback the
 * constructor takes (so the class is testable without a live HTTP stack).
 */

import { StreamingNodeStore } from './StreamingNodeStore';
import type { StreamingNode } from './StreamingNode';
import type { StreamingOctreeView } from './StreamingSource';
import type { Box6, StreamingNodeRecord, VoxelKey } from '../../io/copc/copcTypes';
import {
  eptChildKeys,
  parseHierarchyFile,
} from '../../io/ept/eptHierarchy';
import type { EptHierarchyEntry } from '../../io/ept/eptHierarchy';
import type { EptBounds, EptKey, EptMetadata } from '../../io/ept/eptTypes';
import { eptKeyToString } from '../../io/ept/eptTypes';

/**
 * Async callback the octree uses to fetch one hierarchy file by its key.
 * Returns the JSON text. The caller (EptStreamingPointCloud) owns the
 * actual HTTP fetch, retry, timeout, and cancellation — this class is
 * pure traversal.
 */
export type HierarchyFetcher = (
  key: EptKey,
  signal?: AbortSignal,
) => Promise<string>;

/** A hard cap on hierarchy files, mirroring COPC's MAX_HIERARCHY_PAGES guard. */
const MAX_HIERARCHY_FILES = 4096;

/**
 * Hard cap on EPT key depth. EPT keys are 32-bit signed; `x >> 1`
 * parent-key arithmetic wraps into negative space once `x` reaches
 * 2^31. The cap is set well below the wrap edge — practical Entwine
 * output rarely exceeds depth ~20, so this limit only kicks in for
 * pathological or malicious manifests.
 */
const MAX_EPT_DEPTH = 24;

export class EptOctree implements StreamingOctreeView {
  readonly store = new StreamingNodeStore();
  private readonly _meta: EptMetadata;
  /** EPT cube bounds in source-CRS space — used for per-node bounds derivation. */
  private readonly _cube: Box6;
  /** Render origin to subtract from per-node bounds before they hit the store. */
  private readonly _renderOrigin: readonly [number, number, number];
  private readonly _fetcher: HierarchyFetcher;
  private readonly _loadedFiles = new Set<string>();
  private readonly _errors: string[] = [];
  private _fullyLoaded = false;

  constructor(
    meta: EptMetadata,
    renderOrigin: readonly [number, number, number],
    fetcher: HierarchyFetcher,
  ) {
    this._meta = meta;
    this._cube = meta.bounds.cubic as Box6;
    this._renderOrigin = renderOrigin;
    this._fetcher = fetcher;
  }

  nodes(): StreamingNode[] {
    return this.store.all();
  }

  get errors(): readonly string[] {
    return this._errors;
  }

  get fullyLoaded(): boolean {
    return this._fullyLoaded;
  }

  /**
   * Load the root hierarchy file + every linked sub-file, ingesting all
   * nodes into the store. Mirrors `StreamingOctree.loadFullHierarchy`'s
   * breadth-first walk with cycle protection + a hard file-count cap.
   */
  async loadFullHierarchy(signal?: AbortSignal): Promise<void> {
    if (this._fullyLoaded) return;
    const rootKey: EptKey = { d: 0, x: 0, y: 0, z: 0 };
    let frontier: EptKey[] = [rootKey];
    let filesLoaded = 0;

    // Per-wave concurrency for hierarchy file fetches. The original
    // implementation walked the frontier with `await` in a `for` loop —
    // serialising every file in the wave. For deep public EPT datasets
    // (Grand Canyon 22B pts, LA 75B pts) a single wave can carry 8–32
    // files and a wave at depth 4–6 dominates first-paint by several
    // seconds at typical home-broadband RTTs. Parallelising the wave
    // brings each one down to roughly one RTT.
    //
    // The cap (8) was bumped from 6 in v0.3.6 — the public USGS S3
    // endpoints all speak HTTP/2, which multiplexes far more than the
    // legacy HTTP/1.1 per-origin limit. 8 concurrent gives good
    // first-paint throughput without saturating slow connections.
    const PER_WAVE_CONCURRENCY = 8;

    while (frontier.length > 0) {
      const next: EptKey[] = [];

      // Filter the wave to new files only, respecting the global cap.
      const toFetch: EptKey[] = [];
      for (const fileKey of frontier) {
        if (signal?.aborted) throw new Error('EPT hierarchy load aborted');
        const fileId = eptKeyToString(fileKey);
        if (this._loadedFiles.has(fileId)) continue;
        if (filesLoaded + toFetch.length >= MAX_HIERARCHY_FILES) {
          this._errors.push(
            `EPT hierarchy exceeded ${MAX_HIERARCHY_FILES} files — stopped`,
          );
          break;
        }
        toFetch.push(fileKey);
      }

      // Fetch the wave in fixed-concurrency batches. Each batch resolves
      // in ~1 RTT instead of N. Failures within a batch don't abort the
      // rest of the wave — they accumulate in `_errors` exactly as
      // before.
      const fetched: { fileKey: EptKey; fileId: string; text: string }[] = [];
      for (let i = 0; i < toFetch.length; i += PER_WAVE_CONCURRENCY) {
        const batch = toFetch.slice(i, i + PER_WAVE_CONCURRENCY);
        const results = await Promise.all(
          batch.map(async (fileKey): Promise<{ fileKey: EptKey; fileId: string; text: string } | null> => {
            if (signal?.aborted) return null;
            const fileId = eptKeyToString(fileKey);
            try {
              const text = await this._fetcher(fileKey, signal);
              return { fileKey, fileId, text };
            } catch (err) {
              this._errors.push(
                `EPT hierarchy fetch failed at ${fileId}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
              return null;
            }
          }),
        );
        for (const r of results) {
          if (r) fetched.push(r);
        }
        if (signal?.aborted) throw new Error('EPT hierarchy load aborted');
      }

      // Parse + ingest in deterministic key order so the resulting node
      // store is identical to what the serial walk would have produced.
      for (const { fileId, text } of fetched) {
        let parsed;
        try {
          parsed = parseHierarchyFile(text);
        } catch (err) {
          this._errors.push(
            `EPT hierarchy parse failed at ${fileId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          continue;
        }
        this._loadedFiles.add(fileId);
        filesLoaded++;
        // Ingest every NODE entry — link entries (`value === -1`) just tell
        // us which sub-file to fetch next; they're not nodes themselves.
        for (const entry of parsed.nodes) this._ingestNode(entry);
        for (const link of parsed.links) next.push(link.key);
      }
      frontier = next;
    }

    this._resolveChildLinks();
    this._fullyLoaded = true;
  }

  /** Add one EPT hierarchy node to the store as a {@link StreamingNodeRecord}. */
  private _ingestNode(entry: EptHierarchyEntry): void {
    // Practical-depth guard. EPT keys are 32-bit signed; at d >= 31 the
    // `x >> 1` parent-key arithmetic wraps into negative space and parent
    // links misroute silently. Real-world Entwine output rarely exceeds
    // d ~= 20, so a hard cap below the wrap edge protects the octree
    // structure without rejecting any legitimate dataset.
    if (entry.key.d > MAX_EPT_DEPTH) {
      console.warn(
        `[ept] skipping node at depth ${entry.key.d} (cap ${MAX_EPT_DEPTH}) — ` +
          'the EPT hierarchy is deeper than the supported maximum.',
      );
      return;
    }
    const record: StreamingNodeRecord = {
      id: eptKeyToString(entry.key),
      key: this._toVoxelKey(entry.key),
      bounds: this._boundsForKey(entry.key),
      pointCount: entry.value,
      // EPT tiles are SEPARATE FILES, not byte ranges within one file.
      // The byte offsets / sizes don't apply; the streaming source's
      // readNodeChunk uses the node key to build the tile URL instead.
      byteOffset: 0,
      byteSize: 0,
      spacing: this._spacingForDepth(entry.key.d),
      parentId: this._parentIdOf(entry.key),
    };
    this.store.add(record);
  }

  /** EPT D-X-Y-Z address → COPC-style {depth,x,y,z} VoxelKey (identical shape). */
  private _toVoxelKey(k: EptKey): VoxelKey {
    return { depth: k.d, x: k.x, y: k.y, z: k.z };
  }

  /** The parent of `(d, x, y, z)` is `(d-1, x>>1, y>>1, z>>1)`; root has no parent. */
  private _parentIdOf(k: EptKey): string | undefined {
    if (k.d === 0) return undefined;
    return eptKeyToString({
      d: k.d - 1,
      x: k.x >> 1,
      y: k.y >> 1,
      z: k.z >> 1,
    });
  }

  /**
   * EPT per-depth spacing — the writer's `span` divided by `2^depth`. This
   * matches the heuristic the EPT spec recommends for client-side LOD
   * scoring; the scheduler uses it to weight refinement priority.
   */
  private _spacingForDepth(depth: number): number {
    if (depth === 0) return this._meta.span;
    return this._meta.span / Math.pow(2, depth);
  }

  /**
   * Compute the local-space (render-origin-subtracted) bounds of a node
   * given its EPT key. The octree cube at depth 0 is `cube`; at depth d
   * each side is `cube_side / 2^d`.
   */
  private _boundsForKey(k: EptKey): Box6 {
    const [minX, minY, minZ, maxX, maxY, maxZ] = this._cube;
    const sideX = (maxX - minX) / Math.pow(2, k.d);
    const sideY = (maxY - minY) / Math.pow(2, k.d);
    const sideZ = (maxZ - minZ) / Math.pow(2, k.d);
    const nMinX = minX + k.x * sideX;
    const nMinY = minY + k.y * sideY;
    const nMinZ = minZ + k.z * sideZ;
    const [rx, ry, rz] = this._renderOrigin;
    return [
      nMinX - rx,
      nMinY - ry,
      nMinZ - rz,
      nMinX + sideX - rx,
      nMinY + sideY - ry,
      nMinZ + sideZ - rz,
    ];
  }

  /**
   * After every node is in the store, link each one into its parent's
   * `childIds` so the scheduler can refine top-down. Mirrors the COPC
   * StreamingOctree._resolveChildLinks contract.
   */
  private _resolveChildLinks(): void {
    for (const node of this.store.all()) {
      const parentId = node.record.parentId;
      if (!parentId) continue;
      const parent = this.store.get(parentId);
      if (parent) parent.childIds.push(node.record.id);
    }
  }

  /** Convenience for tests — every child key under a parent, EPT-style. */
  static childKeysOf(parent: EptKey): readonly EptKey[] {
    return eptChildKeys(parent);
  }

  /** The cube bounds the octree spans, for diagnostics. */
  get cubicBounds(): EptBounds['cubic'] {
    return this._meta.bounds.cubic;
  }
}
