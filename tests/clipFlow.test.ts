/**
 * clipFlow.test.ts: Draw clipping box, Isolate this box, the result card and
 * the active-clip chip, over fake ports.
 *
 *   - Draw clipping box arms the EXISTING Box tool through the shell's one
 *     scene-tool command (it never toggles Measure off when already on);
 *   - Isolate this box, the card's clip action and the row action are the same
 *     conversion: same clip, same refusals, same messages;
 *   - the card shows the latest result, once, dismisses on the next tool
 *     activation and on scan close, and adds no listeners when re-shown;
 *   - the chip mirrors the Clip panel's state and clears it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { ClipBox, ClipMode } from '../src/render/clip/clipBox';
import type { BoxMeasurementLike } from '../src/render/clip/clipFromMeasurement';
import type { MeasurementSummary } from '../src/render/measure/MeasureController';
import { FakeEl, installFakeDom } from './support/measurePanelDom';

beforeAll(() => { installFakeDom(); });

const one = { activeLayerId: 'L1', layerCount: 1 };
const box = (id: string, a: number[], b: number[], extra: Partial<BoxMeasurementLike> = {}): BoxMeasurementLike =>
  ({ id, kind: 'box', points: [a as [number, number, number], b as [number, number, number]], ...extra });
const summary = (over: Partial<MeasurementSummary>): MeasurementSummary =>
  ({ id: 'm1', kind: 'distance', name: 'Distance 1', value: '3.00 m', ...over }) as MeasurementSummary;

class FakePanel {
  enabled = false;
  mode: ClipMode = 'keep-inside';
  hints: Array<string | null> = [];
  setDrawHint(t: string | null) { this.hints.push(t); }
  private fns = new Set<() => void>();
  subscribe(fn: () => void) { this.fns.add(fn); return () => { this.fns.delete(fn); }; }
  adoptBounds(c: ClipBox) { this.enabled = c.enabled; this.mode = c.mode; this.emit(); }
  clear() { this.enabled = false; this.emit(); }
  emit() { for (const f of this.fns) f(); }
  get listeners() { return this.fns.size; }
}

async function make(opts: { ms?: BoxMeasurementLike[]; ctx?: typeof one; measureOn?: boolean; vertical?: { axis: 0 | 1 | 2; min: number; max: number }; down?: boolean } = {}) {
  const { createClipFlow } = await import('../src/app/clipFlow');
  const log = { adopted: [] as ClipBox[], pages: [] as string[], toasts: [] as string[], runs: 0, stops: 0, reveals: 0, footprint: [] as boolean[], kinds: [] as string[], copies: [] as string[], details: [] as string[], deleted: [] as string[] };
  const state = { ms: opts.ms ?? [], sums: [] as MeasurementSummary[], on: opts.measureOn ?? false, down: opts.down ?? false, hintFn: null as ((t: string) => void) | null };
  const panel = new FakePanel();
  const overlay = new FakeEl('div');
  const ctx = opts.ctx ?? one;
  const flow = createClipFlow({
    clipPanel: panel,
    overlay: overlay as unknown as { append(...n: Node[]): void },
    box: {
      measurements: () => state.ms, activeLayerId: () => ctx.activeLayerId, layerCount: () => ctx.layerCount,
      adoptClip: (c) => { log.adopted.push(c); panel.adoptBounds(c); },
      openClipPage: () => log.pages.push('clip'), toast: (m) => log.toasts.push(m),
      verticalExtent: () => opts.vertical ?? null,
    },
    lookingDown: () => state.down,
    setFootprintHint: (on) => { log.footprint.push(on); },
    watchHint: (fn) => { state.hintFn = fn; fn('Click one corner of the box'); return () => { state.hintFn = null; }; },
    revealScene: () => { log.reveals++; },
    summaries: () => state.sums,
    scene: () => ({ datumResolved: true, layers: 'single', verticalReferenceKnown: true }),
    measureOn: () => state.on,
    armMeasureTool: () => { log.runs++; state.on = true; flow.dismissCard(); },
    stopMeasureTool: () => { log.stops++; state.on = false; },
    setBoxKind: () => log.kinds.push('box'),
    openDetails: (id) => log.details.push(id),
    deleteMeasurement: (id) => log.deleted.push(id),
    copy: async (t) => { log.copies.push(t); return true; },
  });
  const card = flow.card.element as unknown as FakeEl;
  const btn = (text: string): FakeEl => card.querySelectorAll('button').find((b) => b.textContent === text)!;
  const complete = (s: MeasurementSummary, m?: BoxMeasurementLike) => {
    state.sums = [...state.sums, s];
    if (m) state.ms = [...state.ms, m];
    flow.onMeasurementsChanged();
  };
  return { flow, panel, log, state, card, btn, overlay, complete };
}

describe('Draw clipping box', () => {
  it('arms the Box tool when Measure is off, and stays on the Clip page', async () => {
    const t = await make();
    t.flow.drawClippingBox();
    expect(t.log.runs).toBe(1);
    expect(t.log.pages).toEqual([]);
    expect(t.log.kinds).toEqual(['box']);
  });

  it('never toggles Measure off when it is already on', async () => {
    const t = await make({ measureOn: true });
    t.flow.drawClippingBox();
    expect(t.log.runs).toBe(0);
    expect(t.log.stops).toBe(0);
    expect(t.log.pages).toEqual([]);
    expect(t.log.kinds).toEqual(['box']);
  });
});

describe('Draw clipping box: footprint, hint, and the tool after', () => {
  const scan = { axis: 2 as const, min: 0, max: 20 };

  it('mirrors the Box hint on the Clip page, says the clip is full height, and lowers a phone sheet', async () => {
    const t = await make();
    t.flow.drawClippingBox();
    expect(t.log.footprint).toEqual([true]);
    expect(t.panel.hints.at(-1)).toBe('Click one corner of the box');
    t.state.hintFn?.('Click the opposite corner');
    expect(t.panel.hints.at(-1)).toBe('Click the opposite corner');
    expect(t.log.reveals).toBe(1);
  });

  it("the drawn box clips at the scan's full height, not the height between the two clicks", async () => {
    const t = await make({ vertical: scan });
    t.flow.drawClippingBox();
    // Two clicks 4.7 m apart on a 20 m scan: well over the 5 % flat rule.
    t.complete(summary({ id: 'b1', kind: 'box' }), box('b1', [1, 1, 3.5], [5, 6, 8.2]));
    t.btn('Isolate this box').click();
    const c = t.log.adopted[0];
    expect(c.box.min[2]).toBeLessThan(0);
    expect(c.box.max[2]).toBeGreaterThan(20);
    expect(c.box.min.slice(0, 2)).toEqual([1, 1]);
    expect(t.log.toasts[0]).toMatch(/full height/);
    expect(t.log.toasts[0]).toMatch(/Tools → Clip box/);
  });

  it('a box measured on the Measure page keeps the height it was drawn with', async () => {
    const t = await make({ vertical: scan, ms: [box('b1', [1, 1, 3.5], [5, 6, 8.2])] });
    expect(t.flow.isolate('b1')).toBe(true);
    expect(t.log.adopted[0].box.min[2]).toBe(3.5);
    expect(t.log.adopted[0].box.max[2]).toBe(8.2);
  });

  it('a box completed looking straight down (a plan box) is a footprint too', async () => {
    const t = await make({ vertical: scan, down: true });
    t.complete(summary({ id: 'b1', kind: 'box' }), box('b1', [1, 1, 3.5], [5, 6, 8.2]));
    t.btn('Use as clipping region').click();
    expect(t.log.adopted[0].box.max[2]).toBeGreaterThan(20);
  });

  it('after Isolate the Measure tool is off, so the next clicks do not start Box 2', async () => {
    const t = await make();
    t.flow.drawClippingBox();
    expect(t.state.on).toBe(true);
    t.complete(summary({ id: 'b1', kind: 'box' }), box('b1', [0, 0, 0], [4, 4, 4]));
    t.btn('Isolate this box').click();
    expect(t.log.stops).toBe(1);
    expect(t.state.on).toBe(false);
    expect(t.log.footprint.at(-1)).toBe(false);
    expect(t.panel.hints.at(-1)).toBeNull();
  });

  it('a box measured on purpose and used as the clip leaves the Measure tool on', async () => {
    const t = await make({ measureOn: true });
    t.complete(summary({ id: 'b1', kind: 'box' }), box('b1', [0, 0, 0], [4, 4, 4]));
    t.btn('Use as clipping region').click();
    expect(t.log.adopted).toHaveLength(1);
    expect(t.log.stops).toBe(0);
    expect(t.state.on).toBe(true);
  });

  it('Esc (the tool turned off) ends the drawing hint', async () => {
    const t = await make();
    t.flow.drawClippingBox();
    t.state.on = false;
    t.flow.onMeasurementsChanged();
    expect(t.panel.hints.at(-1)).toBeNull();
    expect(t.state.hintFn).toBeNull();
  });
});

describe('looksDown', () => {
  it('within 15 degrees of straight down along the scene up', async () => {
    const { looksDown } = await import('../src/app/clipFlow');
    expect(looksDown({ position: [0, 0, 100], target: [0, 0, 0] }, [0, 0, 1])).toBe(true);
    expect(looksDown({ position: [10, 0, 100], target: [0, 0, 0] }, [0, 0, 1])).toBe(true);
    expect(looksDown({ position: [100, 0, 100], target: [0, 0, 0] }, [0, 0, 1])).toBe(false);
    expect(looksDown({ position: [0, 100, 0], target: [0, 0, 0] }, [0, 1, 0])).toBe(true);
    expect(looksDown({ position: [0, 0, 0], target: [0, 0, 0] }, [0, 0, 1])).toBe(false);
  });
});

describe('Isolate this box', () => {
  it('a Box that follows Draw clipping box offers "Isolate this box"; a plain one the row wording', async () => {
    const t = await make();
    t.flow.drawClippingBox();
    t.complete(summary({ id: 'b1', kind: 'box', name: 'Box 1', value: '4 × 4 × 4 m' }), box('b1', [0, 0, 0], [4, 4, 4]));
    expect(t.btn('Isolate this box')).toBeDefined();

    const u = await make();
    u.complete(summary({ id: 'b1', kind: 'box', name: 'Box 1' }), box('b1', [0, 0, 0], [4, 4, 4]));
    expect(u.btn('Use as clipping region')).toBeDefined();
  });

  it('the card action, flow.isolate and the row action produce the same clip', async () => {
    const m = box('b1', [4, 4, 4], [0, 0, 0]);
    const viaCard = await make();
    viaCard.flow.drawClippingBox();
    viaCard.complete(summary({ id: 'b1', kind: 'box' }), m);
    viaCard.btn('Isolate this box').click();
    const viaRow = await make({ ms: [m] });
    expect(viaRow.flow.isolate('b1')).toBe(true);
    expect(viaCard.log.adopted).toEqual(viaRow.log.adopted);
    expect(viaCard.log.adopted[0]).toEqual({ box: { min: [0, 0, 0], max: [4, 4, 4] }, mode: 'keep-inside', enabled: true });
    expect(viaCard.log.toasts).toEqual(viaRow.log.toasts);
  });

  it('the measurement stays intact and the clip is an independent copy', async () => {
    const m = box('b1', [0, 0, 0], [4, 4, 4]);
    const t = await make({ ms: [m] });
    t.flow.isolate('b1');
    t.log.adopted[0].box.max[0] = 99;
    expect(m.points[1]).toEqual([4, 4, 4]);
    expect(t.state.ms).toHaveLength(1);
  });

  it('isolating closes the card and the chip takes over', async () => {
    const t = await make();
    t.complete(summary({ id: 'b1', kind: 'box' }), box('b1', [0, 0, 0], [4, 4, 4]));
    t.btn('Use as clipping region').click();
    expect(t.card.classList.contains('olv-hidden')).toBe(true);
    expect((t.flow.indicator.element as unknown as FakeEl).classList.contains('olv-hidden')).toBe(false);
  });

  it('refusals share one set of messages across both entry points and keep the card', async () => {
    const cases: Array<[string, BoxMeasurementLike, typeof one]> = [
      ['wrong ownership', box('b1', [0, 0, 0], [1, 1, 1], { owner: { layerId: 'other' } }), one],
      ['zero extent', box('b1', [0, 0, 0], [1, 1, 0]), one],
      ['non-finite', box('b1', [0, 0, 0], [Number.NaN, 1, 1]), one],
      ['unowned among many', box('b1', [0, 0, 0], [1, 1, 1]), { activeLayerId: 'L1', layerCount: 2 }],
    ];
    for (const [, m, ctx] of cases) {
      const row = await make({ ms: [m], ctx });
      expect(row.flow.isolate('b1')).toBe(false);
      const card = await make({ ms: [m], ctx });
      card.complete(summary({ id: 'b1', kind: 'box' }), m);
      card.btn('Use as clipping region').click();
      expect(card.log.toasts).toEqual(row.log.toasts);
      expect(card.log.toasts).toHaveLength(1);
      expect(card.log.adopted).toHaveLength(0);
      expect(card.card.classList.contains('olv-hidden')).toBe(false);
    }
  });
});

describe('result card', () => {
  it('shows the latest result with the list\'s own formatting', async () => {
    const t = await make();
    t.complete(summary({ id: 'd1', value: '12.35 m' }));
    expect(t.card.classList.contains('olv-hidden')).toBe(false);
    expect(t.card.textContent).toContain('Distance 1');
    expect(t.card.textContent).toContain('12.35 m');
  });

  it('distance and area offer Copy and Open details but not the clip action', async () => {
    for (const kind of ['distance', 'area'] as const) {
      const t = await make();
      t.complete(summary({ id: 'x', kind, value: '7 m' }));
      expect(t.btn('Use as clipping region').classList.contains('olv-hidden')).toBe(true);
      t.btn('Open details').click();
      expect(t.log.details).toEqual(['x']);
    }
  });

  it('Copy writes the exact authoritative string, caveat included', async () => {
    const t = await make();
    t.complete(summary({ value: '12.35 units (unverified)', unitUnverified: true }));
    t.btn('Copy result').click();
    await Promise.resolve();
    expect(t.log.copies).toEqual(['Distance 1: 12.35 units (unverified) (unit unverified (source units, not metres))']);
  });

  it('a withheld value reads as no value, is not copyable and never shows zero', async () => {
    const t = await make();
    t.complete(summary({ value: '—', trust: { grade: 'red', caption: 'Void endpoint', reasons: [], presentable: false } }));
    expect(t.card.textContent).toContain('No value to report');
    expect(t.card.textContent).toContain('Void endpoint');
    expect((t.btn('Copy result') as unknown as { disabled: boolean }).disabled).toBe(true);
    t.btn('Copy result').click();
    expect(t.log.copies).toHaveLength(0);
  });

  it('one instance: a second result replaces the first and listeners do not stack', async () => {
    const t = await make();
    t.complete(summary({ id: 'a', value: '1 m' }));
    t.complete(summary({ id: 'b', name: 'Distance 2', value: '2 m' }));
    expect(t.card.textContent).toContain('Distance 2');
    expect(t.card.textContent).not.toContain('Distance 1');
    expect(t.overlay.querySelectorAll('.olv-result-card')).toHaveLength(1);
    t.btn('Copy result').click();
    await Promise.resolve();
    expect(t.log.copies).toEqual(['Distance 2: 2 m']);
  });

  it('an edit in place refreshes the same figure; a delete hides it', async () => {
    const t = await make();
    t.complete(summary({ id: 'a', value: '1 m' }));
    t.state.sums = [summary({ id: 'a', value: '5 m' })];
    t.flow.onMeasurementsChanged();
    expect(t.card.textContent).toContain('5 m');
    t.state.sums = [];
    t.flow.onMeasurementsChanged();
    expect(t.card.classList.contains('olv-hidden')).toBe(true);
  });

  it('dismisses on the next tool activation, the close control and scan close', async () => {
    const t = await make();
    t.complete(summary({ id: 'a' }));
    t.flow.dismissCard();
    expect(t.card.classList.contains('olv-hidden')).toBe(true);
    t.complete(summary({ id: 'b' }));
    t.btn('×').click();
    expect(t.card.classList.contains('olv-hidden')).toBe(true);
    t.complete(summary({ id: 'c' }));
    t.flow.reset();
    expect(t.card.classList.contains('olv-hidden')).toBe(true);
  });

  it('a loaded set of measurements does not pop a card', async () => {
    const t = await make();
    t.state.sums = [summary({ id: 'a' }), summary({ id: 'b' }), summary({ id: 'c' })];
    t.flow.onMeasurementsChanged();
    expect(t.card.classList.contains('olv-hidden')).toBe(true);
  });
});

describe('active-clip chip', () => {
  const chip = (t: Awaited<ReturnType<typeof make>>) => t.flow.indicator.element as unknown as FakeEl;

  it('is hidden with no clip, shows the mode when on and follows Inside/Outside', async () => {
    const t = await make();
    expect(chip(t).classList.contains('olv-hidden')).toBe(true);
    t.panel.enabled = true; t.panel.emit();
    expect(chip(t).classList.contains('olv-hidden')).toBe(false);
    expect(chip(t).textContent).toContain('Clipping on · Showing inside box');
    t.panel.mode = 'keep-outside'; t.panel.emit();
    expect(chip(t).textContent).toContain('Clipping on · Showing outside box');
  });

  it('is a polite status, and its Turn off turns the clip off and hides the chip', async () => {
    const t = await make();
    t.panel.enabled = true; t.panel.emit();
    const status = chip(t).querySelectorAll('span')[0];
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    chip(t).querySelectorAll('button')[0].click();
    expect(t.panel.enabled).toBe(false);
    expect(chip(t).classList.contains('olv-hidden')).toBe(true);
    expect(chip(t).textContent).not.toContain('Clipping on');
  });

  it('is one instance with one panel subscription, released on dispose', async () => {
    const t = await make();
    expect(t.overlay.querySelectorAll('.olv-clip-indicator')).toHaveLength(1);
    expect(t.panel.listeners).toBe(1);
    t.flow.dispose();
    expect(t.panel.listeners).toBe(0);
  });
});

describe('the result card: Delete', () => {
  it('deletes the measurement through the list and hides the card', async () => {
    const t = await make();
    t.complete(summary({ id: 'd1', kind: 'distance', name: 'Line 1', value: '4.00 m' }));
    expect(t.card.classList.contains('olv-hidden')).toBe(false);
    const del = t.btn('Delete');
    expect(del.getAttribute('aria-label')).toBe('Delete Line 1');
    del.click();
    expect(t.log.deleted).toEqual(['d1']);
    expect(t.card.classList.contains('olv-hidden')).toBe(true);
  });
});
