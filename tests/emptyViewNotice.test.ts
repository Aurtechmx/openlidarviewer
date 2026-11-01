/**
 * emptyViewNotice.test.ts
 *
 * When the clip and the filters hide every loaded point of the visible scans,
 * a card says what is on and offers only the fixes that apply. What these
 * would catch:
 *  - the card showing while points are drawn, or with nothing on to explain
 *    an empty view (scans hidden, a stream, an empty layer);
 *  - a Turn off clip button with no clip on, or Reset filters with none on;
 *  - Reset filters clearing the classes but leaving a range filter on;
 *  - the viewer re-walking every point each frame instead of only when the
 *    clip, a filter or the layers change;
 *  - the check drifting from the pick's own test, so the card and what a
 *    click can reach disagree.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { FakeEl, installFakeDom } from './support/measurePanelDom';
import { anyAccepted, ShownPointsMemo } from '../src/render/pointFilterAccept';
import type { EmptyViewCauses } from '../src/ui/EmptyViewNotice';

beforeAll(() => {
  installFakeDom();
});

const none: EmptyViewCauses = { clip: false, classes: false, elevation: false, intensity: false };

describe('emptyViewText', () => {
  it('names one cause, several, and none', async () => {
    const { emptyViewText } = await import('../src/ui/EmptyViewNotice');
    expect(emptyViewText({ ...none, clip: true })).toBe(
      'No points are drawn: the clip box hides every loaded point of the visible scans.',
    );
    expect(emptyViewText({ ...none, clip: true, classes: true, elevation: true })).toBe(
      'No points are drawn: between them, the clip box, the class filter and the elevation filter hide every loaded point of the visible scans.',
    );
    expect(emptyViewText(none)).toBeNull();
  });
});

describe('EmptyViewNotice', () => {
  async function notice() {
    const { EmptyViewNotice } = await import('../src/ui/EmptyViewNotice');
    const actions = { turnOffClip: vi.fn(), resetFilters: vi.fn() };
    const n = new EmptyViewNotice(actions);
    const root = n.element as unknown as FakeEl;
    const button = (text: string) => root.querySelectorAll('button').find((b) => b.textContent === text)!;
    return { n, root, actions, clip: button('Turn off clip'), filters: button('Reset filters') };
  }

  it('stays hidden while points are drawn or nothing on explains the empty view', async () => {
    const { n } = await notice();
    n.sync(null);
    expect(n.shown).toBe(false);
    n.sync(none);
    expect(n.shown).toBe(false);
  });

  it('offers only the fixes that apply, and each runs its control', async () => {
    const { n, actions, clip, filters } = await notice();
    n.sync({ ...none, clip: true });
    expect(n.shown).toBe(true);
    expect(clip.classList.contains('olv-hidden')).toBe(false);
    expect(filters.classList.contains('olv-hidden')).toBe(true);
    n.sync({ ...none, intensity: true });
    expect(clip.classList.contains('olv-hidden')).toBe(true);
    expect(filters.classList.contains('olv-hidden')).toBe(false);
    clip.click();
    filters.click();
    expect(actions.turnOffClip).toHaveBeenCalledTimes(1);
    expect(actions.resetFilters).toHaveBeenCalledTimes(1);
  });
});

describe('mountEmptyView', () => {
  it('checks after each drawn frame, and Reset filters clears classes and both ranges', async () => {
    const { mountEmptyView } = await import('../src/app/emptyViewMount');
    const classes = { isFiltered: vi.fn(() => true), showAll: vi.fn() };
    const ranges = { elevation: () => true, intensity: () => false, clear: vi.fn() };
    const mount = mountEmptyView({ classes, ranges, clip: { enabled: false, clear: vi.fn() } });
    let shown: boolean | null = true;
    let frame = (): void => {};
    mount.watch({ anyPointShown: () => shown, onDrawnFrame: (l) => { frame = l; return () => {}; } });
    expect(mount.notice.shown).toBe(false);
    shown = false;
    frame();
    expect(mount.notice.shown).toBe(true);
    expect((mount.notice.element as unknown as FakeEl).textContent).toContain('the class filter and the elevation filter');
    const reset = (mount.notice.element as unknown as FakeEl).querySelectorAll('button').find((b) => b.textContent === 'Reset filters')!;
    reset.click();
    expect(classes.showAll).toHaveBeenCalledTimes(1);
    expect(ranges.clear).toHaveBeenCalledTimes(1);
    // A stream or hidden scans: not counted, so no card.
    shown = null;
    frame();
    expect(mount.notice.shown).toBe(false);
  });
});

describe('ShownPointsMemo', () => {
  it('walks the points only when the state or a layer changes', () => {
    const memo = new ShownPointsMemo();
    const accept = vi.fn((i: number) => i === 3);
    const build = vi.fn(() => accept);
    const layers = [{ key: ['a', 4], count: 4, accept: build }];
    expect(memo.shown({ clip: 1 }, layers)).toBe(true);
    expect(memo.shown({ clip: 1 }, layers)).toBe(true);
    expect(build).toHaveBeenCalledTimes(1);
    const none = vi.fn(() => (_i: number) => false);
    expect(memo.shown({ clip: 2 }, [{ key: ['a', 4], count: 4, accept: none }])).toBe(false);
    expect(memo.shown({ clip: 2 }, [{ key: ['a', 5], count: 5, accept: build }])).toBe(true);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('counts a layer with no filter as shown when it has points', () => {
    expect(anyAccepted(3, undefined)).toBe(true);
    expect(anyAccepted(0, undefined)).toBe(false);
    expect(anyAccepted(3, () => false)).toBe(false);
  });

  it('is asked with the pick test over the visible layers only', () => {
    const viewer = readFileSync(join(import.meta.dirname, '..', 'src', 'render', 'Viewer.ts'), 'utf8');
    const start = viewer.indexOf('anyPointShown(): boolean | null {');
    expect(start).toBeGreaterThan(-1);
    const body = viewer.slice(start, viewer.indexOf('\n  }\n', start));
    expect(body).toContain('e.mesh.visible');
    expect(body).toContain('this._pickAccept(');
    expect(body).toContain('this.classificationEpoch(k)');
  });
});

describe('handleHitRadius', () => {
  it('gives a finger a 44 px target and a mouse 24 px', async () => {
    const { handleHitRadius } = await import('../src/render/touchTapGate');
    expect(handleHitRadius(true) * 2).toBe(44);
    expect(handleHitRadius(false) * 2).toBe(24);
  });
});
