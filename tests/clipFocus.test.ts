/**
 * clipFocus.test.ts: "Focus clipped region" on the Clip page and in the command
 * palette is live exactly when the viewer's frameClip would move the camera.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { clipFrameBounds, type ClipBox } from '../src/render/clip/clipBox';
import { canFocusClip, focusClip, NO_CLIP_TO_FOCUS } from '../src/app/clipFocus';
import { contributeToolActions } from '../src/app/actions/toolActions';
import { FakeEl, installFakeDom } from './support/measurePanelDom';

beforeAll(() => {
  installFakeDom();
  (globalThis as unknown as Record<string, unknown>).HTMLInputElement ??= class {};
});

type Bounds = [number, number, number, number, number, number];
const DATA: Bounds = [0, 0, 0, 10, 10, 5];
const clip = (over: Partial<ClipBox> = {}, min: [number, number, number] = [1, 1, 1], max: [number, number, number] = [4, 4, 4]): ClipBox =>
  ({ box: { min, max }, mode: 'keep-inside', enabled: true, ...over });

/** The viewer's own frameClip over a held clip and a scene's bounds. */
function viewer(data: Bounds | null = DATA) {
  let held: ClipBox | null = null;
  const v = {
    framed: 0,
    data,
    setClip: (c: ClipBox | null) => { held = c; },
    getClip: () => held,
    mergedVisibleBounds: () => v.data,
    frameClip: () => { if (!clipFrameBounds(held, v.data)) return false; v.framed++; return true; },
  };
  return v;
}

async function make(v = viewer()) {
  const { ClipPanel } = await import('../src/ui/ClipPanel');
  const toasts: string[] = [];
  const panel = new ClipPanel({
    onApply: (c) => v.setClip(c), fitBounds: () => null, keptCount: () => null,
    onFocus: () => focusClip(v as never, (m) => toasts.push(m)), canFocus: () => canFocusClip(v as never),
  });
  const button = (panel.element as unknown as FakeEl).querySelectorAll('.olv-clip-focus')[0] as FakeEl & { disabled: boolean };
  return { v, panel, toasts, button };
}

describe('canFocusClip', () => {
  it('needs a Keep inside clip that is on and whose box holds some of the scan', () => {
    const v = viewer();
    const can = (c: ClipBox | null): boolean => { v.setClip(c); expect(canFocusClip(v as never)).toBe(v.frameClip()); return canFocusClip(v as never); };
    expect(can(clip())).toBe(true);
    expect(can(null)).toBe(false);
    expect(can(clip({ enabled: false }))).toBe(false);
    expect(can(clip({ mode: 'keep-outside' }))).toBe(false);
    expect(can(clip({}, [20, 20, 20], [30, 30, 30]))).toBe(false);
    // Inverted on one axis, and a bound that is not a number.
    expect(can(clip({}, [4, 1, 1], [1, 4, 4]))).toBe(false);
    expect(can(clip({}, [Number.NaN, 1, 1]))).toBe(false);
    v.data = null;
    expect(can(clip())).toBe(false);
    expect(canFocusClip(null)).toBe(false);
  });
});

describe('the Clip page button', () => {
  it('follows the clip: on, side, box, and the data under it', async () => {
    const t = await make();
    expect(t.button.disabled).toBe(true);
    t.panel.adoptBounds(clip());
    expect(t.button.disabled).toBe(false);
    t.panel.adoptBounds(clip({ mode: 'keep-outside' }));
    expect(t.button.disabled).toBe(true);
    t.panel.adoptBounds(clip({}, [20, 20, 20], [30, 30, 30]));
    expect(t.button.disabled).toBe(true);
    t.panel.adoptBounds(clip());
    t.v.data = null;
    t.panel.invalidateCount();
    expect(t.button.disabled).toBe(true);
    t.v.data = DATA;
    t.panel.invalidateCount();
    expect(t.button.disabled).toBe(false);
    t.panel.clear();
    expect(t.button.disabled).toBe(true);
    t.panel.dispose();
  });

  it('is live after a restore, which does not go through apply', async () => {
    const t = await make();
    t.v.setClip(clip());
    t.panel.setState(clip());
    expect(t.button.disabled).toBe(false);
  });

  it('moves the view and says so', async () => {
    const t = await make();
    t.panel.adoptBounds(clip());
    t.button.click();
    expect(t.v.framed).toBe(1);
    expect(t.toasts).toEqual(['View moved to the clipped region.']);
    // The scan went away since: nothing moves, and the button says why and turns off.
    t.v.data = null;
    t.button.click();
    expect(t.v.framed).toBe(1);
    expect(t.toasts.at(-1)).toBe(NO_CLIP_TO_FOCUS);
    expect(t.button.disabled).toBe(true);
    t.panel.dispose();
  });

  it('is a labelled button with a tip, and absent without a viewer behind it', async () => {
    const t = await make();
    expect(t.button.tagName.toLowerCase()).toBe('button');
    expect(t.button.textContent).toBe('Focus clipped region');
    expect(t.button.title).toMatch(/Keep inside/);
    const { ClipPanel } = await import('../src/ui/ClipPanel');
    const bare = new ClipPanel({ onApply: () => {}, fitBounds: () => null, keptCount: () => null });
    expect((bare.element as unknown as FakeEl).querySelectorAll('.olv-clip-focus')[0].className).toContain('olv-hidden');
  });
});

describe('the palette action', () => {
  it('is unavailable with the reason, then moves the view', () => {
    const v = viewer(), toast = vi.fn();
    const a = contributeToolActions({ getViewer: () => v as never, showLassoToast: toast, hasScan: () => true } as never).find((x) => x.id === 'tool.clip-focus')!;
    expect(a.unavailable).toBe(NO_CLIP_TO_FOCUS);
    v.setClip(clip());
    expect(a.unavailable).toBeUndefined();
    a.run();
    expect(v.framed).toBe(1);
    expect(toast).toHaveBeenCalledWith('View moved to the clipped region.');
  });
});
