/**
 * opfsStoreJanitor.ts — sweep out-of-core stores a crashed session left behind.
 *
 * The out-of-core heavy-LAS store is temporary: a live session builds it,
 * streams from it, and removes it when the source closes. But a tab or worker
 * that dies mid-build, or one whose close-time removal fails, leaves an
 * `ooc-…` or `<name>.partial` directory the size of the scan in OPFS, and
 * nothing ever comes back for it. Once store names are unique per open (see
 * `heavyLasExecutor.ts`), a name can no longer be reclaimed by chance on the
 * next open of the same file, so an explicit janitor is the only thing that
 * frees the disk.
 *
 * This sweep is deliberately conservative, and narrower still since the
 * cross-tab data-loss risk was found. It sweeps ONLY abandoned `<name>.partial`
 * stores — a half-built directory a crashed tab left mid-build — and never a
 * promoted final `ooc-…` store. A store is removed only when it is a partial,
 * its lease marker (`STORE_LEASE_FILE`, written at build time) is older than a
 * safe threshold, AND it is not in the set a live session says it owns. A store
 * whose age it cannot read is KEPT, never guessed at, so a partial a running
 * build is still filling is never swept out from under it. That is the failure
 * it must never have.
 *
 * WHY PROMOTED STORES ARE LEFT ALONE. A promoted `ooc-…` store is a finished
 * dataset another tab may still have open and be streaming from. The lease
 * records CREATION time, not last use, and ownership is known only for THIS tab,
 * so a promoted store a second tab has legitimately kept open past the threshold
 * looks identical to an abandoned one — sweeping it deletes live data out from
 * under that tab. There is no cross-tab ownership signal yet, so promoted stores
 * are never swept automatically. A `.partial` this old, by contrast, is a build
 * that stopped mid-flight: nothing promotes it, no reader opens it, and it only
 * costs disk, so reclaiming it is safe.
 *
 * PROMOTED STORES ARE NOW SWEPT SEPARATELY. That liveness mechanism exists (Web
 * Locks residency, `oocStoreLiveness.ts`), so {@link sweepPromotedOrphans}
 * reclaims a promoted store when it is neither referenced by the persistent
 * cache map nor held open by any live tab — and only when its lease is old, so a
 * store another tab just promoted but has not yet recorded is left alone. The
 * conservative `.partial`-only sweep below is unchanged; the two run side by
 * side. When liveness is unavailable the promoted sweep does not run at all, so
 * an in-use store is never mistaken for an orphan.
 *
 * It runs against the structural {@link OpfsDirHandle}, so it is unit-tested in
 * Node against `tests/support/fakeOpfs.ts` exactly like the spill store.
 */
import {
  PARTIAL_SUFFIX,
  STORE_LEASE_FILE,
  removeOpfsStore,
  readOpfsText,
  type OpfsDirHandle,
} from './opfsSpillStore';
import { CACHE_MAP_FILE } from './oocCacheMap';

/** The prefix every out-of-core temp store name carries. */
export const OOC_STORE_PREFIX = 'ooc-';

/**
 * How old a store's lease must be before the janitor will remove it. Six hours
 * is far beyond any single build and well beyond a normal viewing session, so a
 * store this old is almost certainly abandoned rather than in use.
 */
export const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000;

export interface OocJanitorOptions {
  /** The wall clock to compare a lease against. Defaults to `Date.now()`. */
  readonly now?: number;
  /** Minimum lease age before a store may be swept. Defaults to {@link DEFAULT_STALE_MS}. */
  readonly staleMs?: number;
  /**
   * Store names a live session owns and the janitor must not touch, even if
   * their lease is old. Names are the top-level directory names under the root
   * (`ooc-…` or `<name>.partial`).
   */
  readonly ownedNames?: ReadonlySet<string>;
  readonly debug?: boolean;
}

/**
 * Whether a top-level name is a sweepable store: an abandoned build partial.
 *
 * Only `<name>.partial` directories are sweepable. A promoted final `ooc-…`
 * store is deliberately excluded — it may be a live dataset another tab still
 * owns, and there is no cross-tab ownership signal to tell that apart from an
 * abandoned one (see the header). A partial this scheme reaches is a build that
 * stopped: nothing promotes it and no reader opens it.
 */
function isSweepablePartial(name: string): boolean {
  return name.endsWith(PARTIAL_SUFFIX);
}

/**
 * Read a store's lease timestamp, or null when it cannot be read.
 *
 * A missing, unreadable or malformed lease returns null, which the sweep treats
 * as "unknown age, keep": the janitor removes only what it can prove is stale,
 * so an unreadable lease is always the safe side.
 */
export async function readStoreLease(dir: OpfsDirHandle): Promise<number | null> {
  let text: string;
  try {
    text = await readOpfsText(dir, STORE_LEASE_FILE);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as { createdAt?: unknown };
    const createdAt = parsed.createdAt;
    if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;
    return createdAt;
  } catch {
    return null;
  }
}

/**
 * Sweep abandoned out-of-core build partials under `root`, returning the names
 * removed.
 *
 * A store is removed only when it is a `<name>.partial`, not owned by a live
 * session, and its lease is older than the stale threshold. Promoted final
 * `ooc-…` stores are never swept — they may be live data another tab owns (see
 * the header). Anything the janitor cannot prove stale — no lease, an unreadable
 * lease, a lease younger than the threshold — is left in place. A removal that
 * itself fails is logged (in debug) and skipped rather than aborting the sweep,
 * so one stuck store does not block the rest.
 */
export async function sweepAbandonedOocStores(
  root: OpfsDirHandle,
  options: OocJanitorOptions = {},
): Promise<string[]> {
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const owned = options.ownedNames ?? new Set<string>();

  const candidates: string[] = [];
  for await (const name of root.keys()) {
    if (isSweepablePartial(name) && !owned.has(name)) candidates.push(name);
  }

  const removed: string[] = [];
  for (const name of candidates) {
    let dir: OpfsDirHandle;
    try {
      dir = await root.getDirectoryHandle(name);
    } catch {
      // Not a directory (or gone between listing and open); nothing to sweep.
      continue;
    }
    const createdAt = await readStoreLease(dir);
    if (createdAt === null) continue; // Unknown age — keep.
    if (now - createdAt < staleMs) continue; // Too young — keep.
    try {
      await removeOpfsStore(root, name);
      removed.push(name);
    } catch (err) {
      if (options.debug) console.warn('[ooc-janitor] could not remove stale store', name, err);
    }
  }
  return removed;
}

/**
 * Whether a top-level name is a PROMOTED final store: an `ooc-…` directory that
 * is not a build partial and not the cache-map record. These are the finished
 * indices the persistent cache keeps.
 */
function isPromotedStore(name: string): boolean {
  return (
    name.startsWith(OOC_STORE_PREFIX) && !name.endsWith(PARTIAL_SUFFIX) && name !== CACHE_MAP_FILE
  );
}

/**
 * The promoted stores that are orphans: neither referenced by the cache map nor
 * held open by any live tab. A referenced store is the cache and is kept; a live
 * store is in use and must never be deleted from under the tab that holds it.
 */
export function selectOrphanPromoted(
  names: readonly string[],
  referenced: ReadonlySet<string>,
  live: ReadonlySet<string>,
): string[] {
  return names.filter(
    (name) => isPromotedStore(name) && !referenced.has(name) && !live.has(name),
  );
}

export interface PromotedSweepOptions {
  /** Store names the cache map points at — the cache; never swept. */
  readonly referenced: ReadonlySet<string>;
  /** Store names a live tab holds open (from Web Locks); never swept. */
  readonly live: ReadonlySet<string>;
  readonly now?: number;
  readonly staleMs?: number;
  readonly debug?: boolean;
}

/**
 * Sweep promoted `ooc-…` stores that no longer belong to anything: not in the
 * cache map, not held by a live tab, and — the race guard — with a lease older
 * than the stale threshold, so a store another tab just promoted but has not yet
 * recorded or locked is left alone. This is the sweep the header once listed as
 * future work; it is safe now that the map names the cache and Web Locks name
 * the live stores. The caller supplies both sets and must NOT call this when
 * liveness is unavailable, or an in-use store could read as an orphan.
 */
export async function sweepPromotedOrphans(
  root: OpfsDirHandle,
  options: PromotedSweepOptions,
): Promise<string[]> {
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const names: string[] = [];
  for await (const name of root.keys()) names.push(name);

  const removed: string[] = [];
  for (const name of selectOrphanPromoted(names, options.referenced, options.live)) {
    let dir: OpfsDirHandle;
    try {
      dir = await root.getDirectoryHandle(name);
    } catch {
      continue;
    }
    const createdAt = await readStoreLease(dir);
    if (createdAt === null) continue; // Unknown age — keep.
    if (now - createdAt < staleMs) continue; // Fresh — a just-promoted store; keep.
    try {
      await removeOpfsStore(root, name);
      removed.push(name);
    } catch (err) {
      if (options.debug) console.warn('[ooc-janitor] could not remove orphan store', name, err);
    }
  }
  return removed;
}

/**
 * Resolve the OPFS root and sweep, for a one-line startup call site.
 *
 * A platform without OPFS has nothing to sweep and resolves to an empty list.
 * The caller passes the same live-owned set the application tracks so an in-use
 * store is never removed. This is the function a startup wiring point calls; it
 * is kept separate from {@link sweepAbandonedOocStores} so the sweep itself
 * stays pure and testable without a navigator.
 */
export async function runStartupOocJanitor(
  options: OocJanitorOptions & { getOpfsRoot?: () => Promise<OpfsDirHandle | null> } = {},
): Promise<string[]> {
  const getOpfsRoot = options.getOpfsRoot ?? defaultGetOpfsRoot;
  const root = await getOpfsRoot();
  if (root === null) return [];
  return sweepAbandonedOocStores(root, options);
}

/** The live OPFS root, or null where the platform has no OPFS. */
async function defaultGetOpfsRoot(): Promise<OpfsDirHandle | null> {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') {
    return null;
  }
  try {
    return (await navigator.storage.getDirectory()) as unknown as OpfsDirHandle;
  } catch {
    return null;
  }
}
