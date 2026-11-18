/**
 * The state strip's live pieces: the task-activity store, the published
 * Analyse rows, the live-reads seam and the strip's rendering.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installLiveFakeDom, type FakeEl } from './helpers/liveFakeDom';
import { withLiveRegion } from './helpers/politeLiveRegion';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import { deriveScanFacts } from '../src/process/scanFacts';
import { liveTasks, registerTask, resetTaskActivityForTests, subscribeTaskActivity } from '../src/process/taskActivity';
import { lastAnalysisRows, publishAnalysisRows, subscribeAnalysisRows } from '../src/process/analysisRowsFeed';
import { processingProvider } from '../src/process/stateProviders';
import { readStrip, type StripLiveReads } from '../src/app/stateStrip/stripReads';
import type { AnalysisRow } from '../src/process/analysisStatus';

beforeAll(() => installLiveFakeDom());
beforeEach(() => resetTaskActivityForTests());

const reads = (over: Partial<StripLiveReads> = {}): StripLiveReads => ({
  streamingName: () => null,
  activeCloudName: () => 'site.las',
  spatialContext: () => spatialContextFrom(null),
  resolvedCrs: () => null,
  scanFacts: () => deriveScanFacts({ kind: 'streaming' }),
  analysisRows: () => [{ id: 'terrain', status: 'review' }],
  results: () => [{ id: 'terrain:a', status: 'stale' }],
  tasks: () => [],
  ...over,
});

describe('task activity', () => {
  it('lists live tasks with the label and progress their host states, and forgets gone ones', () => {
    let live = true;
    let gone = false;
    const seen = vi.fn();
    subscribeTaskActivity(seen);
    const t = registerTask({ label: () => 'Opening scan', progress: () => 0.4, live: () => live, gone: () => gone });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(liveTasks(1000)).toEqual([{ id: t.id, label: 'Opening scan', progress: 0.4, elapsedMs: 0, remainingMs: null }]);
    live = false;
    expect(liveTasks(2000)).toMatchObject([{ id: t.id, elapsedMs: 1000 }]);
    gone = true;
    live = true;
    expect(liveTasks()).toEqual([]);
  });

  it('drops a source whose read throws and ends on request', () => {
    registerTask({ label: () => { throw new Error('x'); }, progress: () => null, live: () => true });
    expect(liveTasks()).toEqual([]);
    const t = registerTask({ label: () => 'Run', progress: () => null, live: () => true });
    t.end();
    expect(liveTasks()).toEqual([]);
  });

  it('times a task from when it is first seen live, and restarts the clock after it settles', () => {
    let settled = false;
    let fraction = 0.1;
    registerTask({ label: () => 'Export', progress: () => fraction, live: () => !settled, settled: () => settled });
    expect(liveTasks(5000)[0].elapsedMs).toBe(0);
    fraction = 0.2;
    expect(liveTasks(7000)[0]).toMatchObject({ elapsedMs: 2000, remainingMs: 16_000 });
    settled = true;
    expect(liveTasks(10_000)).toEqual([]);
    settled = false;
    fraction = 0;
    expect(liveTasks(12_000)[0]).toMatchObject({ elapsedMs: 0, remainingMs: null });
  });

  it('keeps a running task listed while it is hidden, until it settles', () => {
    let live = true;
    let settled = false;
    registerTask({ label: () => 'Opening', progress: () => null, live: () => live && !settled, settled: () => settled });
    liveTasks(0);
    live = false;
    expect(liveTasks(5000)).toMatchObject([{ label: 'Opening', elapsedMs: 5000 }]);
    settled = true;
    expect(liveTasks(6000)).toEqual([]);
    settled = false;
    expect(liveTasks(7000)).toEqual([]);
  });

  it('never carries a hidden task into the next run of its indicator', () => {
    let live = true;
    let run = '1';
    registerTask({ label: () => 'Opening', progress: () => null, live: () => live, run: () => run });
    liveTasks(0);
    live = false;
    run = '2';
    expect(liveTasks(30_000)).toEqual([]);
    live = true;
    expect(liveTasks(31_000)).toMatchObject([{ elapsedMs: 0 }]);
  });

  it('keeps the clock while a task is hidden and shown again', () => {
    // A steady 40 s task, hidden from 20 s to 24 s, listed throughout.
    let live = true;
    let now = 0;
    registerTask({ label: () => 'Export', progress: () => now / 40_000, live: () => live });
    for (; now <= 19_000; now += 1000) liveTasks(now);
    live = false;
    for (; now < 24_000; now += 1000) expect(liveTasks(now)[0].elapsedMs).toBe(now);
    live = true;
    for (; now <= 36_000; now += 1000) {
      const t = liveTasks(now)[0];
      expect(t.elapsedMs).toBe(now);
      const left = 40_000 - now;
      expect(Math.abs(t.remainingMs! - left), `at ${now} ms`).toBeLessThan(1500);
    }
  });

  it('a task with no progress gets elapsed time and never an estimate', () => {
    registerTask({ label: () => 'Analysing', progress: () => null, live: () => true });
    liveTasks(0);
    expect(liveTasks(30_000)[0]).toMatchObject({ elapsedMs: 30_000, remainingMs: null });
  });

  it('processing provider: idle, or the oldest task and a count of the rest', () => {
    expect(processingProvider([]).value).toEqual({ state: 'idle' });
    const p = processingProvider([
      { id: 1, label: 'Terrain', progress: 0.5, elapsedMs: 4000, remainingMs: 4000 },
      { id: 2, label: 'Export', progress: null, elapsedMs: 0, remainingMs: null },
    ]);
    expect(p.value).toEqual({ state: 'running', label: 'Terrain', progress: 0.5, more: 1, elapsedMs: 4000, remainingMs: 4000 });
    expect(p.source).toBe('task-activity');
  });
});

describe('analysis rows feed', () => {
  it('hands readers the published rows unchanged', () => {
    const rows = Object.freeze([{ id: 'terrain', label: 'Terrain', status: 'blocked', reason: 'r', remedy: null }]) as readonly AnalysisRow[];
    const fn = vi.fn();
    const off = subscribeAnalysisRows(fn);
    publishAnalysisRows(rows);
    expect(lastAnalysisRows()).toBe(rows);
    expect(fn).toHaveBeenCalledTimes(1);
    off();
  });
});

describe('strip reads', () => {
  it('is null with no scan open', () => {
    expect(readStrip(reads({ activeCloudName: () => null }))).toBeNull();
  });

  it('runs every provider on its owner value', () => {
    const s = readStrip(reads())!;
    expect(s.dataset.value).toBe('site.las');
    expect(s.basis?.value).toBe('resident-only');
    expect(s.vertical?.value.label).toBe('Vertical: unknown');
    expect(s.review?.value.count).toBe(2);
    expect(s.processing?.value).toEqual({ state: 'idle' });
  });

  it('a failing read drops only its own item', () => {
    const s = readStrip(reads({ spatialContext: () => { throw new Error('x'); }, results: () => { throw new Error('y'); } }))!;
    expect(s.horizontal).toBeNull();
    expect(s.review).toBeNull();
    expect(s.basis?.value).toBe('resident-only');
  });
});

describe('strip UI', () => {
  it('renders each fact as a labelled button that opens its place', async () => {
    const { createStateStrip } = await import('../src/ui/stateStrip');
    const open = vi.fn();
    const strip = createStateStrip({ open });
    const root = strip.element as unknown as FakeEl;
    strip.render(null);
    expect(root.hasClass('olv-hidden')).toBe(true);
    strip.render(readStrip(reads()));
    expect(root.hasClass('olv-hidden')).toBe(false);
    const btn = (id: string) => root.querySelector(`.olv-ss-${id}`)!;
    expect(btn('vertical').textContent).toContain('Vertical: unknown');
    expect(btn('vertical').getAttribute('aria-label')).toMatch(/^Vertical reference: Vertical: unknown \(Review\)\. Opens/);
    expect(btn('basis').textContent).toContain('Currently loaded points');
    expect(btn('review').textContent).toContain('2 to review');
    // Nothing is running, so the item is hidden rather than reading "Idle".
    expect(btn('processing').hidden).toBe(true);
    btn('crs').fire('click');
    expect(open).toHaveBeenCalledWith('crs');
  });

  it('hides the processing item when the task leaves, with no task text left behind', async () => {
    const { createStateStrip } = await import('../src/ui/stateStrip');
    const strip = createStateStrip({ open: vi.fn() });
    const root = strip.element as unknown as FakeEl;
    const btn = () => root.querySelector('.olv-ss-processing')!;
    strip.render(readStrip(reads({ tasks: () => [{ id: 1, label: 'Loading current view…', progress: 0.2, elapsedMs: 0, remainingMs: null }] })));
    expect(btn().hidden).toBe(false);
    expect(btn().textContent).toBe('Loading current view… 20%');
    strip.render(readStrip(reads({ tasks: () => [] })));
    expect(btn().hidden).toBe(true);
    expect(btn().textContent).toBe('');
    expect(btn().getAttribute('aria-label')).toBeNull();
    // A task that starts again is painted afresh.
    strip.render(readStrip(reads({ tasks: () => [{ id: 2, label: 'Exporting', progress: null, elapsedMs: 0, remainingMs: null }] })));
    expect(btn().hidden).toBe(false);
    expect(btn().textContent).toBe('Exporting');
  });

  it('shows an active clip with its kept count, and hides the item when no clip is on', async () => {
    const { createStateStrip } = await import('../src/ui/stateStrip');
    const open = vi.fn();
    const strip = createStateStrip({ open });
    const root = strip.element as unknown as FakeEl;
    const btn = () => root.querySelector('.olv-ss-clip')!;
    strip.render(readStrip(reads()));
    expect(btn().hidden).toBe(true);
    strip.render(readStrip(reads({ clip: () => ({ kept: 16739, total: 31839 }) })));
    expect(btn().hidden).toBe(false);
    expect(btn().textContent).toContain(`Clipped: ${(16739).toLocaleString()} of ${(31839).toLocaleString()} points`);
    btn().fire('click');
    expect(open).toHaveBeenCalledWith('clip');
  });

  it('shows the clip item with the side kept and Turn off when there is no count, and hides it when clip is off', async () => {
    const { createStateStrip } = await import('../src/ui/stateStrip');
    const strip = createStateStrip({ open: vi.fn() });
    const root = strip.element as unknown as FakeEl;
    const item = () => root.querySelector('.olv-ss-clip')!;
    const off = () => root.querySelector('.olv-ss-clipoff')!;
    // A streamed scan: clip on, no kept count.
    strip.render(readStrip(reads({ clip: () => null, clipOn: () => 'keep-inside' })));
    expect(item().hidden).toBe(false);
    expect(item().textContent).toBe('Clip on · Showing inside box');
    expect(off().hidden).toBe(false);
    strip.render(readStrip(reads({ clip: () => null, clipOn: () => 'keep-outside' })));
    expect(item().textContent).toBe('Clip on · Showing outside box');
    // Counted: the protected phrase, then the side.
    strip.render(readStrip(reads({ clip: () => ({ kept: 1234, total: 3600, mode: 'keep-inside' }), clipOn: () => 'keep-inside' })));
    expect(item().textContent).toBe(`Clipped: ${(1234).toLocaleString()} of ${(3600).toLocaleString()} points · Showing inside box`);
    // Off: both go.
    strip.render(readStrip(reads({ clip: () => null, clipOn: () => null })));
    expect(item().hidden).toBe(true);
    expect(off().hidden).toBe(true);
  });

  it('keeps the clip item itself at full width: no shrink, no cap, outranking the phone item rule', async () => {
    // A text-level check only: it reads the rules, it does not lay the strip out.
    // Real overlap is for the packaged-build walkthrough to confirm.
    const css = (await import('node:fs')).readFileSync(new URL('../src/ui/stateStrip.css', import.meta.url), 'utf8');
    const rule = /(^|\n)\s*([^{}@]*\.olv-ss-clip(?![\w-])[^{}]*)\{([^}]*)\}/g;
    let clipItem: { selector: string; body: string } | null = null;
    for (const m of css.matchAll(rule)) {
      const selector = m[2].trim();
      if (!/\.olv-ss-text/.test(selector)) clipItem = { selector, body: m[3] };
    }
    expect(clipItem, 'no rule for the clip item itself').not.toBeNull();
    expect(clipItem!.body).toMatch(/flex-shrink:\s*0/);
    expect(clipItem!.body).toMatch(/max-width:\s*none/);
    // Class count stands in for specificity: these selectors hold classes only.
    const classes = (sel: string): number => (sel.match(/\.[\w-]+/g) ?? []).length;
    const phone = /@media[^{]*\{[\s\S]*?\n\s*(\.olv-ss-item)\s*\{[^}]*max-width:\s*100%/.exec(css);
    expect(phone, 'the phone .olv-ss-item max-width rule moved').not.toBeNull();
    expect(classes(clipItem!.selector)).toBeGreaterThan(classes(phone![1]));
  });

  it('does not cap the clip item text, so the side phrase is never cut', async () => {
    const css = (await import('node:fs')).readFileSync(new URL('../src/ui/stateStrip.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.olv-ss-clip \.olv-ss-text\s*\{[^}]*max-width:\s*none/);
  });

  it('says which side of the box is kept, and offers Turn off beside the clip item', async () => {
    const { createStateStrip } = await import('../src/ui/stateStrip');
    const { setClipTurnOff } = await import('../src/render/clip/clipScope');
    const strip = createStateStrip({ open: vi.fn() });
    const root = strip.element as unknown as FakeEl;
    const off = () => root.querySelector('.olv-ss-clipoff')!;
    strip.render(readStrip(reads()));
    expect(off().hidden).toBe(true);
    strip.render(readStrip(reads({ clip: () => ({ kept: 5, total: 9, mode: 'keep-inside' }) })));
    expect(root.querySelector('.olv-ss-clip')!.textContent).toBe('Clipped: 5 of 9 points · Showing inside box');
    strip.render(readStrip(reads({ clip: () => ({ kept: 9, total: 9, mode: 'keep-outside' }) })));
    expect(root.querySelector('.olv-ss-clip')!.textContent).toBe('Clip on: keeps all 9 points · Showing outside box');
    expect(off().hidden).toBe(false);
    expect(off().getAttribute('aria-label')).toBe('Turn off clipping');
    const clear = vi.fn();
    setClipTurnOff(clear);
    off().fire('click');
    expect(clear).toHaveBeenCalledTimes(1);
    setClipTurnOff(null);
  });

  describe('clip announcements', () => {
    /** Run `body` with the app's polite region installed and fake timers, then remove both. */
    const withRegion = async (body: (history: string[]) => Promise<void>): Promise<void> => {
      vi.useFakeTimers();
      const { history } = withLiveRegion();
      const doc = (globalThis as unknown as { document: Record<string, unknown> }).document;
      // dispose() clears the strip height it publishes on the root element.
      doc.documentElement = { style: { removeProperty: () => {} } };
      try {
        await body(history);
      } finally {
        vi.useRealTimers();
        delete doc.querySelector;
        delete doc.documentElement;
      }
    };
    const on = (kept: number, total: number, mode: 'keep-inside' | 'keep-outside') =>
      readStrip(reads({ clip: () => ({ kept, total, mode }), clipOn: () => mode }));
    const streamed = (mode: 'keep-inside' | 'keep-outside' | null) => readStrip(reads({ clip: () => null, clipOn: () => mode }));

    it('turning the clip on, changing side and turning it off each announce once, politely', async () => {
      await withRegion(async (history) => {
        const { createStateStrip } = await import('../src/ui/stateStrip');
        const strip = createStateStrip({ open: vi.fn() });
        const root = strip.element as unknown as FakeEl;
        strip.render(readStrip(reads()));
        expect(history).toEqual([]);
        strip.render(on(5, 9, 'keep-inside'));
        // Spoken with a comma; the strip itself still shows the middle dot.
        expect(root.querySelector('.olv-ss-clip')!.textContent).toBe('Clipped: 5 of 9 points · Showing inside box');
        // A repaint, and a count change on the same side, say nothing new.
        strip.render(on(5, 9, 'keep-inside'));
        strip.render(on(6, 9, 'keep-inside'));
        expect(history).toEqual(['Clipped: 5 of 9 points, Showing inside box']);
        strip.render(on(3, 9, 'keep-outside'));
        expect(history).toEqual(['Clipped: 5 of 9 points, Showing inside box', 'Clipped: 3 of 9 points, Showing outside box']);
        strip.render(streamed(null));
        strip.render(streamed(null));
        vi.advanceTimersByTime(5000);
        expect(history).toEqual([
          'Clipped: 5 of 9 points, Showing inside box',
          'Clipped: 3 of 9 points, Showing outside box',
          'Clip off',
        ]);
        // Through the app's one polite region: the strip mints no live region of its own.
        expect(root.findAll((n) => n.getAttribute('aria-live') !== null || n.getAttribute('role') === 'status')).toEqual([]);
        strip.dispose();
      });
    });

    it('waits briefly for the count of a clip just turned on, and says the side alone when no count comes', async () => {
      await withRegion(async (history) => {
        const { createStateStrip } = await import('../src/ui/stateStrip');
        const strip = createStateStrip({ open: vi.fn() });
        strip.render(readStrip(reads()));
        // On, count pending: nothing yet; the count lands and is said with it, once.
        strip.render(streamed('keep-inside'));
        expect(history).toEqual([]);
        strip.render(on(5, 9, 'keep-inside'));
        vi.advanceTimersByTime(5000);
        expect(history).toEqual(['Clipped: 5 of 9 points, Showing inside box']);
        history.length = 0;
        strip.render(streamed(null));
        // A streamed scan has no count: the clip and its side are said on their own.
        strip.render(streamed('keep-inside'));
        vi.advanceTimersByTime(5000);
        strip.render(streamed('keep-outside'));
        vi.advanceTimersByTime(5000);
        expect(history).toEqual(['Clip off', 'Clip on, Showing inside box', 'Clip on, Showing outside box']);
        // On and off again before anything was said: nothing is said.
        strip.render(streamed(null));
        history.length = 0;
        strip.render(streamed('keep-inside'));
        strip.render(streamed(null));
        vi.advanceTimersByTime(5000);
        expect(history).toEqual([]);
        strip.dispose();
      });
    });

    it('closing the scan says nothing, and the next scan does not hear an old clip turned off', async () => {
      await withRegion(async (history) => {
        const { createStateStrip } = await import('../src/ui/stateStrip');
        const strip = createStateStrip({ open: vi.fn() });
        strip.render(on(5, 9, 'keep-inside'));
        strip.render(null);
        strip.render(readStrip(reads()));
        vi.advanceTimersByTime(5000);
        expect(history).toEqual(['Clipped: 5 of 9 points, Showing inside box']);
        // A clip waiting for its count is dropped with the strip.
        strip.render(streamed('keep-inside'));
        strip.dispose();
        vi.advanceTimersByTime(5000);
        expect(history).toEqual(['Clipped: 5 of 9 points, Showing inside box']);
      });
    });
  });

  describe('the clip item on a touch phone', () => {
    /** Layout numbers the fake DOM does not compute. */
    type Box = { offsetLeft: number; offsetWidth: number; clientWidth: number; scrollLeft: number };
    const setBox = (n: FakeEl, b: Partial<Box>): void => { Object.assign(n, b); };
    const box = (n: FakeEl): Box => n as unknown as Box;

    /** A strip whose row runs past a 300 px screen: the clip item at 400..600, Turn off at 600..660. */
    const make = async (phone: boolean) => {
      const { createStateStrip, STRIP_SCROLL_QUERY } = await import('../src/ui/stateStrip');
      vi.stubGlobal('matchMedia', (q: string) => ({ matches: phone && q === STRIP_SCROLL_QUERY }));
      vi.stubGlobal('getComputedStyle', () => ({ paddingLeft: '4px', paddingRight: '32px' }));
      const strip = createStateStrip({ open: vi.fn() });
      const root = strip.element as unknown as FakeEl;
      const item = root.querySelector('.olv-ss-clip')!;
      const off = root.querySelector('.olv-ss-clipoff')!;
      const scrolled = vi.fn();
      (item as unknown as { scrollIntoView: () => void }).scrollIntoView = scrolled;
      setBox(root, { clientWidth: 300, scrollLeft: 0 });
      setBox(item, { offsetLeft: 400, offsetWidth: 200 });
      setBox(off, { offsetLeft: 600, offsetWidth: 60 });
      return { strip, root, scrolled };
    };
    const clipOn = (kept: number) => readStrip(reads({ clip: () => ({ kept, total: 9, mode: 'keep-inside' }), clipOn: () => 'keep-inside' }));

    it('scrolls the strip, and only the strip, to show the clip item and Turn off when it appears', async () => {
      try {
        const { strip, root, scrolled } = await make(true);
        strip.render(readStrip(reads()));
        expect(box(root).scrollLeft).toBe(0);
        strip.render(clipOn(5));
        // Turn off's right edge (660) clears the 32 px fade at the strip's end.
        expect(box(root).scrollLeft).toBe(660 - (300 - 32));
        expect(scrolled).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('brings it back when its text changes, and leaves the strip where the user put it otherwise', async () => {
      try {
        const { strip, root } = await make(true);
        strip.render(clipOn(5));
        box(root).scrollLeft = 0;
        // The same facts again: the user's scroll stays.
        strip.render(clipOn(5));
        expect(box(root).scrollLeft).toBe(0);
        strip.render(clipOn(6));
        expect(box(root).scrollLeft).toBe(392);
        // Scrolled past it: the item's start comes back into view.
        box(root).scrollLeft = 500;
        strip.render(clipOn(7));
        expect(box(root).scrollLeft).toBe(400 - 4);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('does not scroll outside the touch-phone layout', async () => {
      try {
        const { strip, root } = await make(false);
        strip.render(clipOn(5));
        expect(box(root).scrollLeft).toBe(0);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('uses the same media condition as the stylesheet rule that makes the strip scroll', async () => {
      const { STRIP_SCROLL_QUERY } = await import('../src/ui/stateStrip');
      const css = (await import('node:fs')).readFileSync(new URL('../src/ui/stateStrip.css', import.meta.url), 'utf8');
      const rule = new RegExp(`@media ${STRIP_SCROLL_QUERY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{\\s*\\.olv-state-strip \\{[^}]*overflow-x: auto`);
      expect(css).toMatch(rule);
    });
  });

  it('shows the elapsed time and the estimate in their own span, out of the accessible name and the button text', async () => {
    const { createStateStrip } = await import('../src/ui/stateStrip');
    const strip = createStateStrip({ open: vi.fn() });
    const root = strip.element as unknown as FakeEl;
    const btn = () => root.querySelector('.olv-ss-processing')!;
    const task = (t: Partial<{ label: string; progress: number | null; elapsedMs: number; remainingMs: number | null }>) =>
      readStrip(reads({ tasks: () => [{ id: 1, label: 'Analysing…', progress: null, elapsedMs: 0, remainingMs: null, ...t }] }));
    strip.render(task({ elapsedMs: 500 }));
    expect(btn().querySelector('.olv-ss-wait')).toBeNull();
    strip.render(task({ elapsedMs: 12_000 }));
    expect(btn().querySelector('.olv-ss-text')!.textContent).toBe('Analysing…');
    expect(btn().querySelector('.olv-ss-wait')!.dataset.wait).toBe('· 12 s elapsed');
    expect(btn().querySelector('.olv-ss-wait')!.getAttribute('aria-hidden')).toBe('true');
    expect(btn().textContent).not.toContain('elapsed');
    const name = btn().getAttribute('aria-label');
    expect(name).toBe('Processing: Analysing…. Opens Analyse');
    strip.render(task({ elapsedMs: 13_000 }));
    expect(btn().getAttribute('aria-label')).toBe(name);
    strip.render(task({ label: 'Exporting', progress: 0.25, elapsedMs: 6000, remainingMs: 18_000 }));
    expect(btn().querySelector('.olv-ss-text')!.textContent).toBe('Exporting 25%');
    expect(btn().querySelector('.olv-ss-wait')!.dataset.wait).toBe('· 6 s elapsed, about 20 s left');
  });
});
