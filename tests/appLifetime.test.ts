import { describe, expect, it, vi } from 'vitest';
import { createAppLifetime, type DisposeFailure } from '../src/app/appLifetime';
import { createAppRuntime } from '../src/app/AppRuntime';

describe('createAppLifetime', () => {
  it('runs disposers newest first, each once, and is idempotent', () => {
    const order: string[] = [];
    const life = createAppLifetime();
    life.register(() => order.push('a'), 'a');
    life.register(() => order.push('b'), 'b');
    life.register(() => order.push('c'), 'c');
    life.disposeAll();
    life.disposeAll();
    expect(order).toEqual(['c', 'b', 'a']);
    expect(life.disposed).toBe(true);
  });

  it('continues past a throwing disposer and reports all failures once', () => {
    const onErrors = vi.fn<(f: readonly DisposeFailure[]) => void>();
    const life = createAppLifetime(onErrors);
    const ran: string[] = [];
    life.register(() => ran.push('first'), 'first');
    life.register(() => { throw new Error('x'); }, 'bad1');
    life.register(() => { throw new Error('y'); }, 'bad2');
    life.disposeAll();
    expect(ran).toEqual(['first']);
    expect(onErrors).toHaveBeenCalledTimes(1);
    expect(onErrors.mock.calls[0][0].map((f) => f.label)).toEqual(['bad2', 'bad1']);
  });

  it('unregister removes a disposer', () => {
    const life = createAppLifetime();
    const fn = vi.fn();
    const off = life.register(fn, 'x');
    off();
    off();
    life.disposeAll();
    expect(fn).not.toHaveBeenCalled();
  });

  it('runs a late registration immediately', () => {
    const life = createAppLifetime();
    life.disposeAll();
    const fn = vi.fn();
    life.register(fn, 'late');
    expect(fn).toHaveBeenCalledTimes(1);
    life.disposeAll();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('is safe when a disposer re-enters disposeAll or registers', () => {
    const life = createAppLifetime();
    const a = vi.fn();
    const late = vi.fn();
    life.register(a, 'a');
    life.register(() => {
      life.disposeAll();
      life.register(late, 'late');
    }, 'reentrant');
    life.disposeAll();
    expect(a).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('aborts its signal so listeners added with it are removed', () => {
    const life = createAppLifetime();
    const target = new EventTarget();
    const fn = vi.fn();
    target.addEventListener('ping', fn, { signal: life.signal });
    target.dispatchEvent(new Event('ping'));
    life.disposeAll();
    target.dispatchEvent(new Event('ping'));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(life.signal.aborted).toBe(true);
  });

  it('disposes on pagehide unless the page is persisted', () => {
    const life = createAppLifetime();
    const fn = vi.fn();
    life.register(fn, 'x');
    const target = new EventTarget();
    const detach = life.bindPagehide(target);
    const persisted = Object.assign(new Event('pagehide'), { persisted: true });
    target.dispatchEvent(persisted);
    expect(fn).not.toHaveBeenCalled();
    target.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false }));
    expect(fn).toHaveBeenCalledTimes(1);
    target.dispatchEvent(new Event('pagehide'));
    expect(fn).toHaveBeenCalledTimes(1);
    detach();
  });

  it('releases the app owners registered at boot exactly once each', () => {
    const runtime = createAppRuntime();
    const stage = { dispose: vi.fn() };
    const viewer = { dispose: vi.fn() };
    const debugOverlay = { stop: vi.fn() };
    const copc = { dispose: vi.fn() };
    const ept = { dispose: vi.fn() };
    const streamingUi = { endSession: vi.fn() };
    const order: string[] = [];
    const tag = (name: string, fn: () => void) => () => { order.push(name); fn(); };
    // Mirrors the registrations at the end of src/main.ts.
    runtime.lifetime.register(tag('stage', () => stage.dispose()), 'stage');
    runtime.lifetime.register(tag('viewer', () => { debugOverlay.stop(); viewer.dispose(); }), 'viewer');
    runtime.lifetime.register(tag('decode workers', () => { copc.dispose(); ept.dispose(); }), 'decode workers');
    runtime.lifetime.register(tag('streaming session', () => streamingUi.endSession()), 'streaming session');
    const win = new EventTarget();
    runtime.lifetime.bindPagehide(win);
    win.dispatchEvent(new Event('pagehide'));
    win.dispatchEvent(new Event('pagehide'));
    runtime.lifetime.disposeAll();
    for (const f of [stage.dispose, viewer.dispose, debugOverlay.stop, copc.dispose, ept.dispose, streamingUi.endSession]) {
      expect(f).toHaveBeenCalledTimes(1);
    }
    expect(order).toEqual(['streaming session', 'decode workers', 'viewer', 'stage']);
  });

  it('main.ts registers the boot owners and binds pagehide', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    for (const label of ['stage', 'viewer', 'decode workers', 'streaming session']) {
      expect(src).toContain(`'${label}');`);
    }
    expect(src).toContain('runtime.lifetime.bindPagehide(window);');
    expect(src).not.toMatch(/addEventListener\('beforeunload'/);
  });
});
