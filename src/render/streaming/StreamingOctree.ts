/**
 * StreamingOctree.ts
 *
 * The COPC octree over a {@link StreamingNodeStore}. It ingests hierarchy
 * pages (the small, index-only structure — never point data) into the store
 * and resolves parent/child links.
 *
 * `loadFullHierarchy` walks every child hierarchy page once. The hierarchy is
 * an index of 32-byte entries — tens of KB even for a multi-gigabyte cloud —
 * so loading it whole is cheap and is *not* full-file loading: the point data
 * is what the scheduler streams, node by node.
 *
 * Pure of three.js; async only through the {@link CopcSource} range reads.
 */

import type { CopcSource } from '../../io/copc/CopcSource';
import type { HierarchyPage } from '../../io/copc/copcHierarchy';
import { StreamingNodeStore } from './StreamingNodeStore';
import type { StreamingNode } from './StreamingNode';

/** A hard cap on hierarchy pages, so a malformed file cannot loop forever. */
const MAX_HIERARCHY_PAGES = 4096;

/** The octree of a COPC file — its node store and hierarchy ingestion. */
export class StreamingOctree {
  readonly store = new StreamingNodeStore();
  private readonly _source: CopcSource;
  private readonly _loadedPageOffsets = new Set<number>();
  private readonly _errors: string[] = [];
  private _fullyLoaded = false;

  constructor(source: CopcSource) {
    this._source = source;
    this._ingestPage(source.rootPage, source.metadata.info.rootHierOffset);
  }

  /** Hierarchy parse errors collected across every page — for diagnostics. */
  get errors(): string[] {
    return this._errors;
  }

  /** Whether the whole hierarchy index has been loaded. */
  get fullyLoaded(): boolean {
    return this._fullyLoaded;
  }

  /** Every known node. */
  nodes(): StreamingNode[] {
    return this.store.all();
  }

  /** The octree root nodes (depth 0 — normally exactly one). */
  rootNodes(): StreamingNode[] {
    return this.store.all().filter((n) => n.record.key.depth === 0);
  }

  /** The resolved child nodes of a node. */
  childrenOf(node: StreamingNode): StreamingNode[] {
    const out: StreamingNode[] = [];
    for (const id of node.childIds) {
      const child = this.store.get(id);
      if (child) out.push(child);
    }
    return out;
  }

  /**
   * Load every child hierarchy page, breadth-first, into the store, then
   * resolve parent/child links. Safe against cycles (a page offset is loaded
   * at most once) and against a runaway page count.
   */
  async loadFullHierarchy(signal?: AbortSignal): Promise<void> {
    if (this._fullyLoaded) return;

    let frontier = this._source.rootPage.childPages.slice();
    let pagesLoaded = 1; // the root page

    while (frontier.length > 0) {
      const next: typeof frontier = [];
      for (const ref of frontier) {
        if (signal?.aborted) throw new Error('Hierarchy load aborted');
        if (this._loadedPageOffsets.has(ref.pageOffset)) continue;
        if (pagesLoaded >= MAX_HIERARCHY_PAGES) {
          this._errors.push(`hierarchy exceeded ${MAX_HIERARCHY_PAGES} pages — stopped`);
          frontier = [];
          break;
        }
        let page: HierarchyPage;
        try {
          page = await this._source.loadChildPage(ref, signal);
        } catch (err) {
          this._errors.push(
            `failed to load hierarchy page at ${ref.pageOffset}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          continue;
        }
        pagesLoaded++;
        this._ingestPage(page, ref.pageOffset);
        next.push(...page.childPages);
      }
      frontier = next;
    }

    this._resolveChildLinks();
    this._fullyLoaded = true;
  }

  /** Add a page's data nodes to the store and record its parse errors. */
  private _ingestPage(page: HierarchyPage, pageOffset: number): void {
    this._loadedPageOffsets.add(pageOffset);
    for (const record of page.nodes) this.store.add(record);
    for (const err of page.errors) this._errors.push(err);
  }

  /** After all nodes are in, link each node into its parent's `childIds`. */
  private _resolveChildLinks(): void {
    for (const node of this.store.all()) {
      const parentId = node.record.parentId;
      if (parentId === undefined) continue;
      const parent = this.store.get(parentId);
      if (parent && !parent.childIds.includes(node.record.id)) {
        parent.childIds.push(node.record.id);
      }
    }
  }
}
