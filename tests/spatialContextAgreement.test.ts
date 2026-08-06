/**
 * spatialContextAgreement.test.ts
 *
 * The property the migration exists for: for ONE scan, the facts every surface
 * reads come from one object, so a report, a legend and an exported file cannot
 * describe different frames.
 *
 * These are not unit tests of `spatialContextFrom` (the matrix in
 * spatialContext.test.ts covers that). They pin the AGREEMENTS across the
 * seams — the contour export model's vertical reference against the context's,
 * the three named vertical-scale policies against each other, and the epoch
 * pair's frame options against the same two contexts the alignment reads.
 */

import { describe, it, expect } from 'vitest';
import type { CrsInfo } from '../src/io/crs';
import { spatialContextFrom, verticalMetresPerUnit } from '../src/geo/SpatialContext';
import { compareSpatialFrames, epochFrameOptions } from '../src/geo/frameCompatibility';
import { buildFeatureModel, modelVerticalReference } from '../src/terrain/contour/contourFeatureModel';

const US_SURVEY_FOOT = 1200 / 3937;

/** State-plane feet horizontally, NAVD88 in US survey feet vertically. */
const FOOT_COMPOUND: CrsInfo = {
  source: 'wkt',
  name: 'NAD83 / Utah Central (ftUS)',
  epsg: 3567,
  linearUnit: 'us-survey-foot',
  linearUnitToMetres: US_SURVEY_FOOT,
  isGeographic: false,
  verticalEpsg: 5703,
  verticalDatum: 'NAVD88',
  verticalLinearUnit: 'us-survey-foot',
  verticalUnitToMetres: US_SURVEY_FOOT,
};

/** A projected grid whose unit the file never named. */
const UNKNOWN_UNIT: CrsInfo = {
  source: 'geotiff',
  name: 'Unnamed projected CRS',
  linearUnit: 'unknown',
  linearUnitToMetres: 1,
  isGeographic: false,
};

describe('one scan, one answer', () => {
  it('a compound foot CRS reports feet everywhere, never metres', () => {
    const ctx = spatialContextFrom(FOOT_COMPOUND);
    expect(ctx.linearUnitKnown).toBe(true);
    expect(ctx.metricClaimsPermitted).toBe(true);
    expect(ctx.linearUnit).toBe('us-survey-foot');
    // The LAS writer reads the vertical TOKEN, the terrain core reads the
    // factor, the legend reads the label factor — all three from this object.
    expect(ctx.verticalLinearUnit).toBe('us-survey-foot');
    for (const policy of ['none', 'horizontal-when-known', 'horizontal'] as const) {
      expect(verticalMetresPerUnit(ctx, policy)).toBeCloseTo(US_SURVEY_FOOT, 12);
    }
  });

  it('the contour model carries the SAME vertical reference the context computes', () => {
    const ctx = spatialContextFrom(FOOT_COMPOUND);
    const model = buildFeatureModel([], [], {
      crs: ctx.crsName,
      verticalDatum: ctx.verticalDatum ?? null,
      verticalUnitToMetres: ctx.verticalUnitToMetres ?? null,
      intervalM: 1,
    });
    expect(modelVerticalReference(model)).toBe(ctx.verticalReference);
    expect(modelVerticalReference(model)).toBe('orthometric');
  });

  it('an ellipsoidal source agrees across the context and the exported model', () => {
    const ctx = spatialContextFrom({
      ...FOOT_COMPOUND,
      verticalEpsg: 4979,
      verticalDatum: 'EPSG:4979',
    });
    const model = buildFeatureModel([], [], {
      crs: ctx.crsName,
      verticalDatum: ctx.verticalDatum ?? null,
      intervalM: 1,
    });
    expect(ctx.verticalReference).toBe('ellipsoidal');
    expect(modelVerticalReference(model)).toBe('ellipsoidal');
  });
});

describe('unknown stays unknown', () => {
  it('an undeclared unit withholds the metre claim without substituting one', () => {
    const ctx = spatialContextFrom(UNKNOWN_UNIT);
    expect(ctx.linearUnitKnown).toBe(false);
    expect(ctx.metricClaimsPermitted).toBe(false);
    // The placeholder is still present for geometry, and is never a measurement.
    expect(ctx.linearUnitToMetres).toBe(1);
    expect(verticalMetresPerUnit(ctx, 'none')).toBeUndefined();
    expect(verticalMetresPerUnit(ctx, 'horizontal-when-known')).toBeUndefined();
    // Only the geometry policy borrows the placeholder, and it is named as such.
    expect(verticalMetresPerUnit(ctx, 'horizontal')).toBe(1);
  });

  it('an undeclared vertical unit yields no metre height under any claim policy', () => {
    const ctx = spatialContextFrom({ ...FOOT_COMPOUND, verticalUnitToMetres: undefined });
    expect(ctx.verticalScaleKnown).toBe(false);
    expect(verticalMetresPerUnit(ctx, 'none')).toBeUndefined();
    // The datum is still known; the two permissions really are separate.
    expect(ctx.verticalReferenceKnown).toBe(true);
  });

  it('a declared but degenerate vertical factor fails closed, never borrows horizontal', () => {
    const ctx = spatialContextFrom({ ...FOOT_COMPOUND, verticalUnitToMetres: 0 });
    expect(ctx.verticalScaleKnown).toBe(false);
    for (const policy of ['none', 'horizontal-when-known', 'horizontal'] as const) {
      expect(verticalMetresPerUnit(ctx, policy)).toBeUndefined();
    }
  });

  it('a geographic frame never enters a linear metric', () => {
    const ctx = spatialContextFrom({
      source: 'wkt',
      name: 'WGS 84',
      epsg: 4326,
      linearUnit: 'unknown',
      linearUnitToMetres: 1,
      isGeographic: true,
    });
    expect(ctx.metricClaimsPermitted).toBe(false);
    expect(ctx.metricValidity).toBe('requires-projection');
    expect(epochFrameOptions(ctx, ctx).isGeographic).toBe(true);
    expect(compareSpatialFrames(ctx, ctx).planimetricComparable).toBe(false);
  });
});

describe('the epoch pair reads one verdict', () => {
  it('gives the alignment and the difference the same three facts', () => {
    const a = spatialContextFrom(FOOT_COMPOUND);
    const b = spatialContextFrom(FOOT_COMPOUND);
    const opts = epochFrameOptions(a, b);
    const verdict = compareSpatialFrames(a, b);
    expect(opts.horizontalUnitKnown).toBe(verdict.horizontalUnitKnown);
    expect(opts.isGeographic).toBe(verdict.isGeographic);
    expect(opts.horizontalUnitToMetres).toBe(verdict.horizontalUnitToMetres);
    expect(verdict.planimetricComparable).toBe(true);
    expect(verdict.verticalComparable).toBe(true);
  });

  it('separates the two permissions when only the vertical frame clashes', () => {
    const a = spatialContextFrom(FOOT_COMPOUND);
    const b = spatialContextFrom({ ...FOOT_COMPOUND, verticalEpsg: 4979, verticalDatum: 'EPSG:4979' });
    const verdict = compareSpatialFrames(a, b);
    expect(verdict.planimetricComparable).toBe(true);
    expect(verdict.verticalComparable).toBe(false);
    // …and the horizontal options are unaffected, so cut/fill still computes.
    expect(epochFrameOptions(a, b).horizontalUnitKnown).toBe(true);
  });
});
