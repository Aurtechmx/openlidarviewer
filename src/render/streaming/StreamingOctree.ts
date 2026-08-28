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

/**
 * The named reason pushed into {@link StreamingOctree.errors} when the resolved
 * hierarchy's point total does not equal the LAS header's declared count. A
 * consumer greps for this to tell a count gap apart from a fetch/parse error.
 */
export const POINT_COUNT_MISMATCH = 'POINT_COUNT_MISMATCH';

/**
 * The outcome of reconciling the LAS header's declared point total against the
 * sum of the resolved hierarchy's per-node counts.
 *
 * - `EXACT`   — the hierarchy is fully resolved AND its counts sum to the header.
 * - `MISMATCH` — fully resolved, but the sums disagree (a page/subtree is missing
 *   or the file's own totals are inconsistent).
 * - `UNKNOWN` — the hierarchy is not yet fully resolved, so no verdict is possible.
 */
export type PointTotalStatus = 'EXACT' | 'MISMATCH' | 'UNKNOWN';

/** A declared-vs-resolved point-total comparison. */
export interface PointTotalReconciliation {
  readonly status: PointTotalStatus;
  /** The LAS header's declared point count. */
  readonly declared: number;
  /** The sum of the resolved hierarchy's per-node point counts. */
  readonly resolved: number;
}

/**
 * Compare a declared total (LAS header) against a resolved hierarchy total.
 * Until the hierarchy is fully resolved the resolved sum is still growing, so
 * the only honest verdict is `UNKNOWN` — never `EXACT`.
 */
export function reconcilePointTotals(
  declared: number,
  resolved: number,
  hierarchyResolved: boolean,
): PointTotalReconciliation {
  if (!hierarchyResolved) return { status: 'UNKNOWN', declared, resolved };
  return { status: declared === resolved ? 'EXACT' : 'MISMATCH', declared, resolved };
}

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

  /**
   * Whether the hierarchy index is KNOWN-COMPLETE: the walk terminated (see
   * {@link fullyLoaded}) AND it dropped nothing. `fullyLoaded` alone only says
   * the breadth-first walk stopped — it is set true even when the walk stopped
   * because it hit the {@link MAX_HIERARCHY_PAGES} ceiling, swallowed a page
   * fetch failure, or skipped a malformed entry. Each of those pushes into
   * {@link errors} and leaves whole subtrees out of the store, so a grade that
   * decodes every node it can see still covers less than the file. Consumers
   * that must not overclaim completeness (the full-cloud grade's "exact" label)
   * gate on THIS, not on `fullyLoaded`.
   */
  get isComplete(): boolean {
    return (
      this._fullyLoaded &&
      this._errors.length === 0 &&
      this.pointTotals.status === 'EXACT'
    );
  }

  /**
   * The declared (LAS header) vs resolved (Σ hierarchy node counts) point-total
   * reconciliation. Reads `UNKNOWN` until the hierarchy is fully resolved, then
   * `EXACT` or `MISMATCH`. A consumer that needs scientific completeness (the
   * full-cloud grade's "exact" label) requires `EXACT`.
   */
  get pointTotals(): PointTotalReconciliation {
    return reconcilePointTotals(
      this._source.metadata.header.pointCount,
      this._resolvedPointCount(),
      this._fullyLoaded,
    );
  }

  /** Sum of every resolved node's declared point count. */
  private _resolvedPointCount(): number {
    let total = 0;
    for (const node of this.store.all()) total += node.record.pointCount;
    return total;
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
        // Propagate the signal's own abort reason so the outcome stays
        // classifiable: a user cancel (`controller.abort()`) carries a
        // DOMException named `AbortError`, which `isAbortError` treats as a
        // silent cancellation; a signal aborted with a timeout reason carries a
        // distinct error that stays a visible failure. A plain `Error` here was
        // neither — it read as an ordinary load error, so a user cancel
        // surfaced as one. The fallback covers a signal aborted without a reason.
        if (signal?.aborted) {
          throw signal.reason ?? new DOMException('Hierarchy load aborted', 'AbortError');
        }
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

    // Reconcile the COPC partition invariant: Σ(node point counts) must equal
    // the LAS header's declared total. A hierarchy can walk to completion with
    // no fetch/parse error yet still sum short (a dropped subtree, an
    // inconsistent file), which no other check above would catch. Record the
    // gap as a named reason so `isComplete` goes false and a consumer can see
    // the declared/resolved totals rather than silently overclaiming "exact".
    const totals = this.pointTotals;
    if (totals.status === 'MISMATCH') {
      this._errors.push(
        `${POINT_COUNT_MISMATCH}: LAS header declares ${totals.declared} points but the resolved hierarchy sums to ${totals.resolved}`,
      );
    }
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
