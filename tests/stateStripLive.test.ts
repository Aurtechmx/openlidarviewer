/**
 * The state strip's live pieces: the task-activity store, the published
 * Analyse rows, the live-reads seam and the strip's rendering.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installLiveFakeDom, type FakeEl } from './helpers/liveFakeDom';
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
    expect(btn('basis').textContent).toContain('Resident only');
    expect(btn('review').textContent).toContain('2 to review');
    expect(btn('processing').textContent).toBe('Idle');
    btn('crs').fire('click');
    expect(open).toHaveBeenCalledWith('crs');
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

  it('shows the elapsed time and the estimate in their own span, out of the accessible name', async () => {
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
    expect(btn().querySelector('.olv-ss-wait')!.textContent).toBe('· 12 s elapsed');
    const name = btn().getAttribute('aria-label');
    expect(name).toBe('Processing: Analysing…. Opens Analyse');
    strip.render(task({ elapsedMs: 13_000 }));
    expect(btn().getAttribute('aria-label')).toBe(name);
    strip.render(task({ label: 'Exporting', progress: 0.25, elapsedMs: 6000, remainingMs: 18_000 }));
    expect(btn().querySelector('.olv-ss-text')!.textContent).toBe('Exporting 25%');
    expect(btn().querySelector('.olv-ss-wait')!.textContent).toBe('· 6 s elapsed, about 20 s left');
  });
});
