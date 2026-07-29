/**
 * The load-memory estimate drives admission: it sets the point budget and
 * decides `mayExceedCeiling`. `LAS_DECODED_ATTRIBUTES` declared `hasColor:
 * false` for every LAS point format, while the decoder emits a colour array
 * for the formats that carry RGB. The estimate therefore came in low precisely
 * on the files where memory is tightest, and the planner admitted budgets the
 * device could not hold.
 *
 * These pin the format-to-attribute mapping and the direction of the error.
 */

import { describe, expect, it } from 'vitest';

import { lasDecodedAttributes, pointFormatHasRgb } from '../src/io/lasHeader';

describe('LAS point formats that carry RGB', () => {
  it('matches the ASPRS specification', () => {
    // 2, 3, 5 are the 1.2/1.3 colour formats; 7, 8, 10 the 1.4 counterparts.
    for (const f of [2, 3, 5, 7, 8, 10]) {
      expect(pointFormatHasRgb(f), `format ${f} carries RGB`).toBe(true);
    }
    for (const f of [0, 1, 4, 6, 9]) {
      expect(pointFormatHasRgb(f), `format ${f} carries no RGB`).toBe(false);
    }
  });

  it('declares colour only for the formats that have it', () => {
    expect(lasDecodedAttributes(3).hasColor).toBe(true);
    expect(lasDecodedAttributes(0).hasColor).toBe(false);
  });

  it('leaves every other declared attribute alone', () => {
    const colour = lasDecodedAttributes(3);
    const plain = lasDecodedAttributes(0);
    for (const key of ['hasIntensity', 'hasClassification', 'hasNormals', 'hasLasExtras'] as const) {
      expect(colour[key]).toBe(plain[key]);
    }
  });

  it('raises the per-point estimate for a colour-bearing format', async () => {
    const { estimateMemoryBytes } = await import('../src/io/loadPlan');
    const base = { pointCount: 1_000_000, fileBytes: 0, format: 'las' as const };
    const withColour = estimateMemoryBytes({ ...base, attributes: lasDecodedAttributes(3) });
    const without = estimateMemoryBytes({ ...base, attributes: lasDecodedAttributes(0) });
    // Three bytes per point, so a million points differ by 3 MB. The old
    // constant produced the lower figure for both.
    expect(withColour).toBeGreaterThan(without);
    expect(withColour - without).toBe(3_000_000);
  });
});
