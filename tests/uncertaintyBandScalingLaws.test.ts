/**
 * uncertaintyBandScalingLaws.test.ts
 *
 * UNCERTAINTY-BAND against the SCALING LAWS its own error model implies. The
 * model is documented in `changeUncertainty.ts`: random per-cell noise added in
 * quadrature, plus a systematic co-registration term that does not average
 * away. Those two sentences have consequences that can be written down without
 * writing down the formulas, and the consequences are what this file asserts —
 * restating `area · σ · √N` here would only prove the file agrees with itself.
 *
 * The laws, derived from the model rather than read off the implementation:
 *
 *   L1  With no per-cell σ, the random term is exactly zero: it is proportional
 *       to that σ, so nothing else can leak into it.
 *   L2  The random term grows as √N. Quadrupling the changed-cell count doubles
 *       it — the signature of errors added in quadrature, and the property a
 *       linear sum cannot imitate.
 *   L3  The systematic term grows as N, i.e. linearly with changed AREA. Same
 *       fourfold change in cell count, fourfold change in the term.
 *   L4  Because of L2 and L3 the two respond DIFFERENTLY to the same input, so
 *       their ratio moves as √N. This is the entire reason a co-registration
 *       error is modelled apart from survey noise, and it is what makes the
 *       band more than a single fudge factor.
 *   L5  Both terms are linear in cell AREA, which separates area-dependence
 *       from count-dependence: a change that moves one but not the other would
 *       be confusing the two.
 *   L6  Combining two independent sources can only widen the band, and by less
 *       than their arithmetic sum: max(r, s) < σ < r + s whenever both are
 *       positive. That brackets quadrature without restating it.
 *   L7  Relative error under a purely RANDOM budget falls as 1/√N — averaging
 *       works — while under a purely SYSTEMATIC budget it does not move at all.
 *       So a bias survives any amount of averaging, and detectability under a
 *       systematic budget depends only on how big the change is against the
 *       registration error, never on how many cells were surveyed.
 *   L8  A band is never negative, never narrower than its own detectability
 *       threshold implies, and always brackets the net symmetrically.
 *   L9  The band and the level of detection agree at the boundary: a single
 *       cell that just clears the LoD sits exactly at the ~95 % detection
 *       threshold in VOLUME terms. Two modules, one convention.
 *
 * Pure, deterministic, no randomness anywhere.
 */

import { describe, it, expect } from 'vitest';
import {
  changeVolumeUncertainty,
  cellSigmaFromLoD,
  type ChangeVolumeUncertaintyInput,
} from '../src/terrain/change/changeUncertainty';

/** One knob at a time: every law below varies a single field of this base. */
const base: ChangeVolumeUncertaintyInput = {
  netVolumeM3: 1000,
  significantCells: 400,
  cellAreaM2: 1,
  cellSigmaM: 0.05,
  registrationSigmaM: 0,
};

const band = (over: Partial<ChangeVolumeUncertaintyInput> = {}) =>
  changeVolumeUncertainty({ ...base, ...over });

/** A uniform Δ over N cells: the net volume such a change actually produces. */
const uniformNet = (cells: number, cellAreaM2: number, riseM: number) =>
  cells * cellAreaM2 * riseM;

describe('L1 — with no per-cell σ the random term is exactly zero', () => {
  it('leaves the random component at exactly 0 and the band at the systematic term alone', () => {
    const r = band({ cellSigmaM: 0, registrationSigmaM: 0.02 });
    expect(r.randomErrorM3).toBe(0);
    expect(r.sigmaM3).toBe(r.systematicErrorM3);
    expect(r.sigmaM3).toBeGreaterThan(0);
  });

  it('holds at every cell count, so nothing count-shaped leaks into the random term', () => {
    for (const significantCells of [1, 25, 400, 10_000]) {
      expect(band({ significantCells, cellSigmaM: 0 }).randomErrorM3).toBe(0);
    }
  });
});

describe('L2/L3 — the two components answer the same input differently', () => {
  // One ladder, read twice. Each rung quadruples the changed-cell count.
  const LADDER = [100, 400, 1600, 6400] as const;

  it('random error doubles when the cell count quadruples (√N)', () => {
    const random = LADDER.map((significantCells) =>
      band({ significantCells, registrationSigmaM: 0 }).randomErrorM3,
    );
    for (let i = 1; i < random.length; i++) {
      expect(random[i] / random[i - 1]).toBeCloseTo(2, 12);
    }
    // Stated absolutely as well: the term is √N times its one-cell value.
    const one = band({ significantCells: 1, registrationSigmaM: 0 }).randomErrorM3;
    for (const n of LADDER) {
      expect(band({ significantCells: n, registrationSigmaM: 0 }).randomErrorM3 / one)
        .toBeCloseTo(Math.sqrt(n), 9);
    }
  });

  it('systematic error quadruples when the cell count quadruples (linear in area)', () => {
    const systematic = LADDER.map((significantCells) =>
      band({ significantCells, cellSigmaM: 0, registrationSigmaM: 0.02 }).systematicErrorM3,
    );
    for (let i = 1; i < systematic.length; i++) {
      expect(systematic[i] / systematic[i - 1]).toBeCloseTo(4, 12);
    }
    const one = band({ significantCells: 1, cellSigmaM: 0, registrationSigmaM: 0.02 })
      .systematicErrorM3;
    for (const n of LADDER) {
      expect(
        band({ significantCells: n, cellSigmaM: 0, registrationSigmaM: 0.02 }).systematicErrorM3 / one,
      ).toBeCloseTo(n, 6);
    }
  });

  it('L4 — so their ratio doubles at each rung: the terms are not the same term twice', () => {
    const ratio = LADDER.map((significantCells) => {
      const r = band({ significantCells, registrationSigmaM: 0.02 });
      return r.systematicErrorM3 / r.randomErrorM3;
    });
    for (let i = 1; i < ratio.length; i++) {
      expect(ratio[i] / ratio[i - 1]).toBeCloseTo(2, 12);
    }
    // Which is to say: the systematic term overtakes the random one as a survey
    // covers more ground, and no amount of extra area rescues a bias.
    expect(ratio[ratio.length - 1]).toBeGreaterThan(ratio[0]);
  });
});

describe('L5 — both components are linear in cell area', () => {
  it('doubles each component when the cell area doubles, at a fixed cell count', () => {
    const small = band({ cellAreaM2: 1, registrationSigmaM: 0.02 });
    const large = band({ cellAreaM2: 2, registrationSigmaM: 0.02 });
    expect(large.randomErrorM3 / small.randomErrorM3).toBeCloseTo(2, 12);
    expect(large.systematicErrorM3 / small.systematicErrorM3).toBeCloseTo(2, 12);
    expect(large.sigmaM3 / small.sigmaM3).toBeCloseTo(2, 12);
  });
});

describe('L6 — quadrature bracketing, without restating the formula', () => {
  it('lands strictly between the larger component and the arithmetic sum', () => {
    const cases = [
      { significantCells: 400, cellSigmaM: 0.05, registrationSigmaM: 0.02 },
      { significantCells: 9, cellSigmaM: 0.2, registrationSigmaM: 0.001 },
      { significantCells: 10_000, cellSigmaM: 0.01, registrationSigmaM: 0.05 },
    ];
    for (const c of cases) {
      const r = band(c);
      expect(r.randomErrorM3).toBeGreaterThan(0);
      expect(r.systematicErrorM3).toBeGreaterThan(0);
      expect(r.sigmaM3).toBeGreaterThan(Math.max(r.randomErrorM3, r.systematicErrorM3));
      expect(r.sigmaM3).toBeLessThan(r.randomErrorM3 + r.systematicErrorM3);
    }
  });

  it('never shrinks when a second source is added', () => {
    const randomOnly = band({ registrationSigmaM: 0 });
    for (const registrationSigmaM of [0.001, 0.01, 0.1]) {
      expect(band({ registrationSigmaM }).sigmaM3).toBeGreaterThan(randomOnly.sigmaM3);
    }
  });

  it('is monotone in each input on its own', () => {
    const sigmas = [0.01, 0.02, 0.05, 0.1].map((cellSigmaM) => band({ cellSigmaM }).sigmaM3);
    for (let i = 1; i < sigmas.length; i++) expect(sigmas[i]).toBeGreaterThan(sigmas[i - 1]);

    const regs = [0.001, 0.01, 0.05].map((registrationSigmaM) => band({ registrationSigmaM }).sigmaM3);
    for (let i = 1; i < regs.length; i++) expect(regs[i]).toBeGreaterThan(regs[i - 1]);
  });
});

describe('L7 — averaging beats noise and never beats a bias', () => {
  const RISE_M = 0.05; // a uniform 5 cm lift across every changed cell
  const AREA = 1;

  it('relative error halves when the cell count quadruples, under a random-only budget', () => {
    const rel = [100, 400, 1600, 6400].map((cells) =>
      band({
        significantCells: cells,
        netVolumeM3: uniformNet(cells, AREA, RISE_M),
        cellAreaM2: AREA,
        cellSigmaM: 0.02,
        registrationSigmaM: 0,
      }).relativeError,
    );
    for (let i = 1; i < rel.length; i++) expect(rel[i] / rel[i - 1]).toBeCloseTo(0.5, 9);
  });

  it('relative error does NOT move with the cell count under a systematic-only budget', () => {
    const rel = [100, 400, 1600, 6400].map((cells) =>
      band({
        significantCells: cells,
        netVolumeM3: uniformNet(cells, AREA, RISE_M),
        cellAreaM2: AREA,
        cellSigmaM: 0,
        registrationSigmaM: 0.02,
      }).relativeError,
    );
    // Every rung is the same number: a bias is the ratio of the registration
    // error to the change, and surveying more ground does not touch it.
    for (const r of rel) expect(r).toBeCloseTo(rel[0], 12);
    expect(rel[0]).toBeCloseTo(0.02 / RISE_M, 9);
  });

  it('detectability under a systematic-only budget depends on the change, not the cell count', () => {
    // 1.96 × 0.02 m = 0.0392 m. A uniform 5 cm lift clears it at any size;
    // a uniform 3 cm lift clears it at none.
    for (const cells of [4, 100, 10_000]) {
      const clears = band({
        significantCells: cells,
        netVolumeM3: uniformNet(cells, AREA, 0.05),
        cellAreaM2: AREA,
        cellSigmaM: 0,
        registrationSigmaM: 0.02,
      });
      const misses = band({
        significantCells: cells,
        netVolumeM3: uniformNet(cells, AREA, 0.03),
        cellAreaM2: AREA,
        cellSigmaM: 0,
        registrationSigmaM: 0.02,
      });
      expect(clears.detectable).toBe(true);
      expect(misses.detectable).toBe(false);
    }
  });
});

describe('L8 — a band is never negative and never narrower than its verdict implies', () => {
  it('clamps every negative or fractional input rather than propagating it', () => {
    const hostile: Array<Partial<ChangeVolumeUncertaintyInput>> = [
      { cellSigmaM: -0.05 },
      { registrationSigmaM: -1 },
      { cellAreaM2: -4 },
      { significantCells: -100 },
      { significantCells: 3.7 },
      { cellSigmaM: -0.05, registrationSigmaM: -1, cellAreaM2: -4, significantCells: -100 },
    ];
    for (const over of hostile) {
      const r = band(over);
      expect(r.randomErrorM3).toBeGreaterThanOrEqual(0);
      expect(r.systematicErrorM3).toBeGreaterThanOrEqual(0);
      expect(r.sigmaM3).toBeGreaterThanOrEqual(0);
      expect(r.relativeError).toBeGreaterThanOrEqual(0);
    }
  });

  it('brackets the net symmetrically, for a gain and for a loss alike', () => {
    for (const netVolumeM3 of [1000, -1000, 0.5, -0.5]) {
      const r = band({ netVolumeM3, registrationSigmaM: 0.02 });
      expect(r.highM3).toBeGreaterThanOrEqual(netVolumeM3);
      expect(r.lowM3).toBeLessThanOrEqual(netVolumeM3);
      expect(r.highM3 - r.lowM3).toBeCloseTo(2 * r.sigmaM3, 12);
      expect(netVolumeM3 - r.lowM3).toBeCloseTo(r.highM3 - netVolumeM3, 12);
    }
  });

  it('only calls a change detectable when the band is narrower than the change over 1.96', () => {
    // The implication, not the comparison: whatever produced `detectable`, a
    // true verdict must leave |net| clear of the ~95 % threshold, and a false
    // one (on a quantified budget) must not.
    for (const cells of [1, 16, 400, 5000]) {
      for (const netVolumeM3 of [0, 1, 12, 100, 4000, -4000]) {
        for (const registrationSigmaM of [0, 0.005, 0.05]) {
          const r = band({ significantCells: cells, netVolumeM3, registrationSigmaM });
          if (r.detectable) {
            expect(r.sigmaM3).toBeLessThan(Math.abs(netVolumeM3) / 1.96);
            expect(r.sigmaM3).toBeGreaterThan(0);
          } else {
            expect(1.96 * r.sigmaM3).toBeGreaterThanOrEqual(Math.abs(netVolumeM3));
          }
        }
      }
    }
  });

  it('degrades confidence monotonically as the band widens', () => {
    const RANK = { low: 0, medium: 1, high: 2 } as const;
    // Against a 1000 m³ net over 400 cells: σ runs from 0.02 m³ to 600 m³, so
    // the ladder crosses the 10 % and 30 % relative-error cuts and then the
    // detectability threshold itself.
    const ranks = [0.001, 0.02, 1, 8, 30].map(
      (cellSigmaM) => RANK[band({ cellSigmaM }).confidence],
    );
    for (let i = 1; i < ranks.length; i++) expect(ranks[i]).toBeLessThanOrEqual(ranks[i - 1]);
    expect(ranks[0]).toBe(RANK.high);
    expect(ranks[ranks.length - 1]).toBe(RANK.low);
  });
});

describe('L9 — the band and the level of detection meet at the same boundary', () => {
  const LOD_M = 0.14;
  const AREA_M2 = 4;

  it('puts one cell that just clears the LoD exactly at the ~95 % volume threshold', () => {
    // σ_cell = LoD/1.96, so for a single cell 1.96σ = cellArea × LoD — which is
    // precisely the volume of a cell sitting at the level of detection. The two
    // modules describe one convention, not two that happen to look alike.
    const single = changeVolumeUncertainty({
      netVolumeM3: AREA_M2 * LOD_M,
      significantCells: 1,
      cellAreaM2: AREA_M2,
      cellSigmaM: cellSigmaFromLoD(LOD_M),
      registrationSigmaM: 0,
    });
    expect(1.96 * single.sigmaM3).toBeCloseTo(AREA_M2 * LOD_M, 12);
    expect(single.detectable).toBe(false); // exactly at the threshold is not above it

    const justOver = changeVolumeUncertainty({
      netVolumeM3: AREA_M2 * LOD_M * 1.01,
      significantCells: 1,
      cellAreaM2: AREA_M2,
      cellSigmaM: cellSigmaFromLoD(LOD_M),
      registrationSigmaM: 0,
    });
    expect(justOver.detectable).toBe(true);
  });

  it('makes a uniform LoD-sized change detectable from two cells up, under random noise alone', () => {
    // The change grows as N while the threshold grows as √N, so N > √N decides
    // it: one cell sits on the boundary, two are past it.
    const atLoD = (cells: number) =>
      changeVolumeUncertainty({
        netVolumeM3: cells * AREA_M2 * LOD_M,
        significantCells: cells,
        cellAreaM2: AREA_M2,
        cellSigmaM: cellSigmaFromLoD(LOD_M),
        registrationSigmaM: 0,
      });
    expect(atLoD(1).detectable).toBe(false);
    for (const cells of [2, 10, 400]) expect(atLoD(cells).detectable).toBe(true);
  });
});

describe('an empty error budget is the weakest result, not the strongest', () => {
  it('refuses to read certainty out of a ±0 band when no source was supplied', () => {
    // Reachable from the shipping path: a level of detection of 0 is permitted,
    // and `cellSigmaFromLoD(0)` is 0, so a caller with no alignment applied and
    // no LoD set produces both terms empty. A ±0 band clears every threshold in
    // the module, which would otherwise grade the least supported result the
    // module can produce as detectable at 0 % relative error.
    const empty = changeVolumeUncertainty({
      netVolumeM3: 1000,
      significantCells: 400,
      cellAreaM2: 1,
      cellSigmaM: cellSigmaFromLoD(0),
      registrationSigmaM: 0,
    });
    expect(empty.sigmaM3).toBe(0);
    expect(empty.quantified).toBe(false);
    expect(empty.detectable).toBe(false);
    expect(empty.confidence).toBe('low');
    expect(empty.caveats.join(' ')).toMatch(/No error source is quantified/i);
    expect(empty.caveats.join(' ')).toMatch(/bounds nothing/i);
  });

  it('counts a budget as quantified as soon as either source is supplied', () => {
    expect(band({ cellSigmaM: 0.05, registrationSigmaM: 0 }).quantified).toBe(true);
    expect(band({ cellSigmaM: 0, registrationSigmaM: 0.02 }).quantified).toBe(true);
    expect(band({ cellSigmaM: 0, registrationSigmaM: 0 }).quantified).toBe(false);
  });

  it('does not call a change detectable when no cell changed, whatever the budget says', () => {
    // σ is 0 with nothing to average over, which is the same fail-open from the
    // other side: a quantified budget must not make an empty comparison certain.
    const noCells = band({ significantCells: 0, netVolumeM3: 500, registrationSigmaM: 0.02 });
    expect(noCells.sigmaM3).toBe(0);
    expect(noCells.quantified).toBe(true);
    expect(noCells.detectable).toBe(false);
    expect(noCells.confidence).toBe('low');
  });
});
