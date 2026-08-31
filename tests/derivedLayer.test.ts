import { describe, it, expect } from 'vitest';
import { DerivedLayerStore } from '../src/model/DerivedLayer';

describe('DerivedLayerStore', () => {
  it('adds layers, preserves order, and defaults display state', () => {
    const s = new DerivedLayerStore();
    s.put({ id: 'dtm', type: 'dtm-mesh', name: 'DTM', sourceScanIds: ['a'] });
    s.put({ id: 'ctr', type: 'contours', name: 'Contours 0.5 m', sourceScanIds: ['a'], opacity: 0.6 });
    const ids = s.list().map((l) => l.id);
    expect(ids).toEqual(['dtm', 'ctr']);
    expect(s.get('dtm')!.visible).toBe(true);
    expect(s.get('dtm')!.opacity).toBe(1);
    expect(s.get('dtm')!.generation).toBe(1);
    expect(s.get('ctr')!.opacity).toBeCloseTo(0.6);
  });

  it('regenerating an existing id replaces it and bumps generation', () => {
    const s = new DerivedLayerStore();
    s.put({ id: 'dtm', type: 'dtm-mesh', name: 'DTM', sourceScanIds: ['a'], provenanceDigest: 'x1' });
    const again = s.put({ id: 'dtm', type: 'dtm-mesh', name: 'DTM', sourceScanIds: ['a'], provenanceDigest: 'x2' });
    expect(again.generation).toBe(2);
    expect(s.get('dtm')!.provenanceDigest).toBe('x2');
    expect(s.list()).toHaveLength(1);
  });

  it('finds layers by source scan and clamps opacity', () => {
    const s = new DerivedLayerStore();
    s.put({ id: 'change', type: 'change-raster', name: '2025 → 2026', sourceScanIds: ['a', 'b'] });
    s.put({ id: 'dtm', type: 'dtm-mesh', name: 'DTM', sourceScanIds: ['a'] });
    expect(s.bySource('b').map((l) => l.id)).toEqual(['change']);
    expect(s.bySource('a').map((l) => l.id).sort()).toEqual(['change', 'dtm']);
    expect(s.setOpacity('dtm', 5)!.opacity).toBe(1);
    expect(s.setOpacity('dtm', -1)!.opacity).toBe(0);
  });

  it('solo shows only one layer, null clears the isolate', () => {
    const s = new DerivedLayerStore();
    s.put({ id: 'a', type: 'slope', name: 'Slope', sourceScanIds: ['x'] });
    s.put({ id: 'b', type: 'hillshade', name: 'Hillshade', sourceScanIds: ['x'] });
    s.solo('a');
    expect(s.get('a')!.visible).toBe(true);
    expect(s.get('b')!.visible).toBe(false);
    s.solo(null);
    expect(s.get('b')!.visible).toBe(true);
  });

  it('merges style patches and removes layers', () => {
    const s = new DerivedLayerStore();
    s.put({ id: 'a', type: 'slope', name: 'Slope', sourceScanIds: ['x'], style: { ramp: 'viridis' } });
    s.setStyle('a', { clip: true });
    expect(s.get('a')!.style).toEqual({ ramp: 'viridis', clip: true });
    expect(s.remove('a')).toBe(true);
    expect(s.has('a')).toBe(false);
  });

  it('notifies a subscriber on every change and stops after unsubscribe', () => {
    const s = new DerivedLayerStore();
    let calls = 0;
    const off = s.subscribe(() => {
      calls += 1;
    });
    s.put({ id: 'a', type: 'contours', name: 'Contours', sourceScanIds: ['x'] });
    s.setVisible('a', false);
    s.setOpacity('a', 0.5);
    s.setStyle('a', { ramp: 'x' });
    s.solo('a');
    s.remove('a');
    expect(calls).toBe(6);
    off();
    s.put({ id: 'b', type: 'slope', name: 'Slope', sourceScanIds: ['x'] });
    expect(calls).toBe(6);
  });

  it('does not notify when a remove or patch hits no layer', () => {
    const s = new DerivedLayerStore();
    let calls = 0;
    s.subscribe(() => {
      calls += 1;
    });
    expect(s.remove('missing')).toBe(false);
    expect(s.setVisible('missing', false)).toBeUndefined();
    expect(calls).toBe(0);
  });
});
