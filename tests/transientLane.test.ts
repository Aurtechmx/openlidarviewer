import { describe, it, expect, vi } from 'vitest';
import { createTransientLane } from '../src/ui/transientLane';

/** The class surface the lane touches. */
function card(): HTMLElement {
  const classes = new Set<string>();
  return {
    classList: {
      add: (c: string) => void classes.add(c),
      remove: (c: string) => void classes.delete(c),
      contains: (c: string) => classes.has(c),
    },
  } as unknown as HTMLElement;
}
const waiting = (el: HTMLElement): boolean => el.classList.contains('olv-lane-wait');

describe('transient lane', () => {
  it('on a phone shows one card at a time and promotes the next on release', () => {
    const lane = createTransientLane(() => true);
    const a = card(), b = card(), c = card();
    const onB = vi.fn();
    lane.claim(a);
    lane.claim(b, onB);
    lane.claim(c);
    expect(lane.front()).toBe(a);
    expect([waiting(a), waiting(b), waiting(c)]).toEqual([false, true, true]);
    expect(onB).not.toHaveBeenCalled();
    lane.release(a);
    expect(lane.front()).toBe(b);
    expect(waiting(b)).toBe(false);
    expect(onB).toHaveBeenCalledTimes(1);
    expect(waiting(c)).toBe(true);
  });

  it('releasing a waiting card does not disturb the front', () => {
    const lane = createTransientLane(() => true);
    const a = card(), b = card(), c = card();
    lane.claim(a); lane.claim(b); lane.claim(c);
    lane.release(b);
    expect(lane.front()).toBe(a);
    lane.release(a);
    expect(lane.front()).toBe(c);
    expect(waiting(c)).toBe(false);
  });

  it('re-claiming a card keeps its place and re-runs onFront only at the front', () => {
    const lane = createTransientLane(() => true);
    const a = card(), b = card();
    const onA = vi.fn(), onB = vi.fn();
    lane.claim(a, onA); lane.claim(b);
    lane.claim(a, onA);
    lane.claim(b, onB);
    expect(onA).toHaveBeenCalledTimes(2);
    expect(onB).not.toHaveBeenCalled();
    expect(lane.front()).toBe(a);
  });

  it('off the phone layout every card shows at once', () => {
    const lane = createTransientLane(() => false);
    const a = card(), b = card();
    const onB = vi.fn();
    lane.claim(a); lane.claim(b, onB);
    expect([waiting(a), waiting(b)]).toEqual([false, false]);
    expect(onB).toHaveBeenCalledTimes(1);
    expect(lane.front()).toBeNull();
  });
  it('a first claim takes the front and the card it displaced returns after it', () => {
    const lane = createTransientLane(() => true);
    const toast = card(), project = card();
    const onToast = vi.fn();
    lane.claim(toast, onToast);
    lane.claim(project, undefined, true);
    expect(lane.front()).toBe(project);
    expect(waiting(toast)).toBe(true);
    lane.release(project);
    expect(lane.front()).toBe(toast);
    expect(onToast).toHaveBeenCalledTimes(2);
  });
});
