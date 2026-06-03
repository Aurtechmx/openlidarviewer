/**
 * tests/terrainSuggestion.test.ts
 *
 * Coverage for the v0.3.7 terrain auto-suggestion heuristic.
 */

import { describe, it, expect } from 'vitest';
import { terrainSuggestion } from '../src/render/terrainSuggestion';

function classCloud(classCode: number, count: number): Uint8Array {
  const out = new Uint8Array(count);
  out.fill(classCode);
  return out;
}

function mixedCloud(
  parts: ReadonlyArray<{ cls: number; count: number }>,
): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.count;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.fill(p.cls, off, off + p.count);
    off += p.count;
  }
  return out;
}

describe('terrainSuggestion', () => {
  it('returns shouldSuggest=false for an empty cloud', () => {
    const r = terrainSuggestion({ classifications: new Uint8Array(0) });
    expect(r.shouldSuggest).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it('suggests Terrain on a ground-dominated cloud', () => {
    const r = terrainSuggestion({ classifications: classCloud(2, 10_000) });
    expect(r.shouldSuggest).toBe(true);
    expect(r.groundFraction).toBeGreaterThan(0.9);
    expect(r.reason).toMatch(/Ground|terrain/i);
  });

  it('suggests Terrain on a vegetation-dominated cloud', () => {
    const r = terrainSuggestion({ classifications: classCloud(5, 10_000) });
    expect(r.shouldSuggest).toBe(true);
    expect(r.vegetationFraction).toBeGreaterThan(0.9);
  });

  it('vetoes the suggestion when buildings dominate', () => {
    const r = terrainSuggestion({ classifications: classCloud(6, 10_000) });
    expect(r.shouldSuggest).toBe(false);
    expect(r.buildingFraction).toBeGreaterThan(0.9);
    expect(r.reason).toMatch(/Infrastructure/i);
  });

  it('declines a sparse-classification cloud', () => {
    // All unclassified (class 1 = "Unclassified" in LAS).
    const r = terrainSuggestion({ classifications: classCloud(1, 10_000) });
    expect(r.shouldSuggest).toBe(false);
  });

  it('reports fractions that sum within their classes', () => {
    const r = terrainSuggestion({
      classifications: mixedCloud([
        { cls: 2, count: 4_000 }, // ground 40 %
        { cls: 5, count: 2_000 }, // veg 20 %
        { cls: 6, count: 1_000 }, // building 10 %
        { cls: 1, count: 3_000 }, // unclassified 30 %
      ]),
    });
    expect(r.shouldSuggest).toBe(true);
    expect(r.groundFraction).toBeCloseTo(0.4, 1);
    expect(r.vegetationFraction).toBeCloseTo(0.2, 1);
    expect(r.buildingFraction).toBeCloseTo(0.1, 1);
  });
});
