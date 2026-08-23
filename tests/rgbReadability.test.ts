/**
 * rgbReadability.test.ts
 *
 * Whether a colour array is worth opening a scan in.
 *
 * The case this exists for: a survey that carries a full RGB array in which
 * every point is within a few levels of white. The channel is present, the
 * renderer draws it, and the result is a blank sheet. A real file measured at
 * a mean of 242 of 255, entirely greyscale, with 96 per cent of its points near
 * white, and it opened in true colour because the check asked whether colour
 * existed rather than whether it could be read.
 *
 * The failure in the other direction matters more, so the tests below spend
 * most of their attention on clouds that must KEEP true colour: dim ones, dark
 * ones, monochrome ones with real contrast, and ones where only a small part of
 * the scan is coloured at all.
 */

import { describe, it, expect } from 'vitest';
import {
  readRgbReadability,
  RGB_MIN_SAMPLE,
  RGB_LUMINANCE_IQR_FLOOR,
  RGB_CHROMATIC_FRACTION_FLOOR,
} from '../src/render/rgbReadability';
import { recommendColorMode } from '../src/render/colorModeRecommend';

/** An RGB array of `n` points, coloured by `f`. */
function cloud(n: number, f: (i: number) => readonly [number, number, number]): Uint8Array {
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const [r, g, b] = f(i);
    out[i * 3] = r; out[i * 3 + 1] = g; out[i * 3 + 2] = b;
  }
  return out;
}

/** A deterministic pseudo-random in [0, 1); no seeded generator needed. */
function rand(i: number): number {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

describe('readRgbReadability', () => {
  it('reports absent for a missing or empty array', () => {
    expect(readRgbReadability(undefined).verdict).toBe('absent');
    expect(readRgbReadability(new Uint8Array(0)).verdict).toBe('absent');
  });

  it('calls a near-white greyscale cloud uniform', () => {
    // The measured shape: grey, mean around 242, tightly clustered near white.
    const c = cloud(50_000, (i) => {
      const v = 236 + Math.round(rand(i) * 8);
      return [v, v, v];
    });
    const r = readRgbReadability(c);
    expect(r.verdict).toBe('uniform');
    expect(r.chromaticFraction).toBe(0);
    expect(r.luminanceIqr).toBeLessThan(RGB_LUMINANCE_IQR_FLOOR);
  });

  it('calls a near-black cloud uniform too, which is the same wash', () => {
    const c = cloud(50_000, (i) => {
      const v = Math.round(rand(i) * 6);
      return [v, v, v];
    });
    expect(readRgbReadability(c).verdict).toBe('uniform');
  });

  it('keeps a photogrammetric cloud readable', () => {
    const c = cloud(50_000, (i) => [
      Math.round(rand(i) * 255),
      Math.round(rand(i + 1) * 255),
      Math.round(rand(i + 2) * 255),
    ]);
    const r = readRgbReadability(c);
    expect(r.verdict).toBe('readable');
    expect(r.chromaticFraction).toBeGreaterThan(0.5);
  });

  it('keeps a monochrome cloud with real contrast readable', () => {
    // No chroma at all, but the greys span the range, so shape is visible.
    const c = cloud(50_000, (i) => {
      const v = Math.round(rand(i) * 255);
      return [v, v, v];
    });
    const r = readRgbReadability(c);
    expect(r.chromaticFraction).toBe(0);
    expect(r.luminanceIqr).toBeGreaterThan(RGB_LUMINANCE_IQR_FLOOR);
    expect(r.verdict).toBe('readable');
  });

  it('keeps a dim but colourful cloud readable', () => {
    // Every point dark, so luminance barely varies, but the hues differ.
    const c = cloud(50_000, (i) => {
      const h = i % 3;
      return [h === 0 ? 24 : 2, h === 1 ? 24 : 2, h === 2 ? 24 : 2];
    });
    const r = readRgbReadability(c);
    expect(r.luminanceIqr).toBeLessThan(RGB_LUMINANCE_IQR_FLOOR);
    expect(r.chromaticFraction).toBeGreaterThan(RGB_CHROMATIC_FRACTION_FLOOR);
    expect(r.verdict).toBe('readable');
  });

  it('keeps a cloud readable when only a small minority carries colour', () => {
    // Three per cent coloured against a flat white background: above the floor,
    // so the colour that is there is not thrown away.
    const c = cloud(50_000, (i) => (i % 33 === 0 ? [200, 40, 40] : [250, 250, 250]));
    const r = readRgbReadability(c);
    expect(r.chromaticFraction).toBeGreaterThan(RGB_CHROMATIC_FRACTION_FLOOR);
    expect(r.verdict).toBe('readable');
  });

  it('refuses to call a handful of points uniform', () => {
    // A summary of a distribution needs a distribution. Below the floor the
    // answer is readable, because withholding true colour is the worse error.
    const tiny = cloud(RGB_MIN_SAMPLE - 1, () => [255, 255, 255]);
    expect(readRgbReadability(tiny).verdict).toBe('readable');
    const enough = cloud(RGB_MIN_SAMPLE, () => [255, 255, 255]);
    expect(readRgbReadability(enough).verdict).toBe('uniform');
  });

  it('samples across the whole cloud rather than its head', () => {
    // The first fifth is vivid and the rest is white. Point order follows
    // acquisition, so a head-only sample would call this whole scan colourful.
    const n = 500_000;
    const c = cloud(n, (i) => (i < n / 5 ? [220, 30, 30] : [252, 252, 252]));
    const r = readRgbReadability(c);
    expect(r.chromaticFraction).toBeGreaterThan(0.15);
    expect(r.chromaticFraction).toBeLessThan(0.25);
  });

  it('does not alias against periodic structure in point order', () => {
    // The defect this replaced a fixed stride to fix. One million points with
    // colour on every fiftieth, and a stride of fifty, put the sampler on a
    // coloured point every single time: it reported the cloud as 100 per cent
    // chromatic when 2 per cent of it carries colour, a 4,900 per cent error.
    // Point clouds are full of periodic order from scan lines, tile boundaries
    // and interleaved returns, so this is a shape real data has.
    const n = 1_000_000;
    const c = cloud(n, (i) => (i % 50 === 0 ? [200, 40, 40] : [250, 250, 250]));
    const r = readRgbReadability(c);
    expect(r.chromaticFraction).toBeGreaterThan(0.015);
    expect(r.chromaticFraction).toBeLessThan(0.025);
  });

  it('holds that accuracy across a range of periods and cloud sizes', () => {
    // Any fixed step aliases with SOME period; a step near the golden ratio of
    // the count minimises the worst case rather than removing it. Measured
    // worst relative error over these combinations is 11 per cent, against
    // 4,900 for the fixed stride.
    for (const n of [50_000, 250_000, 1_000_000]) {
      for (const every of [8, 25, 50, 64, 128, 250]) {
        const r = readRgbReadability(
          cloud(n, (i) => (i % every === 0 ? [200, 40, 40] : [250, 250, 250])),
        );
        const truth = 1 / every;
        expect(Math.abs(r.chromaticFraction - truth) / truth).toBeLessThan(0.2);
      }
    }
  });

  it('costs exactly the target on a large cloud', () => {
    // The walk takes a fixed number of steps rather than striding to the end,
    // so the sample size is the target and not a multiple of it.
    expect(readRgbReadability(cloud(2_000_000, () => [10, 200, 30])).sampled).toBe(20_000);
    expect(readRgbReadability(cloud(39_999, () => [10, 200, 30])).sampled).toBe(20_000);
  });

  it('inspects every point of a cloud smaller than the target', () => {
    expect(readRgbReadability(cloud(500, () => [10, 200, 30])).sampled).toBe(500);
  });

  it('visits each point at most once, so no point is double counted', () => {
    // The step is coprime to the count, which is what makes the walk a
    // permutation rather than a cycle over a subset.
    const n = 12_345;
    const r = readRgbReadability(cloud(n, (i) => (i === 0 ? [200, 40, 40] : [250, 250, 250])));
    expect(r.chromaticFraction).toBeCloseTo(1 / n, 6);
  });
});

describe('recommendColorMode with a uniform colour array', () => {
  const WASH = cloud(50_000, (i) => {
    const v = 236 + Math.round(rand(i) * 8);
    return [v, v, v];
  });

  it('opens a near-white scan in height rather than true colour', () => {
    const r = recommendColorMode({ colors: WASH });
    expect(r.mode).toBe('elevation');
    expect(r.reason).toMatch(/too uniform/);
  });

  it('says why, distinctly from a scan that carries no colour at all', () => {
    expect(recommendColorMode({}).reason).not.toMatch(/too uniform/);
  });

  it('prefers classification over a wash when the scan is classified', () => {
    const r = recommendColorMode({
      colors: WASH,
      classification: new Uint8Array([2, 6, 2, 5]),
    });
    expect(r.mode).toBe('classification');
  });

  it('still opens a colourful scan in true colour', () => {
    const colourful = cloud(50_000, (i) => [
      Math.round(rand(i) * 255), Math.round(rand(i + 1) * 255), Math.round(rand(i + 2) * 255),
    ]);
    expect(recommendColorMode({ colors: colourful, classification: new Uint8Array([2]) }).mode)
      .toBe('rgb');
  });
});

describe('where the decision boundary actually sits', () => {
  /**
   * The three thresholds were chosen, not derived, and the file that motivated
   * them is not in this repository. What can be pinned instead is where the
   * boundary falls, so a reader can compare a real scan's two numbers against
   * it rather than trusting the constants.
   *
   * These also make the constants load-bearing. Moving one without meaning to
   * moves a boundary below, which is the failure a set of hand-picked numbers
   * is otherwise wide open to.
   */

  /** A greyscale cloud whose luminance spans `span` levels around mid grey. */
  function greysSpanning(span: number): Uint8Array {
    return cloud(50_000, (i) => {
      const v = Math.round(128 - span / 2 + (i % (span + 1)));
      return [v, v, v];
    });
  }

  /** A cloud where `fraction` of points carry strong chroma and the rest are flat. */
  function chromaticFraction(fraction: number): Uint8Array {
    const every = Math.max(1, Math.round(1 / fraction));
    return cloud(50_000, (i) => (i % every === 0 ? [200, 40, 40] : [250, 250, 250]));
  }

  it('flips on luminance range within a few levels of the stated floor', () => {
    // Below the floor the greys are a wash; above it they read as shape.
    expect(readRgbReadability(greysSpanning(RGB_LUMINANCE_IQR_FLOOR * 2 - 4)).verdict)
      .toBe('uniform');
    expect(readRgbReadability(greysSpanning(RGB_LUMINANCE_IQR_FLOOR * 2 + 8)).verdict)
      .toBe('readable');
  });

  it('flips on chromatic fraction within a factor of two of the stated floor', () => {
    expect(readRgbReadability(chromaticFraction(RGB_CHROMATIC_FRACTION_FLOOR / 2)).verdict)
      .toBe('uniform');
    expect(readRgbReadability(chromaticFraction(RGB_CHROMATIC_FRACTION_FLOOR * 2)).verdict)
      .toBe('readable');
  });

  it('reports the two numbers a reader can check a real scan against', () => {
    // The verdict is a threshold applied to these, so a scan that lands near a
    // boundary is visible as a figure rather than only as a yes or no.
    const r = readRgbReadability(greysSpanning(6));
    expect(r.luminanceIqr).toBeGreaterThan(0);
    expect(r.chromaticFraction).toBe(0);
    expect(r.sampled).toBeGreaterThan(RGB_MIN_SAMPLE);
  });

  it('calls the reported LA03mapry distribution uniform', () => {
    // The scan that motivated this is not in the repository, so this
    // reconstructs it from what was measured on it: greyscale throughout, mean
    // 242 of 255, and 96 per cent of points near white. If a real file with
    // those statistics did NOT land on `uniform`, the thresholds would be wrong
    // for the only case anyone has actually seen.
    const reconstructed = cloud(200_000, (i) => {
      const nearWhite = i % 100 < 96;
      const v = nearWhite ? 236 + (i % 9) : 200 + (i % 30);
      return [v, v, v];
    });
    const r = readRgbReadability(reconstructed);
    expect(r.chromaticFraction).toBe(0);
    expect(r.verdict).toBe('uniform');
  });
});
