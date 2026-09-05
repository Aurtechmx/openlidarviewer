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
import { footprintsToGeoJson } from '../src/features/footprintGeoJson';

const METRE = knownUnit(1);
const Z_UP: Vec3 = [0, 0, 1];
const Y_UP: Vec3 = [0, 1, 0];
const FOOT = knownUnit(0.3048);

/** A solid 10x10 block of building points. */
function block(ox = 0, oy = 0, n = 10): BuildingPoint[] {
  const pts: BuildingPoint[] = [];
  for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) pts.push({ x: ox + x, y: oy + y });
  return pts;
}
const GRID = { originX: 0, originY: 0, cellSizeSource: 1, minPointsPerCell: 1, minAreaSource: 4 };

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
    const c = extractConductorCandidate(span(), METRE, Z_UP);
    expect(c).not.toBeNull();
    expect(c!.kind).toBe('conductor');
    expect(c!.linearity).toBeGreaterThan(0.9);
    expect(c!.spanSource).toBeGreaterThan(30);
    expect(c!.sagSource).toBeGreaterThan(0);
  });

  it('rejects a non-linear blob as not a conductor', () => {
    const pts: Vec3[] = [];
    for (let x = 0; x < 6; x++) for (let y = 0; y < 6; y++) pts.push([x, y, 0]);
    expect(extractConductorCandidate(pts, METRE, Z_UP)).toBeNull();
  });
});

describe('FeatureExtractionService — unit honesty', () => {
  it('an UNKNOWN unit yields no metric claim at all, never a metres guess', () => {
    const b = extractBuildingCandidates(block(), GRID, unknownUnit())[0];
    expect(b.areaSource).toBeGreaterThan(0); // the source measure still stands
    expect(b.areaM2).toBeNull();

    const c = extractConductorCandidate(span(), unknownUnit(), Z_UP)!;
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

  it('a KNOWN unit converts a span whose length is known by construction', () => {
    // 39 units end to end, in feet: 39 x 0.3048 = 11.8872 m, and nothing else.
    const c = extractConductorCandidate(span(), FOOT, Z_UP)!;
    expect(c.spanSource).toBeCloseTo(39, 6);
    expect(c.spanM).toBeCloseTo(11.8872, 6);
  });

  it('the up axis reaches the core: a Y-up span measures the same as a Z-up one', () => {
    const zUp = extractConductorCandidate(span(), METRE, Z_UP)!;
    const rotated = span().map((p) => [p[0], p[2], -p[1]] as Vec3);
    const yUp = extractConductorCandidate(rotated, METRE, Y_UP)!;
    expect(yUp.spanSource).toBeCloseTo(zUp.spanSource, 9);
    expect(yUp.sagSource).toBeCloseTo(zUp.sagSource, 9);
    expect(yUp.spanM).toBeCloseTo(zUp.spanM!, 9);
  });

  it('LENGTH converts by the scale once (span, sag and residual alike)', () => {
    const c = extractConductorCandidate(span(), FOOT, Z_UP)!;
    expect(c.spanM).toBeCloseTo(c.spanSource * 0.3048, 9);
    expect(c.sagM).toBeCloseTo(c.sagSource * 0.3048, 9);
    expect(c.residualRmsM).toBeCloseTo(c.residualRmsSource * 0.3048, 9);
    // A squared conversion would be ~0.093x, not 0.3048x — pin that it is not.
    expect(c.spanM).toBeGreaterThan(c.spanSource * 0.3048 * 0.3048 * 2);
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
    const a = extractConductorCandidate(span(), METRE, Z_UP)!;
    const b = extractConductorCandidate(span(), METRE, Z_UP)!;
    expect(b.id).toBe(a.id);
  });
});

describe('FeatureExtractionService — the traced ring', () => {
  it('carries a real outline, not a bounding box', () => {
    // An L-shaped block: a rectangle would have 4 corners and cover the notch,
    // so a ring that is genuinely traced must have more vertices than that.
    const pts: BuildingPoint[] = [];
    for (let x = 0; x < 10; x++) for (let y = 0; y < 4; y++) pts.push({ x, y });
    for (let x = 0; x < 4; x++) for (let y = 4; y < 10; y++) pts.push({ x, y });
    const [b] = extractBuildingCandidates(pts, GRID, METRE);
    expect(b.ring.length).toBeGreaterThan(4);
  });

  it('the ring closes, stays inside the bounds, and is not repeated at the end', () => {
    const [b] = extractBuildingCandidates(block(), GRID, METRE);
    expect(b.ring.length).toBeGreaterThanOrEqual(3);
    const [minX, minY, maxX, maxY] = b.bounds;
    for (const p of b.ring) {
      expect(p.x).toBeGreaterThanOrEqual(minX);
      expect(p.x).toBeLessThanOrEqual(maxX);
      expect(p.y).toBeGreaterThanOrEqual(minY);
      expect(p.y).toBeLessThanOrEqual(maxY);
    }
    // First vertex is NOT repeated as the last (the documented convention).
    const first = b.ring[0];
    const last = b.ring[b.ring.length - 1];
    expect(first.x === last.x && first.y === last.y).toBe(false);
  });

  it('feeds the GeoJSON writer, which previously had no ring to consume', () => {
    const cands = extractBuildingCandidates(block(), GRID, METRE);
    const fc = footprintsToGeoJson(
      cands.map((c) => ({
        ring: c.ring,
        areaSource: c.areaSource,
        areaM2: c.areaM2,
        centroidX: c.centroid[0],
        centroidY: c.centroid[1],
        id: c.id,
      })),
      { sourceCrsLabel: 'EPSG:32610' },
    );
    expect(fc.features).toHaveLength(1);
    const geom = fc.features[0].geometry as { type: string; coordinates: number[][][] };
    expect(geom.type).toBe('Polygon');
    // RFC 7946: the writer closes the ring on output.
    const out = geom.coordinates[0];
    expect(out[0]).toEqual(out[out.length - 1]);
  });
});
