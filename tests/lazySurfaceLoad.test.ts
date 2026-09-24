/**
 * lazySurfaceLoad.test.ts
 *
 * The shared lazy-load contract every overlay/panel entry point uses
 * (LAZY-1 / LOAD-1): a busy cue on the trigger while the chunk fetches, and
 * on failure — a rejection, OR a resolve to `undefined` the way a stale
 * chunk's cooldown branch produces (see `staleChunkReload.ts`) — a visible
 * report through the bound toast instead of an unhandled rejection.
 *
 * DOM-free: `trigger`/`toast` are plain recording fakes, no jsdom needed.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createLazySurfaceLoader,
  createLazySingleton,
  buttonLazyTrigger,
} from '../src/app/lazySurfaceLoad';

function fakeToast() {
  const calls: Array<{ message: string; action?: { label: string; onClick: () => void } }> = [];
  return { show: (message: string, action?: { label: string; onClick: () => void }) => { calls.push({ message, action }); }, calls };
}

function fakeTrigger() {
  const states: boolean[] = [];
  return { setBusy: (busy: boolean) => { states.push(busy); }, states };
}

describe('createLazySurfaceLoader', () => {
  it('resolves to the loaded value on success, toggling busy true then false', async () => {
    const toast = fakeToast();
    const trigger = fakeTrigger();
    const run = createLazySurfaceLoader(toast);
    const result = await run(() => Promise.resolve('module'), 'thing', { trigger });
    expect(result).toBe('module');
    expect(trigger.states).toEqual([true, false]);
    expect(toast.calls).toEqual([]);
  });

  it('reports a rejection through the toast and resolves to undefined, never throwing', async () => {
    const toast = fakeToast();
    const trigger = fakeTrigger();
    const run = createLazySurfaceLoader(toast);
    const result = await run(() => Promise.reject(new Error('network down')), 'command palette', { trigger });
    expect(result).toBeUndefined();
    expect(trigger.states).toEqual([true, false]);
    expect(toast.calls).toHaveLength(1);
    expect(toast.calls[0].message).toBe('network down');
  });

  it('reports the stale-chunk "resolves to undefined" case when the caller throws on it', async () => {
    // The caller's own composite `load` is what detects this shape (see the
    // module doc): destructuring/using an `undefined` module throws, and
    // that throw is what this test simulates directly.
    const toast = fakeToast();
    const run = createLazySurfaceLoader(toast);
    const load = async () => {
      const mod: { Thing?: unknown } | undefined = undefined;
      // @ts-expect-error - deliberately reading a property off undefined, as a real caller's destructure would.
      return mod.Thing;
    };
    const result = await run(load, 'shortcut sheet');
    expect(result).toBeUndefined();
    expect(toast.calls).toHaveLength(1);
  });

  it('uses a fallback message for a non-Error rejection', async () => {
    const toast = fakeToast();
    const run = createLazySurfaceLoader(toast);
    await run(() => Promise.reject('boom'), 'help overlay');
    expect(toast.calls[0].message).toBe('Could not load the help overlay.');
  });

  it('omits the toast action when no retry is given', async () => {
    const toast = fakeToast();
    const run = createLazySurfaceLoader(toast);
    await run(() => Promise.reject(new Error('x')), 'context menu');
    expect(toast.calls[0].action).toBeUndefined();
  });

  it('wires the toast action to the supplied retry callback', async () => {
    const toast = fakeToast();
    const run = createLazySurfaceLoader(toast);
    const retry = vi.fn();
    await run(() => Promise.reject(new Error('x')), 'quality panel', { retry });
    expect(toast.calls[0].action?.label).toBe('Try again');
    toast.calls[0].action?.onClick();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('clears busy on both success and failure even without a retry', async () => {
    const trigger = fakeTrigger();
    const toast = fakeToast();
    const run = createLazySurfaceLoader(toast);
    await run(() => Promise.reject(new Error('x')), 'thing', { trigger });
    expect(trigger.states).toEqual([true, false]);
  });
});

describe('createLazySingleton', () => {
  it('builds once, caches the value, and skips the build on later ensure() calls', async () => {
    const toast = fakeToast();
    const build = vi.fn(() => Promise.resolve({ id: 1 }));
    const singleton = createLazySingleton(build, 'thing', toast);
    expect(singleton.current()).toBeNull();
    const first = await singleton.ensure();
    expect(first).toEqual({ id: 1 });
    expect(singleton.current()).toEqual({ id: 1 });
    const second = await singleton.ensure();
    expect(second).toBe(first);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight build across concurrent ensure() calls', async () => {
    const toast = fakeToast();
    let resolveBuild: (v: { id: number }) => void = () => {};
    const build = vi.fn(() => new Promise<{ id: number }>((resolve) => { resolveBuild = resolve; }));
    const singleton = createLazySingleton(build, 'thing', toast);
    const a = singleton.ensure();
    const b = singleton.ensure();
    resolveBuild({ id: 7 });
    expect(await a).toEqual({ id: 7 });
    expect(await b).toEqual({ id: 7 });
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('reports a failed build through the toast and resolves to undefined, leaving current() null', async () => {
    const toast = fakeToast();
    const build = vi.fn(() => Promise.reject(new Error('chunk failed')));
    const singleton = createLazySingleton(build, 'shortcut sheet', toast);
    const result = await singleton.ensure();
    expect(result).toBeUndefined();
    expect(singleton.current()).toBeNull();
    expect(toast.calls).toHaveLength(1);
    expect(toast.calls[0].message).toBe('chunk failed');
    expect(toast.calls[0].action?.label).toBe('Try again');
  });

  it('a failed build can be retried; a later build succeeding caches it', async () => {
    const toast = fakeToast();
    let attempt = 0;
    const build = vi.fn(() => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(new Error('flaky')) : Promise.resolve({ id: 2 });
    });
    const singleton = createLazySingleton(build, 'thing', toast);
    const failed = await singleton.ensure();
    expect(failed).toBeUndefined();
    // The toast's own "Try again" action re-invokes the whole flow, not just the raw loader.
    toast.calls[0].action?.onClick();
    // Let the retried build's microtasks settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(singleton.current()).toEqual({ id: 2 });
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('replays a caller-supplied onReady on a later retry, even though the retry itself calls ensure() with no argument', async () => {
    // Pins createLazySingleton's own replay mechanism in isolation — `pending`
    // survives a failed attempt and fires on whatever later call actually
    // succeeds, even the bare `ensure()` the baked-in `retry` below always
    // makes. This is the primitive `main.ts`'s ensureShortcutSheet() relies on
    // for its onReady-on-retry wiring; that wiring itself (main.ts is not
    // unit-testable — no exports) is pinned end to end by the Firefox-only
    // e2e case in lazyOverlayStates.spec.ts, not here.
    const toast = fakeToast();
    let attempt = 0;
    const build = vi.fn(() => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(new Error('flaky')) : Promise.resolve({ id: 3 });
    });
    const singleton = createLazySingleton(build, 'shortcut sheet', toast);
    const onReady = vi.fn();
    const failed = await singleton.ensure(onReady);
    expect(failed).toBeUndefined();
    expect(onReady).not.toHaveBeenCalled();
    toast.calls[0].action?.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith({ id: 3 });
  });
});

describe('buttonLazyTrigger', () => {
  it('disables the button and sets aria-busy while busy, clearing both after', () => {
    const button = { disabled: false, setAttribute: vi.fn(), getAttribute: vi.fn() } as unknown as HTMLButtonElement;
    const trigger = buttonLazyTrigger(button);
    trigger.setBusy(true);
    expect(button.disabled).toBe(true);
    expect(button.setAttribute).toHaveBeenCalledWith('aria-busy', 'true');
    trigger.setBusy(false);
    expect(button.disabled).toBe(false);
    expect(button.setAttribute).toHaveBeenCalledWith('aria-busy', 'false');
  });

  it('is a harmless no-op when the button lookup found nothing', () => {
    const trigger = buttonLazyTrigger(null);
    expect(() => { trigger.setBusy(true); trigger.setBusy(false); }).not.toThrow();
  });

  it('resolves a getter fresh on every setBusy, for a button built after the trigger', () => {
    let button: HTMLButtonElement | null = null;
    const trigger = buttonLazyTrigger(() => button);
    trigger.setBusy(true); // no button yet: a no-op, not a throw.
    button = { disabled: false, setAttribute: vi.fn(), getAttribute: vi.fn() } as unknown as HTMLButtonElement;
    trigger.setBusy(true);
    expect(button.disabled).toBe(true);
    expect(button.setAttribute).toHaveBeenCalledWith('aria-busy', 'true');
  });
});
