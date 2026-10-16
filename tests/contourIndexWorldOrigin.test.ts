/**
 * contourIndexWorldOrigin.test.ts — index contours are chosen on WORLD
 * elevation when the DTM is in a recentred local frame.
 *
 * `contoursAt` anchors derived levels to world elevation through
 * `levelOriginZ` (local value + origin is a multiple of the interval). The
 * index classification has to use the same frame, or a 1-unit interval with
 * origin 337 puts index lines on world 342 and 347 instead of 340 and 345, and
 * a fractional origin such as 337.4 leaves no index line (and so no label) at
 * all.
 */
import { describe, it, expect } from 'vitest';
import { analyseContours } from '../src/terrain/contour/analyseContours';
import { styleLevels } from '../src/terrain/contour/contourStyle';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

/** Local z = 0.2·x over x ∈ [0, 50]: a plane rising 0 → 10 local units. */
function plane(): TerrainPoint[] {
  const pts: TerrainPoint[] = [];
  for (let x = 0; x <= 50; x += 0.5) for (let y = 0; y <= 20; y += 0.5) pts.push({ x, y, z: 0.2 * x });
  return pts;
}

const base = {
  cellSizeM: 1,
  crs: 'EPSG:32610',
  verticalDatum: 'EPSG:5703',
  intervalM: 1,
  indexEvery: 5,
} as const;

const worldOf = (v: number, oz: number): number => Math.round((v + oz) * 1000) / 1000;

function run(oz: number) {
  return analyseContours(plane(), { ...base, levelOriginZ: oz });
}

function indexWorldLevels(oz: number): number[] {
  return run(oz).style.levels.filter((l) => l.isIndex).map((l) => worldOf(l.value, oz));
}

describe('styleLevels: index classification on world elevation', () => {
  it('classifies value + originZ, and returns values in the caller frame', () => {
    // Local 0..10 at a 1-unit interval, origin 337: world 337..347.
    const local = Array.from({ length: 11 }, (_, i) => i);
    const r = styleLevels(local, { intervalM: 1, indexEvery: 5, originZ: 337 });
    expect(r.levels.map((l) => l.value)).toEqual(local);
    expect(r.levels.filter((l) => l.isIndex).map((l) => l.value + 337)).toEqual([340, 345]);
    for (const l of r.levels) expect(l.labelEligible).toBe(l.isIndex);
    for (const l of r.levels) expect(l.weight).toBe(l.isIndex ? 2 : 1);
  });

  it('a fractional origin still yields the world index levels', () => {
    // Levels that sit on whole world metres: local = k − 0.4.
    const local = Array.from({ length: 10 }, (_, i) => i + 0.6);
    const r = styleLevels(local, { intervalM: 1, indexEvery: 5, originZ: 337.4 });
    expect(r.levels.filter((l) => l.isIndex).map((l) => worldOf(l.value, 337.4))).toEqual([340, 345]);
  });

  it('an omitted or non-finite originZ is the local frame (origin 0)', () => {
    const local = Array.from({ length: 11 }, (_, i) => i);
    const idx = (o?: number | null) =>
      styleLevels(local, { intervalM: 1, indexEvery: 5, originZ: o }).levels
        .filter((l) => l.isIndex).map((l) => l.value);
    expect(idx()).toEqual([0, 5, 10]);
    expect(idx(null)).toEqual([0, 5, 10]);
    expect(idx(Number.NaN)).toEqual([0, 5, 10]);
  });
});

describe('analyseContours: index contours and exported features follow world elevation', () => {
  it('origin 0: index contours on multiples of 5', () => {
    const idx = indexWorldLevels(0);
    expect(idx.length).toBeGreaterThan(0);
    for (const v of idx) expect(v % 5).toBe(0);
  });

  it('integer origin not a multiple of 5 × interval: index at world 340 and 345', () => {
    expect(indexWorldLevels(337)).toEqual([340, 345]);
  });

  it('fractional origin: index contours still exist at world 340 and 345', () => {
    expect(indexWorldLevels(337.4)).toEqual([340, 345]);
  });

  it('the feature model and labels carry the same classification', () => {
    const oz = 337.4;
    const r = run(oz);
    const indexValues = new Set(r.style.levels.filter((l) => l.isIndex).map((l) => l.value));
    // Every exported feature's isIndex (contour_type, overlay emphasis and
    // map-sheet weight all read it) matches the world classification.
    expect(r.model.features.length).toBeGreaterThan(0);
    for (const f of r.model.features) expect(f.isIndex).toBe(indexValues.has(f.value));
    const indexFeatureWorld = [...new Set(
      r.model.features.filter((f) => f.isIndex).map((f) => worldOf(f.value, oz)),
    )].sort((a, b) => a - b);
    expect(indexFeatureWorld).toEqual([340, 345]);
    // Labels are placed along index contours only, so every label value is
    // one of the world-classified index levels.
    for (const l of r.labels) expect(indexValues.has(l.value)).toBe(true);
  });
});

describe('index contours survive level thinning at any origin', () => {
  /** Local z = 5·x over x ∈ [0, 50]: 0 → 250 local units, over the 200-level cap at a 1-unit interval. */
  function steep(): TerrainPoint[] {
    const pts: TerrainPoint[] = [];
    for (let x = 0; x <= 50; x += 0.5) for (let y = 0; y <= 20; y += 0.5) pts.push({ x, y, z: 5 * x });
    return pts;
  }

  it.each([0, 337, 337.4])('origin %s: thinned levels are world multiples of 2 and index lines fall on multiples of 10', (oz) => {
    const r = analyseContours(steep(), { ...base, levelOriginZ: oz });
    // ~250 levels at 1 unit against a cap of 200 → one in every 2 kept.
    expect(r.intervalM).toBe(2);
    expect(r.contours.warnings.join(' ')).toMatch(/thinned/);
    const world = r.style.levels.map((l) => worldOf(l.value, oz));
    // Every level but a forced summit is on the world grid of 2.
    for (const w of world.slice(0, -1)) expect(w % 2).toBe(0);
    const idx = r.style.levels.filter((l) => l.isIndex).map((l) => worldOf(l.value, oz));
    expect(idx.length).toBeGreaterThan(10);
    for (const w of idx) expect(w % 10).toBe(0);
  });
});
