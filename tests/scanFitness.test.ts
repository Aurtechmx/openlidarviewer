/**
 * scanFitness.test.ts — the verdict-led "Data Fitness" core: the six-dimension
 * traffic-light scorecard, the plain-language verdict (which must be willing to
 * be negative), the earned-only tier badge, and the non-hideable caveats.
 */

import { describe, it, expect } from 'vitest';
import { buildScanFitness, type FitnessInputs, type FitnessKey, type FitnessTone } from '../src/terrain/quality/scanFitness';

/** A fully-passing georeferenced survey-grade baseline; override per test. */
function base(over: Partial<FitnessInputs> = {}): FitnessInputs {
  return {
    status: 'Good',
    score: 88,
    crsKnown: true,
    datumKnown: true,
    crsName: 'WGS 84 / UTM zone 12N',
    datumName: 'NAVD88',
    measuredFraction: 0.9,
    groundDensityPerM2: 12,
    verticalRmse: 0.07,
    notSurveyGrade: false,
    unit: 'm',
    unitToMetres: 1,
    unclassifiedFraction: 0.02,
    hasGroundClass: true,
    coverageMode: 'full',
    qualityLevel: 'USGS QL1',
    ...over,
  };
}

const tone = (f: ReturnType<typeof buildScanFitness>, key: FitnessKey): FitnessTone =>
  f.dimensions.find((d) => d.key === key)!.tone;

describe('buildScanFitness — scorecard tones', () => {
  it('all-pass scan → every dimension ready, positive verdict, tier badge earned', () => {
    const f = buildScanFitness(base());
    expect(f.overallTone).toBe<FitnessTone>('ready');
    expect(f.verdict).toMatch(/ready for terrain products/i);
    expect(f.tierBadge).toBe('USGS QL1 (estimated)');
    expect(f.headlineAccuracy).toBe('±0.07 m vertical');
    expect(f.dimensions).toHaveLength(6);
  });

  it('sparse coverage → coverage reviewed and named in the verdict', () => {
    const f = buildScanFitness(base({ status: 'Limited', measuredFraction: 0.34 }));
    expect(tone(f, 'coverage')).toBe<FitnessTone>('review');
    expect(f.verdict).toMatch(/sparse|interpolated/i);
    expect(f.overallTone).toBe<FitnessTone>('review');
  });

  it('density buckets at the USGS QL floors (2 and 8 pts/m²)', () => {
    expect(tone(buildScanFitness(base({ groundDensityPerM2: 9 })), 'density')).toBe('ready');
    expect(tone(buildScanFitness(base({ groundDensityPerM2: 3 })), 'density')).toBe('okay');
    expect(tone(buildScanFitness(base({ groundDensityPerM2: 0.9 })), 'density')).toBe('review');
  });

  it('vertical accuracy buckets at 0.1 / 0.3, and null is unvalidated', () => {
    expect(tone(buildScanFitness(base({ verticalRmse: 0.08 })), 'accuracy')).toBe('ready');
    expect(tone(buildScanFitness(base({ verticalRmse: 0.2 })), 'accuracy')).toBe('okay');
    expect(tone(buildScanFitness(base({ verticalRmse: 0.5 })), 'accuracy')).toBe('review');
    const none = buildScanFitness(base({ verticalRmse: null }));
    expect(tone(none, 'accuracy')).toBe('review');
    expect(none.headlineAccuracy).toBeNull();
  });

  it('no classification → reviewed; partial → okay', () => {
    expect(tone(buildScanFitness(base({ unclassifiedFraction: null, hasGroundClass: false })), 'classification')).toBe('review');
    expect(tone(buildScanFitness(base({ unclassifiedFraction: 0.3 })), 'classification')).toBe('okay');
  });

  it('streamed / partial coverage → integrity okay, not ready', () => {
    expect(tone(buildScanFitness(base({ coverageMode: 'resident-only' })), 'integrity')).toBe('okay');
    expect(tone(buildScanFitness(base({ status: 'Blocked' })), 'integrity')).toBe('review');
  });
});

describe('buildScanFitness — unit-correct accuracy bucketing', () => {
  it('buckets a feet RMSE against metric thresholds, not raw feet', () => {
    // 0.5 ft = 0.1524 m → "okay" (≤ 0.3 m). Bucketing on raw 0.5 would be "review".
    const f = buildScanFitness(base({ verticalRmse: 0.5, unit: 'ft', unitToMetres: 0.3048 }));
    expect(tone(f, 'accuracy')).toBe<FitnessTone>('okay');
    expect(f.headlineAccuracy).toBe('±0.50 ft vertical'); // displayed in feet
  });
});

describe('buildScanFitness — provisional (streaming / partial) state', () => {
  it('partial coverage marks provisional, prefixes the verdict, and voids the badge', () => {
    const f = buildScanFitness(base({ coverageMode: 'resident-only' }));
    expect(f.provisional).toBe(true);
    expect(f.verdict).toMatch(/^still streaming/i);
    expect(f.tierBadge).toBeNull(); // a partial grade can't earn a tier
  });
  it('a full-cloud grade is not provisional and can earn its badge', () => {
    const f = buildScanFitness(base());
    expect(f.provisional).toBe(false);
    expect(f.tierBadge).toBe('USGS QL1 (estimated)');
  });
});

describe('buildScanFitness — verdict leads with the most use-limiting axis (not array order)', () => {
  it('coverage outranks georeferencing as the lead limiter', () => {
    // Both coverage and georeferencing are reviewed; coverage must lead.
    const f = buildScanFitness(base({
      status: 'Limited', crsKnown: false, datumKnown: false, crsName: null, datumName: null,
      measuredFraction: 0.3,
    }));
    expect(f.verdict).toMatch(/ground coverage is sparse/i);
  });
});

describe('buildScanFitness — verdict is willing to be negative', () => {
  it('blocked → an unambiguous "not usable" verdict', () => {
    const f = buildScanFitness(base({ status: 'Blocked' }));
    expect(f.verdict).toMatch(/not usable/i);
  });

  it('ungeoreferenced vineyard-like scan → the verdict word mirrors the Limited tier', () => {
    // dense surface, but no CRS/datum, sparse ground, derived classes.
    const f = buildScanFitness(base({
      status: 'Limited', crsKnown: false, datumKnown: false, crsName: null, datumName: null,
      measuredFraction: 0.34, groundDensityPerM2: 0.9, unclassifiedFraction: null, hasGroundClass: false,
      notSurveyGrade: true,
    }));
    // Verdict leads with "Limited" (not "Preview only") to match the hero tier.
    expect(f.verdict).toMatch(/^Limited —/);
    expect(f.verdict).not.toMatch(/preview only/i);
    expect(f.overallTone).toBe<FitnessTone>('review');
    expect(f.verdict).toMatch(/more to review/i);
  });

  it("the verdict's lead word tracks the status tier (Limited / Preview / Good)", () => {
    const limited = buildScanFitness(base({ status: 'Limited', measuredFraction: 0.3 }));
    expect(limited.verdict).toMatch(/^Limited —/);
    const preview = buildScanFitness(base({ status: 'Preview', measuredFraction: 0.3 }));
    expect(preview.verdict).toMatch(/^Preview only —/);
    // A Good gate with a soft caveat reads positive, never "Preview only".
    const goodCaveat = buildScanFitness(base({ status: 'Good', unclassifiedFraction: null, hasGroundClass: false }));
    expect(goodCaveat.verdict).toMatch(/^Usable, with caveats/);
  });
});

describe('buildScanFitness — tier badge is earned, never overclaimed', () => {
  it('no badge when density is below floor even if a QL is supplied', () => {
    expect(buildScanFitness(base({ groundDensityPerM2: 0.9 })).tierBadge).toBeNull();
  });
  it('no badge when not georeferenced', () => {
    expect(buildScanFitness(base({ crsKnown: false })).tierBadge).toBeNull();
  });
  it('no badge when accuracy is unvalidated', () => {
    expect(buildScanFitness(base({ verticalRmse: null })).tierBadge).toBeNull();
  });
});

describe('buildScanFitness — non-hideable caveats', () => {
  it('held-out RMSE carries the "not independent checkpoints" caveat', () => {
    const f = buildScanFitness(base({ notSurveyGrade: true }));
    expect(f.caveats.some((c) => /internal consistency/i.test(c))).toBe(true);
  });
  it('missing datum and CRS each add their own plain caveat', () => {
    const f = buildScanFitness(base({ crsKnown: false, datumKnown: false, crsName: null, datumName: null }));
    expect(f.caveats.some((c) => /no vertical datum/i.test(c))).toBe(true);
    expect(f.caveats.some((c) => /no map position/i.test(c))).toBe(true);
  });
  it('georeferenced but datum-unknown: caveat says datum not declared, NOT "relative"', () => {
    // A horizontally-georeferenced scan has absolute Z — the honest caveat is that
    // the datum is undeclared, not that the heights are relative.
    const f = buildScanFitness(base({ datumKnown: false }));
    const datumCaveat = f.caveats.find((c) => /vertical datum/i.test(c))!;
    expect(datumCaveat).toMatch(/tied to a known reference/i);
    expect(datumCaveat).not.toMatch(/relative/i);
  });
  it('a clean georeferenced survey-grade scan has no caveats', () => {
    expect(buildScanFitness(base()).caveats).toHaveLength(0);
  });
});

describe('buildScanFitness — density reports a measurement, not a quality level', () => {
  const summary = (d: number): string =>
    buildScanFitness(base({ groundDensityPerM2: d })).dimensions.find((x) => x.key === 'density')!.summary;

  it('never claims the scan IS a USGS quality level', () => {
    for (const d of [12, 3, 0.9]) {
      expect(summary(d)).not.toMatch(/QL\d-class/i);
      expect(summary(d)).not.toMatch(/meets the USGS QL/i);
    }
  });

  it('keeps the measured density and names the threshold it is compared against', () => {
    expect(summary(12)).toMatch(/12 ground pts\/m²/);
    expect(summary(12)).toMatch(/8 pts\/m².*QL1 density floor/i);
    expect(summary(3)).toMatch(/2 pts\/m².*QL2 density floor/i);
    expect(summary(0.9)).toMatch(/below.*2 pts\/m².*QL2 density floor/i);
  });

  it('marks the tier badge as an estimate, matching every other surface', () => {
    expect(buildScanFitness(base()).tierBadge).toBe('USGS QL1 (estimated)');
  });
});

describe('buildScanFitness — unverified units fail closed', () => {
  const summary = (f: ReturnType<typeof buildScanFitness>, key: FitnessKey): string =>
    f.dimensions.find((d) => d.key === key)!.summary;

  it('an unknown-unit CRS holds the pts/m² and metre verdicts and discloses it', () => {
    // Same dense, survey-grade numbers as the all-pass baseline, but the source
    // linear unit is NOT confirmed (inert placeholder factor). The metric claims
    // must be withheld rather than asserted as metres.
    const f = buildScanFitness(base({ unitKnown: false }));
    expect(tone(f, 'density')).toBe<FitnessTone>('review');
    expect(tone(f, 'accuracy')).toBe<FitnessTone>('review');
    // No bare metric figure survives in either summary.
    expect(summary(f, 'density')).not.toMatch(/\d+\s*ground pts\/m²/);
    expect(summary(f, 'density')).toMatch(/units are unverified/i);
    expect(summary(f, 'accuracy')).not.toMatch(/±\s*\d/);
    expect(summary(f, 'accuracy')).toMatch(/units are unverified/i);
    // Headline accuracy (a bare "± m") is withheld too.
    expect(f.headlineAccuracy).toBeNull();
    // The disclosure leads the non-hideable caveats.
    expect(f.caveats[0]).toMatch(/coordinate units are unverified/i);
    // A QL tier can't be earned on an unverified scale, even though a QL was supplied.
    expect(f.tierBadge).toBeNull();
    // The hero tone is driven to review and the verdict names the unit limitation.
    expect(f.overallTone).toBe<FitnessTone>('review');
    expect(f.verdict).toMatch(/units are unverified/i);
  });

  it('omitting unitKnown keeps the legacy metric verdict (no regression)', () => {
    const f = buildScanFitness(base()); // unitKnown undefined ⇒ assume known
    expect(tone(f, 'density')).toBe<FitnessTone>('ready');
    expect(tone(f, 'accuracy')).toBe<FitnessTone>('ready');
    expect(f.headlineAccuracy).toBe('±0.07 m vertical');
    expect(f.tierBadge).toBe('USGS QL1 (estimated)');
    expect(f.caveats.some((c) => /units are unverified/i.test(c))).toBe(false);
  });

  it('unitKnown:true is unchanged from the assume-known baseline', () => {
    const f = buildScanFitness(base({ unitKnown: true }));
    expect(tone(f, 'density')).toBe<FitnessTone>('ready');
    expect(tone(f, 'accuracy')).toBe<FitnessTone>('ready');
    expect(f.tierBadge).toBe('USGS QL1 (estimated)');
  });
});
