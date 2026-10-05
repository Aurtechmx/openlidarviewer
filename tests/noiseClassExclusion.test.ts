/**
 * noiseClassExclusion.test.ts: epoch change and the volume tools leave ASPRS
 * noise classes 7 and 18 out, and report how many they left out. A file with
 * no classification channel gives the same result as before.
 */
import { describe, expect, it } from 'vitest';

import { buildSharedEpochDtms, epochNoiseLines, excludeWithheldEpoch, withheldEpochs } from '../src/terrain/change/compareEpochs';
import { compareDtms } from '../src/terrain/change/compareDtms';
import { samplePolygonVolume } from '../src/render/measure/polygonVolumeSample';
import { dropNoise } from '../src/render/measure/lassoVolumeCompute';
import { withheldClause } from '../src/render/measure/stockpileResult';
import { noiseExcludedClause } from '../src/terrain/ground/classificationFilter';
import type { Vec3 } from '../src/render/navMath';

const N = 40;
const SIZE = 20;
const UP: Vec3 = [0, 0, 1];
const POLY: Vec3[] = [[2, 2, 0], [18, 2, 0], [18, 18, 0], [2, 18, 0]];

/** A flat grid at z = 0; every 9th point inside the centre is a class-7 return 5 m low. */
function epoch(withNoise: boolean): { positions: Float32Array; classification: Uint8Array; noise: number } {
  const pos = new Float32Array(N * N * 3);
  const cls = new Uint8Array(N * N).fill(2);
  let noise = 0;
  for (let i = 0; i < N * N; i++) {
    const x = ((i % N) / (N - 1)) * SIZE;
    const y = (Math.floor(i / N) / (N - 1)) * SIZE;
    let z = 0;
    if (withNoise && Math.hypot(x - 10, y - 10) < 4 && i % 9 === 0) {
      cls[i] = i % 2 === 0 ? 7 : 18;
      z = -5;
      noise++;
    }
    pos.set([x, y, z], i * 3);
  }
  return { positions: pos, classification: cls, noise };
}

function maxAbsDiff(before: Float32Array, after: Float32Array): number {
  const dtms = buildSharedEpochDtms({ positions: before }, { positions: after })!;
  const diff = compareDtms(dtms.before, dtms.after, {}).result.diff;
  let m = 0;
  for (const d of diff) if (Number.isFinite(d)) m = Math.max(m, Math.abs(d));
  return m;
}

describe('epoch change leaves noise classes out', () => {
  it('a low noise return changes the DoD when read and does not once excluded', () => {
    const before = epoch(false);
    const after = epoch(true);
    expect(after.noise).toBeGreaterThan(0);
    const unfiltered = maxAbsDiff(before.positions, after.positions);
    expect(unfiltered).toBeGreaterThan(1);
    const kept = excludeWithheldEpoch({ positions: after.positions }, undefined, after.classification);
    expect(kept.noiseExcluded).toBe(after.noise);
    expect(kept.cloud.positions.length).toBe(after.positions.length - after.noise * 3);
    expect(maxAbsDiff(before.positions, kept.cloud.positions)).toBe(0);
  });

  it('an unclassified epoch is returned unchanged', () => {
    const after = epoch(true);
    const cloud = { positions: after.positions };
    const out = excludeWithheldEpoch(cloud, undefined, undefined);
    expect(out.cloud).toBe(cloud);
    expect(out.noiseExcluded).toBe(0);
    const prepared = withheldEpochs({ beforeCloud: cloud, afterCloud: cloud }, {}, {});
    expect(prepared.beforeCloud).toBe(cloud);
    expect(prepared.lines).toEqual([]);
  });

  it('names the excluded count on the compare panel', () => {
    expect(epochNoiseLines(0, 12)).toEqual(['After points: 12 noise points (classes 7, 18) excluded']);
    expect(epochNoiseLines(0, 0)).toEqual([]);
    const after = epoch(true);
    const p = withheldEpochs(
      { beforeCloud: { positions: after.positions }, afterCloud: { positions: after.positions } },
      { classification: after.classification },
      {},
    );
    expect(p.lines).toEqual([`Before points: ${noiseExcludedClause(after.noise)}`]);
  });
});

describe('volume leaves noise classes out', () => {
  it('a low noise return adds cut when read and not once excluded', () => {
    const g = epoch(true);
    const total = g.positions.length;
    const unclassified = samplePolygonVolume([{ pos: g.positions }], total, POLY, 0, UP);
    expect(unclassified.cut).toBeGreaterThan(0);
    const filtered = samplePolygonVolume([{ pos: g.positions, classification: g.classification }], total, POLY, 0, UP);
    expect(filtered.cut).toBe(0);
    expect(filtered.withheld?.noiseExcluded).toBe(g.noise);
    expect(filtered.withheld?.analysed).toBe((unclassified.withheld?.analysed ?? 0) - g.noise);
  });

  it('an unclassified buffer integrates exactly as before', () => {
    const g = epoch(false);
    const total = g.positions.length;
    const a = samplePolygonVolume([{ pos: g.positions }], total, POLY, 0, UP);
    const b = samplePolygonVolume([{ pos: g.positions, classification: undefined }], total, POLY, 0, UP);
    expect(b).toEqual(a);
    expect(a.withheld?.noiseExcluded).toBeUndefined();
  });

  it('the lasso walk drops noise by source index and reports it', () => {
    const indices = new Int32Array([0, 1, 2, 3]);
    const sel = { indices, screenX: new Float64Array(4), screenY: new Float64Array(4), depth: new Float64Array(4), count: 4 };
    const cls = new Uint8Array([2, 2, 7, 2, 18, 2, 2, 2]);
    const out = dropNoise(sel, cls, 8, 2);
    expect(out.dropped).toBe(2);
    expect(Array.from(out.sel.indices.subarray(0, out.sel.count))).toEqual([0, 3]);
    const none = dropNoise({ ...sel, count: 4 }, undefined, 8, 2);
    expect(none.dropped).toBe(0);
    expect(withheldClause({ source: 10, excluded: 0, analysed: 8, noiseExcluded: 2 })).toBe(
      ' · 2 noise points (classes 7, 18) excluded',
    );
    expect(withheldClause({ source: 10, excluded: 0, analysed: 10 })).toBe('');
  });
});
