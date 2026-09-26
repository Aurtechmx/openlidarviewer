/**
 * resultsIndex.test.ts
 *
 * The Results shelf's read-only index and the shelf's Focus and Export
 * actions. Each result type appears, updates and disappears with its owner;
 * updates arrive through the owners' own signals with no timer; Focus routes
 * and aims without calling into an analysis, so the owner's result is the
 * same object with the same digest afterwards; a result from another layer
 * says so and never changes the active layer; titles render as text.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { FakeEl, installLiveFakeDom } from './helpers/liveFakeDom';
import {
  contourSource,
  createResultsIndex,
  dtmAim,
  findingsSource,
  measurementSource,
  signalSources,
  terrainSource,
  type ContourReader,
  type DtmExtent,
  type FindingsReader,
  type MeasurementReader,
  type TerrainReader,
} from '../src/app/results/resultsIndex';
import { createResultsShelf } from '../src/app/results/resultsShelf';
import { poseAt } from '../src/app/results/resultsShelfMount';
import {
  announceObservatoryRunner,
  labRun,
  observatoryRunnerView,
  publishLabRun,
  resetResultSignalsForTest,
  subscribeResultSignals,
} from '../src/app/results/resultSignals';
import { SessionFindings } from '../src/render/measure/sessionFindings';

beforeAll(installLiveFakeDom);
beforeEach(() => resetResultSignalsForTest());

type M = ReturnType<MeasurementReader['getMeasurements']>[number];
type Layer = NonNullable<ReturnType<NonNullable<ReturnType<ContourReader['getContourLayers']>>['layerFor']>>;

/** A 3 x 2 grid, 2 m cells, origin (10, 20), every cell covered at 5 m. */
function grid(): DtmExtent {
  return { cols: 3, rows: 2, cellSizeM: 2, originH1: 10, originH2: 20, z: new Float32Array(6).fill(5), coverage: new Uint8Array(6).fill(1) };
}

class FakeTerrain implements TerrainReader {
  ref: ReturnType<TerrainReader['resultRef']> = null;
  private fns = new Set<() => void>();
  resultRef() { return this.ref; }
  subscribeResult(fn: () => void) { this.fns.add(fn); return () => { this.fns.delete(fn); }; }
  set(ref: ReturnType<TerrainReader['resultRef']>) { this.ref = ref; for (const f of [...this.fns]) f(); }
  get listeners() { return this.fns.size; }
}

class FakeRunner implements ContourReader {
  layers = new Map<string, Layer>();
  private fns = new Set<() => void>();
  service: { layerFor(id: string): Layer | undefined } | null = null;
  getContourLayers() { return this.service; }
  subscribeDerivedLayers(fn: () => void) { this.fns.add(fn); return () => { this.fns.delete(fn); }; }
  put(id: string, l: Layer) { this.service ??= { layerFor: (x) => this.layers.get(x) }; this.layers.set(id, l); this.emit(); }
  clear() { this.layers.clear(); this.emit(); }
  emit() { for (const f of [...this.fns]) f(); }
}

class FakeExport implements FindingsReader {
  ledger: SessionFindings | null = null;
  private fns = new Set<() => void>();
  findingsLedger() { return this.ledger; }
  watchFindings(fn: () => void) { this.fns.add(fn); return () => { this.fns.delete(fn); }; }
  build() { this.ledger = new SessionFindings(); this.ledger.subscribe(() => { for (const f of [...this.fns]) f(); }); for (const f of [...this.fns]) f(); }
}

function owners(active: () => string | null = () => 'a') {
  const measurements: M[] = [];
  const measure: MeasurementReader = { getMeasurements: () => measurements };
  const terrain = new FakeTerrain();
  const runner = new FakeRunner();
  const exp = new FakeExport();
  const scanIds = ['a', 'b'];
  let t = 1000;
  const index = createResultsIndex([
    measurementSource(() => measure, (id) => id, active),
    terrainSource(() => terrain),
    contourSource(() => runner, () => scanIds),
    signalSources({ observatory: observatoryRunnerView, lab: labRun, subscribe: subscribeResultSignals }, active, () => null),
    findingsSource(() => exp),
  ], () => (t += 1000));
  index.refresh();
  return { index, measurements, terrain, runner, exp };
}

function fakeObservatory() {
  let state: { phase: string; outcome?: { status: string; record?: { id: string } } } = { phase: 'idle' };
  const fns = new Set<() => void>();
  return {
    getState: () => state,
    subscribe: (fn: () => void) => { fns.add(fn); return () => { fns.delete(fn); }; },
    set(s: typeof state) { state = s; for (const f of [...fns]) f(); },
  };
}

describe('results index: one test per owner, pushed with no timer', () => {
  it('measurements appear, update and leave on a sync', () => {
    const o = owners();
    o.measurements.push({ id: 'm1', name: 'Distance 1', points: [[0, 0, 0], [2, 0, 0]] });
    o.index.refresh();
    expect(o.index.entries()[0]).toMatchObject({ type: 'measurement', anchor: [1, 0, 0], route: { mode: 'work', page: 'measure' }, exportProduct: 'measurements', sourceIdentity: 'a' });
    o.measurements[0] = { ...o.measurements[0]!, name: 'Kerb height' };
    o.index.refresh();
    expect(o.index.entries()[0]!.title).toBe('Kerb height');
    o.measurements.length = 0;
    o.index.refresh();
    expect(o.index.entries()).toHaveLength(0);
  });

  it('the terrain result arrives on its own signal and aims at the grid extent', () => {
    vi.useFakeTimers();
    const o = owners();
    o.terrain.set({ result: { dtm: grid() }, scanId: 'a', fresh: true, filename: 'site.laz', sceneUpAxis: 'z' });
    expect(vi.getTimerCount()).toBe(0);
    const e = o.index.entries()[0]!;
    expect(e).toMatchObject({ type: 'terrain', title: 'Terrain surface, site.laz', route: { mode: 'analyse', page: 'terrain' }, exportProduct: 'terrain-dem', status: 'ready' });
    expect(e.anchor).toEqual([12, 21, 5]);
    expect(e.fit).toBeCloseTo(Math.hypot(3, 2));
    o.terrain.set({ ...o.terrain.ref!, fresh: false });
    expect(o.index.entries()[0]!.status).toBe('stale');
    o.terrain.set(null);
    expect(o.index.entries()).toHaveLength(0);
    vi.useRealTimers();
  });

  it('contours arrive once the store exists and leave when it clears', () => {
    const o = owners();
    o.runner.put('a', { name: 'Contours, site.laz', visible: true, sourceScanIds: ['a'], bounds: [0, 0, 0, 10, 10, 2] });
    expect(o.index.entries()[0]).toMatchObject({ type: 'contours', anchor: [5, 5, 1], exportProduct: 'contours' });
    o.runner.put('a', { name: 'Contours, site.laz', visible: false, sourceScanIds: ['a'], bounds: null });
    expect(o.index.entries()[0]!.status).toBe('hidden');
    o.runner.clear();
    expect(o.index.entries()).toHaveLength(0);
  });

  it('an Observatory run arrives when the runner commits and leaves when it resets', () => {
    const o = owners();
    const obs = fakeObservatory();
    announceObservatoryRunner(obs);
    expect(o.index.entries()).toHaveLength(0);
    obs.set({ phase: 'committed', outcome: { status: 'ok', record: { id: 'run-1' } } });
    expect(o.index.entries()[0]).toMatchObject({ id: 'observatory:run-1', route: { mode: 'analyse', page: 'observatory' }, sourceIdentity: 'a' });
    obs.set({ phase: 'idle' });
    expect(o.index.entries()).toHaveLength(0);
  });

  it('Flow Pulse and Terrain Access runs arrive when published and leave on invalidation', () => {
    const o = owners();
    const outcome = { ok: true };
    publishLabRun('flow-pulse', { outcome, layerId: 'a', filename: 'site.laz' });
    publishLabRun('terrain-access', { outcome: { ok: true }, layerId: 'a', filename: null });
    const types = o.index.entries().map((e) => e.type).sort();
    expect(types).toEqual(['flow-pulse', 'terrain-access']);
    expect(o.index.entries().find((e) => e.type === 'flow-pulse')).toMatchObject({ title: 'Flow Pulse run, site.laz', route: { mode: 'analyse', page: 'flow' } });
    expect(labRun('flow-pulse')!.outcome).toBe(outcome);
    publishLabRun('flow-pulse', null);
    publishLabRun('terrain-access', null);
    expect(o.index.entries()).toHaveLength(0);
  });

  it('findings arrive once the ledger is built and follow its changes', () => {
    const o = owners();
    o.exp.build();
    o.exp.ledger!.retarget('a');
    o.exp.ledger!.add({ label: 'Stockpile volume', value: 12.5, unit: 'm³' });
    expect(o.index.entries()[0]).toMatchObject({ type: 'finding', title: 'Stockpile volume, 12.5 m³', sourceIdentity: 'a', route: { mode: 'output', page: null }, exportProduct: 'findings' });
    const id = o.index.entries()[0]!.id;
    o.exp.ledger!.add({ label: 'Area', value: 3, unit: 'm²' });
    expect(o.index.entries().map((e) => e.id)).toContain(id);
    o.exp.ledger!.clear();
    expect(o.index.entries()).toHaveLength(0);
  });

  it('empties when the scan closes', () => {
    const o = owners();
    o.measurements.push({ id: 'm1', name: 'Distance 1', points: [] });
    o.terrain.set({ result: { dtm: grid() }, scanId: 'a', fresh: true, filename: null, sceneUpAxis: 'z' });
    o.runner.put('a', { name: 'Contours', visible: true, sourceScanIds: ['a'], bounds: null });
    publishLabRun('flow-pulse', { outcome: {}, layerId: 'a', filename: null });
    o.index.refresh();
    expect(o.index.entries()).toHaveLength(4);
    o.measurements.length = 0;
    o.terrain.set(null);
    o.runner.clear();
    publishLabRun('flow-pulse', null);
    expect(o.index.entries()).toHaveLength(0);
  });

  it('holds references and display fields only', () => {
    const o = owners();
    o.terrain.set({ result: { dtm: grid() }, scanId: 'a', fresh: true, filename: 'x.laz', sceneUpAxis: 'z' });
    expect(Object.keys(o.index.entries()[0]!).sort()).toEqual(
      ['anchor', 'createdAt', 'exportProduct', 'fit', 'id', 'route', 'sourceIdentity', 'status', 'title', 'type'],
    );
  });

  it('subscribes once per owner and lets go on dispose', () => {
    const o = owners();
    o.index.refresh();
    o.index.refresh();
    expect(o.terrain.listeners).toBe(1);
    o.index.dispose();
    expect(o.terrain.listeners).toBe(0);
  });

  it('maps a stable owner to its layer and stamps the active layer when there is none', () => {
    const ms: M[] = [
      { id: 'm1', name: 'Owned', points: [], owner: { layerId: 'stable-b' } },
      { id: 'm2', name: 'Unowned', points: [] },
    ];
    let active = 'a';
    const index = createResultsIndex([measurementSource(
      () => ({ getMeasurements: () => ms }),
      (stable) => (stable === 'stable-b' ? 'b' : null),
      () => active,
    )]);
    index.refresh();
    active = 'b';
    index.refresh();
    const by = (t: string) => index.entries().find((e) => e.title === t)!.sourceIdentity;
    expect(by('Owned')).toBe('b');
    expect(by('Unowned')).toBe('a');
  });

  it('survives an owner that throws mid-teardown', () => {
    const index = createResultsIndex([{ list: () => { throw new Error('gone'); } }]);
    expect(() => index.refresh()).not.toThrow();
    expect(index.entries()).toHaveLength(0);
  });

  it('places a Y-up grid the way the overlays do', () => {
    expect(dtmAim(grid(), 'y')!.anchor).toEqual([12, 5, -21]);
  });
});

describe('results shelf actions', () => {
  function shelfFor(active: string | null) {
    const o = owners(() => 'a');
    const result = { dtm: grid(), digest: 'sha256:abc' };
    o.terrain.set({ result, scanId: 'a', fresh: true, filename: 'north.laz', sceneUpAxis: 'z' });
    o.measurements.push({ id: 'm1', name: '<img src=x onerror=alert(1)>', points: [[4, 4, 4]], owner: { layerId: 'a' } });
    o.index.refresh();
    const navigate = vi.fn();
    const aim = vi.fn();
    const exportTo = vi.fn(() => true);
    const shelf = createResultsShelf({
      index: o.index,
      navigate,
      aim,
      exportTo,
      activeLayerId: () => active,
      layerName: (id) => (id === 'a' ? 'north.laz' : 'south.laz'),
    });
    return { o, shelf, navigate, aim, exportTo, result };
  }

  it('routes to the owning page and aims without recomputing', () => {
    const s = shelfFor('a');
    const before = JSON.stringify({ ...s.result, dtm: { ...s.result.dtm, z: Array.from(s.result.dtm.z) } });
    const ref = s.result;
    expect(s.shelf.focusResult('measurement:m1')).toBe(true);
    expect(s.navigate).toHaveBeenCalledWith({ mode: 'work', page: 'measure' });
    expect(s.aim).toHaveBeenCalledWith([4, 4, 4], null);
    expect(s.shelf.focusResult('terrain:a')).toBe(true);
    expect(s.navigate).toHaveBeenLastCalledWith({ mode: 'analyse', page: 'terrain' });
    expect(s.aim).toHaveBeenLastCalledWith([12, 21, 5], expect.closeTo(Math.hypot(3, 2)));
    expect(JSON.stringify({ ...s.result, dtm: { ...s.result.dtm, z: Array.from(s.result.dtm.z) } })).toBe(before);
    expect(s.o.terrain.ref!.result).toBe(ref);
  });

  it('Export hands the product to the Export mode', () => {
    const s = shelfFor('a');
    const root = s.shelf.element as unknown as FakeEl;
    root.find((e) => e.dataset.resultId === 'terrain:a')!.find((e) => e.hasClass('olv-results-export'))!.fire('click');
    expect(s.exportTo).toHaveBeenCalledWith('terrain-dem');
    expect(root.find((e) => e.hasClass('olv-results-live'))!.ownText).toBe('Export opened with Terrain surface, north.laz selected.');
  });

  it('names another source and leaves the active layer alone', () => {
    const s = shelfFor('b');
    const root = s.shelf.element as unknown as FakeEl;
    const row = root.find((e) => e.dataset.resultId === 'terrain:a')!;
    expect(row.hasClass('is-other-source')).toBe(true);
    expect(row.textContent).toContain('From north.laz');
    s.shelf.focusResult('terrain:a');
    const live = root.find((e) => e.hasClass('olv-results-live'))!;
    expect(live.ownText).toBe('Showing Terrain surface, north.laz from north.laz. The active layer is unchanged.');
  });

  it('moves the other-layer note when the active layer changes', () => {
    let active = 'a';
    const o = owners();
    o.terrain.set({ result: { dtm: grid() }, scanId: 'a', fresh: true, filename: 'north.laz', sceneUpAxis: 'z' });
    const shelf = createResultsShelf({ index: o.index, navigate: vi.fn(), aim: vi.fn(), exportTo: vi.fn(() => true), activeLayerId: () => active, layerName: () => 'north.laz' });
    const row = () => (shelf.element as unknown as FakeEl).find((e) => e.dataset.resultId === 'terrain:a')!;
    expect(row().hasClass('is-other-source')).toBe(false);
    active = 'b';
    shelf.sync();
    expect(row().hasClass('is-other-source')).toBe(true);
  });

  it('renders titles as text and shows the count', () => {
    const s = shelfFor('a');
    const root = s.shelf.element as unknown as FakeEl;
    const title = root.find((e) => e.hasClass('olv-results-title') && e.ownText.startsWith('<img'))!;
    expect(title.children).toHaveLength(0);
    expect(root.find((e) => e.hasClass('olv-results-count'))!.ownText).toBe('2');
    const toggle = root.find((e) => e.hasClass('olv-results-toggle'))!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    s.shelf.setExpanded(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const groups = root.findAll((e) => e.hasClass('olv-results-group')).map((g) => g.ownText);
    expect(groups).toEqual(['Measurements', 'Terrain']);
  });

  it('keeps the viewing distance, or fits a radius', () => {
    expect(poseAt({ position: [10, 0, 5], target: [0, 0, 0] }, [1, 2, 3]))
      .toEqual({ position: [11, 2, 8], target: [1, 2, 3] });
    const fitted = poseAt({ position: [10, 0, 0], target: [0, 0, 0] }, [1, 2, 3], 5);
    expect(fitted.position).toEqual([13, 2, 3]);
  });
});
