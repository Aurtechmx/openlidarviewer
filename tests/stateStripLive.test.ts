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
    expect(liveTasks()).toEqual([{ id: t.id, label: 'Opening scan', progress: 0.4 }]);
    live = false;
    expect(liveTasks()).toEqual([]);
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

  it('processing provider: idle, or the oldest task and a count of the rest', () => {
    expect(processingProvider([]).value).toEqual({ state: 'idle' });
    const p = processingProvider([{ id: 1, label: 'Terrain', progress: 0.5 }, { id: 2, label: 'Export', progress: null }]);
    expect(p.value).toEqual({ state: 'running', label: 'Terrain', progress: 0.5, more: 1 });
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
});
