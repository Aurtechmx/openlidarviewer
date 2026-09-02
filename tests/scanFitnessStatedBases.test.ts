/**
 * scanFitnessStatedBases.test.ts — each fitness row states what it was graded
 * on, the verdict leads with the assessment's actual limiter, and the
 * scorecard tones share the assessment chip bands.
 */
import { describe, it, expect } from 'vitest';
import { buildScanFitness, type FitnessInputs, type FitnessKey } from '../src/terrain/quality/scanFitness';

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
    densityReferenceFloor: 'QL1',
    ...over,
  };
}
const dim = (f: ReturnType<typeof buildScanFitness>, key: FitnessKey) => f.dimensions.find((d) => d.key === key)!;

describe('integrity row states the graded basis', () => {
  it('a strided sample never reads "full cloud"', () => {
    const f = buildScanFitness(base({
      gradedBasis: { sampled: true, gradedPointCount: 300_000, residentPointCount: 2_880_236 },
    }));
    const d = dim(f, 'integrity');
    expect(d.tone).toBe('okay');
    expect(d.summary).toBe('Graded on a 300,000-point sample of the loaded cloud (2,880,236 points resident).');
    expect(d.summary).not.toMatch(/full cloud/i);
    // A sample of the loaded cloud is not a streaming/partial coverage mode: no
    // "still streaming" prefix and no status change.
    expect(f.provisional).toBe(false);
  });
  it('without a resident count the sample sentence stands alone', () => {
    const d = dim(buildScanFitness(base({ gradedBasis: { sampled: true, gradedPointCount: 1234 } })), 'integrity');
    expect(d.summary).toBe('Graded on a 1,234-point sample of the loaded cloud.');
  });
  it('an unknown sample size states the analysed ground returns instead', () => {
    const d = dim(buildScanFitness(base({
      gradedBasis: { sampled: true, gradedPointCount: null, analysedGroundCount: 210_433, residentPointCount: 2_880_236 },
    })), 'integrity');
    expect(d.summary).toBe('Graded on a sample of the loaded cloud: 210,433 ground returns analysed (2,880,236 points resident).');
  });
  it('every source point graded keeps the full-cloud string', () => {
    const d = dim(buildScanFitness(base({ gradedBasis: { sampled: false, gradedPointCount: 500 } })), 'integrity');
    expect(d.tone).toBe('ready');
    expect(d.summary).toBe('Graded on the full cloud.');
  });
  it('legacy callers (no basis) are unchanged', () => {
    expect(dim(buildScanFitness(base()), 'integrity').summary).toBe('Graded on the full cloud.');
  });
});

describe('verdict leads with the assessment limiter', () => {
  it('uses the assessment cause list ahead of the scorecard priority order', () => {
    const f = buildScanFitness(base({
      status: 'Limited',
      groundDensityPerM2: 1.3,
      verticalRmse: 0.66,
      assessmentLimiters: [
        '79% of measured cells sit at the edge of the data, where the surface is least supported',
        'vertical RMSE 0.66 m is rated poor',
      ],
    }));
    // The lead clause is whatever sentence the assessment produced for the
    // cap; its exact prose belongs to terrainAssessment, so match the clause
    // identity and the tail, not the wording.
    expect(f.verdict).toMatch(/^Limited — 79% of measured cells .*\(\+1 more to review\)\.$/);
  });
  it('falls back to the scorecard order when the assessment names no cause', () => {
    const f = buildScanFitness(base({ status: 'Limited', measuredFraction: 0.3, assessmentLimiters: [] }));
    expect(f.verdict).toMatch(/ground coverage is sparse/);
  });
  it('"+N more" counts the assessment causes, not the scorecard rows', () => {
    const f = buildScanFitness(base({ status: 'Preview', groundDensityPerM2: 0.5, assessmentLimiters: ['ground returns are sparse'] }));
    expect(f.verdict).toBe('Preview only — ground returns are sparse.');
  });
});

describe('scorecard tones share the assessment chip bands', () => {
  it('density: ready ≥ 2, okay ≥ 1, review < 1 (the chip bandHigh(2, 1))', () => {
    expect(dim(buildScanFitness(base({ groundDensityPerM2: 3 })), 'density').tone).toBe('ready');
    expect(dim(buildScanFitness(base({ groundDensityPerM2: 1.3 })), 'density').tone).toBe('okay');
    expect(dim(buildScanFitness(base({ groundDensityPerM2: 0.9 })), 'density').tone).toBe('review');
  });
  it('accuracy: ready ≤ 0.10, okay ≤ 0.25, review > 0.25 (the chip bandLow(0.1, 0.25))', () => {
    expect(dim(buildScanFitness(base({ verticalRmse: 0.1 })), 'accuracy').tone).toBe('ready');
    expect(dim(buildScanFitness(base({ verticalRmse: 0.25 })), 'accuracy').tone).toBe('okay');
    expect(dim(buildScanFitness(base({ verticalRmse: 0.28 })), 'accuracy').tone).toBe('review');
  });
  it('the density badge still needs the old ≥ 2 pts/m² and ≤ 0.3 m gates', () => {
    expect(buildScanFitness(base({ groundDensityPerM2: 1.5, densityReferenceFloor: 'QL3' })).tierBadge).toBeNull();
    expect(buildScanFitness(base({ verticalRmse: 0.31 })).tierBadge).toBeNull();
    expect(buildScanFitness(base({ verticalRmse: 0.3 })).tierBadge).toBe('≥ QL1 density reference');
  });
});

describe('density row discloses the returns-vs-pulses basis', () => {
  it('names ground returns vs pulses of all classes in the hint', () => {
    const d = dim(buildScanFitness(base({ groundDensityPerM2: 1.3 })), 'density');
    expect(d.summary).toBe('1.3 ground pts/m² — below the 2 pts/m² QL2 pulse-density reference.');
    expect(d.hint).toMatch(/Ground returns only; the USGS figure counts pulses of all classes/);
  });
});

describe('median/mean readout needs enough returns per cell', () => {
  it('suppresses the readout under 10 returns per measured cell and says why', () => {
    const d = dim(buildScanFitness(base({ groundDensityPerM2: 1.3, medianGroundDensityPerM2: 1.3, meanCountsPerMeasuredCell: 2.1 })), 'density');
    expect(d.summary).not.toMatch(/median\/mean/);
    expect(d.hint).toMatch(/about 2 returns per measured cell/);
    expect(d.hint).toMatch(/Median\/mean not shown/);
  });
  it('keeps the readout at 10 or more returns per cell', () => {
    const d = dim(buildScanFitness(base({ groundDensityPerM2: 12, medianGroundDensityPerM2: 11, meanCountsPerMeasuredCell: 12 })), 'density');
    expect(d.summary).toMatch(/median\/mean 0\.92/);
  });
});

describe('accuracy and coverage wording', () => {
  it('an RMSE is not printed as a ± bound', () => {
    const d = dim(buildScanFitness(base({ verticalRmse: 0.66 })), 'accuracy');
    expect(d.summary).toBe('RMSE 0.66 m (internal hold-out) — loose.');
    expect(dim(buildScanFitness(base({ verticalRmse: 0.07 })), 'accuracy').summary).toBe('RMSE 0.07 m (internal hold-out) — tight.');
  });
  it('coverage names its denominator', () => {
    expect(dim(buildScanFitness(base({ measuredFraction: 0.76 })), 'coverage').summary).toBe(
      '76% of covered cells measured; the rest is interpolated between gaps.',
    );
    expect(dim(buildScanFitness(base({ measuredFraction: 0.9 })), 'coverage').summary).toMatch(/of covered cells/);
    expect(dim(buildScanFitness(base({ measuredFraction: 0.3 })), 'coverage').summary).toMatch(/of covered cells/);
  });
});
