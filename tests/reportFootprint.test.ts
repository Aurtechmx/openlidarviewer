/**
 * reportFootprint.test.ts — the raw-extent → metres/pts·m⁻² conversion the
 * report metadata is contracted to carry. Guards the foot-CRS bug: area must
 * not be printed ~10.76× too large, and density must be graded in pts·m⁻².
 */

import { describe, it, expect } from 'vitest';
import { footprintMetres } from '../src/report/reportFootprint';

const FT = 0.3048; // US/international foot → metre

describe('footprintMetres', () => {
  it('passes a metre CRS through unchanged (factor 1)', () => {
    const f = footprintMetres({
      extentX: 100, extentY: 50, extentZ: 20, pointCount: 5000,
      linearUnitToMetres: 1,
    });
    expect(f.width).toBeCloseTo(100, 6);
    expect(f.depth).toBeCloseTo(50, 6);
    expect(f.height).toBeCloseTo(20, 6);
    expect(f.density).toBeCloseTo(5000 / (100 * 50), 6); // 1 pt/m²
  });

  it('converts a foot CRS to metres and pts·m⁻²', () => {
    // 100 ft × 50 ft footprint. In metres: 30.48 × 15.24 = 464.5 m² (NOT 5000).
    const f = footprintMetres({
      extentX: 100, extentY: 50, extentZ: 20, pointCount: 5000,
      linearUnitToMetres: FT,
    });
    expect(f.width).toBeCloseTo(30.48, 4);
    expect(f.depth).toBeCloseTo(15.24, 4);
    expect(f.height).toBeCloseTo(20 * FT, 4);
    // Density in pts/m² is the raw pts/ft² scaled up by 1/0.3048² ≈ 10.76.
    const area_m2 = 100 * FT * (50 * FT);
    expect(f.density).toBeCloseTo(5000 / area_m2, 6);
    expect(f.density / (5000 / (100 * 50))).toBeCloseTo(1 / (FT * FT), 4); // ~10.76×
  });

  it('honours a distinct vertical unit for height only', () => {
    const f = footprintMetres({
      extentX: 100, extentY: 50, extentZ: 10, pointCount: 1,
      linearUnitToMetres: FT, verticalUnitToMetres: 1, // height already in metres
    });
    expect(f.width).toBeCloseTo(30.48, 4); // horizontal still feet→m
    expect(f.height).toBeCloseTo(10, 6);   // vertical untouched
  });

  it('falls back to factor 1 when the unit is missing (unit-less cloud)', () => {
    const f = footprintMetres({ extentX: 10, extentY: 10, extentZ: 2, pointCount: 400 });
    expect(f.width).toBeCloseTo(10, 6);
    expect(f.density).toBeCloseTo(4, 6);
  });

  it('returns NaN density for a degenerate (zero-extent) footprint', () => {
    const f = footprintMetres({ extentX: 0, extentY: 50, extentZ: 5, pointCount: 100, linearUnitToMetres: 1 });
    expect(Number.isNaN(f.density)).toBe(true);
  });
});
