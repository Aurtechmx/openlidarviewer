/**
 * swActivateCleanup.test.ts
 *
 * CacheStorage is ORIGIN-wide, not scoped to a service worker. The `activate`
 * handler must therefore prune only OLV's own caches (the `olv-shell-` prefix),
 * never a co-hosted application's cache on the same origin. This evaluates
 * public/sw.js in a stubbed scope, seeds a mix of caches, runs `activate`, and
 * pins that only stale OLV caches are deleted.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SW_SOURCE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../public/sw.js'),
  'utf8',
);

function evalSw(initialKeys: string[]) {
  const keys = new Set(initialKeys);
  const listeners = new Map<string, (e: unknown) => void>();
  const selfObj = {
    addEventListener: (t: string, fn: (e: unknown) => void) => listeners.set(t, fn),
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
    location: { origin: 'https://viewer.example', href: 'https://viewer.example/' },
    registration: { scope: 'https://viewer.example/' },
  };
  const cachesObj = {
    open: async () => ({ addAll: async () => {}, put: async () => {}, match: async () => undefined }),
    keys: async () => [...keys],
    delete: async (k: string) => keys.delete(k),
    match: async () => undefined,
  };
  new Function('self', 'caches', 'fetch', SW_SOURCE)(selfObj, cachesObj, async () => {
    throw new Error('no fetch');
  });
  return { listeners, remaining: keys };
}

describe('service worker activate cleanup is scoped to OLV caches', () => {
  it('prunes stale olv-shell-* caches but keeps the current one and unrelated apps', async () => {
    const { listeners, remaining } = evalSw([
      'olv-shell-0.6.5', // stale OLV → delete
      'olv-shell-0.6.6', // previous OLV release → delete
      'olv-shell-0.6.7', // current (matches VERSION) → keep
      'my-other-app-v3', // a co-hosted PWA on the same origin → MUST survive
      'workbox-precache-v2', // another library's cache → MUST survive
    ]);
    let done: Promise<unknown> = Promise.resolve();
    listeners.get('activate')?.({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    expect(remaining.has('olv-shell-0.6.5')).toBe(false); // pruned
    expect(remaining.has('olv-shell-0.6.6')).toBe(false); // pruned (previous release)
    expect(remaining.has('olv-shell-0.6.7')).toBe(true); // kept (current)
    expect(remaining.has('my-other-app-v3')).toBe(true); // untouched
    expect(remaining.has('workbox-precache-v2')).toBe(true); // untouched
  });
});
