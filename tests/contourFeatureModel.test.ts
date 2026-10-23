/**
 * contourFeatureModel.test.ts — shared model: grade-run split,
 * CRS handling, interpolated fraction.
 */

import { describe, it, expect } from 'vitest';
import {
  buildFeatureModel,
  contourBasis,
  contourLineKind,
  featureEvidence,
  modelLengthShares,
  type ContourFeature,
} from '../src/terrain/contour/contourFeatureModel';
import { PROV_I, PROV_M, serializeProvenance } from '../src/terrain/contour/contourSegmentEvidence';
import { gradeForConfidence } from '../src/terrain/ground/cellConfidence';
import type { ContourPolyline, ContourVertex, StitchedLevel } from '../src/terrain/contour/stitchContours';
import type { StyledLevel } from '../src/terrain/contour/contourStyle';

const v = (x: number, y: number, c: number): ContourVertex => ({
  x,
  y,
  confidence: c,
  grade: gradeForConfidence(c),
  provBits: 1,
});

const styled = (value: number, isIndex: boolean): StyledLevel => ({
  value,
  isIndex,
  weight: isIndex ? 2 : 1,
  labelEligible: isIndex,
});

describe('buildFeatureModel', () => {
  it('splits a mixed-grade polyline into single-grade runs', () => {
    const poly: ContourPolyline = {
      value: 10,
      vertices: [v(0, 0, 90), v(1, 0, 90), v(2, 0, 10), v(3, 0, 10), v(4, 0, 90), v(5, 0, 90)],
      closed: false,
    };
    const stitched: StitchedLevel[] = [{ value: 10, polylines: [poly] }];
    const model = buildFeatureModel(stitched, [styled(10, true)], {
      crs: 'EPSG:32610',
      intervalM: 1,
    });
    expect(model.features).toHaveLength(3);
    expect(model.features.map((f) => f.grade)).toEqual(['solid', 'gap', 'solid']);
    expect(model.features.every((f) => f.isIndex)).toBe(true);
  });

  it('computes a length-weighted interpolated fraction', () => {
    const poly: ContourPolyline = {
      value: 10,
      vertices: [v(0, 0, 90), v(1, 0, 90), v(2, 0, 10), v(3, 0, 10), v(4, 0, 90), v(5, 0, 90)],
      closed: false,
    };
    const model = buildFeatureModel([{ value: 10, polylines: [poly] }], [styled(10, false)], {
      crs: 'EPSG:32610',
      intervalM: 1,
    });
    // total length 5, gap length 3 → 0.6
    expect(model.interpolatedFraction).toBeCloseTo(0.6, 6);
  });

  it('warns when CRS is unknown', () => {
    const poly: ContourPolyline = { value: 1, vertices: [v(0, 0, 90), v(1, 0, 90)], closed: false };
    const model = buildFeatureModel([{ value: 1, polylines: [poly] }], [styled(1, false)], {
      crs: null,
      intervalM: 1,
    });
    expect(model.crs).toBeNull();
    expect(model.warnings.join(' ')).toMatch(/CRS unknown/i);
  });

  it('keeps a single-grade closed ring as one closed feature', () => {
    const poly: ContourPolyline = {
      value: 5,
      vertices: [v(0, 0, 90), v(2, 0, 90), v(2, 2, 90), v(0, 2, 90)],
      closed: true,
    };
    const model = buildFeatureModel([{ value: 5, polylines: [poly] }], [styled(5, false)], {
      crs: 'EPSG:32610',
      intervalM: 1,
    });
    expect(model.features).toHaveLength(1);
    expect(model.features[0].closed).toBe(true);
  });

  it('computes a bounding box over all features', () => {
    const poly: ContourPolyline = {
      value: 1,
      vertices: [v(-1, 2, 90), v(3, 5, 90)],
      closed: false,
    };
    const model = buildFeatureModel([{ value: 1, polylines: [poly] }], [styled(1, false)], {
      crs: 'EPSG:32610',
      intervalM: 1,
    });
    expect(model.bbox).toEqual({ minX: -1, minY: 2, maxX: 3, maxY: 5 });
  });

  it('warns when CRS is unknown', () => {
    const poly: ContourPolyline = { value: 1, vertices: [v(0, 0, 90), v(1, 0, 90)], closed: false };
    const model = buildFeatureModel([{ value: 1, polylines: [poly] }], [styled(1, false)], {
      crs: null,
      verticalDatum: 'EPSG:5703',
      intervalM: 1,
    });
    expect(model.crs).toBeNull();
    expect(model.warnings.join(' ')).toMatch(/CRS unknown/i);
  });

  it('warns when the vertical datum is unknown', () => {
    const poly: ContourPolyline = { value: 1, vertices: [v(0, 0, 90), v(1, 0, 90)], closed: false };
    const model = buildFeatureModel([{ value: 1, polylines: [poly] }], [styled(1, false)], {
      crs: 'EPSG:32610',
      verticalDatum: null,
      intervalM: 1,
    });
    expect(model.warnings.join(' ')).toMatch(/datum unknown/i);
  });

  it('defaults coverageMode to full and carries an explicit one through', () => {
    const poly: ContourPolyline = { value: 1, vertices: [v(0, 0, 90), v(1, 0, 90)], closed: false };
    const full = buildFeatureModel([{ value: 1, polylines: [poly] }], [styled(1, false)], {
      crs: 'EPSG:32610',
      intervalM: 1,
    });
    expect(full.coverageMode).toBe('full');
    const resident = buildFeatureModel([{ value: 1, polylines: [poly] }], [styled(1, false)], {
      crs: 'EPSG:32610',
      intervalM: 1,
      coverageMode: 'resident-only',
    });
    expect(resident.coverageMode).toBe('resident-only');
  });
});

/**
 * The basis split. A measured cell's confidence is its ground-return count over
 * the scene's median count (times an absolute floor), so measured ground under
 * canopy grades dashed. Read off the grade, all of it was "interpolated"; the
 * basis reads the grade and the provenance together.
 */
describe('buildFeatureModel — basis split', () => {
  const pv = (x: number, c: number, provBits: number): ContourVertex => ({
    x, y: 0, confidence: c, grade: gradeForConfidence(c), provBits,
  });
  const MI = PROV_M | PROV_I;
  // Unit-spaced, 14 long: dense measured 0-3, sparse measured 3-8, interpolated
  // 8-10, sparse 10-12, gap 12-14. Vertices 8 and 10 sit where measured and
  // interpolated cells meet, so they carry both bits.
  const vertices = [
    pv(0, 90, PROV_M), pv(1, 90, PROV_M), pv(2, 90, PROV_M), pv(3, 90, PROV_M),
    pv(4, 50, PROV_M), pv(5, 50, PROV_M), pv(6, 50, PROV_M), pv(7, 50, PROV_M),
    pv(8, 40, MI), pv(9, 40, PROV_I), pv(10, 40, MI),
    pv(11, 50, PROV_M), pv(12, 50, PROV_M),
    pv(13, 10, PROV_I), pv(14, 10, PROV_I),
  ];
  const model = buildFeatureModel(
    [{ value: 10, polylines: [{ value: 10, vertices, closed: false }] }],
    [styled(10, false)],
    { crs: 'EPSG:32610', intervalM: 1 },
  );

  it('gives each run one basis, splitting a dashed run where interpolated support starts and stops', () => {
    expect(model.features.map((f) => f.grade)).toEqual(['solid', 'dashed', 'dashed', 'dashed', 'gap']);
    expect(model.features.map(contourBasis)).toEqual(['measured', 'sparse', 'interpolated', 'sparse', 'gap']);
    expect(model.features.map((f) => f.coordinates.map(([x]) => x))).toEqual([
      [0, 1, 2, 3], [3, 4, 5, 6, 7, 8], [8, 9, 10], [10, 11, 12], [12, 13, 14],
    ]);
  });

  it('does not count the measured segment beside an interpolated stretch as interpolated', () => {
    // Segments 7-8 and 10-11 each have one end on a vertex shared with an
    // interpolated cell. Their own cells are measured: counting them doubled the
    // interpolated share on a real drone strip.
    const interp = model.features.filter((f) => contourBasis(f) === 'interpolated');
    expect(interp.map((f) => f.coordinates.map(([x]) => x))).toEqual([[8, 9, 10]]);
  });

  it('leaves provenance as the union over the run\'s vertices', () => {
    // A sparse run that ends where interpolated ground begins touches it at that
    // one vertex, so its provenance reads mixed while its segments, and so its
    // basis, are measured.
    const prov = model.features.map((f) => serializeProvenance(featureEvidence(f)));
    expect(prov).toEqual(['measured', 'mixed', 'mixed', 'mixed', 'mixed']);
  });

  it('reports interpolated, sparse and gap shares beside the unchanged non-solid share', () => {
    expect(model.interpolatedFraction).toBeCloseTo(11 / 14, 12);
    expect(model.interpolatedLengthFraction).toBeCloseTo(2 / 14, 12);
    expect(model.sparseLengthFraction).toBeCloseTo(7 / 14, 12);
    expect(model.gapLengthFraction).toBeCloseTo(2 / 14, 12);
    expect(modelLengthShares(model)).toEqual({
      interpolated: model.interpolatedLengthFraction,
      sparse: model.sparseLengthFraction,
      gap: model.gapLengthFraction,
    });
  });

  it('does not move a vertex: the runs re-join into the input line', () => {
    const joined = model.features.flatMap((f, i) => (i === 0 ? f.coordinates : f.coordinates.slice(1)));
    expect(joined).toEqual(vertices.map((q) => [q.x, q.y]));
  });

  it('leaves solid runs whole: a solid run never touches interpolated support', () => {
    // Interpolated cells score at most 50, under the solid threshold, so the
    // confidence the grade reads already keeps them out of solid runs.
    const solidOnly = buildFeatureModel(
      [{ value: 1, polylines: [{ value: 1, vertices: [pv(0, 90, PROV_M), pv(1, 90, PROV_M), pv(2, 90, PROV_M)], closed: true }] }],
      [styled(1, false)],
      { crs: 'EPSG:32610', intervalM: 1 },
    );
    expect(solidOnly.features).toHaveLength(1);
    expect(solidOnly.features[0].closed).toBe(true);
    expect(solidOnly.interpolatedLengthFraction).toBe(0);
    expect(solidOnly.sparseLengthFraction).toBe(0);
  });

  it('reports NaN shares, not zero, when nothing was drawn', () => {
    const empty = buildFeatureModel([], [], { crs: 'EPSG:32610', intervalM: 1 });
    expect(Number.isNaN(empty.interpolatedLengthFraction)).toBe(true);
    expect(Number.isNaN(empty.sparseLengthFraction)).toBe(true);
    expect(Number.isNaN(empty.gapLengthFraction)).toBe(true);
  });
});

describe('contourBasis', () => {
  const f = (grade: ContourFeature['grade'], provBits?: number): ContourFeature =>
    ({ value: 1, isIndex: false, grade, meanConfidence: 50, closed: false, coordinates: [[0, 0], [1, 0]], provBits });

  it('reads grade and provenance together', () => {
    expect(contourBasis(f('solid', PROV_M))).toBe('measured');
    expect(contourBasis(f('dashed', PROV_M))).toBe('sparse');
    expect(contourBasis(f('dashed', PROV_I))).toBe('interpolated');
    expect(contourBasis(f('dashed', PROV_M | PROV_I))).toBe('interpolated');
    expect(contourBasis(f('gap', PROV_M))).toBe('gap');
    expect(contourBasis(f('gap', PROV_I))).toBe('gap');
  });

  it('fails closed without provenance: never measured or sparse', () => {
    expect(contourBasis(f('solid'))).toBe('unavailable');
    expect(contourBasis(f('dashed'))).toBe('unavailable');
    expect(contourBasis(f('dashed', 0))).toBe('unavailable');
    // Drawn: a solid line keeps its plain line, anything weaker is drawn as interpolated.
    expect(contourLineKind(f('solid'))).toBe('measured');
    expect(contourLineKind(f('dashed'))).toBe('interpolated');
  });

  it('measures the shares of a model assembled by hand from its features', () => {
    const shares = modelLengthShares({
      features: [f('solid', PROV_M), f('dashed', PROV_M), f('dashed', PROV_I), f('gap', PROV_I)],
      interpolatedFraction: 0.75,
    } as never);
    expect(shares).toEqual({ interpolated: 0.25, sparse: 0.25, gap: 0.25 });
  });
});
