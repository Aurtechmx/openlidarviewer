import { describe, it, expect } from 'vitest';
import { HistoryTargets, type HistorySurface } from '../src/render/continuity/historyTargets';
import { FLOAT_LAYOUT, historyBytes } from '../src/render/streaming/historyBudget';

/** A factory that records what was made and what was freed. */
function tracker() {
  const made: string[] = [];
  const freed: string[] = [];
  let live = 0;
  const make = (label: string, widthPx: number, heightPx: number): HistorySurface => {
    made.push(`${label}@${widthPx}x${heightPx}`);
    live += 1;
    return {
      label,
      widthPx,
      heightPx,
      dispose() {
        freed.push(`${label}@${widthPx}x${heightPx}`);
        live -= 1;
      },
    };
  };
  return { make, made, freed, live: () => live };
}

describe('history targets', () => {
  it('allocates nothing before a viewport is known', () => {
    const t = tracker();
    const h = new HistoryTargets(t.make);
    expect(h.set).toBeNull();
    expect(h.refusal).toBe('no-viewport');
    expect(t.made).toEqual([]);
  });

  // Three surfaces or none: a colour history with no depth beside it is the
  // photographic accumulation this renderer must not do.
  it('allocates the three surfaces together', () => {
    const t = tracker();
    const h = new HistoryTargets(t.make);
    h.resize(1920, 1080);
    expect(t.live()).toBe(3);
    expect(t.made).toEqual([
      'continuity-colour@1920x1080',
      'continuity-depth@1920x1080',
      'continuity-support@1920x1080',
    ]);
    expect(h.set?.bytes).toBe(historyBytes(1920, 1080));
    expect(h.refusal).toBeNull();
  });

  // A render loop may call this every frame.
  it('does nothing when asked for the size it already has', () => {
    const t = tracker();
    const h = new HistoryTargets(t.make);
    h.resize(1920, 1080);
    for (let i = 0; i < 10; i++) h.resize(1920, 1080);
    expect(h.allocationCount).toBe(1);
    expect(t.live()).toBe(3);
    expect(t.freed).toEqual([]);
  });

  // Holding both sets at once is the moment a device is most likely to refuse
  // the second.
  it('frees the old surfaces before making new ones', () => {
    const t = tracker();
    const h = new HistoryTargets(t.make);
    h.resize(1920, 1080);
    h.resize(2560, 1440);
    expect(t.freed).toEqual([
      'continuity-colour@1920x1080',
      'continuity-depth@1920x1080',
      'continuity-support@1920x1080',
    ]);
    expect(t.live()).toBe(3);
    expect(h.set?.widthPx).toBe(2560);
  });

  it('leaves nothing allocated when a viewport collapses', () => {
    const t = tracker();
    const h = new HistoryTargets(t.make);
    h.resize(1920, 1080);
    h.resize(0, 1080);
    expect(t.live()).toBe(0);
    expect(h.set).toBeNull();
    expect(h.refusal).toBe('no-viewport');
  });

  // Declining is the failure path working: a worse picture beats a lost tab.
  it('declines above the ceiling and leaves source rendering', () => {
    const t = tracker();
    const h = new HistoryTargets(t.make);
    h.resize(3840 * 2, 2160 * 2);
    expect(h.set).toBeNull();
    expect(h.refusal).toBe('over-ceiling');
    expect(t.made).toEqual([]);
  });

  it('declines sooner under a heavier layout', () => {
    const conservative = new HistoryTargets(tracker().make);
    const float = new HistoryTargets(tracker().make, FLOAT_LAYOUT);
    conservative.resize(2560 * 2, 1440 * 2);
    float.resize(2560 * 2, 1440 * 2);
    expect(conservative.refusal).toBeNull();
    expect(float.refusal).toBe('over-ceiling');
  });

  it('recovers when the viewport comes back under the ceiling', () => {
    const t = tracker();
    const h = new HistoryTargets(t.make);
    h.resize(3840 * 2, 2160 * 2);
    expect(h.refusal).toBe('over-ceiling');
    h.resize(1920, 1080);
    expect(h.refusal).toBeNull();
    expect(t.live()).toBe(3);
  });

  // A stale history is the right shape with the wrong pixels. Reallocating on
  // every camera nudge would cost more than the accumulation saves.
  it('clears without freeing or reallocating', () => {
    const t = tracker();
    const h = new HistoryTargets(t.make);
    h.resize(1920, 1080);
    const before = h.set;
    h.clear();
    h.clear();
    expect(h.set).toBe(before);
    expect(h.clearCount).toBe(2);
    expect(h.allocationCount).toBe(1);
    expect(t.freed).toEqual([]);
  });

  it('does not count a clear when there is nothing to clear', () => {
    const h = new HistoryTargets(tracker().make);
    h.clear();
    expect(h.clearCount).toBe(0);
  });

  it('frees everything on dispose, and twice is harmless', () => {
    const t = tracker();
    const h = new HistoryTargets(t.make);
    h.resize(1920, 1080);
    h.dispose();
    h.dispose();
    expect(t.live()).toBe(0);
    expect(t.freed.length).toBe(3);
    expect(h.set).toBeNull();
  });

  it('never leaks across a run of resizes', () => {
    const t = tracker();
    const h = new HistoryTargets(t.make);
    for (const [w, hh] of [[800, 600], [1920, 1080], [1280, 720], [2560, 1440], [640, 480]]) {
      h.resize(w, hh);
      expect(t.live()).toBe(3);
    }
    h.dispose();
    expect(t.live()).toBe(0);
    expect(t.made.length).toBe(t.freed.length);
  });

  it('treats a degenerate size as no viewport rather than allocating', () => {
    const t = tracker();
    const h = new HistoryTargets(t.make);
    for (const [w, hh] of [[Number.NaN, 1080], [-5, 1080], [1920, Number.POSITIVE_INFINITY]]) {
      h.resize(w, hh);
      expect(h.set).toBeNull();
      expect(h.refusal).toBe('no-viewport');
    }
    expect(t.made).toEqual([]);
  });
});
