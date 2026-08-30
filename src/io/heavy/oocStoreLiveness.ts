/**
 * oocStoreLiveness.ts — cross-tab liveness for the persistent OOC cache.
 *
 * Phase 3, and the prerequisite for a stable store name. Today every open builds
 * a randomly-named store, so two tabs never share one and eviction is safe by
 * construction. A persistent cache keys the store by the file fingerprint, so two
 * tabs that open the same file share a store — and then eviction, or a rebuild in
 * place, must never touch a store another tab still has open.
 *
 * The signal is the Web Locks API. A tab holds a SHARED lock named after the
 * store for as long as it keeps that store open; many tabs can hold the same
 * shared lock at once. To ask "is anyone using store X" a caller requests an
 * EXCLUSIVE lock with `ifAvailable`: granted (non-null) means nobody holds it,
 * null means someone does. No polling, no heartbeat to expire — the browser drops
 * a tab's locks when the tab goes away.
 *
 * The one safety rule: when liveness cannot be determined — the API is absent —
 * a store reads as BUSY and the live-set is null. A missing signal can only ever
 * PREVENT an eviction, never cause a wrong one.
 *
 * The Web Locks manager is injected (the subset used is small), so the logic is
 * tested in Node against a fake; the browser passes `navigator.locks`.
 */

/** The Web Locks subset this module uses — so it can be faked in a test. */
export interface LockGrantLike {
  readonly name: string;
}
export interface LockRequestOptions {
  readonly mode?: 'exclusive' | 'shared';
  readonly ifAvailable?: boolean;
  readonly signal?: AbortSignal;
}
export interface LockManagerLike {
  request<T>(
    name: string,
    options: LockRequestOptions,
    callback: (lock: LockGrantLike | null) => T | Promise<T>,
  ): Promise<T>;
  query(): Promise<{ held: ReadonlyArray<{ name: string }> }>;
}

/** Lock-name namespace, so a store lock never collides with another app lock. */
const LOCK_PREFIX = 'olv-ooc-store:';

/** The lock name a store's residency is held under. */
export function storeLockName(storeName: string): string {
  return `${LOCK_PREFIX}${storeName}`;
}

/** The store name behind a lock name, or null if it is not one of ours. */
function storeNameFromLock(lockName: string): string | null {
  return lockName.startsWith(LOCK_PREFIX) ? lockName.slice(LOCK_PREFIX.length) : null;
}

/** The live Web Locks manager, or null when the API is unavailable. */
export function resolveLockManager(): LockManagerLike | null {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  return (locks as unknown as LockManagerLike | undefined) ?? null;
}

/**
 * Hold a store's residency: acquire a shared lock and keep it until the returned
 * function is called. Resolves once the lock is granted, with a release function
 * whose own promise settles when the lock is actually let go.
 */
export function acquireStoreResidency(
  locks: LockManagerLike,
  storeName: string,
  signal?: AbortSignal,
): Promise<() => Promise<void>> {
  return new Promise((resolveOuter, rejectOuter) => {
    let resolveHeld!: () => void;
    const held = new Promise<void>((r) => {
      resolveHeld = r;
    });
    let requestP: Promise<void>;
    const release = (): Promise<void> => {
      resolveHeld();
      return requestP;
    };
    requestP = locks.request(storeLockName(storeName), { mode: 'shared', signal }, () => {
      resolveOuter(release);
      return held;
    });
    requestP.catch(rejectOuter);
  });
}

/**
 * Whether any tab is currently using the store. Requests an exclusive lock with
 * `ifAvailable`: a null grant means someone holds it (busy). With no lock manager
 * the answer is BUSY — never claim a store is free when we cannot tell.
 */
export function isStoreBusy(locks: LockManagerLike | null, storeName: string): Promise<boolean> {
  if (!locks) return Promise.resolve(true);
  return locks.request(
    storeLockName(storeName),
    { mode: 'exclusive', ifAvailable: true },
    (lock) => lock === null,
  );
}

/**
 * The set of store names currently held by any tab, for an eviction pass to skip.
 * Null when liveness cannot be determined (no lock manager) — the caller must
 * then evict nothing.
 */
export async function liveStoreNames(locks: LockManagerLike | null): Promise<Set<string> | null> {
  if (!locks) return null;
  const { held } = await locks.query();
  const names = new Set<string>();
  for (const lock of held) {
    const storeName = storeNameFromLock(lock.name);
    if (storeName !== null) names.add(storeName);
  }
  return names;
}
