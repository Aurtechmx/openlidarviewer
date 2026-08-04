/**
 * reportFootprint.test.ts — the raw-extent → footprint conversion the report
 * metadata is contracted to carry. Guards the foot-CRS bug: area must not be
 * printed ~10.76× too large, and density must be graded in pts·m⁻². Also guards
 * the fail-closed contract: an unconfirmed linear unit yields raw source-unit
 * spans with NO metre value and NO density, never a source span stamped "m".
 */

import { describe, it, expect } from 'vitest';
import { footprintMetres } from '../src/report/reportFootprint';

const FT = 0.3048; // US/international foot → metre

describe('footprintMetres — confirmed unit', () => {
  it('passes a metre CRS through unchanged (factor 1)', () => {
    const f = footprintMetres({
      extentX: 100, extentY: 50, extentZ: 20, pointCount: 5000,
      linearUnitToMetres: 1, linearUnitKnown: true,
    });
    expect(f.unitStatus).toBe('confirmed');
    if (f.unitStatus !== 'confirmed') throw new Error('unreachable');
    expect(f.widthMetres).toBeCloseTo(100, 6);
    expect(f.depthMetres).toBeCloseTo(50, 6);
    expect(f.heightMetres).toBeCloseTo(20, 6);
    expect(f.densityPerM2).toBeCloseTo(5000 / (100 * 50), 6); // 1 pt/m²
  });

  it('converts a foot CRS to metres and pts·m⁻²', () => {
    // 100 ft × 50 ft footprint. In metres: 30.48 × 15.24 = 464.5 m² (NOT 5000).
    const f = footprintMetres({
      extentX: 100, extentY: 50, extentZ: 20, pointCount: 5000,
      linearUnitToMetres: FT, linearUnitKnown: true,
    });
    if (f.unitStatus !== 'confirmed') throw new Error('expected confirmed');
    expect(f.widthMetres).toBeCloseTo(30.48, 4);
    expect(f.depthMetres).toBeCloseTo(15.24, 4);
    expect(f.heightMetres).toBeCloseTo(20 * FT, 4);
    // Density in pts/m² is the raw pts/ft² scaled up by 1/0.3048² ≈ 10.76.
    const area_m2 = 100 * FT * (50 * FT);
    expect(f.densityPerM2).toBeCloseTo(5000 / area_m2, 6);
    expect(f.densityPerM2 / (5000 / (100 * 50))).toBeCloseTo(1 / (FT * FT), 4); // ~10.76×
  });

  it('honours a distinct vertical unit for height only', () => {
    const f = footprintMetres({
      extentX: 100, extentY: 50, extentZ: 10, pointCount: 1,
      linearUnitToMetres: FT, verticalUnitToMetres: 1, // height already in metres
      linearUnitKnown: true,
    });
    if (f.unitStatus !== 'confirmed') throw new Error('expected confirmed');
    expect(f.widthMetres).toBeCloseTo(30.48, 4); // horizontal still feet→m
    expect(f.heightMetres).toBeCloseTo(10, 6);   // vertical untouched
  });

  it('returns NaN density for a degenerate (zero-extent) footprint', () => {
    const f = footprintMetres({
      extentX: 0, extentY: 50, extentZ: 5, pointCount: 100,
      linearUnitToMetres: 1, linearUnitKnown: true,
    });
    if (f.unitStatus !== 'confirmed') throw new Error('expected confirmed');
    expect(Number.isNaN(f.densityPerM2)).toBe(true);
  });
});

describe('footprintMetres — fail closed on an unconfirmed unit', () => {
  it('emits raw source-unit spans with NO metre value and NO density', () => {
    // The old fail-OPEN behaviour multiplied by the placeholder factor 1 and
    // stamped "m" on a unit-less cloud. It must now report source units.
    const f = footprintMetres({
      extentX: 10, extentY: 8, extentZ: 2, pointCount: 400,
      linearUnitKnown: false,
    });
    expect(f.unitStatus).toBe('unknown');
    if (f.unitStatus !== 'unknown') throw new Error('unreachable');
    expect(f.widthSourceUnits).toBeCloseTo(10, 6);
    expect(f.depthSourceUnits).toBeCloseTo(8, 6);
    expect(f.heightSourceUnits).toBeCloseTo(2, 6);
    // There is no density and no metre field on the unknown shape.
    expect('densityPerM2' in f).toBe(false);
    expect('widthMetres' in f).toBe(false);
  });

  it('ignores any unit factor present when the unit is not confirmed', () => {
    // A placeholder linearUnitToMetres must not sneak a conversion in.
    const f = footprintMetres({
      extentX: 100, extentY: 50, extentZ: 20, pointCount: 5000,
      linearUnitToMetres: 1, linearUnitKnown: false,
    });
    if (f.unitStatus !== 'unknown') throw new Error('expected unknown');
    expect(f.widthSourceUnits).toBe(100); // raw span, not "×1 metres"
  });

  it('honours the up axis for the source-unit spans (Y-up depth/height swap)', () => {
    const f = footprintMetres({
      extentX: 30, extentY: 8, extentZ: 40, pointCount: 1,
      linearUnitKnown: false, zUp: false, // Y carries height, Z carries depth
    });
    if (f.unitStatus !== 'unknown') throw new Error('expected unknown');
    expect(f.widthSourceUnits).toBe(30);
    expect(f.depthSourceUnits).toBe(40); // Z is depth when Y-up
    expect(f.heightSourceUnits).toBe(8); // Y is height when Y-up
  });
});
