/**
 * sampledTerrainSummaryWording.test.ts
 *
 * The terrain summary of a scan opened as a display sample. The Dataset Story
 * named the bounding box as the point cloud's area, the scope and limiter read
 * as a full read, and the ground-detail line compared a sample-based density
 * with the QL figures.
 */

import { describe, it, expect } from 'vitest';
import { buildScanStory } from '../src/intelligence/scanStory';
import { buildScanFitness, type FitnessInputs } from '../src/terrain/quality/scanFitness';
import { scopeForSampledBasis, type SupportingMetric } from '../src/terrain/contour/terrainAssessment';

describe('Dataset Story area', () => {
  it('names the bounding box as such', () => {
    const s = buildScanStory({ pointCount: 2_271_607, areaM2: 443_900 });
    expect(s.headline).toBe('Point cloud — 44.39 ha bounding box, 2.3M points');
  });

  it('leads with the measured data area when the terrain grid gives one', () => {
    const s = buildScanStory({ pointCount: 2_271_607, areaM2: 443_900, dataAreaM2: 132_300 });
    expect(s.headline).toBe('Point cloud — 13.23 ha data area (44.39 ha bounding box), 2.3M points');
  });
});

describe('Dataset Story on a display sample', () => {
  it('does not report no limiter when the load is a sample', () => {
    const s = buildScanStory({ surfaceTier: 'Good', coverageMode: 'display-sample' });
    expect(s.primaryLimiter).not.toMatch(/^None/);
    expect(s.primaryLimiter).toMatch(/sample/i);
  });
});

describe('Scan scope on a display sample', () => {
  const metrics: SupportingMetric[] = [
    { label: 'Scan scope', value: 'full', rating: 'good' },
    { label: 'DTM quality', value: '80/100', rating: 'good' },
  ];
  it('reads as a sample, not full', () => {
    const out = scopeForSampledBasis(metrics, true);
    expect(out.find((m) => m.label === 'Scan scope')).toEqual({ label: 'Scan scope', value: 'display sample', rating: 'fair' });
    expect(out.find((m) => m.label === 'DTM quality')?.value).toBe('80/100');
  });
  it('is unchanged on a full read', () => {
    expect(scopeForSampledBasis(metrics, false)).toBe(metrics);
  });
});

describe('Ground detail on a sample', () => {
  const base = {
    status: 'Good', score: 80, crsKnown: true, datumKnown: true, crsName: 'x', datumName: 'y',
    measuredFraction: 0.9, groundDensityPerM2: 10.9, verticalRmse: 0.05, unit: 'm', unitToMetres: 1,
    unclassifiedFraction: 0.1, hasGroundClass: true, coverageMode: 'full',
  } as FitnessInputs;
  const density = (inp: FitnessInputs): string =>
    buildScanFitness(inp).dimensions.find((d) => d.key === 'density')?.summary ?? '';

  it('is not compared with the QL figures', () => {
    const s = density({ ...base, densityOnSample: true });
    expect(s).toContain('10.9 ground pts/m²');
    expect(s).not.toMatch(/QL1|QL2/);
    expect(s).toMatch(/sample/);
  });
  it('keeps the comparison on a full read', () => {
    expect(density(base)).toMatch(/QL1/);
  });
});
