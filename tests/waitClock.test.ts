/**
 * waitClock.test.ts: the elapsed time and remaining-time estimate shown beside
 * a long task. The estimate stays hidden until enough progress has been seen,
 * moves smoothly, never counts down through a stall, and never appears for a
 * task that reports no progress.
 */
import { describe, expect, it } from 'vitest';
import { createWaitClock, formatWait, ETA_MIN_ELAPSED_MS, ETA_MIN_FRACTION } from '../src/process/waitClock';

describe('createWaitClock', () => {
  it('reports elapsed time from the start', () => {
    const clock = createWaitClock(1000);
    expect(clock.read(null, 4500).elapsedMs).toBe(3500);
  });

  it('gives no estimate for a task with no progress', () => {
    const clock = createWaitClock(0);
    for (let t = 0; t <= 60_000; t += 1000) expect(clock.read(null, t).remainingMs).toBeNull();
  });

  it('gives no estimate before the progress threshold', () => {
    const clock = createWaitClock(0);
    expect(clock.read(ETA_MIN_FRACTION / 2, 10_000).remainingMs).toBeNull();
  });

  it('gives no estimate before the time threshold, even with progress', () => {
    const clock = createWaitClock(0);
    expect(clock.read(0.5, ETA_MIN_ELAPSED_MS - 1).remainingMs).toBeNull();
  });

  it('estimates from the observed rate once both thresholds pass', () => {
    const clock = createWaitClock(0);
    clock.read(0, 0);
    // 20% in 2 s: 8 s left at a steady rate.
    expect(clock.read(0.2, 2000).remainingMs).toBeCloseTo(8000, 0);
  });

  it('follows a steady task down without jumping up', () => {
    const clock = createWaitClock(0);
    clock.read(0, 0);
    let last = Infinity;
    for (let t = 2000; t <= 9000; t += 1000) {
      const r = clock.read(t / 10_000, t).remainingMs!;
      expect(r).toBeLessThanOrEqual(last + 1);
      expect(Math.abs(r - (10_000 - t))).toBeLessThan(600);
      last = r;
    }
  });

  it('smooths a noisy rate', () => {
    const clock = createWaitClock(0);
    clock.read(0, 0);
    clock.read(0.2, 2000);
    // A burst to 60% one second later reads 2 s left raw; the shown estimate moves part way.
    const r = clock.read(0.6, 3000).remainingMs!;
    expect(r).toBeGreaterThan(2000);
    expect(r).toBeLessThan(7000);
  });

  it('does not count down to nothing while progress stalls', () => {
    const clock = createWaitClock(0);
    clock.read(0, 0);
    clock.read(0.5, 2000);
    let r = 0;
    for (let t = 3000; t <= 30_000; t += 1000) r = clock.read(0.5, t).remainingMs!;
    expect(r).toBeGreaterThan(10_000);
  });

  it('reading twice at the same moment gives the same answer', () => {
    const clock = createWaitClock(0);
    clock.read(0, 0);
    clock.read(0.2, 2000);
    const a = clock.read(0.5, 3000).remainingMs;
    expect(clock.read(0.5, 3000).remainingMs).toBe(a);
  });

  it('starts the estimate again when progress goes backwards', () => {
    const clock = createWaitClock(0);
    clock.read(0, 0);
    clock.read(0.8, 4000);
    expect(clock.read(0.1, 5000).remainingMs).toBeNull();
  });

  it('reads nothing left at completion', () => {
    const clock = createWaitClock(0);
    clock.read(0, 0);
    clock.read(0.5, 2000);
    expect(clock.read(1, 4000).remainingMs).toBe(0);
  });
});

describe('a clock that starts mid-task', () => {
  it('measures the rate from its first reading, not from zero', () => {
    // First seen at 60%, then 70% two seconds later: 0.05 per second, 6 s left.
    // Measuring from zero would count the first 60% as instant and read under 1 s.
    const clock = createWaitClock(0);
    expect(clock.read(0.6, 0).remainingMs).toBeNull();
    expect(clock.read(0.7, 2000).remainingMs).toBeCloseTo(6000, 0);
  });

  it('waits for 5% of progress past the first reading', () => {
    const clock = createWaitClock(0);
    clock.read(0.6, 0);
    expect(clock.read(0.62, 5000).remainingMs).toBeNull();
  });
});

describe('formatWait', () => {
  it('shows elapsed seconds, then minutes and seconds', () => {
    expect(formatWait({ elapsedMs: 12_400, remainingMs: null })).toBe('12 s elapsed');
    expect(formatWait({ elapsedMs: 65_000, remainingMs: null })).toBe('1 min 5 s elapsed');
  });

  it('adds the estimate when there is one', () => {
    expect(formatWait({ elapsedMs: 4000, remainingMs: 23_000 })).toBe('4 s elapsed, about 25 s left');
    expect(formatWait({ elapsedMs: 4000, remainingMs: 150_000 })).toBe('4 s elapsed, about 3 min left');
    expect(formatWait({ elapsedMs: 4000, remainingMs: 3000 })).toBe('4 s elapsed, a few seconds left');
  });
});
