/**
 * tests/colorEncode.test.ts
 *
 * Pins the shared sRGB EOTF/OETF seam in `colorEncode.ts`. The encode
 * direction (`linearToSrgbScalar`) was converged here in v0.5.0 from two
 * byte-identical inline copies in `patchView.ts` and `colorProvenance.ts`
 * (QualityRevision v0.4.4 item 5); these tests lock the curve so the seam
 * can never silently drift from the bulk upload path or three.js.
 */

import { describe, it, expect } from 'vitest';
import { srgbToLinearScalar, linearToSrgbScalar } from '../src/render/colorEncode';

describe('linearToSrgbScalar — piecewise sRGB OETF', () => {
  it('maps the anchors exactly', () => {
    expect(linearToSrgbScalar(0)).toBeCloseTo(0, 12);
    expect(linearToSrgbScalar(1)).toBeCloseTo(1, 12);
  });

  it('uses the linear segment below the 0.0031308 knee', () => {
    // s = 12.92 · x in the toe.
    expect(linearToSrgbScalar(0.001)).toBeCloseTo(0.01292, 12);
  });

  it('matches a known mid-tone (linear 0.21404 ⇒ sRGB ~0.5)', () => {
    expect(linearToSrgbScalar(0.21404)).toBeCloseTo(0.5, 4);
  });

  it('clamps out-of-range input to [0, 1]', () => {
    expect(linearToSrgbScalar(-0.5)).toBe(0);
    expect(linearToSrgbScalar(1.5)).toBeCloseTo(1, 12);
  });
});

describe('colorEncode — encode/decode are exact inverses', () => {
  it('round-trips every byte value 0..255 within half a code', () => {
    for (let b = 0; b <= 255; b++) {
      const linear = srgbToLinearScalar(b / 255);
      const back = Math.round(linearToSrgbScalar(linear) * 255);
      expect(back).toBe(b);
    }
  });

  it('round-trips a sweep of linear values', () => {
    for (let i = 0; i <= 100; i++) {
      const x = i / 100;
      expect(srgbToLinearScalar(linearToSrgbScalar(x))).toBeCloseTo(x, 6);
    }
  });
});
