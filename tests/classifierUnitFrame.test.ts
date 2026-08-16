/**
 * classifierUnitFrame.test.ts
 *
 * The classifier's parameters are physical metres, but it runs on raw source
 * coordinates. A caller must restate the parameters in the cloud's source units
 * before running, or a foot cloud classifies with a 0.5 ft ground band and a
 * 1 ft wall-rescue radius instead of 0.5 m and 1 m. `classifierParamsForFrame`
 * is that boundary converter, and the production classify path applies it via
 * `classifierOptions`. This pins the conversion and the end-to-end equivalence:
 * the same physical terrain classifies the same whether its coordinates are in
 * metres or feet.
 */
import { describe, it, expect } from 'vitest';
import {
  classifierParamsForFrame,
  deriveClassification,
  CLASSIFIER_PRESET,
  DERIVED_GROUND,
  DERIVED_BUILDING,
} from '../src/render/class/deriveClassification';

const FOOT = 0.3048;
const P = CLASSIFIER_PRESET.params;

describe('classifierParamsForFrame — unit conversion', () => {
  it('a unit frame returns the metre defaults unchanged', () => {
    const out = classifierParamsForFrame({ linearUnitToMetres: 1, verticalUnitToMetres: 1 });
    expect(out.maxObjectSizeM).toBeCloseTo(P.maxObjectSizeM, 12);
    expect(out.groundBandM).toBeCloseTo(P.groundBandM, 12);
    expect(out.structuralNeighborRadiusM).toBeCloseTo(P.structuralNeighborRadiusM, 12);
    expect(out.slope).toBeCloseTo(P.slope, 12);
  });

  it('a foot frame divides every length by the foot factor, slope unchanged', () => {
    const out = classifierParamsForFrame({ linearUnitToMetres: FOOT, verticalUnitToMetres: FOOT });
    // Horizontal.
    expect(out.maxObjectSizeM).toBeCloseTo(P.maxObjectSizeM / FOOT, 9);
    expect(out.structuralNeighborRadiusM).toBeCloseTo(P.structuralNeighborRadiusM / FOOT, 9);
    // Vertical.
    expect(out.groundBandM).toBeCloseTo(P.groundBandM / FOOT, 9);
    expect(out.buildingMinHagM).toBeCloseTo(P.buildingMinHagM / FOOT, 9);
    // Slope is a rise/run ratio; both axes share the foot, so it is unchanged.
    expect(out.slope).toBeCloseTo(P.slope, 12);
  });

  it('a compound frame scales horizontal and vertical separately and adjusts slope', () => {
    // Metre horizontal, foot vertical.
    const out = classifierParamsForFrame({ linearUnitToMetres: 1, verticalUnitToMetres: FOOT });
    expect(out.maxObjectSizeM).toBeCloseTo(P.maxObjectSizeM, 12); // horizontal unchanged
    expect(out.groundBandM).toBeCloseTo(P.groundBandM / FOOT, 9); // vertical scaled
    expect(out.slope).toBeCloseTo(P.slope * (1 / FOOT), 9); // ratio scaled
  });

  it('a missing or zero factor falls back to 1 (metre defaults, no NaN)', () => {
    const out = classifierParamsForFrame({ linearUnitToMetres: null, verticalUnitToMetres: 0 });
    expect(out.groundBandM).toBeCloseTo(P.groundBandM, 12);
    expect(Number.isFinite(out.slope as number)).toBe(true);
  });
});

/**
 * A ground plane with a raised smooth block (a building). 60x60 m at 1 m
 * spacing, block 12x12 m raised 6 m. Deterministic, no RNG.
 */
function scene(scale: number): Float32Array {
  const pts: number[] = [];
  for (let i = 0; i <= 60; i++) {
    for (let j = 0; j <= 60; j++) {
      const inBlock = i >= 24 && i <= 36 && j >= 24 && j <= 36;
      const z = inBlock ? 6 : 0;
      pts.push(i * scale, j * scale, z * scale);
    }
  }
  return new Float32Array(pts);
}

describe('deriveClassification — metre / foot physical equivalence', () => {
  it('classifies the same physical terrain identically in metres and feet', () => {
    const metre = new Float32Array(scene(1));
    const n = metre.length / 3;
    const foot = new Float32Array(scene(1 / FOOT));

    const metreRes = deriveClassification(metre, n, {});
    const footRes = deriveClassification(foot, n, {
      ...classifierParamsForFrame({ linearUnitToMetres: FOOT, verticalUnitToMetres: FOOT }),
    });

    // The block is a building and the plane is ground in both frames.
    expect(metreRes.counts[DERIVED_BUILDING]).toBeGreaterThan(0);
    expect(metreRes.counts[DERIVED_GROUND]).toBeGreaterThan(0);
    // Same physical scene, so the per-code totals match point-for-point.
    expect(footRes.counts[DERIVED_BUILDING]).toBe(metreRes.counts[DERIVED_BUILDING]);
    expect(footRes.counts[DERIVED_GROUND]).toBe(metreRes.counts[DERIVED_GROUND]);
  });
});
