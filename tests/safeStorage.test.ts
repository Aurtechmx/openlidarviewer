/**
 * safeStorage.test.ts — guarded localStorage access. Persistence here is
 * always a nice-to-have (a panel-collapse flag, a compass toggle, a one-shot
 * tour marker), so every helper must degrade to "the preference just doesn't
 * persist" rather than throw out of a constructor or event handler. These
 * tests pin get/set/remove against a working store, a throwing store, and a
 * store that is entirely absent.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { storageGet, storageSet, storageRemove } from '../src/ui/safeStorage';

const realDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

function install(stub: unknown): void {
  Object.defineProperty(globalThis, 'localStorage', { value: stub, configurable: true });
}

afterEach(() => {
  if (realDescriptor) Object.defineProperty(globalThis, 'localStorage', realDescriptor);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('safeStorage', () => {
  it('reads, writes, and removes through a working store', () => {
    const map = new Map<string, string>();
    install({
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    });
    expect(storageGet('k')).toBeNull();
    storageSet('k', 'v');
    expect(storageGet('k')).toBe('v');
    storageRemove('k');
    expect(storageGet('k')).toBeNull();
  });

  it('never throws when the store throws on every access', () => {
    const boom = () => { throw new Error('SecurityError'); };
    install({ getItem: boom, setItem: boom, removeItem: boom });
    expect(storageGet('k')).toBeNull();
    expect(() => storageSet('k', 'v')).not.toThrow();
    expect(() => storageRemove('k')).not.toThrow();
  });

  it('never throws when localStorage is undefined (Node / sandboxed embed)', () => {
    install(undefined);
    expect(storageGet('k')).toBeNull();
    expect(() => storageSet('k', 'v')).not.toThrow();
    expect(() => storageRemove('k')).not.toThrow();
  });
});
