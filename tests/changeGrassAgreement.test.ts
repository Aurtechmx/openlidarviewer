/**
 * changeGrassAgreement.test.ts — OLV's change detection against GRASS and
 * against closed-form truth.
 *
 * The candidate is `detectChange`, the production function. Nothing here
 * recomputes a difference or a volume; a harness that did would compare the
 * formula to itself.
 *
 * Two references, and they answer different questions. GRASS `r.mapcalc` is an
 * independent implementation of the same quantity, which is what a
 * cross-implementation result means. The `truth` field on each fixture is the
 * closed-form volume computed from how the case was constructed, and it
 * outranks the agreement: two programs summing the same wrong cells agree
 * perfectly, so a leg that only ever compares implementations cannot tell that
 * apart from both being right.
 *
 * References are committed, so this runs where GRASS is not installed.
 * Regenerating them is a separate job:
 *
 *   node validation/external-oracles/change/make-fixtures.mjs
 *   GRASSBIN=... node validation/external-oracles/change/run-grass.mjs
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { detectChange } from '../src/terrain/change/changeDetection';
import type { ChangeGrid } from '../src/terrain/change/changeDetection';

const DIR = resolve(__dirname, '../validation/external-oracles/change');

interface Truth { gainVolumeM3: number; lossVolumeM3: number; gainedCells: number; lostCells: number }
interface Case {
  id: string; why: string; width: number; height: number;
  truth: Truth; a: (number | null)[]; b: (number | null)[];
}
interface Fixtures { levelOfDetectionM: number; cellSizeM: number; cases: Case[] }
interface GrassResult {
  id: string; comparableCells: number; gainedCells: number; lostCells: number;
  gainVolumeM3: number; lossVolumeM3: number;
}
interface Reference {
  fixturesSha256: string; caseCount: number; levelOfDetectionM: number;
  oracles: { oracleId: string; role: string; executablePath: string; versionOutput: string }[];
  results: GrassResult[];
}

const fixturesRaw = readFileSync(resolve(DIR, 'fixtures.json'), 'utf8');
const fixtures: Fixtures = JSON.parse(fixturesRaw);
const reference: Reference = JSON.parse(readFileSync(resolve(DIR, 'references/grass-change.json'), 'utf8'));

/**
 * The tolerance comes from the storage, not from the observed numbers.
 *
 * `ChangeGrid.values` is a Float32Array, so an elevation is held to a 24-bit
 * mantissa and a difference of two similar values loses several of those bits
 * to the shared exponent. A Δz that is not exactly representable in binary
 * therefore carries a relative error of order 1e-6 into every cell of the sum.
 * The fixtures show exactly that split: the cases whose Δz is a binary-exact
 * 0.5, 1.0, 1.5 or 2.0 agree to the last digit, and the 1.2, 0.06 and 0.1x
 * cases do not.
 *
 * So the gate is relative, at roughly an order of magnitude above float32
 * epsilon, with an absolute floor for the cases whose correct answer is zero.
 * An absolute tolerance would either fail the large volumes or be meaningless
 * on the small ones.
 */
const VOLUME_REL_TOL = 1e-5;
const VOLUME_ABS_FLOOR_M3 = 1e-9;

/** Whether two volumes agree, given float32 storage on the candidate's side. */
const volumesAgree = (got: number, want: number): boolean =>
  Math.abs(got - want) <= Math.max(VOLUME_ABS_FLOOR_M3, Math.abs(want) * VOLUME_REL_TOL);

const toGrid = (values: (number | null)[], width: number, height: number): ChangeGrid => {
  const v = new Float32Array(width * height);
  for (let i = 0; i < v.length; i++) v[i] = values[i] === null ? Number.NaN : (values[i] as number);
  return { width, height, cellSizeM: fixtures.cellSizeM, values: v };
};

const runCase = (c: Case) =>
  detectChange(toGrid(c.a, c.width, c.height), toGrid(c.b, c.width, c.height), {
    levelOfDetectionM: fixtures.levelOfDetectionM,
    horizontalUnitToMetres: 1,
  });

const grassFor = (id: string) => reference.results.find((r) => r.id === id) as GrassResult;

describe('change oracle — the record is bound to what produced it', () => {
  it('was generated from the committed fixtures', () => {
    const digest = `sha256:${createHash('sha256').update(fixturesRaw).digest('hex')}`;
    expect(reference.fixturesSha256).toBe(digest);
  });

  it('used the same level of detection the candidate is given', () => {
    // A reference thresholded differently would disagree for a reason that has
    // nothing to do with either implementation.
    expect(reference.levelOfDetectionM).toBe(fixtures.levelOfDetectionM);
  });

  it('names GRASS with the executable and version it ran', () => {
    expect(reference.oracles).toHaveLength(1);
    expect(reference.oracles[0].oracleId).toBe('grass-8.5.0');
    expect(reference.oracles[0].role).toBe('independent-same-quantity-implementation');
    expect(reference.oracles[0].versionOutput).toMatch(/GRASS\s+8\./);
  });

  it('covers every fixture', () => {
    expect(reference.caseCount).toBe(fixtures.cases.length);
    for (const c of fixtures.cases) expect(grassFor(c.id), `${c.id} missing`).toBeTruthy();
  });
});

describe('against closed-form truth, which outranks agreement', () => {
  it.each(fixtures.cases.map((c) => [c.id, c] as const))(
    'gain and loss volume match the construction for %s',
    (_id, c) => {
      const r = runCase(c);
      expect(volumesAgree(r.stats.gainVolumeM3, c.truth.gainVolumeM3), `gain ${r.stats.gainVolumeM3} vs ${c.truth.gainVolumeM3}`).toBe(true);
      expect(volumesAgree(r.stats.lossVolumeM3, c.truth.lossVolumeM3), `loss ${r.stats.lossVolumeM3} vs ${c.truth.lossVolumeM3}`).toBe(true);
      expect(r.stats.gained).toBe(c.truth.gainedCells);
      expect(r.stats.lost).toBe(c.truth.lostCells);
    },
  );

  it('GRASS also matches truth, so the reference is not merely self-consistent', () => {
    // If the oracle disagreed with truth, its agreement with the candidate
    // would say nothing about whether the candidate is right.
    for (const c of fixtures.cases) {
      const g = grassFor(c.id);
      // GRASS computes in double, so it is held to a far tighter bound than the
      // candidate: it must be exact to a microlitre, not merely close.
      expect(Math.abs(g.gainVolumeM3 - c.truth.gainVolumeM3), `${c.id} gain`).toBeLessThan(1e-6);
      expect(Math.abs(g.lossVolumeM3 - c.truth.lossVolumeM3), `${c.id} loss`).toBeLessThan(1e-6);
    }
  });
});

describe('against GRASS, an independent implementation', () => {
  it.each(fixtures.cases.map((c) => [c.id, c] as const))(
    'volumes and cell counts agree with r.mapcalc for %s',
    (_id, c) => {
      const r = runCase(c);
      const g = grassFor(c.id);
      expect(volumesAgree(r.stats.gainVolumeM3, g.gainVolumeM3), `gain ${r.stats.gainVolumeM3} vs ${g.gainVolumeM3}`).toBe(true);
      expect(volumesAgree(r.stats.lossVolumeM3, g.lossVolumeM3), `loss ${r.stats.lossVolumeM3} vs ${g.lossVolumeM3}`).toBe(true);
      expect(r.stats.gained).toBe(g.gainedCells);
      expect(r.stats.lost).toBe(g.lostCells);
    },
  );

  it('agrees on which cells are comparable, including where an epoch has holes', () => {
    // The hole case is the one that separates "absent" from "zero". A run that
    // read a missing cell as no-change would count the same comparable total
    // and a different volume.
    for (const c of fixtures.cases) {
      expect(runCase(c).stats.comparable, `${c.id}`).toBe(grassFor(c.id).comparableCells);
    }
  });

  it('every case passes both legs, which is what the decision rule requires', () => {
    const failures = fixtures.cases.filter((c) => {
      const r = runCase(c);
      const g = grassFor(c.id);
      return !(
        volumesAgree(r.stats.gainVolumeM3, g.gainVolumeM3) &&
        volumesAgree(r.stats.lossVolumeM3, g.lossVolumeM3) &&
        volumesAgree(r.stats.gainVolumeM3, c.truth.gainVolumeM3) &&
        volumesAgree(r.stats.lossVolumeM3, c.truth.lossVolumeM3)
      );
    });
    expect(failures.map((c) => c.id)).toEqual([]);
  });
});

describe('the threshold edge, which a single case cannot cover', () => {
  it('excludes a sub-threshold shift entirely rather than reporting a small volume', () => {
    const c = fixtures.cases.find((x) => x.id === 'C05-sub-lod') as Case;
    const r = runCase(c);
    expect(r.stats.gainVolumeM3).toBe(0);
    expect(r.stats.gained).toBe(0);
    // Still comparable: the cells exist and were measured, they just did not move enough.
    expect(r.stats.comparable).toBe(c.width * c.height);
  });

  it('includes a shift one centimetre above the same threshold', () => {
    const c = fixtures.cases.find((x) => x.id === 'C06-just-above-lod') as Case;
    const r = runCase(c);
    expect(r.stats.gained).toBe(c.width * c.height);
    expect(volumesAgree(r.stats.gainVolumeM3, c.truth.gainVolumeM3)).toBe(true);
  });
});
