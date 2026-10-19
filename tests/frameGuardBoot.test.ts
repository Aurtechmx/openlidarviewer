/**
 * frameGuardBoot.test.ts
 *
 * The guard that stops the app from starting inside a page nothing authorises
 * fails closed. If the framing facts cannot be read, a framed page does not
 * start; only a window that is its own top (a test double) is let through.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** A window whose `location` cannot be read, so the policy throws before deciding. */
function windowWithUnreadableLocation(framed: boolean): Window {
  const win: Record<string, unknown> = {};
  win.top = framed ? {} : win;
  Object.defineProperty(win, 'location', { get() { throw new Error('location unavailable'); } });
  win.document = { createElement: () => { throw new Error('no DOM'); } };
  return win as unknown as Window;
}

describe('frameGuardBoot', () => {
  it('does not start a framed page whose framing cannot be read', async () => {
    vi.stubGlobal('window', windowWithUnreadableLocation(true));
    await expect(import('../src/ui/frameGuardBoot')).rejects.toThrow(/did not start: it is framed by a page that is not an allowed embedding origin/);
  });

  it('does not start a page whose own top cannot even be read', async () => {
    const win = windowWithUnreadableLocation(false);
    Object.defineProperty(win, 'top', { get() { throw new Error('cross-origin'); } });
    vi.stubGlobal('window', win);
    await expect(import('../src/ui/frameGuardBoot')).rejects.toThrow(/did not start/);
  });

  it('lets a window that is its own top start even when its facts cannot be read (a test double)', async () => {
    vi.stubGlobal('window', windowWithUnreadableLocation(false));
    await expect(import('../src/ui/frameGuardBoot')).resolves.toBeDefined();
  });

  it('is a no-op outside a browser', async () => {
    await expect(import('../src/ui/frameGuardBoot')).resolves.toBeDefined();
  });

  it('is the first import of main.ts, ahead of everything that could run before the guard', async () => {
    const { readFileSync } = await import('node:fs');
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    expect(main.split('\n').find((l) => l.trim() !== '' && !l.trim().startsWith('//'))).toMatch(/^import '\.\/ui\/frameGuardBoot';/);
  });
});
