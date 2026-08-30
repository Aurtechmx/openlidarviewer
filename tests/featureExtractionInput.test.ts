import { describe, it, expect } from 'vitest';
import { buildFeatureExtractionInput } from '../src/app/featureExtractionInput';
import type { PointCloud } from '../src/model/PointCloud';

/**
 * tests/featureExtractionInput.test.ts
 *
 * The bridge from a loaded cloud to the feature cores. What is guarded here is
 * exactly what the review surface trusts: which points are building vs wire, the
 * horizontal pair by up axis, and the fail-CLOSED unit derivation (a missing CRS
 * must read as unknown, never as metres).
 */

/** A minimal cloud stub — only the fields the builder reads. */
function stub(fields: Partial<PointCloud>): PointCloud {
  return {
    positions: new Float32Array(0),
    classification: undefined,
    classificationIsDerived: false,
    sourceFormat: 'las',
    metadata: undefined,
    ...fields,
  } as unknown as PointCloud;
}

describe('buildFeatureExtractionInput', () => {
  it('returns null when the cloud has no classification', () => {
    expect(buildFeatureExtractionInput(stub({ positions: new Float32Array([0, 0, 0]) }))).toBeNull();
  });

  it('returns null when no point is building- or wire-classified', () => {
    const input = buildFeatureExtractionInput(
      stub({
        positions: new Float32Array([0, 0, 0, 1, 1, 1]),
        classification: new Uint8Array([2, 5]), // ground, high vegetation
      }),
    );
    expect(input).toBeNull();
  });

  it('splits building (6) and wire (14) points, Z-up using (x, y) horizontal', () => {
    const input = buildFeatureExtractionInput(
      stub({
        // building at (10, 20, 3), wire at (1, 2, 40)
        positions: new Float32Array([10, 20, 3, 1, 2, 40]),
        classification: new Uint8Array([6, 14]),
        sourceFormat: 'las',
      }),
    );
    expect(input).not.toBeNull();
    expect(input!.buildingPoints).toEqual([{ x: 10, y: 20 }]);
    expect(input!.conductorPoints).toEqual([[1, 2, 40]]);
    expect(input!.up).toEqual([0, 0, 1]);
  });

  it('uses (x, z) horizontal for a Y-up format', () => {
    const input = buildFeatureExtractionInput(
      stub({
        positions: new Float32Array([10, 99, 20]), // y is up, so horizontal is (x=10, z=20)
        classification: new Uint8Array([6]),
        sourceFormat: 'ply',
      }),
    );
    expect(input!.buildingPoints).toEqual([{ x: 10, y: 20 }]);
    expect(input!.up).toEqual([0, 1, 0]);
  });

  it('derives a KNOWN unit only when the CRS declares one', () => {
    const known = buildFeatureExtractionInput(
      stub({
        positions: new Float32Array([0, 0, 0]),
        classification: new Uint8Array([6]),
        metadata: { crs: { linearUnit: 'foot', linearUnitToMetres: 0.3048 } },
      } as unknown as Partial<PointCloud>),
    );
    expect(known!.unit.known).toBe(true);
  });

  it('fails CLOSED to an unknown unit when no CRS is present', () => {
    const input = buildFeatureExtractionInput(
      stub({
        positions: new Float32Array([0, 0, 0]),
        classification: new Uint8Array([6]),
        metadata: undefined,
      }),
    );
    expect(input!.unit.known).toBe(false);
  });

  it('fails CLOSED when the CRS linear unit is unknown', () => {
    const input = buildFeatureExtractionInput(
      stub({
        positions: new Float32Array([0, 0, 0]),
        classification: new Uint8Array([6]),
        metadata: { crs: { linearUnit: 'unknown', linearUnitToMetres: 1 } },
      } as unknown as Partial<PointCloud>),
    );
    expect(input!.unit.known).toBe(false);
  });

  it('carries the derived-classification flag through', () => {
    const input = buildFeatureExtractionInput(
      stub({
        positions: new Float32Array([0, 0, 0]),
        classification: new Uint8Array([6]),
        classificationIsDerived: true,
      }),
    );
    expect(input!.classificationIsDerived).toBe(true);
  });
});
