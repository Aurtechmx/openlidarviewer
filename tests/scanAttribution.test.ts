/**
 * scanAttribution.test.ts: work is attributed to the scan its points were
 * picked on, and a profile source is recorded by stable layer id.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { relabelWorkLayer } from '../src/app/measurementOwnership';
import { clipFromBoxMeasurement } from '../src/render/clip/clipFromMeasurement';
import { heldCutAxes } from '../src/app/sessionUpAxisNote';
import { profileDetailSources } from '../src/render/measure/profilePointLink';
import { createProfileSectionSeam } from '../src/render/measure/profileSectionSeam';
import type { Vec3 } from '../src/render/measure/types';

describe('a box and the scan it was picked on', () => {
  const box = { id: 'b', kind: 'box', points: [[0, 0, 0], [4, 4, 4]] as Vec3[], owner: { layerId: 'A' }, pickLayers: ['B'] };
  const on = (activeLayerId: string | null) => clipFromBoxMeasurement(box, { activeLayerId, layerCount: 2 }).ok;
  it('clips from either scan it names and no other', () => {
    expect([on('A'), on('B'), on('C'), on(null)]).toEqual([true, true, false, false]);
  });
});

describe('held work and the axis it was cut along', () => {
  const p = (picks: string[]) => ({ kind: 'profile', owner: { layerId: 'A' }, pickLayers: picks, profileChart: [1] });
  const axis = (picks: string[]) => heldCutAxes([p(picks)], { axis: 'y', basis: 'format-spec' } as never, 'A')[0] as { derivedUpAxis?: string; derivedWithheld?: string };
  it('takes the recorded axis only when every point was picked on the recorded scan', () => {
    expect(axis(['A']).derivedUpAxis).toBe('y');
    expect(axis(['B']).derivedUpAxis).toBeUndefined();
    expect(axis(['A', 'B']).derivedWithheld).toContain('withheld');
  });
});

describe('a profile record and a layer that hands over its identity', () => {
  it('follows the kept id', () => {
    const m = { profileProvenance: { sources: [{ layerId: 'new', displayName: 's.las' }, { layerId: 'other', displayName: 'o.las' }] } };
    expect(relabelWorkLayer([m], 'new', 'kept')).toBe(1);
    expect(m.profileProvenance.sources.map((s) => s.layerId)).toEqual(['kept', 'other']);
  });
});

describe('profile sources', () => {
  const layer = (id: string, z: number) => ({ mesh: { visible: true }, locked: false, mounted: true, compatibility: null, placement: null, id, displayName: 'same.las', positions: Float32Array.from([1, 0, z, 5, 0, z, 9, 0, z]), channels: null, bounds: null });
  const seam = createProfileSectionSeam({
    layers: () => [layer('id1', 1), layer('id2', 2)] as never, residentNodes: () => [], streamingMayCombine: () => false,
    worldUp: () => [0, 0, 1], streamingCoverage: () => null,
  });
  it('two scans of one name are recorded, listed and found by their own id', () => {
    const series = seam.sampleSeries([0, 0, 0], [10, 0, 0])!;
    const recorded = series.provenanceInput!.sources;
    expect(recorded.map((s) => [s.layerId, s.displayName])).toEqual([['id1', 'same.las'], ['id2', 'same.las']]);
    const section = seam.section({ a: [0, 0, 0], b: [10, 0, 0] })!;
    expect(section.sources.map((s) => [s.id, s.name])).toEqual([['id1', 'same.las'], ['id2', 'same.las']]);
    expect(profileDetailSources(section.sources).map((s) => [s.layerId, s.layerName])).toEqual([['id1', 'same.las'], ['id2', 'same.las']]);
    const out = new Float64Array(3);
    expect(seam.locateReturn({ kind: 'static', id: 'id2', pointIndex: 0 }, out)).toBe('linked');
    expect(out[2]).toBe(2);
  });
});

describe('the offline shell', () => {
  it('holds every script the entry page loads by a fixed name', () => {
    const html = readFileSync('index.html', 'utf8'), sw = readFileSync('public/sw.js', 'utf8');
    const shell = /const SHELL = \[([\s\S]*?)\];/.exec(sw)![1]!;
    const fixed = [...html.matchAll(/<script(?![^>]*type="module")[^>]*\bsrc="\/([^"]+)"/g)].map((m) => m[1]!);
    expect(fixed).toContain('browser-check.js');
    for (const f of fixed) expect(shell).toContain(`'./${f}'`);
  });
});
