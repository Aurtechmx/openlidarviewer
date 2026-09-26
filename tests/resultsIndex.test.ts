/**
 * resultsIndex.test.ts
 *
 * The Results shelf's read-only index and the shelf's Focus action: each
 * result type appears, updates and disappears with its owner (a closed scan
 * empties its owners, so it empties the index); Focus navigates and aims the
 * camera without calling into an analysis, so the owner's result is the same
 * object with the same digest afterwards; a result from another layer says so
 * and never changes the active layer; titles render as text.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { FakeEl, installLiveFakeDom } from './helpers/liveFakeDom';
import {
  contourSource,
  createResultsIndex,
  measurementSource,
  terrainSource,
  type ContourReader,
  type MeasurementReader,
  type TerrainReader,
} from '../src/app/results/resultsIndex';
import { createResultsShelf } from '../src/app/results/resultsShelf';
import { poseAt } from '../src/app/results/resultsShelfMount';

beforeAll(installLiveFakeDom);

type M = ReturnType<MeasurementReader['getMeasurements']>[number];

function owners() {
  const measurements: M[] = [];
  const measure: MeasurementReader = { getMeasurements: () => measurements };
  let terrainInput: { layerId: string | null; filename: string | null; result: { digest: string } } | null = null;
  const terrain: TerrainReader = { flowPulseInput: () => terrainInput };
  const layers = new Map<string, NonNullable<ReturnType<ContourReader['layerFor']>>>();
  const contours: ContourReader = { layerFor: (id) => layers.get(id) };
  const scanIds: string[] = [];
  let t = 1000;
  const index = createResultsIndex([
    measurementSource(() => measure),
    terrainSource(() => terrain),
    contourSource(() => contours, () => scanIds),
  ], () => (t += 1000));
  return {
    index, measurements, layers, scanIds,
    setTerrain: (v: typeof terrainInput) => { terrainInput = v; },
    closeScan: () => { measurements.length = 0; terrainInput = null; layers.clear(); scanIds.length = 0; },
  };
}

describe('results index', () => {
  it('lists each result type from its owner, newest first', () => {
    const o = owners();
    o.measurements.push({ id: 'm1', name: 'Distance 1', points: [[0, 0, 0], [2, 0, 0]], owner: { layerId: 'a' } });
    o.index.refresh();
    o.setTerrain({ layerId: 'a', filename: 'site.laz', result: { digest: 'd1' } });
    o.index.refresh();
    o.scanIds.push('a');
    o.layers.set('a', { name: 'Contours, site.laz', visible: true, sourceScanIds: ['a'], bounds: [0, 0, 0, 10, 10, 2] });
    o.index.refresh();
    const e = o.index.entries();
    expect(e.map((x) => x.type)).toEqual(['contours', 'terrain', 'measurement']);
    expect(e[2]!.anchor).toEqual([1, 0, 0]);
    expect(e[2]!.route).toEqual({ mode: 'work', page: 'measure' });
    expect(e[1]!.title).toBe('Terrain surface, site.laz');
    expect(e[1]!.route).toEqual({ mode: 'analyse', page: 'terrain' });
    expect(e[0]!.anchor).toEqual([5, 5, 1]);
    expect(e.every((x) => x.exportRoute?.mode === 'output')).toBe(true);
  });

  it('updates in place and notifies only on a change', () => {
    const o = owners();
    const fn = vi.fn();
    o.index.subscribe(fn);
    o.measurements.push({ id: 'm1', name: 'Distance 1', points: [] });
    o.index.refresh();
    const created = o.index.entries()[0]!.createdAt;
    o.index.refresh();
    expect(fn).toHaveBeenCalledTimes(1);
    o.measurements[0] = { ...o.measurements[0]!, name: 'Kerb height' };
    o.index.refresh();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(o.index.entries()[0]!.title).toBe('Kerb height');
    expect(o.index.entries()[0]!.createdAt).toBe(created);
    o.scanIds.push('a');
    o.layers.set('a', { name: 'Contours', visible: false, sourceScanIds: ['a'], bounds: null });
    o.index.refresh();
    expect(o.index.entries().find((x) => x.type === 'contours')!.status).toBe('hidden');
  });

  it('empties when the scan closes', () => {
    const o = owners();
    o.measurements.push({ id: 'm1', name: 'Distance 1', points: [] });
    o.setTerrain({ layerId: 'a', filename: null, result: { digest: 'd1' } });
    o.scanIds.push('a');
    o.layers.set('a', { name: 'Contours', visible: true, sourceScanIds: ['a'], bounds: null });
    o.index.refresh();
    expect(o.index.entries()).toHaveLength(3);
    o.closeScan();
    o.index.refresh();
    expect(o.index.entries()).toHaveLength(0);
  });

  it('holds references and display fields only', () => {
    const o = owners();
    o.setTerrain({ layerId: 'a', filename: 'x.laz', result: { digest: 'd1' } });
    o.index.refresh();
    expect(Object.keys(o.index.entries()[0]!).sort()).toEqual(
      ['anchor', 'createdAt', 'exportRoute', 'id', 'route', 'sourceIdentity', 'status', 'title', 'type'],
    );
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
});

describe('results shelf focus', () => {
  function shelfFor(active: string | null) {
    const o = owners();
    const result = { digest: 'sha256:abc' };
    o.setTerrain({ layerId: 'a', filename: 'north.laz', result });
    o.measurements.push({ id: 'm1', name: '<img src=x onerror=alert(1)>', points: [[4, 4, 4]], owner: { layerId: 'a' } });
    o.index.refresh();
    const navigate = vi.fn();
    const aim = vi.fn();
    const setActive = vi.fn();
    const run = vi.fn();
    const shelf = createResultsShelf({
      index: o.index,
      navigate,
      aim,
      activeLayerId: () => active,
      layerName: (id) => (id === 'a' ? 'north.laz' : 'south.laz'),
    });
    return { o, shelf, navigate, aim, setActive, run, result };
  }

  it('routes to the owning page and aims without recomputing', () => {
    const s = shelfFor('a');
    const before = JSON.stringify(s.result);
    const ref = s.result;
    expect(s.shelf.focusResult('measurement:m1')).toBe(true);
    expect(s.navigate).toHaveBeenCalledWith({ mode: 'work', page: 'measure' });
    expect(s.aim).toHaveBeenCalledWith([4, 4, 4]);
    expect(s.shelf.focusResult('terrain:a')).toBe(true);
    expect(s.navigate).toHaveBeenLastCalledWith({ mode: 'analyse', page: 'terrain' });
    expect(s.run).not.toHaveBeenCalled();
    expect(JSON.stringify(s.result)).toBe(before);
    expect(s.result).toBe(ref);
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
    expect(s.setActive).not.toHaveBeenCalled();
  });

  it('moves the other-layer note when the active layer changes', () => {
    let active = 'a';
    const o = owners();
    o.setTerrain({ layerId: 'a', filename: 'north.laz', result: { digest: 'd' } });
    o.index.refresh();
    const shelf = createResultsShelf({ index: o.index, navigate: vi.fn(), aim: vi.fn(), activeLayerId: () => active, layerName: () => 'north.laz' });
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

  it('keeps the viewing distance when aiming', () => {
    expect(poseAt({ position: [10, 0, 5], target: [0, 0, 0] }, [1, 2, 3]))
      .toEqual({ position: [11, 2, 8], target: [1, 2, 3] });
  });
});
