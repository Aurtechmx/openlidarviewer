/**
 * qualityLevelOracle.test.ts — the USGS 3DEP nominal-pulse-density FLOORS used
 * as a REFERENCE, checked against an ANALYTIC ORACLE, not the implementation's
 * control flow.
 *
 * The module no longer emits a quality-level GRADE: ground-return density is not
 * nominal pulse density (NPD/ANPD), and a merged/tiled cloud need not carry the
 * swath context a 3DEP determination requires. What it reports is, as context
 * only, which published 3DEP nominal-pulse-density FLOORS the measured
 * ground-return density clears. USGS publishes those floors (3D Elevation
 * Program, Lidar Base Specification, Table 1):
 *
 *   QL0 ≥ 8 pts/m² · QL1 ≥ 8 · QL2 ≥ 2 · QL3 ≥ 0.5
 *
 * {@link SPEC} is that column transcribed by hand, and {@link expectedFloors}
 * derives the answer from it, walking an explicit strength order rather than the
 * array order. The floor is INCLUSIVE ("≥ N pts/m²"), so a density exactly on a
 * floor clears it; every floor is asserted three times — exactly on it, one ULP
 * inside, one ULP outside — so a `>` for a `>=` moves exactly one grid point and
 * is caught.
 *
 * WHAT THIS DOES NOT ESTABLISH: that a scan IS any quality level. This is a
 * density reference only — a determination rests on pulse density measured from
 * first returns with swath context, and on checkpoint accuracy, none of which
 * this module sees.
 */

import { describe, it, expect } from 'vitest';
import {
  demAccuracyStandards,
  type UsgsDensityFloor,
} from '../src/terrain/quality/demAccuracyStandards';

// ── the oracle ──────────────────────────────────────────────────────────────

/** The published density floors, transcribed independently of the module's copy. */
const SPEC: ReadonlyArray<{ readonly level: UsgsDensityFloor; readonly minDensityPerM2: number }> = [
  { level: 'QL2', minDensityPerM2: 2 },
  { level: 'QL0', minDensityPerM2: 8 },
  { level: 'QL3', minDensityPerM2: 0.5 },
  { level: 'QL1', minDensityPerM2: 8 },
];

/** Strongest → weakest. Separate from {@link SPEC}'s (non-sorted) array order. */
const STRENGTH: readonly UsgsDensityFloor[] = ['QL0', 'QL1', 'QL2', 'QL3'];

/** The floors a density clears, strongest first, straight off {@link SPEC}. */
function expectedFloors(densityPerM2: number): UsgsDensityFloor[] {
  if (!Number.isFinite(densityPerM2) || densityPerM2 <= 0) return [];
  const met = new Set(SPEC.filter((r) => densityPerM2 >= r.minDensityPerM2).map((r) => r.level));
  return STRENGTH.filter((l) => met.has(l));
}

/** The floors the module actually reports. */
const actualFloors = (densityPerM2: number): readonly UsgsDensityFloor[] =>
  demAccuracyStandards(0.05, null, densityPerM2).densityReferenceFloorsMet;

// ── ULP stepping ────────────────────────────────────────────────────────────

const BITS = new DataView(new ArrayBuffer(8));
function step(x: number, dir: 1 | -1): number {
  BITS.setFloat64(0, x);
  BITS.setBigUint64(0, BITS.getBigUint64(0) + BigInt(dir));
  return BITS.getFloat64(0);
}
const nextUp = (x: number): number => step(x, 1);
const nextDown = (x: number): number => step(x, -1);

const DENSITY_FLOORS = [0.5, 2, 8] as const;

describe('USGS density-floor reference vs the published 3DEP table', () => {
  it('steps by one ULP, with nothing representable in between', () => {
    for (const x of DENSITY_FLOORS) {
      expect(nextUp(x)).toBeGreaterThan(x);
      expect(nextDown(x)).toBeLessThan(x);
      expect(nextDown(nextUp(x))).toBe(x);
      expect([x, nextUp(x)]).toContain((x + nextUp(x)) / 2);
    }
  });

  it('the floor is INCLUSIVE: a density exactly on it clears it', () => {
    expect(actualFloors(8)).toEqual(['QL0', 'QL1', 'QL2', 'QL3']);
    expect(actualFloors(2)).toEqual(['QL2', 'QL3']);
    expect(actualFloors(0.5)).toEqual(['QL3']);
  });

  it('one ULP INSIDE a floor still clears it', () => {
    expect(actualFloors(nextUp(8))).toEqual(['QL0', 'QL1', 'QL2', 'QL3']);
    expect(actualFloors(nextUp(2))).toEqual(['QL2', 'QL3']);
    expect(actualFloors(nextUp(0.5))).toEqual(['QL3']);
  });

  it('one ULP OUTSIDE a floor drops it', () => {
    expect(actualFloors(nextDown(8))).toEqual(['QL2', 'QL3']);
    expect(actualFloors(nextDown(2))).toEqual(['QL3']);
    expect(actualFloors(nextDown(0.5))).toEqual([]);
  });

  it('matches the published floors over the whole boundary grid', () => {
    const densities = [
      0, 0.1, 0.25, nextDown(0.5), 0.5, nextUp(0.5), 1, nextDown(2), 2, nextUp(2),
      5, nextDown(8), 8, nextUp(8), 20, 100,
    ];
    const disagreements: string[] = [];
    for (const d of densities) {
      const got = actualFloors(d);
      const want = expectedFloors(d);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        disagreements.push(`density=${d}: got ${JSON.stringify(got)}, table says ${JSON.stringify(want)}`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('never names a floor the published table does not grant that density', () => {
    for (const d of [0.5, 1, 2, 3, 8, 9, 40]) {
      for (const level of actualFloors(d)) {
        const row = SPEC.find((s) => s.level === level);
        expect(row, `no published row named ${level}`).toBeDefined();
        expect(d).toBeGreaterThanOrEqual(row!.minDensityPerM2);
      }
    }
  });

  it('clears no floor when the density is under the QL3 floor', () => {
    expect(actualFloors(0.4)).toEqual([]);
    expect(demAccuracyStandards(0.05, null, 0.4).densityReferenceNote).toContain('below the USGS 3DEP QL3');
  });
});

describe('USGS density reference: inputs that establish no density fact', () => {
  const UNUSABLE_DENSITY: ReadonlyArray<readonly [string, number]> = [
    ['zero', 0],
    ['negative zero', -0],
    ['negative', -3],
    ['NaN', Number.NaN],
    ['+Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ];

  for (const [label, density] of UNUSABLE_DENSITY) {
    it(`density ${label} clears no floor and says so`, () => {
      const s = demAccuracyStandards(0.05, 0.2, density);
      expect(s.densityReferenceFloorsMet).toEqual([]);
      expect(s.densityReferenceFloorsMet).toEqual(expectedFloors(density));
      expect(s.densityReferenceNote).toContain('No measured ground-return density');
      // A non-finite or negative density is reported as 0, not passed through.
      expect(s.pointDensityPerM2).toBe(0);
      // The RMSEz itself was measurable, so it survives.
      expect(s.rmseZM).toBe(0.05);
    });
  }

  it('a non-finite VVA is dropped rather than reported', () => {
    for (const vva of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(demAccuracyStandards(0.08, vva, 9).vvaM).toBeNull();
    }
    expect(demAccuracyStandards(0.08, null, 9).vvaM).toBeNull();
    expect(demAccuracyStandards(0.08, 0.21, 9).vvaM).toBe(0.21);
  });

  it('names the floor cleared as a reference and disclaims a determination', () => {
    for (const [density, strongest] of [
      [9, 'QL0'],
      [3, 'QL2'],
      [1, 'QL3'],
    ] as const) {
      const s = demAccuracyStandards(0.05, null, density);
      expect(s.densityReferenceFloorsMet[0]).toBe(strongest);
      expect(s.densityReferenceNote).toContain(strongest);
      expect(s.densityReferenceNote).toMatch(/not a nominal-pulse-density/i);
    }
  });
});
