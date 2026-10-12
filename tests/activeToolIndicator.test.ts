/**
 * activeToolIndicator.test.ts
 *
 * The active-tool pill and the read that feeds it. The pill must mirror the
 * controllers' own state, change at once when the tool or kind changes, show
 * Finish only where the controller can finish, cancel through the same exit Esc
 * uses, show nothing while idle, stay a single instance, keep clipping as a
 * secondary chip rather than an operation, and clear when the scan closes.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { FakeEl, installLiveFakeDom } from './helpers/liveFakeDom';
import { readActiveTool, wireActiveToolIndicator, type ActiveToolViewer } from '../src/app/activeToolStatus';

beforeAll(installLiveFakeDom);

/** A viewer whose modes are exclusive, as `_setToolMode` makes them. */
function fakeViewer(): ActiveToolViewer & { mode: string; kind: string; drafting: boolean; finished: number } {
  const v = {
    mode: 'none', kind: 'distance', drafting: false, finished: 0,
    get measureMode() { return v.mode === 'measure'; },
    get inspectMode() { return v.mode === 'inspect'; },
    get annotateMode() { return v.mode === 'annotate'; },
    measure: {
      get kind() { return v.kind; },
      firstVertexForClose: () => (v.drafting && ['polyline', 'area', 'volume', 'profile'].includes(v.kind) ? [0, 0, 0] : null),
      finishCurrent: () => { v.finished++; v.drafting = false; },
    },
    setMeasureMode: (on: boolean) => { v.mode = on ? 'measure' : 'none'; v.drafting = false; },
    setInspectMode: (on: boolean) => { v.mode = on ? 'inspect' : 'none'; },
    setAnnotateMode: (on: boolean) => { v.mode = on ? 'annotate' : 'none'; },
  };
  return v;
}

function harness() {
  const v = fakeViewer();
  let clip = false;
  const mount = new FakeEl('div');
  const hint = new FakeEl('div');
  let observerCb: () => void = () => {};
  const docListeners = new Map<string, () => void>();
  const w = wireActiveToolIndicator({
    viewer: () => v,
    clipEnabled: () => clip,
    mount: mount as unknown as HTMLElement,
    watch: [hint as unknown as HTMLElement],
    doc: {
      addEventListener: (t: string, fn: () => void) => docListeners.set(t, fn),
      removeEventListener: (t: string) => docListeners.delete(t),
    } as unknown as Document,
    observe: (cb) => { observerCb = cb; return { observe: () => {}, disconnect: () => { observerCb = () => {}; } }; },
  });
  const pill = (): FakeEl => mount.findAll((e) => e.hasClass('olv-ati'))[0];
  return {
    v, w, mount, pill, docListeners,
    setClip: (on: boolean) => { clip = on; },
    /** A hint bar mutation: what the controllers do on every state change. */
    mutate: () => observerCb(),
    label: () => pill().findAll((e) => e.hasClass('olv-ati-label'))[0].ownText,
    visible: () => !pill().hasClass('olv-hidden') && !pill().hidden,
    finish: () => pill().findAll((e) => e.hasClass('olv-ati-finish'))[0],
    cancel: () => pill().findAll((e) => e.hasClass('olv-ati-cancel'))[0],
    chips: () => pill().findAll((e) => e.hasClass('olv-ati-chip')).map((c) => c.ownText),
  };
}

describe('readActiveTool', () => {
  it('is idle (no mode) while only orbiting', () => {
    expect(readActiveTool({ viewer: fakeViewer(), clipEnabled: false }).mode).toBeNull();
    expect(readActiveTool({ viewer: null, clipEnabled: false }).mode).toBeNull();
  });

  it('names each tool from the controller state', () => {
    const v = fakeViewer();
    v.mode = 'measure';
    expect(readActiveTool({ viewer: v, clipEnabled: false }).mode?.label).toBe('Measuring distance');
    v.kind = 'box';
    expect(readActiveTool({ viewer: v, clipEnabled: false }).mode?.label).toBe('Drawing box');
    v.mode = 'annotate';
    expect(readActiveTool({ viewer: v, clipEnabled: false }).mode?.label).toBe('Adding annotation');
    v.mode = 'inspect';
    expect(readActiveTool({ viewer: v, clipEnabled: false }).mode?.label).toBe('Inspecting points');
  });

  it('offers Finish only for an open polyline or area draft', () => {
    const v = fakeViewer();
    v.mode = 'measure';
    v.kind = 'distance'; v.drafting = true;
    expect(readActiveTool({ viewer: v, clipEnabled: false }).mode?.finish).toBeFalsy();
    v.kind = 'area'; v.drafting = false;
    expect(readActiveTool({ viewer: v, clipEnabled: false }).mode?.finish).toBeFalsy();
    v.drafting = true;
    expect(readActiveTool({ viewer: v, clipEnabled: false }).mode?.finish).toBeTypeOf('function');
    v.kind = 'polyline';
    expect(readActiveTool({ viewer: v, clipEnabled: false }).mode?.finish).toBeTypeOf('function');
  });

  it('keeps clipping as a chip, never as the active operation', () => {
    const s = readActiveTool({ viewer: fakeViewer(), clipEnabled: true });
    expect(s.mode).toBeNull();
    expect(s.chips).toEqual(['Clip on']);
  });
});

describe('active-tool pill', () => {
  it('is absent while idle and mirrors the controller once a tool is on', () => {
    const h = harness();
    expect(h.visible()).toBe(false);
    h.v.setMeasureMode(true);
    h.mutate();
    expect(h.visible()).toBe(true);
    expect(h.label()).toBe('Measuring distance');
  });

  it('updates immediately when switching kind or tool', () => {
    const h = harness();
    h.v.setMeasureMode(true); h.mutate();
    h.v.kind = 'box'; h.mutate();
    expect(h.label()).toBe('Drawing box');
    h.v.setAnnotateMode(true); h.mutate();
    expect(h.label()).toBe('Adding annotation');
    expect(h.pill().dataset.tool).toBe('annotate');
    h.v.setInspectMode(true); h.mutate();
    expect(h.label()).toBe('Inspecting points');
  });

  it('Cancel runs the controller exit Esc runs and the pill goes away', () => {
    const h = harness();
    h.v.setAnnotateMode(true); h.mutate();
    h.cancel().fire('click');
    expect(h.v.mode).toBe('none');
    h.mutate();
    expect(h.visible()).toBe(false);
  });

  it('Esc mid-draft exits measuring without committing the draft', () => {
    const h = harness();
    h.v.setMeasureMode(true); h.v.kind = 'area'; h.v.drafting = true; h.mutate();
    h.cancel().fire('click');
    expect(h.v.finished).toBe(0);
    expect(h.v.measureMode).toBe(false);
  });

  it('Finish is shown only when the controller can finish, and calls it', () => {
    const h = harness();
    h.v.setMeasureMode(true); h.mutate();
    expect(h.finish().hidden).toBe(true);
    h.v.kind = 'polyline'; h.v.drafting = true; h.mutate();
    expect(h.finish().hidden).toBe(false);
    h.finish().fire('click');
    expect(h.v.finished).toBe(1);
    h.mutate();
    expect(h.finish().hidden).toBe(true);
    expect(h.v.measureMode).toBe(true);
  });

  it('labels its buttons and announces through a polite status region', () => {
    const h = harness();
    h.v.setMeasureMode(true); h.mutate();
    const status = h.pill().findAll((e) => e.getAttribute('role') === 'status')[0];
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(h.cancel().getAttribute('aria-label')).toBe('Cancel measuring distance (Esc)');
  });

  it('shows the clip chip beside an active tool, never alone', () => {
    const h = harness();
    h.setClip(true); h.w.refresh();
    expect(h.visible()).toBe(false);
    h.v.setMeasureMode(true); h.mutate();
    expect(h.chips()).toEqual(['Clip on']);
    expect(h.label()).toBe('Measuring distance');
  });

  it('stays a single instance across refreshes and re-wiring', () => {
    const h = harness();
    for (let i = 0; i < 4; i++) { h.v.setMeasureMode(i % 2 === 0); h.mutate(); }
    expect(h.mount.findAll((e) => e.hasClass('olv-ati'))).toHaveLength(1);
    wireActiveToolIndicator({
      viewer: () => h.v, clipEnabled: () => false, mount: h.mount as unknown as HTMLElement, watch: [],
      doc: { addEventListener: () => {}, removeEventListener: () => {} } as unknown as Document,
      observe: () => ({ observe: () => {}, disconnect: () => {} }),
    });
    expect(h.mount.findAll((e) => e.hasClass('olv-ati'))).toHaveLength(1);
  });

  it('clears when the scan closes and the tools are reset', () => {
    const h = harness();
    h.v.setMeasureMode(true); h.v.kind = 'area'; h.v.drafting = true; h.setClip(true); h.mutate();
    expect(h.visible()).toBe(true);
    // resetToEmptyState: every tool off, clip cleared.
    h.v.setMeasureMode(false); h.v.setAnnotateMode(false); h.v.setInspectMode(false); h.setClip(false);
    h.mutate();
    expect(h.visible()).toBe(false);
    expect(h.chips()).toEqual([]);
  });

  it('dispose detaches the pill and its document listeners', () => {
    const h = harness();
    expect(h.docListeners.size).toBe(3);
    const cancel = h.cancel();
    h.w.dispose();
    expect(h.docListeners.size).toBe(0);
    expect(cancel.listenerCount('click')).toBe(0);
    expect(h.mount.findAll((e) => e.hasClass('olv-ati'))).toHaveLength(0);
  });

  it('seats the pill invisibly, then reveals it settled on the next frame', () => {
    const frames: (() => void)[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => { frames.length = 0; });
    try {
      const h = harness();
      expect(h.pill().hasClass('olv-ati-placing')).toBe(false);
      h.v.setMeasureMode(true); h.mutate();
      // Shown but still being placed: invisible, no glide, no animation yet.
      expect(h.visible()).toBe(true);
      expect(h.pill().hasClass('olv-ati-placing')).toBe(true);
      expect(h.pill().hasClass('olv-ati-settled')).toBe(false);
      expect(frames).toHaveLength(1);
      // A refresh in the same frame does not queue a second reveal.
      h.mutate();
      expect(frames).toHaveLength(1);
      frames.shift()!();
      expect(h.pill().hasClass('olv-ati-placing')).toBe(false);
      expect(h.pill().hasClass('olv-ati-settled')).toBe(true);
      // A kind change while shown is not a new entrance.
      h.v.kind = 'area'; h.mutate();
      expect(frames).toHaveLength(0);
      expect(h.pill().hasClass('olv-ati-settled')).toBe(true);
      // Leaving resets, so the next entrance is placed again before it shows.
      h.v.setMeasureMode(false); h.mutate();
      expect(h.pill().hasClass('olv-ati-settled')).toBe(false);
      h.v.setAnnotateMode(true); h.mutate();
      expect(h.pill().hasClass('olv-ati-placing')).toBe(true);
      // Hiding before the frame cancels the reveal.
      h.v.setAnnotateMode(false); h.mutate();
      expect(frames).toHaveLength(0);
      expect(h.pill().hasClass('olv-ati-placing')).toBe(false);
      h.w.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
