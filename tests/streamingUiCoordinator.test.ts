/**
 * streamingUiCoordinator.test.ts
 *
 * The streaming panel's controls and status over fakes: quality reaches the
 * renderer with the phone flag, pause and resume route to the right call, a
 * poll tick projects one snapshot into the panel and to every registered
 * reader, the grade runs once at a time and cancels through its controller,
 * and ending the session stops the poll, aborts the grade and hides the
 * panel. The panel is a spy built through the factory; timers are manual.
 * Nothing here needs a DOM or a renderer. The grade action is a promise the
 * test resolves by hand. Each case builds a fresh harness.
 */
import { describe, it, expect, vi } from 'vitest';
import { createStreamingUiCoordinator, STREAMING_STATUS_POLL_MS } from '../src/app/streamingUiCoordinator';

function harness(over: { cloud?: boolean } = {}) {
  const panel = { setStatus: vi.fn(), setViewDiagnostics: vi.fn(), setQuality: vi.fn(), hide: vi.fn(), element: {} };
  let callbacks: any = null;
  const renderer = {
    setStreamingColorMode: vi.fn(), setStreamingQuality: vi.fn(), pauseStreaming: vi.fn(), resumeStreaming: vi.fn(), clearStreamingCache: vi.fn(),
    streamingCloud: () => (over.cloud === false ? null : cloud),
    streamingScheduler: () => (over.cloud === false ? null : scheduler),
  };
  const cloud = { counts: () => ({ resident: 4, known: 9, loading: 0, queued: 0 }), residentPointCount: 1200, sourcePointCount: 5000 };
  const scheduler = { diagnostics: () => ({ readinessPhase: 'settled' }), cacheStats: () => ({ byteSize: 777 }) };
  const timers: Array<{ fn: () => void; ms: number }> = [];
  let cleared: number[] = [];
  let gradeResolve: (() => void) | null = null;
  const runFullCloudGrade = vi.fn(() => new Promise<void>((r) => { gradeResolve = r; }));
  const c = createStreamingUiCoordinator({
    renderer: renderer as never,
    isPhone: () => true,
    getViewer: () => ({ tag: 'viewer' }) as never,
    gradeContext: () => ({ tag: 'ctx' }) as never,
    loadGrade: async () => ({ runFullCloudGrade: runFullCloudGrade as never }),
    debug: false,
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearInterval: (id) => { cleared.push(id); },
    createPanel: (cb) => { callbacks = cb; return panel as never; },
  });
  const tick = () => timers.at(-1)!.fn();
  return { c, panel, renderer, callbacks: () => callbacks, timers, cleared: () => cleared, tick, runFullCloudGrade, resolveGrade: () => gradeResolve!() };
}

describe('streaming UI coordinator', () => {
  it('routes the panel controls to the renderer', () => {
    const h = harness();
    const cb = h.callbacks();
    cb.onQuality('high');
    expect(h.renderer.setStreamingQuality).toHaveBeenCalledWith('high', true);
    expect(h.c.quality()).toBe('high');
    cb.onPauseToggle(true);
    cb.onPauseToggle(false);
    expect(h.renderer.pauseStreaming).toHaveBeenCalledTimes(1);
    expect(h.renderer.resumeStreaming).toHaveBeenCalledTimes(1);
    cb.onClearCache();
    expect(h.renderer.clearStreamingCache).toHaveBeenCalledTimes(1);
    cb.onColorMode('rgb');
    expect(h.renderer.setStreamingColorMode).toHaveBeenCalledWith('rgb');
  });

  it('a quality moved by the performance control is recorded and shown, not re-applied', () => {
    const h = harness();
    h.c.noteQualityFromControl('low');
    expect(h.c.quality()).toBe('low');
    expect(h.panel.setQuality).toHaveBeenCalledWith('low');
    expect(h.renderer.setStreamingQuality).not.toHaveBeenCalled();
  });

  it('one poll tick projects one snapshot into the panel and to every reader', () => {
    const h = harness();
    const seen: unknown[] = [];
    const off = h.c.onTick((t) => seen.push(t));
    h.c.startPolling();
    expect(h.timers.at(-1)!.ms).toBe(STREAMING_STATUS_POLL_MS);
    h.tick();
    expect(h.panel.setStatus).toHaveBeenCalledWith({ loadedNodes: 4, knownNodes: 9, displayedPoints: 1200, sourcePoints: 5000, cacheBytes: 777 });
    expect(h.panel.setViewDiagnostics).toHaveBeenCalledWith({ readinessPhase: 'settled' });
    expect(seen).toHaveLength(1);
    expect((seen[0] as { counts: { resident: number } }).counts.resident).toBe(4);
    off();
    h.tick();
    expect(seen).toHaveLength(1);
  });

  it('a tick with no streaming cloud touches nothing', () => {
    const h = harness({ cloud: false });
    const reader = vi.fn();
    h.c.onTick(reader);
    h.c.startPolling();
    h.tick();
    expect(h.panel.setStatus).not.toHaveBeenCalled();
    expect(reader).not.toHaveBeenCalled();
  });

  it('restarting the poll clears the previous timer', () => {
    const h = harness();
    h.c.startPolling();
    h.c.startPolling();
    expect(h.cleared()).toEqual([1]);
    h.c.stopPolling();
    expect(h.cleared()).toEqual([1, 2]);
  });

  it('the grade runs once at a time and cancels through its controller', async () => {
    const h = harness();
    const first = h.c.runGrade();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.c.gradeRunning()).toBe(true);
    void h.c.runGrade(); // re-entry: ignored
    expect(h.runFullCloudGrade).toHaveBeenCalledTimes(1);
    const args = (h.runFullCloudGrade.mock.calls[0] as unknown[])[0] as { signal: AbortSignal; panel: unknown; context: { tag: string } };
    expect(args.panel).toBe(h.panel);
    expect(args.context.tag).toBe('ctx');
    h.c.cancelGrade();
    expect(args.signal.aborted).toBe(true);
    h.resolveGrade();
    await first;
    expect(h.c.gradeRunning()).toBe(false);
  });

  it('ending the session stops the poll, aborts the grade and hides the panel', async () => {
    const h = harness();
    h.c.startPolling();
    const run = h.c.runGrade();
    await Promise.resolve();
    await Promise.resolve();
    const args = (h.runFullCloudGrade.mock.calls[0] as unknown[])[0] as { signal: AbortSignal };
    h.c.endSession();
    expect(h.cleared()).toEqual([1]);
    expect(args.signal.aborted).toBe(true);
    expect(h.panel.hide).toHaveBeenCalledTimes(1);
    h.resolveGrade();
    await run;
  });
});
