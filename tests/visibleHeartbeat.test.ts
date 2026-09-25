import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VisibleHeartbeat, type VisibilitySource } from '../src/render/frameDemand';

class FakeDoc implements VisibilitySource {
  hidden = false;
  private _fns = new Set<() => void>();
  addEventListener(_t: 'visibilitychange', fn: () => void): void { this._fns.add(fn); }
  removeEventListener(_t: 'visibilitychange', fn: () => void): void { this._fns.delete(fn); }
  get listeners(): number { return this._fns.size; }
  set(hidden: boolean): void { this.hidden = hidden; for (const fn of [...this._fns]) fn(); }
}

describe('VisibleHeartbeat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('ticks while visible and does no work while hidden', () => {
    const doc = new FakeDoc();
    const tick = vi.fn();
    const hb = new VisibleHeartbeat(tick, 200, doc);
    hb.start();
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(5);
    doc.set(true);
    expect(hb.running).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(tick).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(0);
    doc.set(false);
    expect(tick).toHaveBeenCalledTimes(6); // one immediate tick on resume
    vi.advanceTimersByTime(400);
    expect(tick).toHaveBeenCalledTimes(8);
    hb.stop();
  });

  it('does not arm when started in a hidden tab, and arms on visible', () => {
    const doc = new FakeDoc();
    doc.hidden = true;
    const tick = vi.fn();
    const hb = new VisibleHeartbeat(tick, 200, doc);
    hb.start();
    vi.advanceTimersByTime(1000);
    expect(tick).not.toHaveBeenCalled();
    doc.set(false);
    vi.advanceTimersByTime(200);
    expect(tick).toHaveBeenCalledTimes(2);
    hb.stop();
  });

  it('start is idempotent and stop clears the timer and the listener', () => {
    const doc = new FakeDoc();
    const tick = vi.fn();
    const hb = new VisibleHeartbeat(tick, 200, doc);
    hb.start();
    hb.start();
    expect(doc.listeners).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    hb.stop();
    hb.stop();
    expect(doc.listeners).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    doc.set(false);
    vi.advanceTimersByTime(1000);
    expect(tick).not.toHaveBeenCalled();
    hb.start(); // restartable after stop
    vi.advanceTimersByTime(200);
    expect(tick).toHaveBeenCalledTimes(1);
    hb.stop();
  });

  it('runs without a document (worker / Node)', () => {
    const tick = vi.fn();
    const hb = new VisibleHeartbeat(tick, 100, null);
    hb.start();
    vi.advanceTimersByTime(300);
    expect(tick).toHaveBeenCalledTimes(3);
    hb.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
