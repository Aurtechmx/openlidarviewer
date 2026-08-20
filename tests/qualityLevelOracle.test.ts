/**
 * qualityLevelOracle.test.ts — the USGS 3DEP quality-level comparison against an
 * ANALYTIC ORACLE, not against the implementation's control flow.
 *
 * The quality level is one of the few figures this project produces whose right
 * answer is defined OUTSIDE this repository. USGS publishes the table (3D
 * Elevation Program, "Topographic Data Quality Levels (QLs)" / Lidar Base
 * Specification, Table 1):
 *
 *   ┌───────┬───────────────────┬──────────────────────┐
 *   │ Level │ Vertical accuracy │ Nominal pulse density│
 *   ├───────┼───────────────────┼──────────────────────┤
 *   │ QL0   │ RMSEz  5 cm       │ ≥ 8   pts/m²         │
 *   │ QL1   │ RMSEz 10 cm       │ ≥ 8   pts/m²         │
 *   │ QL2   │ RMSEz 10 cm       │ ≥ 2   pts/m²         │
 *   │ QL3   │ RMSEz 20 cm       │ ≥ 0.5 pts/m²         │
 *   └───────┴───────────────────┴──────────────────────┘
 *
 * {@link SPEC} below is that table transcribed by hand, and {@link expectedLevel}
 * derives the answer from it by picking the STRONGEST row a (density, RMSEz)
 * pair satisfies — walking an explicit strength order, never the array order.
 * The module under test walks its own table with `Array.prototype.find`, so the
 * two agree only while that table stays ordered best-first with every row
 * relaxing both legs. Reorder or re-tune a row and the grid below reds.
 *
 * ── WHICH BOUNDS ARE INCLUSIVE, AND WHY ────────────────────────────────────
 * Both. The published density leg is written "≥ N pts/square meter", so a scan
 * landing exactly on the floor MEETS the level. The accuracy leg is the RMSEz a
 * collection is required to be at or within, so a measured RMSEz exactly equal
 * to the figure MEETS it too. "≥ 2 pts/m²" in a specification sentence and `>=`
 * in code are the same claim only once someone has checked, so every one of the
 * six bounds is asserted three times here: exactly on the figure, one ULP inside
 * it, and one ULP outside it. A `>` for a `>=` (or `<` for `<=`) moves exactly
 * one grid point and is caught.
 *
 * ── WHAT THIS DOES NOT ESTABLISH ───────────────────────────────────────────
 * That a scan IS a given quality level. A 3DEP determination rests on RMSEz
 * against independent survey checkpoints plus collection requirements this
 * module never sees; the RMSEz fed in here is hold-out validation against
 * internally withheld ground points. What is verified is the comparison: given a
 * density and an RMSEz, the level named is the one the published table names.
 */

import { describe, it, expect } from 'vitest';
import { demAccuracyStandards, type UsgsQualityLevel } from '../src/terrain/quality/demAccuracyStandards';

// ── the oracle ──────────────────────────────────────────────────────────────

/** The published table, transcribed independently of the module's own copy. */
const SPEC: ReadonlyArray<{
  readonly level: UsgsQualityLevel;
  readonly maxRmseM: number;
  readonly minDensityPerM2: number;
}> = [
  { level: 'QL2', maxRmseM: 0.1, minDensityPerM2: 2 },
  { level: 'QL0', maxRmseM: 0.05, minDensityPerM2: 8 },
  { level: 'QL3', maxRmseM: 0.2, minDensityPerM2: 0.5 },
  { level: 'QL1', maxRmseM: 0.1, minDensityPerM2: 8 },
];

/**
 * Strongest → weakest. Deliberately separate from {@link SPEC}'s array order,
 * which is deliberately NOT best-first: the oracle must not be able to inherit
 * an ordering bug from the shape of a table, because that is the exact bug it
 * exists to detect in the module.
 */
const STRENGTH: readonly UsgsQualityLevel[] = ['QL0', 'QL1', 'QL2', 'QL3'];

/**
 * The expected level for a (density, RMSEz) pair, straight off {@link SPEC}.
 * A fact that cannot be established degrades to `unknown` rather than being
 * guessed: no RMSEz, an unusable RMSEz, or no measured density means no level.
 */
function expectedLevel(densityPerM2: number, rmseZM: number | null): UsgsQualityLevel {
  if (rmseZM == null || !Number.isFinite(rmseZM) || rmseZM < 0) return 'unknown';
  if (!Number.isFinite(densityPerM2) || densityPerM2 <= 0) return 'unknown';
  const met = new Set(
    SPEC.filter((r) => densityPerM2 >= r.minDensityPerM2 && rmseZM <= r.maxRmseM).map((r) => r.level),
  );
  return STRENGTH.find((l) => met.has(l)) ?? 'below-QL3';
}

/** The level the module actually reports. */
const actualLevel = (densityPerM2: number, rmseZM: number | null): UsgsQualityLevel =>
  demAccuracyStandards(rmseZM, null, densityPerM2).qualityLevel;

// ── ULP stepping ────────────────────────────────────────────────────────────

const BITS = new DataView(new ArrayBuffer(8));

/** The adjacent representable double above (`+1`) or below (`-1`) a positive x. */
function step(x: number, dir: 1 | -1): number {
  BITS.setFloat64(0, x);
  BITS.setBigUint64(0, BITS.getBigUint64(0) + BigInt(dir));
  return BITS.getFloat64(0);
}
const nextUp = (x: number): number => step(x, 1);
const nextDown = (x: number): number => step(x, -1);

// ── the boundary figures ────────────────────────────────────────────────────

const DENSITY_FLOORS = [0.5, 2, 8] as const;
const RMSE_CEILINGS = [0.05, 0.1, 0.2] as const;

describe('USGS quality-level classification vs the published 3DEP table', () => {
  it('steps by one ULP, with nothing representable in between', () => {
    for (const x of [...DENSITY_FLOORS, ...RMSE_CEILINGS]) {
      expect(nextUp(x)).toBeGreaterThan(x);
      expect(nextDown(x)).toBeLessThan(x);
      expect(nextDown(nextUp(x))).toBe(x);
      expect(nextUp(nextDown(x))).toBe(x);
      // Adjacency: the midpoint of x and its neighbour rounds back to one of them.
      expect([x, nextUp(x)]).toContain((x + nextUp(x)) / 2);
    }
  });

  it('both legs are INCLUSIVE: a value exactly on a published bound meets that level', () => {
    // Density exactly on each floor, with an RMSEz well inside every ceiling.
    expect(actualLevel(8, 0.01)).toBe('QL0');
    expect(actualLevel(2, 0.01)).toBe('QL2');
    expect(actualLevel(0.5, 0.01)).toBe('QL3');
    // RMSEz exactly on each ceiling, with a density well inside every floor.
    expect(actualLevel(50, 0.05)).toBe('QL0');
    expect(actualLevel(50, 0.1)).toBe('QL1');
    expect(actualLevel(50, 0.2)).toBe('QL3');
    // Both legs exactly on the bound at once — the corner of each cell.
    expect(actualLevel(8, 0.05)).toBe('QL0');
    expect(actualLevel(8, 0.1)).toBe('QL1');
    expect(actualLevel(2, 0.1)).toBe('QL2');
    expect(actualLevel(0.5, 0.2)).toBe('QL3');
  });

  it('one ULP INSIDE a bound still meets the level', () => {
    expect(actualLevel(nextUp(8), 0.01)).toBe('QL0');
    expect(actualLevel(nextUp(2), 0.01)).toBe('QL2');
    expect(actualLevel(nextUp(0.5), 0.01)).toBe('QL3');
    expect(actualLevel(50, nextDown(0.05))).toBe('QL0');
    expect(actualLevel(50, nextDown(0.1))).toBe('QL1');
    expect(actualLevel(50, nextDown(0.2))).toBe('QL3');
  });

  it('one ULP OUTSIDE a bound drops to the next level the pair actually meets', () => {
    // Density one ULP under a floor: the pair falls through to the next row down.
    expect(actualLevel(nextDown(8), 0.01)).toBe('QL2');
    expect(actualLevel(nextDown(2), 0.01)).toBe('QL3');
    expect(actualLevel(nextDown(0.5), 0.01)).toBe('below-QL3');
    // RMSEz one ULP over a ceiling: likewise.
    expect(actualLevel(50, nextUp(0.05))).toBe('QL1');
    expect(actualLevel(50, nextUp(0.1))).toBe('QL3');
    expect(actualLevel(50, nextUp(0.2))).toBe('below-QL3');
    expect(actualLevel(2, nextUp(0.1))).toBe('QL3');
    expect(actualLevel(0.5, nextUp(0.2))).toBe('below-QL3');
  });

  it('separates QL0 from QL1, which share the 8 pts/m² floor and differ only by RMSEz', () => {
    for (const density of [8, nextUp(8), 12, 200]) {
      // Everything at or under 5 cm is QL0; the first representable value above
      // it is QL1, and QL1 holds all the way to 10 cm inclusive.
      expect(actualLevel(density, 0)).toBe('QL0');
      expect(actualLevel(density, nextDown(0.05))).toBe('QL0');
      expect(actualLevel(density, 0.05)).toBe('QL0');
      expect(actualLevel(density, nextUp(0.05))).toBe('QL1');
      expect(actualLevel(density, 0.08)).toBe('QL1');
      expect(actualLevel(density, nextDown(0.1))).toBe('QL1');
      expect(actualLevel(density, 0.1)).toBe('QL1');
      // Past 10 cm the density is irrelevant: only QL3's 20 cm ceiling is left.
      expect(actualLevel(density, nextUp(0.1))).toBe('QL3');
    }
  });

  it('returns the STRONGEST level a pair satisfies, over the whole boundary grid', () => {
    const densities = [
      0, 0.1, 0.25, nextDown(0.5), 0.5, nextUp(0.5), 1, nextDown(2), 2, nextUp(2),
      5, nextDown(8), 8, nextUp(8), 20, 100,
    ];
    const rmses = [
      0, 0.01, nextDown(0.05), 0.05, nextUp(0.05), 0.075, nextDown(0.1), 0.1,
      nextUp(0.1), 0.15, nextDown(0.2), 0.2, nextUp(0.2), 0.5,
    ];
    const disagreements: string[] = [];
    for (const d of densities) {
      for (const r of rmses) {
        const got = actualLevel(d, r);
        const want = expectedLevel(d, r);
        if (got !== want) disagreements.push(`density=${d} rmse=${r}: got ${got}, table says ${want}`);
      }
    }
    expect(disagreements).toEqual([]);
    expect(densities.length * rmses.length).toBe(224);
  });

  it('never names a level the published table does not grant that pair', () => {
    // Soundness, independent of the equality check above: whenever a level comes
    // back, the pair genuinely clears BOTH legs of that row in the transcription.
    for (const d of [0.5, 1, 2, 3, 8, 9, 40]) {
      for (const r of [0, 0.05, 0.09, 0.1, 0.19, 0.2, 0.4]) {
        const got = actualLevel(d, r);
        if (got === 'below-QL3' || got === 'unknown') continue;
        const row = SPEC.find((s) => s.level === got);
        expect(row, `no published row named ${got}`).toBeDefined();
        expect(d).toBeGreaterThanOrEqual(row!.minDensityPerM2);
        expect(r).toBeLessThanOrEqual(row!.maxRmseM);
      }
    }
  });

  it('is below-QL3 when the pair clears no row, rather than rounding down to one', () => {
    expect(actualLevel(0.4, 0.01)).toBe('below-QL3'); // density under the QL3 floor
    expect(actualLevel(100, 0.25)).toBe('below-QL3'); // RMSEz over the QL3 ceiling
    expect(actualLevel(0.4, 0.25)).toBe('below-QL3'); // both
    expect(demAccuracyStandards(0.25, null, 100).qualityLevelReason).toContain('below the USGS QL3');
  });
});

describe('USGS quality-level classification: inputs that establish no fact', () => {
  /** Each case must degrade to `unknown` — never to a fabricated level. */
  const UNUSABLE_RMSE: ReadonlyArray<readonly [string, number | null]> = [
    ['missing (null)', null],
    ['NaN', Number.NaN],
    ['+Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['negative', -0.01],
    ['very negative', -1000],
  ];

  const UNUSABLE_DENSITY: ReadonlyArray<readonly [string, number]> = [
    ['zero', 0],
    ['negative zero', -0],
    ['negative', -3],
    ['NaN', Number.NaN],
    ['+Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ];

  for (const [label, rmse] of UNUSABLE_RMSE) {
    it(`RMSEz ${label} yields unknown at any density`, () => {
      for (const density of [0.5, 2, 8, 1000]) {
        const s = demAccuracyStandards(rmse, 0.2, density);
        expect(s.qualityLevel).toBe('unknown');
        expect(s.qualityLevel).toBe(expectedLevel(density, rmse));
        // An unusable RMSEz cannot become an accuracy figure either.
        expect(s.rmseZM).toBeNull();
        expect(s.nvaM).toBeNull();
        expect(s.qualityLevelReason).toContain('Not enough validated points');
      }
    });
  }

  for (const [label, density] of UNUSABLE_DENSITY) {
    it(`density ${label} yields unknown at any RMSEz`, () => {
      for (const rmse of [0, 0.01, 0.05, 0.1, 0.2, 5]) {
        const s = demAccuracyStandards(rmse, 0.2, density);
        expect(s.qualityLevel).toBe('unknown');
        expect(s.qualityLevel).toBe(expectedLevel(density, rmse));
        expect(s.qualityLevelReason).toContain('No measured ground density');
        // A non-finite or negative density is reported as 0, not passed through.
        expect(s.pointDensityPerM2).toBe(0);
        // The RMSEz itself was measurable, so it survives; only the level does not.
        expect(s.rmseZM).toBe(rmse);
      }
    });
  }

  it('an RMSEz of exactly zero is a measurement, not a missing fact', () => {
    const s = demAccuracyStandards(0, null, 9);
    expect(s.qualityLevel).toBe('QL0');
    expect(s.rmseZM).toBe(0);
    expect(s.nvaM).toBe(0);
  });

  it('a non-finite VVA is dropped rather than reported', () => {
    for (const vva of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(demAccuracyStandards(0.08, vva, 9).vvaM).toBeNull();
    }
    expect(demAccuracyStandards(0.08, null, 9).vvaM).toBeNull();
    expect(demAccuracyStandards(0.08, 0.21, 9).vvaM).toBe(0.21);
  });

  it('states the level it matched and disclaims a 3DEP determination', () => {
    for (const [density, rmse, level] of [
      [9, 0.04, 'QL0'],
      [9, 0.08, 'QL1'],
      [3, 0.09, 'QL2'],
      [1, 0.15, 'QL3'],
    ] as const) {
      const s = demAccuracyStandards(rmse, null, density);
      expect(s.qualityLevel).toBe(level);
      expect(s.qualityLevelReason).toContain(level);
      expect(s.qualityLevelReason).toContain('not a USGS 3DEP determination');
    }
  });
});
