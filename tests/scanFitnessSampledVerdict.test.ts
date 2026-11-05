import { describe, it, expect } from 'vitest';
import { buildScanFitness, type FitnessInputs } from '../src/terrain/quality/scanFitness';

function sampled(over: Partial<FitnessInputs> = {}): FitnessInputs {
  return {
    status: 'Preview',
    score: 60,
    crsKnown: true,
    datumKnown: true,
    crsName: 'WGS 84 / UTM zone 12N',
    datumName: 'NAVD88',
    measuredFraction: 0.9,
    groundDensityPerM2: 0.5,
    verticalRmse: 0.05,
    notSurveyGrade: true,
    unit: 'm',
    unitToMetres: 1,
    unclassifiedFraction: 0.1,
    hasGroundClass: true,
    coverageMode: 'sampled',
    densityOnSample: true,
    densityReferenceFloor: 'QL1',
    ...over,
  };
}

describe('ground detail on a sampled run', () => {
  it('states the figure from the sample and does not grade it against the pulse-density reference', () => {
    const f = buildScanFitness(sampled());
    const density = f.dimensions.find((d) => d.key === 'density')!;
    expect(density.summary).toMatch(/not compared with QL figures/);
    expect(density.tone).not.toBe('review');
    expect(f.verdict).not.toMatch(/pulse-density reference/);
  });

  it('does not say density passed when it was stated without a grade', () => {
    const f = buildScanFitness(sampled({ status: 'Good', coverageMode: 'full' }));
    expect(f.dimensions.find((d) => d.key === 'density')!.ungraded).toBe(true);
    expect(f.verdict).not.toMatch(/density and hold-out residuals all pass/);
  });
});
