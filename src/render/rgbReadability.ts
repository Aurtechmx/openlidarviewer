/**
 * rgbReadability.ts
 *
 * Whether a cloud's RGB carries enough variation to be worth showing.
 *
 * `cloudSupportsColorMode` asks whether the channel exists. That is the right
 * question for whether a mode can be selected, and the wrong one for what to
 * open a scan in: a survey can carry a full RGB array in which every point is
 * within a few levels of white, and colouring by it produces a blank sheet that
 * reads as a broken render rather than as a scan with no usable colour. One
 * real file measured here was entirely greyscale with a mean of 242 of 255 and
 * 96 per cent of its points near white.
 *
 * The rule is deliberately conservative, because taking true colour away from a
 * scan that has it is the worse error. Colour counts as readable when EITHER
 * enough points carry chroma, OR the greys span a usable range. Only a cloud
 * that fails both is called uniform. A well exposed monochrome scan passes on
 * the second test, and a dim but colourful one passes on the first.
 *
 * Nothing here changes what a user may select. It only changes what a freshly
 * opened scan starts in, and the verdict carries the numbers behind it so the
 * choice can be stated rather than asserted.
 *
 * Pure — no DOM, no three.js — unit-tested in Node.
 */

/** What a cloud's colour array is worth as an opening view. */
export type RgbVerdict = 'readable' | 'uniform' | 'absent';

/** The verdict and the measurements behind it. */
export interface RgbReadability {
  readonly verdict: RgbVerdict;
  /** Points inspected. Zero when the array is absent or empty. */
  readonly sampled: number;
  /**
   * Fraction of sampled points whose channels differ by more than
   * {@link RGB_CHROMA_FLOOR}. Zero for a greyscale cloud.
   */
  readonly chromaticFraction: number;
  /** Interquartile range of sampled luminance, on the 0 to 255 scale. */
  readonly luminanceIqr: number;
}

/**
 * Channel spread, in 8-bit levels, at or below which a point counts as grey.
 *
 * Two levels absorbs the rounding a 16-bit source picks up on the way down to
 * 8-bit without admitting colour that is not there.
 */
export const RGB_CHROMA_FLOOR = 2;

/** Fraction of chromatic points at which colour is worth showing. */
export const RGB_CHROMATIC_FRACTION_FLOOR = 0.02;

/**
 * Luminance interquartile range, in 8-bit levels, at which greys read as shape.
 *
 * Twelve levels is roughly five per cent of the range. Below it the middle half
 * of the cloud sits inside a band too narrow to show relief on screen.
 */
export const RGB_LUMINANCE_IQR_FLOOR = 12;

/**
 * Points below which no verdict of uniform is returned.
 *
 * The measurements are summaries of a distribution, and a handful of points is
 * not one. On thin evidence the answer is `readable`, because the cost of
 * wrongly withholding true colour is higher than the cost of opening a small
 * cloud in a wash the user can see and change.
 */
export const RGB_MIN_SAMPLE = 64;

/** Points inspected at most, so the check stays cheap on a large cloud. */
export const RGB_SAMPLE_TARGET = 20000;

/**
 * Measure a cloud's RGB array.
 *
 * The sample strides across the whole array rather than taking the head of it:
 * point order usually follows acquisition or a spatial sort, so the first
 * twenty thousand points are one corner of the scan and not the scan.
 */
export function readRgbReadability(colors: Uint8Array | undefined): RgbReadability {
  const points = colors ? Math.floor(colors.length / 3) : 0;
  if (points === 0) {
    return { verdict: 'absent', sampled: 0, chromaticFraction: 0, luminanceIqr: 0 };
  }
  const rgb = colors as Uint8Array;

  const stride = Math.max(1, Math.floor(points / RGB_SAMPLE_TARGET));
  const luminance: number[] = [];
  let chromatic = 0;
  for (let p = 0; p < points; p += stride) {
    const i = p * 3;
    const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    if (spread > RGB_CHROMA_FLOOR) chromatic++;
    // Rec. 601 luma: the eye weights green most, and an unweighted mean would
    // call a saturated green and a mid grey the same brightness.
    luminance.push(0.299 * r + 0.587 * g + 0.114 * b);
  }

  const sampled = luminance.length;
  const chromaticFraction = chromatic / sampled;
  const luminanceIqr = interquartileRange(luminance);

  if (sampled < RGB_MIN_SAMPLE) {
    return { verdict: 'readable', sampled, chromaticFraction, luminanceIqr };
  }
  const readable =
    chromaticFraction >= RGB_CHROMATIC_FRACTION_FLOOR ||
    luminanceIqr >= RGB_LUMINANCE_IQR_FLOOR;
  return {
    verdict: readable ? 'readable' : 'uniform',
    sampled,
    chromaticFraction,
    luminanceIqr,
  };
}

/**
 * Distance between the first and third quartiles.
 *
 * The quartiles are nearest-rank, which needs no interpolation rule and is
 * therefore the same number on every platform. A range rather than a variance
 * because one stray black or white point should not decide the verdict.
 */
function interquartileRange(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
  return at(0.75) - at(0.25);
}
