/**
 * busyWaits.test.ts: the pieces of the busy-indicator adapter that decide
 * what a long task shows and says. Progress is read back from the trail a
 * progress controller drew, and a screen reader hears a long task every
 * thirty seconds, never every tick.
 */
import { describe, expect, it } from 'vitest';
import { trailFraction, announcementsDue, ANNOUNCE_EVERY_MS } from '../src/app/stateStrip/busyTasks';
import { trailLength, TRAIL_IDLE } from '../src/ui/busyScan';

describe('trailFraction', () => {
  it('reads back the fraction a controller drew', () => {
    for (const f of [0.05, 0.25, 0.5, 0.9, 1]) expect(trailFraction(trailLength(f))).toBeCloseTo(f, 6);
  });

  it('is null for an idle trail, an emblem (no length) or garbage', () => {
    expect(trailFraction(TRAIL_IDLE)).toBeNull();
    expect(trailFraction(Number.NaN)).toBeNull();
    expect(trailFraction(0)).toBeNull();
  });
});

describe('announcementsDue', () => {
  it('stays at zero for the first thirty seconds, then steps once per interval', () => {
    expect(announcementsDue(0)).toBe(0);
    expect(announcementsDue(ANNOUNCE_EVERY_MS - 1)).toBe(0);
    expect(announcementsDue(ANNOUNCE_EVERY_MS)).toBe(1);
    expect(announcementsDue(ANNOUNCE_EVERY_MS * 2 + 500)).toBe(2);
  });
});
