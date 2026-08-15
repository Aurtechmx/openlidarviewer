import { describe, it, expect } from 'vitest';
import {
  extractBuildingCandidates,
  extractConductorCandidate,
} from '../src/features/FeatureExtractionService';
import type { BuildingPoint } from '../src/features/buildingFootprints';
import type { Vec3 } from '../src/features/conductors';

describe('FeatureExtractionService', () => {
  it('turns a dense occupied block into a derived building candidate', () => {
    const pts: BuildingPoint[] = [];
    for (let x = 0; x < 10; x++) for (let y = 0; y < 10; y++) pts.push({ x, y });
    const cands = extractBuildingCandidates(pts, { originX: 0, originY: 0, cellSizeM: 1, minPointsPerCell: 1, minAreaM2: 4 });
    expect(cands.length).toBe(1);
    expect(cands[0].id).toBe('building-1');
    expect(cands[0].kind).toBe('building');
    expect(cands[0].confidence).toBe('derived');
    expect(cands[0].areaM2).toBeGreaterThan(0);
    expect(cands[0].bounds).toHaveLength(4);
  });

  it('returns no candidates for empty input', () => {
    expect(extractBuildingCandidates([], { originX: 0, originY: 0, cellSizeM: 1 })).toEqual([]);
  });

  it('fits a straight span as a conductor candidate', () => {
    const pts: Vec3[] = [];
    for (let i = 0; i < 40; i++) pts.push([i, 0, 10 - 0.001 * i * (40 - i)]); // slight sag
    const c = extractConductorCandidate(pts);
    expect(c).not.toBeNull();
    expect(c!.kind).toBe('conductor');
    expect(c!.linearity).toBeGreaterThan(0.9);
    expect(c!.spanM).toBeGreaterThan(30);
    expect(c!.sagM).toBeGreaterThan(0);
  });

  it('rejects a non-linear blob as not a conductor', () => {
    const pts: Vec3[] = [];
    for (let x = 0; x < 6; x++) for (let y = 0; y < 6; y++) pts.push([x, y, 0]);
    expect(extractConductorCandidate(pts)).toBeNull();
  });
});
