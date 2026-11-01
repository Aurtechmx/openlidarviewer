// What these tests would catch:
//
//  - Removing the active layer promoting a survivor while the class legend,
//    the colour chips, the point-count detail and the Scan Report kept
//    describing the removed layer.
//  - The report running in the removed layer's class filter: the legend is
//    reseeded before the report reads its scope.
//  - The shell's activateLayer bypassing the shared refresh.
//  - A switch back to a layer with derived classes reseeding the legend as
//    the source's, so its shares fell back to the load sample while the Scan
//    Report, which reads the cloud's provenance, still counted the held codes.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { refreshActiveLayerSurfaces, refreshStreamSurfaces, type ActiveLayerSurfaceDeps, type StreamSurfaceDeps } from '../src/app/ScanService';

type Cloud = { pointCount: number; declaredPointCount?: number; decodedPointCount?: number; classification?: Uint8Array; classificationProvenance?: string };

function deps() {
  const order: string[] = [];
  const spy = (name: string) => vi.fn(() => { order.push(name); });
  const d: ActiveLayerSurfaceDeps<Cloud> = {
    refreshCrs: spy('crs'),
    refreshProvenance: spy('provenance'),
    refreshDatasetIntelligence: spy('dataset'),
    refreshClassLegend: spy('legend'),
    syncColorMode: spy('colour'),
    setDetail: spy('detail'),
    setReport: spy('report'),
  };
  return { d, order };
}

describe('refreshActiveLayerSurfaces', () => {
  it('describes the promoted layer on every per-scan surface', () => {
    const { d } = deps();
    const cls = new Uint8Array([2, 2, 6]);
    const cloud: Cloud = { pointCount: 3, declaredPointCount: 10, decodedPointCount: 8, classification: cls, classificationProvenance: 'derived' };
    refreshActiveLayerSurfaces(d, cloud, 'cloud-2');
    expect(d.refreshCrs).toHaveBeenCalledWith(cloud);
    expect(d.refreshProvenance).toHaveBeenCalledWith(cloud, 'cloud-2');
    expect(d.refreshDatasetIntelligence).toHaveBeenCalledWith(cloud);
    expect(d.refreshClassLegend).toHaveBeenCalledWith(cls, { loaded: 3, declared: 10 }, 'derived');
    expect(d.syncColorMode).toHaveBeenCalledTimes(1);
    expect(d.setDetail).toHaveBeenCalledWith(3, 8);
    expect(d.setReport).toHaveBeenCalledWith(cloud);
  });

  it('seeds the legend before the report, which reads the legend for its class scope', () => {
    const { d, order } = deps();
    refreshActiveLayerSurfaces(d, { pointCount: 1 }, 'c');
    expect(order.indexOf('legend')).toBeLessThan(order.indexOf('report'));
    expect(order.indexOf('legend')).toBeLessThan(order.indexOf('colour'));
  });

  it('shows the whole count when the file was not reduced, and hands the legend no classes', () => {
    const { d } = deps();
    refreshActiveLayerSurfaces(d, { pointCount: 5 }, 'c');
    expect(d.setDetail).toHaveBeenCalledWith(5, 5);
    expect(d.refreshClassLegend).toHaveBeenCalledWith(undefined, { loaded: 5, declared: undefined }, undefined);
  });

  it('is what the shell runs when a layer becomes active', () => {
    const main = readFileSync(join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf8');
    const start = main.indexOf('function activateLayer(id: string): void {');
    expect(start).toBeGreaterThan(-1);
    const body = main.slice(start, main.indexOf('\nfunction ', start + 1));
    expect(body).toContain('refreshActiveLayerSurfaces(');
  });

  it('restores the layer provenance on the legend before Process Studio reads it', () => {
    const main = readFileSync(join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf8');
    const start = main.indexOf('function refreshClassLegend(');
    expect(start).toBeGreaterThan(-1);
    const body = main.slice(start, main.indexOf('\n}\n', start));
    const sync = body.indexOf('classLegendPanel.syncProvenance(provenance)');
    expect(sync).toBeGreaterThan(-1);
    expect(sync).toBeLessThan(body.indexOf('processStudio.refresh()'));
  });
});

describe('refreshStreamSurfaces', () => {
  it('describes the stream once the last static layer beside it is removed', () => {
    const tally = new Map([[2, 10], [6, 4]]);
    const d: StreamSurfaceDeps<{ name: string }> = {
      refreshCrs: vi.fn(),
      refreshProvenance: vi.fn(),
      refreshDatasetIntelligence: vi.fn(),
      streamClasses: () => tally,
      reseedLegend: vi.fn(),
      refreshReport: vi.fn(),
    };
    const stream = { name: 'big.laz' };
    refreshStreamSurfaces(d, stream);
    expect(d.refreshCrs).toHaveBeenCalledWith(stream);
    expect(d.refreshProvenance).toHaveBeenCalledWith(stream);
    expect(d.refreshDatasetIntelligence).toHaveBeenCalledWith(stream);
    expect(d.reseedLegend).toHaveBeenCalledWith(tally);
    expect(d.refreshReport).toHaveBeenCalledTimes(1);
  });

  it('is what the shell runs when a removal leaves only the stream, instead of the empty state', () => {
    const main = readFileSync(join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf8');
    const start = main.indexOf('function removeCloud(id: string): void {');
    expect(start).toBeGreaterThan(-1);
    const body = main.slice(start, main.indexOf('\n}\n', start));
    expect(body).toContain('viewer.clouds().length === 0 && !viewer.hasStreamingCloud) resetToEmptyState()');
    expect(body).toContain('refreshStreamSurfaces(');
  });
});
