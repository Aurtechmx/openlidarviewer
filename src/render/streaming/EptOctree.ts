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
  // Resumable-walk state: the frontier of hierarchy files still to fetch and the
  // running file count, persisted so an initial (first-paint) load can stop at a
  // budget and a later `continueHierarchy` picks up from exactly where it left.
  private _frontier: EptKey[] | null = null;
  private _filesLoaded = 0;

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
   * Load the whole hierarchy up front, ingesting every node. Kept for callers
   * that want the complete index before rendering (small datasets, tests).
   */
  async loadFullHierarchy(signal?: AbortSignal): Promise<void> {
    await this._walkHierarchy(MAX_HIERARCHY_FILES, signal);
  }

  /**
   * Load just enough hierarchy to render coarse geometry, then return so the
   * scan can attach. The root file alone carries the shallow LODs that span the
   * whole extent, so a handful of files is a full coarse octree. A
   * multi-billion-point EPT links to thousands of sub-files, and fetching all of
   * them before first paint took minutes of apparent hang; the rest arrive
   * through {@link continueHierarchy}. A small dataset whose entire hierarchy
   * fits inside `firstPaintFiles` finishes here — identical to a full load.
   */
  async loadInitialHierarchy(firstPaintFiles: number, signal?: AbortSignal): Promise<void> {
    await this._walkHierarchy(Math.max(1, firstPaintFiles), signal);
  }

  /**
   * Resume the walk to completion after an initial paint. The scheduler reads
   * `store.all()` every tick, so nodes become selectable as they land and the
   * cloud refines from coarse to full detail in the background.
   */
  async continueHierarchy(signal?: AbortSignal): Promise<void> {
    await this._walkHierarchy(MAX_HIERARCHY_FILES, signal);
  }

  /**
   * Breadth-first hierarchy walk, resumable across calls: it consumes at most
   * `fileBudget` files total (counting files already fetched by earlier calls),
   * persisting the frontier and file count so a later call continues from the
   * exact point this one stopped.
   *
   * Concurrency: the original walk fetched each file serially with `await`; a
   * deep public EPT (Grand Canyon 22B pts, LA 75B pts) carries 8–32 files in a
   * wave, so serialising dominated first paint. Fetching a wave 8 at a time
   * (the USGS S3 endpoints speak HTTP/2) brings each wave to roughly one RTT.
   */
  private async _walkHierarchy(fileBudget: number, signal?: AbortSignal): Promise<void> {
    if (this._fullyLoaded) return;
    if (this._frontier === null) this._frontier = [{ d: 0, x: 0, y: 0, z: 0 }];
    const cap = Math.min(fileBudget, MAX_HIERARCHY_FILES);
    const PER_WAVE_CONCURRENCY = 8;

    while (this._frontier.length > 0 && this._filesLoaded < cap) {
      // Pick this wave's new files, stopping at the budget. Entries left unfetched
      // (already loaded, or beyond the budget) stay on the frontier for later.
      const toFetch: EptKey[] = [];
      for (const fileKey of this._frontier) {
        if (signal?.aborted) throw new Error('EPT hierarchy load aborted');
        const fileId = eptKeyToString(fileKey);
        if (this._loadedFiles.has(fileId)) continue;
        if (this._filesLoaded + toFetch.length >= cap) break;
        toFetch.push(fileKey);
      }

      // Fetch the wave in fixed-concurrency batches. A failure within a batch
      // doesn't abort the rest of the wave — it accumulates in `_errors`.
      const fetched: { fileId: string; text: string }[] = [];
      for (let i = 0; i < toFetch.length; i += PER_WAVE_CONCURRENCY) {
        const batch = toFetch.slice(i, i + PER_WAVE_CONCURRENCY);
        const results = await Promise.all(
          batch.map(async (fileKey): Promise<{ fileId: string; text: string } | null> => {
            if (signal?.aborted) return null;
            const fileId = eptKeyToString(fileKey);
            try {
              const text = await this._fetcher(fileKey, signal);
              return { fileId, text };
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
        for (const r of results) if (r) fetched.push(r);
        if (signal?.aborted) throw new Error('EPT hierarchy load aborted');
      }

      // Parse + ingest, collecting the ids ingested this wave. Their parents are
      // in earlier waves (shallower files) or this wave, so linking after every
      // node in the wave is ingested keeps child lists correct at each pause
      // point without an O(N) rebuild per wave.
      const next: EptKey[] = [];
      const ingested: string[] = [];
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
        this._filesLoaded++;
        // NODE entries become nodes; link entries (`value === -1`) name the next
        // sub-file to fetch — not nodes themselves.
        for (const entry of parsed.nodes) {
          const id = this._ingestNode(entry);
          if (id) ingested.push(id);
        }
        for (const link of parsed.links) next.push(link.key);
      }
      this._linkToParents(ingested);

      // Drop every file we ATTEMPTED this round — not just the ones that loaded.
      // A fetch or parse failure leaves a file out of `_loadedFiles`, and if such
      // a file stayed on the frontier it would be retried every iteration while
      // `_filesLoaded` never advanced: an infinite loop that allocates until the
      // heap dies (the original walk avoided this by discarding the whole
      // frontier each round). Attempted-and-failed files surface in `_errors`,
      // exactly as before; only files beyond the budget stay for a later call.
      const attempted = new Set(toFetch.map((k) => eptKeyToString(k)));
      this._frontier = this._frontier.filter((k) => {
        const id = eptKeyToString(k);
        // Keep only files still worth fetching: not attempted this round (success
        // or failure) and not already loaded by an earlier one. Anything else
        // would spin the loop without advancing.
        return !attempted.has(id) && !this._loadedFiles.has(id);
      });
      this._frontier.push(...next);
    }

    if (this._filesLoaded >= MAX_HIERARCHY_FILES && this._frontier.length > 0) {
      this._errors.push(`EPT hierarchy exceeded ${MAX_HIERARCHY_FILES} files — stopped`);
      this._frontier = [];
    }
    if (this._frontier.length === 0) this._fullyLoaded = true;
  }

  /** Add one EPT hierarchy node to the store as a {@link StreamingNodeRecord}. */
  private _ingestNode(entry: EptHierarchyEntry): string | undefined {
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
      return undefined;
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
    return record.id;
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
   * Link the given just-ingested nodes into their parents' `childIds` so the
   * scheduler can refine top-down. Called once per wave with only that wave's
   * nodes; a node's parent is always shallower — an earlier wave, or ingested
   * earlier in this same wave — so it is already in the store. Each node links
   * exactly once (it appears in one wave), so no child is duplicated even across
   * the progressive initial + continue passes. Mirrors the COPC
   * StreamingOctree child-link contract, made incremental.
   */
  private _linkToParents(ids: readonly string[]): void {
    for (const id of ids) {
      const node = this.store.get(id);
      if (!node) continue;
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
