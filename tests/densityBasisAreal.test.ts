/**
 * densityBasisAreal.test.ts
 *
 * The Dataset Intelligence density tier must not call a wide, thin airborne
 * tile "Sparse". Such a tile spreads its points over a large footprint under a
 * bounding box that is mostly empty air, so points-per-m³ lands far below the
 * per-m² density the scan actually delivers on the ground — the reading a
 * surveyor checks against the USGS 3DEP floors.
 *
 * These cases pin the three outcomes that matter:
 *   - a flat, well-covered tile tiers on AREAL density and stops reading Sparse;
 *   - a genuinely thin cloud still reads Sparse on either measure;
 *   - a tall scan (interior / façade) keeps the VOLUMETRIC behaviour.
 *
 * Plus the honesty half: the row is named after the measure behind the tier, in
 * the card and in the scan story, so a pts/m² number is never shown under a
 * "volumetric" heading.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  classifyDensityTier,
  summariseDataset,
  chooseDensityTier,
  isTallExtent,
  type DatasetIntelligenceInput,
} from '../src/terrain/datasetIntelligence';
import { classifyArealDensity } from '../src/render/streaming/sampleGrade';
import { DENSITY_ROW } from '../src/ui/DatasetIntelligenceCard';
import { buildExportHealth } from '../src/intelligence/scanStory';
import { createInspectorCardRefreshers } from '../src/app/inspectorCardRefreshers';

// A USGS-style airborne tile: 89.6M points over a 1500 × 1500 m footprint with
// 300 m of relief. Areal ≈ 39.8 pts/m² (well above the QL1 floor of 8);
// volumetric ≈ 0.13 pts/m³, which the per-m³ bands call sparse.
const AIRBORNE = {
  pointCount: 89_600_000,
  bboxSpansM: [1500, 1500, 300] as [number, number, number],
  bboxVolume: 1500 * 1500 * 300,
};

describe('density tier — flat airborne tiles read areally', () => {
  it('a thin wide tile with good pts/m² is not Sparse', () => {
    const volumeOnly = classifyDensityTier({
      pointCount: AIRBORNE.pointCount,
      bboxVolume: AIRBORNE.bboxVolume,
    });
    expect(volumeOnly).toEqual({ bucket: 'sparse', basis: 'volumetric' });

    const withSpans = classifyDensityTier(AIRBORNE);
    expect(withSpans.basis).toBe('areal');
    expect(withSpans.bucket).toBe('dense');
  });

  it('a genuinely sparse cloud still reads Sparse', () => {
    // 10 000 points over a square kilometre — 0.01 pts/m², below every floor.
    const tier = classifyDensityTier({
      pointCount: 10_000,
      bboxSpansM: [1000, 1000, 50],
      bboxVolume: 1000 * 1000 * 50,
    });
    expect(tier.bucket).toBe('sparse');
  });

  it('a tall scan keeps the volumetric reading', () => {
    // 10 × 10 m footprint, 20 m of height: an interior / façade capture. Areal
    // would say very-dense (2 000 pts/m²); the volume is the honest measure.
    const tier = classifyDensityTier({
      pointCount: 200_000,
      bboxSpansM: [10, 10, 20],
      bboxVolume: 10 * 10 * 20,
    });
    expect(tier).toEqual({ bucket: 'dense', basis: 'volumetric' });
  });

  it('an engine-measured resident density stays volumetric even with spans', () => {
    const tier = classifyDensityTier({
      residentDensity: 0.5,
      pointCount: AIRBORNE.pointCount,
      bboxSpansM: AIRBORNE.bboxSpansM,
    });
    expect(tier).toEqual({ bucket: 'sparse', basis: 'volumetric' });
  });

  it('no spans leaves the volume-only reading unchanged', () => {
    expect(classifyDensityTier({ pointCount: 50_000, bboxVolume: 100 })).toEqual({
      bucket: 'very-dense',
      basis: 'volumetric',
    });
    expect(classifyDensityTier({})).toEqual({ bucket: 'unknown', basis: 'none' });
  });

  it('degenerate spans fall back rather than inventing a tier', () => {
    // Zero footprint: no area to divide by, so the volume estimate answers.
    expect(classifyDensityTier({ pointCount: 1_000, bboxSpansM: [0, 10, 10], bboxVolume: 100 }))
      .toEqual({ bucket: 'moderate', basis: 'volumetric' });
    // A perfectly flat sheet has no volume at all — areal is the only measure.
    expect(classifyDensityTier({ pointCount: 1_000, bboxSpansM: [100, 100, 0] })).toEqual({
      bucket: 'sparse',
      basis: 'areal',
    });
  });

  it('the flat / tall split uses the shorter horizontal span', () => {
    expect(isTallExtent(2000, 40, 30)).toBe(true); // a narrow corridor with height
    expect(isTallExtent(2000, 40, 5)).toBe(false);
    expect(isTallExtent(0, 100, 10)).toBe(false); // degenerate footprint
  });

  it('the streaming grade and the static card share one band table', () => {
    // Same numbers through both entry points — the thresholds exist once.
    expect(classifyArealDensity(39.8)).toBe('dense');
    expect(
      chooseDensityTier({ arealDensityPerM2: 39.8, volumetricDensityPerM3: 0.13, isTall: false }),
    ).toEqual({ bucket: 'dense', basis: 'areal' });
  });
});

describe('density tier — the row never misnames its unit', () => {
  it('summariseDataset reports the basis alongside the bucket', () => {
    const intel = summariseDataset(AIRBORNE);
    expect(intel?.density).toEqual({ bucket: 'dense', label: 'Dense', basis: 'areal' });
  });

  it('the card row copy states pts/m² for an areal reading', () => {
    expect(DENSITY_ROW.areal.label).toBe('Areal point density');
    expect(DENSITY_ROW.areal.label).not.toMatch(/volumetric/i);
    expect(DENSITY_ROW.areal.tooltip).toContain('pts/m²');
    expect(DENSITY_ROW.volumetric.tooltip).toContain('pts/m³');
  });

  it('the scan story names the density row after its basis', () => {
    const areal = buildExportHealth({ density: 'dense', densityBasis: 'areal' });
    expect(areal.rows.some((r) => r.label === 'Areal point density')).toBe(true);
    const volumetric = buildExportHealth({ density: 'dense', densityBasis: 'volumetric' });
    expect(volumetric.rows.some((r) => r.label === 'Volumetric point density')).toBe(true);
    // Absent basis keeps the historical wording.
    const legacy = buildExportHealth({ density: 'dense' });
    expect(legacy.rows.some((r) => r.label === 'Volumetric point density')).toBe(true);
  });
});

describe('density tier — the static loader hands over the spans', () => {
  function makeInspector() {
    const calls: DatasetIntelligenceInput[] = [];
    const inspector = {
      setDatasetIntelligence: (s: DatasetIntelligenceInput) => calls.push(s),
      clearDatasetIntelligence: vi.fn(),
      setProvenance: vi.fn(),
    } as never;
    return { inspector, last: () => calls[calls.length - 1] };
  }

  const METRE = { linearUnit: 'metre', linearUnitToMetres: 1 };
  const UNKNOWN = { linearUnit: 'unknown', linearUnitToMetres: 1 };
  const FOOT = { linearUnit: 'us-ft', linearUnitToMetres: 0.30480060960121924 };
  const tile = {
    pointCount: 2_850_000,
    declaredPointCount: 89_600_000,
    metadata: { crs: METRE },
    bounds: () => ({
      min: [0, 0, 0] as [number, number, number],
      max: [1500, 1500, 300] as [number, number, number],
    }),
  };

  it('the metre tile arrives with spans, and its tier is areal', () => {
    const { inspector, last } = makeInspector();
    createInspectorCardRefreshers(inspector, () => METRE)
      .refreshDatasetIntelligenceFromStaticCloud(tile);
    expect(last().bboxSpansM).toEqual([1500, 1500, 300]);
    // The declared total, not the display sample, drives the reading.
    expect(summariseDataset(last())?.density).toEqual({
      bucket: 'dense',
      label: 'Dense',
      basis: 'areal',
    });
  });

  it('spans are converted to metres, like the volume', () => {
    const { inspector, last } = makeInspector();
    createInspectorCardRefreshers(inspector, () => FOOT)
      .refreshDatasetIntelligenceFromStaticCloud(tile);
    const spans = last().bboxSpansM as [number, number, number];
    expect(spans[0]).toBeCloseTo(457.2, 1);
    expect(spans[2]).toBeCloseTo(91.44, 1);
  });

  it('an unknown unit fails closed — no spans, no areal claim', () => {
    const { inspector, last } = makeInspector();
    createInspectorCardRefreshers(inspector, () => UNKNOWN)
      .refreshDatasetIntelligenceFromStaticCloud(tile);
    expect(last().bboxSpansM).toBeUndefined();
    expect(summariseDataset(last())?.density.bucket).toBe('unknown');
  });
});
