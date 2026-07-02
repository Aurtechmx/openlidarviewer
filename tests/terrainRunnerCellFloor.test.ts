/**
 * terrainRunnerCellFloor.test.ts — the runner's UNIT-AWARE cell-size floor and
 * grid-centre latitude derivation (v0.4.3 audit: the raw `Math.max(0.25, …)`
 * floor was unit-blind, so a geographic scan got 0.25° ≈ 28 km cells and any
 * extent under ~64° collapsed to 1–2 cells).
 *
 * All expectations hand-computed: floor = 0.25 m expressed in source units
 * (÷ metres-per-degree for geographic, ÷ metres-per-foot for feet), target
 * resolution = extent / 256, cell = max(floor, target).
 */

import { describe, it, expect } from 'vitest';
import { deriveCoreParams } from '../src/app/terrainAnalysisRunner';
import { METRES_PER_DEGREE } from '../src/terrain/ground/horizontalScale';
import type { CrsService } from '../src/geo/CrsService';

/** Flat square of points spanning `extent` source units per axis at `origin`. */
function square(extent: number, n = 4): Float32Array {
  const pts: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      pts.push((i / (n - 1)) * extent, (j / (n - 1)) * extent, 0);
    }
  }
  return Float32Array.from(pts);
}

function fakeCrs(current: unknown): CrsService {
  return { current: () => current } as unknown as CrsService;
}

const GEOGRAPHIC = { kind: 'geographic', name: 'WGS 84', linearUnitToMetres: 1, verticalDatum: null };
const METRES = { kind: 'projected', name: 'UTM 10N', linearUnitToMetres: 1, verticalDatum: null };
const US_FEET = { kind: 'projected', name: 'State Plane', linearUnitToMetres: 0.3048, verticalDatum: null };

describe('deriveCoreParams — unit-aware cell floor', () => {
  it('projected metres keep the historical 0.25 m floor', () => {
    // Extent 30 m: target 30/256 ≈ 0.1172 < 0.25 → the floor wins, exactly
    // as before the fix (projected-metre behaviour must be identical).
    const p = deriveCoreParams(square(30), undefined, fakeCrs(METRES));
    expect(p.cellSizeM).toBeCloseTo(0.25, 9);
  });

  it('a 0.01° geographic scan no longer collapses to a 0.25° cell', () => {
    // Old: max(0.25, 0.01/256) = 0.25° ≈ 28 km cells → 1-cell grid.
    // New floor: 0.25 / 111320 ≈ 2.2458e-6°; target 0.01/256 = 3.90625e-5°
    // wins → a genuine ~256-cell grid.
    const p = deriveCoreParams(square(0.01), undefined, fakeCrs(GEOGRAPHIC));
    expect(p.cellSizeM).toBeCloseTo(0.01 / 256, 10); // Float32 positions round the extent slightly
    expect(p.isGeographic).toBe(true);
  });

  it('a tiny geographic extent bottoms out at 0.25 METRES worth of degrees', () => {
    // Extent 1e-4°: target 3.90625e-7° < floor 0.25/111320 = 2.24578…e-6°.
    const p = deriveCoreParams(square(1e-4), undefined, fakeCrs(GEOGRAPHIC));
    expect(p.cellSizeM).toBeCloseTo(0.25 / METRES_PER_DEGREE, 12);
  });

  it('a US-feet CRS floors at 0.25 m expressed in feet (≈ 0.8202 ft)', () => {
    const p = deriveCoreParams(square(3), undefined, fakeCrs(US_FEET));
    expect(p.cellSizeM).toBeCloseTo(0.25 / 0.3048, 9);
  });

  it('no resolved CRS behaves like projected metres (factor 1)', () => {
    const p = deriveCoreParams(square(30), undefined, fakeCrs(null));
    expect(p.cellSizeM).toBeCloseTo(0.25, 9);
  });
});

describe('deriveCoreParams — grid-centre latitude for cos φ corrections', () => {
  it('recovers origin + local bbox centre for a geographic frame', () => {
    // Local Y spans 0…0.4° with a world-origin latitude of 59.8° →
    // grid-centre latitude 59.8 + 0.2 = 60.0.
    const p = deriveCoreParams(square(0.4), undefined, fakeCrs(GEOGRAPHIC), undefined, false, () => 59.8);
    expect(p.latitudeDeg).toBeCloseTo(60.0, 6); // Float32 positions
  });

  it('treats local Y as absolute latitude when the origin is unknown', () => {
    const p = deriveCoreParams(square(0.4), undefined, fakeCrs(GEOGRAPHIC), undefined, false, () => null);
    expect(p.latitudeDeg).toBeCloseTo(0.2, 6); // Float32 positions
  });

  it('never reads the origin for a projected frame (lazy thunk, latitude null)', () => {
    let called = 0;
    const p = deriveCoreParams(square(30), undefined, fakeCrs(METRES), undefined, false, () => {
      called++;
      return 1234;
    });
    expect(p.latitudeDeg).toBeNull();
    expect(called).toBe(0);
  });
});
