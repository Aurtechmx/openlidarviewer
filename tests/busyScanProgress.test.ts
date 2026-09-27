/**
 * busyScanProgress.test.ts: the busy scan controller. Progress sets the trail
 * length, clamped to 0..1 and never shown shrinking; a reset fades the trail
 * back to the short indeterminate one; completion grows it to full, waits for
 * the point to reach the front, then fades it.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { Node0, installBusyScanDom } from './helpers/busyScanDom';

beforeAll(() => installBusyScanDom());
afterEach(() => vi.useRealTimers());

async function fresh() {
  const m = await import('../src/ui/busyScan');
  const ctl = m.createBusyScanController();
  const el = ctl.element as unknown as Node0;
  return { m, ctl, el, cssLen: () => Number(el.style['--olv-bs-len']) };
}

describe('busy scan progress', () => {
  it('starts indeterminate with the short trail', async () => {
    const { m, ctl, cssLen } = await fresh();
    expect(ctl.length).toBe(m.TRAIL_IDLE);
    expect(cssLen()).toBe(m.TRAIL_IDLE);
  });

  it('maps 0..1 onto the short trail up to a near-closed loop, clamping', async () => {
    const { m } = await fresh();
    expect(m.trailLength(0)).toBe(m.TRAIL_IDLE);
    expect(m.trailLength(1)).toBe(m.TRAIL_FULL);
    expect(m.trailLength(-3)).toBe(m.TRAIL_IDLE);
    expect(m.trailLength(7)).toBe(m.TRAIL_FULL);
    expect(m.trailLength(Number.NaN)).toBe(m.TRAIL_IDLE);
    expect(m.TRAIL_FULL).toBeGreaterThanOrEqual(92);
    expect(m.TRAIL_FULL).toBeLessThanOrEqual(95);
  });

  it('only grows: a lower value leaves the trail where it is', async () => {
    const { ctl, cssLen } = await fresh();
    ctl.setProgress(0.6);
    const high = ctl.length;
    ctl.setProgress(0.2);
    expect(ctl.length).toBe(high);
    expect(cssLen()).toBeCloseTo(high, 2);
  });

  it('fades back to the short trail on reset rather than snapping', async () => {
    vi.useFakeTimers();
    const { m, ctl, el } = await fresh();
    ctl.setProgress(0.8);
    ctl.reset();
    expect(el.cls.has('is-fading')).toBe(true);
    expect(ctl.length).toBeGreaterThan(m.TRAIL_IDLE);
    await vi.advanceTimersByTimeAsync(m.FADE_MS);
    expect(ctl.length).toBe(m.TRAIL_IDLE);
    expect(el.cls.has('is-instant')).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(el.cls.has('is-fading')).toBe(false);
    expect(el.cls.has('is-instant')).toBe(false);
  });

  it('returns to indeterminate with null, fading', async () => {
    vi.useFakeTimers();
    const { m, ctl } = await fresh();
    ctl.setProgress(0.5);
    ctl.setProgress(null);
    await vi.advanceTimersByTimeAsync(m.FADE_MS + 20);
    expect(ctl.length).toBe(m.TRAIL_IDLE);
  });

  it('completes: full trail, rest at the front, then fade', async () => {
    vi.useFakeTimers();
    const { m, ctl, el } = await fresh();
    let done = false;
    void ctl.complete().then(() => { done = true; });
    expect(ctl.length).toBe(m.TRAIL_FULL);
    await vi.advanceTimersByTimeAsync(m.LENGTH_EASE_MS);
    expect(el.cls.has('is-settled')).toBe(false);
    el.find('olv-bs-point')[0].fire('animationiteration');
    await vi.advanceTimersByTimeAsync(0);
    expect(el.cls.has('is-settled')).toBe(true);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(m.FADE_MS);
    expect(done).toBe(true);
  });

  it('completes even if the point never reports reaching the front', async () => {
    vi.useFakeTimers();
    const { m, ctl, el } = await fresh();
    let done = false;
    void ctl.complete().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(m.LENGTH_EASE_MS + m.SETTLE_WAIT_MS + m.FADE_MS);
    expect(el.cls.has('is-settled')).toBe(true);
    expect(done).toBe(true);
  });
});
