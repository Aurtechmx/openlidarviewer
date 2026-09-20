import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  MAX_COVERAGE_GROWTH,
  coverageSizeFactor,
  coverageSizeMultiplier,
  focalLengthPxFor,
  renderSpacingPx,
} from '../src/render/continuity/coverageSizing';
import { projectedSpacingPx } from '../src/render/streaming/coverageBudget';

describe('render spacing', () => {
  it('is the projection the scheduler already uses, not a second one', () => {
    // A renderer and a scheduler that disagreed about how far apart the
    // samples land would size for one picture and load for another.
    for (const [s, d, f] of [[0.1, 10, 800], [0.5, 3, 1200], [2, 100, 600]]) {
      expect(renderSpacingPx(s, d, f)).toBe(projectedSpacingPx(s, d, f));
    }
  });

  it('is null where it has no meaning', () => {
    expect(renderSpacingPx(0.1, 0, 800)).toBe(null);
    expect(renderSpacingPx(0.1, -5, 800)).toBe(null);
    expect(renderSpacingPx(0, 10, 800)).toBe(null);
    expect(renderSpacingPx(Number.NaN, 10, 800)).toBe(null);
  });

  it('grows as a surface recedes, at the rate the projection says', () => {
    const near = renderSpacingPx(0.1, 5, 800);
    const far = renderSpacingPx(0.1, 10, 800);
    expect(near).toBeCloseTo(16, 6);
    expect(far).toBeCloseTo(8, 6);
  });
});

describe('the growth factor', () => {
  it('leaves a point alone when it already meets its neighbour', () => {
    expect(coverageSizeFactor(2, 2)).toBe(1);
    expect(coverageSizeFactor(1, 4)).toBe(1);
  });

  it('grows a point to the spacing when it falls short', () => {
    expect(coverageSizeFactor(6, 2)).toBeCloseTo(3, 6);
  });

  it('never shrinks a point, because that would hide a sample that is there', () => {
    for (const [spacing, drawn] of [[1, 8], [0.25, 3], [2, 2.0001]]) {
      expect(coverageSizeFactor(spacing, drawn)).toBe(1);
    }
  });

  it('stops growing at the cap rather than turning a thin scan into blobs', () => {
    expect(coverageSizeFactor(400, 2)).toBe(MAX_COVERAGE_GROWTH);
    expect(coverageSizeFactor(1e9, 1)).toBe(MAX_COVERAGE_GROWTH);
  });

  it('refuses to grow on a spacing it could not compute', () => {
    // A renderer that grew points from an unknown spacing would invent
    // coverage, and it would look exactly like the feature working.
    expect(coverageSizeFactor(null, 2)).toBe(1);
    expect(coverageSizeFactor(Number.NaN, 2)).toBe(1);
    expect(coverageSizeFactor(-3, 2)).toBe(1);
  });

  it('refuses a drawn size it cannot divide by', () => {
    expect(coverageSizeFactor(8, 0)).toBe(1);
    expect(coverageSizeFactor(8, Number.NaN)).toBe(1);
  });

  it('stays inside its band for every input', () => {
    for (const spacing of [null, 0, 0.5, 1, 3, 17, 1e6]) {
      for (const drawn of [0, 0.5, 1, 2, 40]) {
        const f = coverageSizeFactor(spacing, drawn);
        expect(f).toBeGreaterThanOrEqual(1);
        expect(f).toBeLessThanOrEqual(MAX_COVERAGE_GROWTH);
      }
    }
  });
});

describe('the whole path', () => {
  it('projects and caps in one call', () => {
    const input = { nodeSpacing: 0.2, distance: 10, focalLengthPx: 800, drawnSizePx: 2 };
    expect(coverageSizeMultiplier(input)).toBeCloseTo(
      coverageSizeFactor(renderSpacingPx(0.2, 10, 800), 2),
      9,
    );
  });

  it('leaves an oversampled view alone', () => {
    // Samples closer together than the dot that draws them need nothing.
    const factor = coverageSizeMultiplier({
      nodeSpacing: 0.001,
      distance: 50,
      focalLengthPx: 800,
      drawnSizePx: 3,
    });
    expect(factor).toBe(1);
  });
});

describe('focal length', () => {
  it('is the pinhole length for a vertical field of view', () => {
    // 90 degrees: the focal length is half the height.
    expect(focalLengthPxFor(90, 1000)).toBeCloseTo(500, 6);
  });

  it('refuses anything that is not a usable perspective view', () => {
    expect(focalLengthPxFor(0, 1000)).toBe(null);
    expect(focalLengthPxFor(180, 1000)).toBe(null);
    expect(focalLengthPxFor(60, 0)).toBe(null);
    expect(focalLengthPxFor(Number.NaN, 1000)).toBe(null);
  });
});

describe('the vocabulary cannot be crossed', () => {
  it('names no count, area or density in any code it runs', () => {
    // The structural half of the rule, checked against the source with the
    // comments removed: the header discusses density at length, and the point
    // is that no executable line reaches for one. A future edit that took a
    // point count or returned a density would fail here.
    const source = readFileSync(
      new URL('../src/render/continuity/coverageSizing.ts', import.meta.url),
      'utf8',
    );
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/count|area|density/i);
    // And the check itself is not vacuous: the stripped source is still the
    // module, not an empty string.
    expect(code).toMatch(/export function coverageSizeFactor/);
  });
});
