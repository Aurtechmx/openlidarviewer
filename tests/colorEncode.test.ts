/**
 * tests/colorEncode.test.ts
 *
 * Pins the shared sRGB EOTF/OETF seam in `colorEncode.ts`. The encode
 * direction (`linearToSrgbScalar`) was converged here in v0.5.0 from two
 * byte-identical inline copies in `patchView.ts` and `colorProvenance.ts`
 * during a v0.4.4 review pass; these tests lock the curve so the seam
 * can never silently drift from the bulk upload path or three.js.
 */

import { describe, it, expect } from 'vitest';
import {
  srgbToLinearScalar,
  srgbByteToLinear,
  linearToSrgbScalar,
  writeFloatColorsInto,
} from '../src/render/colorEncode';

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

describe('srgbByteToLinear — the 256-entry table is the formula, not an approximation', () => {
  /**
   * The whole safety argument for the lookup table is that a byte has 256
   * possible values, so the table holds every result the formula can produce
   * for byte input. A sampled check would not establish that, so this walks
   * all 256 and demands bit equality (`Object.is`, not `toBeCloseTo`).
   */
  it('equals srgbToLinearScalar(b / 255) bit for bit for all 256 byte values', () => {
    const mismatches: string[] = [];
    for (let b = 0; b <= 255; b++) {
      const table = srgbByteToLinear(b);
      const formula = srgbToLinearScalar(b / 255);
      if (!Object.is(table, formula)) {
        mismatches.push(`b=${b}: table ${table} vs formula ${formula}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('covers both sides of the 0.04045 knee', () => {
    // b = 10 is 0.0392 (linear segment), b = 11 is 0.0431 (power segment).
    expect(srgbByteToLinear(10)).toBe(10 / 255 / 12.92);
    expect(srgbByteToLinear(11)).toBe(Math.pow((11 / 255 + 0.055) / 1.055, 2.4));
  });

  it('maps the endpoints to 0 and 1 exactly', () => {
    expect(srgbByteToLinear(0)).toBe(0);
    expect(srgbByteToLinear(255)).toBe(1);
  });

  /**
   * A raw table index would return `undefined` for any of these and poison a
   * Float32 write with NaN. The guard sends them to the formula instead, so
   * they behave exactly as they did before the table existed.
   */
  it('falls through to the formula for non-integer, negative and above-255 input', () => {
    for (const v of [-1, -0.5, 255.5, 256, 1000, 3.5, 0.5]) {
      expect(srgbByteToLinear(v)).toBe(srgbToLinearScalar(v / 255));
      expect(srgbByteToLinear(v)).not.toBeUndefined();
    }
  });

  it('returns NaN for NaN rather than undefined', () => {
    expect(srgbByteToLinear(NaN)).toBeNaN();
    expect(srgbByteToLinear(Infinity)).toBe(srgbToLinearScalar(Infinity));
    expect(srgbByteToLinear(-Infinity)).toBe(srgbToLinearScalar(-Infinity));
  });
});

describe('writeFloatColorsInto — table path matches the formula for every byte', () => {
  it('produces the pre-table result for all 256 byte values', () => {
    const src = new Uint8Array(256);
    for (let b = 0; b <= 255; b++) src[b] = b;
    const dst = new Float32Array(256);
    writeFloatColorsInto(dst, src);

    const expected = new Float32Array(256);
    for (let b = 0; b <= 255; b++) expected[b] = srgbToLinearScalar(b / 255);

    expect(Array.from(dst)).toEqual(Array.from(expected));
  });

  it('accepts a Uint8ClampedArray source with the same results', () => {
    const src = new Uint8ClampedArray(256);
    for (let b = 0; b <= 255; b++) src[b] = b;
    const dst = new Float32Array(256);
    writeFloatColorsInto(dst, src);
    for (let b = 0; b <= 255; b++) {
      expect(dst[b]).toBe(Math.fround(srgbToLinearScalar(b / 255)));
    }
  });

  it('never writes undefined or NaN into the attribute', () => {
    const src = new Uint8Array([0, 1, 127, 128, 254, 255]);
    const dst = new Float32Array(src.length);
    writeFloatColorsInto(dst, src);
    for (const v of dst) expect(Number.isFinite(v)).toBe(true);
  });
});
