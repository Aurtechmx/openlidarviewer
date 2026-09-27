/**
 * polygonVolumeWithheld.test.ts — the polygon Volume tool leaves Withheld
 * points out of its cut/fill and states points read, Withheld excluded and
 * points analysed, as the lasso volume does. A cloud without flags integrates
 * exactly as before, with its exclusion count unknown.
 */
import { describe, it, expect } from 'vitest';
import { samplePolygonVolume } from '../src/render/measure/polygonVolumeSample';
import { POINT_SAMPLE_VOLUME_METHOD, volumeCutFill, type PlacedVolumeBuffer } from '../src/render/measure/volume';
import { deriveVolumeRecord } from '../src/render/measure/measureDerivations';
import { encodeExtendedClassificationFlags } from '../src/lasSemantics';
import type { Vec3 } from '../src/render/navMath';

const WITHHELD = encodeExtendedClassificationFlags({ withheld: true });
const OVERLAP = encodeExtendedClassificationFlags({ overlap: true });
const N = 20;
const SIZE = 10;
const UP: Vec3 = [0, 0, 1];
/** Footprint covering the inner part of the grid; points outside it exist too. */
const POLY: Vec3[] = [[1, 1, 0], [9, 1, 0], [9, 9, 0], [1, 9, 0]];

function grid(): { pos: Float32Array; flags: Uint8Array; clean: Float32Array } {
  const pos = new Float32Array(N * N * 3);
  const flags = new Uint8Array(N * N);
  const clean: number[] = [];
  for (let i = 0; i < N * N; i++) {
    const x = ((i % N) / (N - 1)) * SIZE;
    const y = (Math.floor(i / N) / (N - 1)) * SIZE;
    let z = Math.hypot(x - 5, y - 5) < 2.5 ? 1 : 0;
    if (i % 13 === 4) {
      flags[i] = WITHHELD;
      z = 40; // a spike that would add fill if read
    } else {
      if (i % 7 === 2) flags[i] = OVERLAP;
      clean.push(x, y, z);
    }
    pos.set([x, y, z], i * 3);
  }
  return { pos, flags, clean: new Float32Array(clean) };
}

function inside(pos: Float32Array): number {
  return volumeCutFill({ polygon: POLY, referenceZ: 0, up: UP, positions: pos }).pointsInPolygon;
}

describe('polygon volume Withheld exclusion', () => {
  it('integrates only the non-Withheld points and counts the exclusion', () => {
    const g = grid();
    const rec = samplePolygonVolume([{ pos: g.pos, flags: g.flags }], g.pos.length, POLY, 0, UP);
    const ref = volumeCutFill({ polygon: POLY, referenceZ: 0, up: UP, positions: g.clean });
    expect(rec.fill).toBeCloseTo(ref.fill, 9);
    expect(rec.cut).toBeCloseTo(ref.cut, 9);
    expect(rec.pointsInPolygon).toBe(ref.pointsInPolygon);
    const all = inside(g.pos);
    const excluded = all - ref.pointsInPolygon;
    expect(excluded).toBeGreaterThan(0);
    expect(rec.withheld).toEqual({ source: all, excluded, analysed: ref.pointsInPolygon });
    // Reading the spikes would have inflated the fill.
    expect(volumeCutFill({ polygon: POLY, referenceZ: 0, up: UP, positions: g.pos }).fill).toBeGreaterThan(rec.fill! * 2);
    expect(rec.method).toBe(POINT_SAMPLE_VOLUME_METHOD);
  });

  it('applies each source placement to the Withheld points it counts', () => {
    const g = grid();
    const shifted = new Float32Array(g.pos.length);
    for (let k = 0; k < g.pos.length; k += 3) shifted.set([g.pos[k] - 100, g.pos[k + 1], g.pos[k + 2]], k);
    const placement: PlacedVolumeBuffer['placement'] = {
      sourceOrigin: [0, 0, 0], sourceToProject: [100, 0, 0], projectToSource: [-100, 0, 0],
    };
    const a = samplePolygonVolume([{ pos: g.pos, flags: g.flags }], g.pos.length, POLY, 0, UP);
    const b = samplePolygonVolume([{ pos: shifted, flags: g.flags, placement }], g.pos.length, POLY, 0, UP);
    expect(b.withheld).toEqual(a.withheld);
    expect(b.fill).toBeCloseTo(a.fill!, 9);
  });

  it('leaves a cloud without flags unchanged and reports the count as unknown', () => {
    const g = grid();
    const rec = samplePolygonVolume([{ pos: g.pos }], g.pos.length, POLY, 0, UP);
    const golden = deriveVolumeRecord(
      volumeCutFill({ polygon: POLY, referenceZ: 0, up: UP, positions: g.pos }),
      0,
      POINT_SAMPLE_VOLUME_METHOD,
    );
    const { withheld, ...rest } = rec;
    expect(rest).toEqual(golden);
    expect(withheld).toEqual({ source: golden.pointsInPolygon, excluded: 'unknown', analysed: golden.pointsInPolygon });
  });

  it('marks the count unknown when one of two sources has no flags', () => {
    const g = grid();
    const rec = samplePolygonVolume(
      [{ pos: g.pos, flags: g.flags }, { pos: g.clean }],
      g.pos.length + g.clean.length,
      POLY, 0, UP,
    );
    expect(rec.withheld?.excluded).toBe('unknown');
    expect(rec.withheld?.analysed).toBe(2 * inside(g.clean));
  });
});
