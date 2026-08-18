/**
 * featureExtractionService.test.ts
 *
 * The product-side entry over the feature cores. Beyond "does it extract", the
 * two contracts this layer exists to own are pinned here:
 *
 *  - UNITS: the cores measure in the SOURCE unit, so a metric field is emitted
 *    only when the unit is KNOWN, and area converts by the scale SQUARED.
 *  - IDENTITY: a candidate id is derived from its geometry, so it survives a
 *    re-run whose ordering shifts — an index-based id would rename a building
 *    the reviewer had already accepted.
 */

import { describe, it, expect } from 'vitest';
import {
  extractBuildingCandidates,
  extractConductorCandidate,
} from '../src/features/FeatureExtractionService';
import type { BuildingPoint } from '../src/features/buildingFootprints';
import type { Vec3 } from '../src/features/conductors';
import { knownUnit, unknownUnit } from '../src/units/units';

const METRE = knownUnit(1);
const FOOT = knownUnit(0.3048);

/** A solid 10x10 block of building points. */
function block(ox = 0, oy = 0, n = 10): BuildingPoint[] {
  const pts: BuildingPoint[] = [];
  for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) pts.push({ x: ox + x, y: oy + y });
  return pts;
}
const GRID = { originX: 0, originY: 0, cellSizeM: 1, minPointsPerCell: 1, minAreaM2: 4 };

/** A near-straight span with a slight sag. */
function span(len = 40): Vec3[] {
  const pts: Vec3[] = [];
  for (let i = 0; i < len; i++) pts.push([i, 0, 10 - 0.001 * i * (len - i)]);
  return pts;
}

describe('FeatureExtractionService — extraction', () => {
  it('turns a dense occupied block into a derived building candidate', () => {
    const cands = extractBuildingCandidates(block(), GRID, METRE);
    expect(cands.length).toBe(1);
    expect(cands[0].kind).toBe('building');
    expect(cands[0].confidence).toBe('derived');
    expect(cands[0].areaSource).toBeGreaterThan(0);
    expect(cands[0].bounds).toHaveLength(4);
  });

  it('returns no candidates for empty input', () => {
    expect(extractBuildingCandidates([], GRID, METRE)).toEqual([]);
  });

  it('fits a straight span as a conductor candidate', () => {
    const c = extractConductorCandidate(span(), METRE);
    expect(c).not.toBeNull();
    expect(c!.kind).toBe('conductor');
    expect(c!.linearity).toBeGreaterThan(0.9);
    expect(c!.spanSource).toBeGreaterThan(30);
    expect(c!.sagSource).toBeGreaterThan(0);
  });

  it('rejects a non-linear blob as not a conductor', () => {
    const pts: Vec3[] = [];
    for (let x = 0; x < 6; x++) for (let y = 0; y < 6; y++) pts.push([x, y, 0]);
    expect(extractConductorCandidate(pts, METRE)).toBeNull();
  });
});

describe('FeatureExtractionService — unit honesty', () => {
  it('an UNKNOWN unit yields no metric claim at all, never a metres guess', () => {
    const b = extractBuildingCandidates(block(), GRID, unknownUnit())[0];
    expect(b.areaSource).toBeGreaterThan(0); // the source measure still stands
    expect(b.areaM2).toBeNull();

    const c = extractConductorCandidate(span(), unknownUnit())!;
    expect(c.spanSource).toBeGreaterThan(30);
    expect(c.spanM).toBeNull();
    expect(c.sagM).toBeNull();
    expect(c.residualRmsM).toBeNull();
  });

  it('AREA converts by the scale SQUARED — a foot grid is not a metre grid', () => {
    const inFeet = extractBuildingCandidates(block(), GRID, FOOT)[0];
    const inMetres = extractBuildingCandidates(block(), GRID, METRE)[0];
    // Same source area (the cores never saw a unit)...
    expect(inFeet.areaSource).toBeCloseTo(inMetres.areaSource, 9);
    // ...but the metric twin differs by the scale squared, not the scale.
    expect(inFeet.areaM2).toBeCloseTo(inFeet.areaSource * 0.3048 * 0.3048, 9);
    // A once-converted area would be ~3.3x too large — pin that it is not.
    expect(inFeet.areaM2).toBeLessThan(inFeet.areaSource * 0.3048);
  });

  it('LENGTH converts by the scale once (span, sag and residual alike)', () => {
    const c = extractConductorCandidate(span(), FOOT)!;
    expect(c.spanM).toBeCloseTo(c.spanSource * 0.3048, 9);
    expect(c.sagM).toBeCloseTo(c.sagSource * 0.3048, 9);
    expect(c.residualRmsM).toBeCloseTo(c.residualRmsSource * 0.3048, 9);
  });

  it('a metre unit leaves the numbers unchanged', () => {
    const b = extractBuildingCandidates(block(), GRID, METRE)[0];
    expect(b.areaM2).toBeCloseTo(b.areaSource, 9);
  });
});

describe('FeatureExtractionService — stable identity', () => {
  it('the same geometry keeps the same id across re-runs', () => {
    const a = extractBuildingCandidates(block(), GRID, METRE)[0];
    const b = extractBuildingCandidates(block(), GRID, METRE)[0];
    expect(b.id).toBe(a.id);
  });

  it('an id follows its OWN building when another appears and reorders the list', () => {
    // One small building first; then add a LARGER one, which sorts ahead of it.
    const small = block(0, 0, 6);
    const before = extractBuildingCandidates(small, GRID, METRE);
    expect(before).toHaveLength(1);
    const smallId = before[0].id;

    const big = block(40, 40, 14);
    const after = extractBuildingCandidates([...small, ...big], GRID, METRE);
    expect(after.length).toBe(2);
    // The larger building sorts first, so an index-based id would have renamed
    // the small one. Its geometry-derived id must be untouched.
    expect(after[0].areaSource).toBeGreaterThan(after[1].areaSource);
    expect(after.map((c) => c.id)).toContain(smallId);
  });

  it('distinct buildings never share an id', () => {
    const cands = extractBuildingCandidates([...block(0, 0, 6), ...block(40, 40, 6)], GRID, METRE);
    expect(cands).toHaveLength(2);
    expect(new Set(cands.map((c) => c.id)).size).toBe(2);
  });

  it('a conductor id is stable for the same span', () => {
    const a = extractConductorCandidate(span(), METRE)!;
    const b = extractConductorCandidate(span(), METRE)!;
    expect(b.id).toBe(a.id);
  });
});
