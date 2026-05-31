/**
 * rgbAutoNormalize.ts
 *
 * Histogram-driven exposure + gamma suggestion for a single cloud's
 * RGB. The analyser walks a sample of the cloud's sRGB Uint8 colours,
 * computes per-channel percentile statistics, and returns a recommended
 * `RgbAppearance` bundle the inspector can apply with one click.
 *
 * Design intent:
 *   - **Non-destructive.** Returns a suggestion. The caller decides
 *     whether to apply it.
 *   - **Transparent.** Returns the diagnostic that drove the
 *     suggestion alongside the bundle so the inspector can show "your
 *     scan looked underexposed at p5=12, p95=180 → exposure 1.18,
 *     gamma 1.05".
 *   - **Gentle.** The corrections are documented per-class and capped
 *     at conservative ratios so a healthy scan barely moves.
 *
 * The classifier looks at the luminance histogram (Rec.709 weights),
 * and assigns one of four classes that drive the bundle:
 *
 *   - "healthy"        — p5 and p95 sit inside a comfortable display
 *                        range. Identity bundle, no correction needed.
 *   - "underexposed"   — both percentiles sit low (e.g. p95 < 0.70).
 *                        Lift exposure + lower gamma slightly.
 *   - "overexposed"    — both percentiles sit high (e.g. p5 > 0.40).
 *                        Cut exposure + raise gamma slightly.
 *   - "low-contrast"   — span p95 − p5 < 0.35. Raise contrast.
 *   - "washed-out"     — chroma variance is low. Raise saturation.
 *
 * Pure data — no DOM, no three.js, unit-tested in Node — so the module
 * ships through the same module-graph seam every Stream A leaf uses.
 */

import { IDENTITY_RGB_APPEARANCE, type RgbAppearance } from './rgbAppearance';

/** Classification the analyser assigns to a cloud's RGB histogram. */
export type ScanColourClass =
  | 'healthy'
  | 'underexposed'
  | 'overexposed'
  | 'low-contrast'
  | 'washed-out';

/** Diagnostic stats the analyser computes. Returned alongside the suggestion. */
export interface RgbAutoNormalizeStats {
  /** Sample count actually examined (may be ≤ length / 3). */
  sampleCount: number;
  /** 5th-percentile luminance in [0, 1]. */
  p5: number;
  /** 50th-percentile luminance in [0, 1]. */
  p50: number;
  /** 95th-percentile luminance in [0, 1]. */
  p95: number;
  /** Chroma standard deviation — a low value reads as washed-out. */
  chromaStdDev: number;
  /** The assigned class. */
  scanClass: ScanColourClass;
  /** A short, user-facing explanation matching the assigned class. */
  reason: string;
}

/** A suggestion the inspector can apply with one click. */
export interface RgbAutoNormalizeSuggestion {
  /** The diagnostic that drove the suggestion. */
  readonly stats: RgbAutoNormalizeStats;
  /** The recommended `RgbAppearance` bundle. */
  readonly settings: Readonly<RgbAppearance>;
}

/** Inputs to `rgbAutoNormalize`. */
export interface RgbAutoNormalizeInput {
  /** Interleaved sRGB Uint8 colours, length 3·N. */
  colorsU8: Uint8Array;
  /**
   * Sampling stride. The analyser walks one point every `stride`,
   * so a stride of 64 gives 1 / 64th of the cloud at ~16 µs per sample.
   * Defaults to a stride that yields ~50 000 samples on the input.
   * Capped to a minimum of 1.
   */
  stride?: number;
}

/** Rec.709 luminance for a normalised sRGB triple. */
function lum709(r: number, g: number, b: number): number {
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

/** Sort + percentile pick on a Float32Array. Mutates `sorted` in place. */
function percentile(sorted: Float32Array, p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * p)));
  return sorted[i];
}

/**
 * Diagnose a cloud's RGB histogram and recommend a gentle correction.
 *
 * Returns `null` only when the input is empty. Otherwise returns a
 * suggestion even for the healthy class — the bundle is identity in
 * that case, and the diagnostic explains why.
 */
export function rgbAutoNormalize(
  input: RgbAutoNormalizeInput,
): RgbAutoNormalizeSuggestion | null {
  const totalPoints = input.colorsU8.length / 3;
  if (totalPoints === 0) return null;
  const targetSamples = 50_000;
  const stride = Math.max(1, input.stride ?? Math.max(1, Math.floor(totalPoints / targetSamples)));

  // First pass — sample luminance + chroma variance.
  const lums: number[] = [];
  let chromaSumSq = 0;
  let chromaCount = 0;
  for (let i = 0; i < totalPoints; i += stride) {
    const r = input.colorsU8[i * 3] / 255;
    const g = input.colorsU8[i * 3 + 1] / 255;
    const b = input.colorsU8[i * 3 + 2] / 255;
    const l = lum709(r, g, b);
    lums.push(l);
    // Chroma — max-channel minus min-channel, a quick saturation proxy.
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    const chroma = maxC - minC;
    chromaSumSq += chroma * chroma;
    chromaCount++;
  }
  if (lums.length === 0) return null;

  const sorted = new Float32Array(lums);
  sorted.sort();
  const p5 = percentile(sorted, 0.05);
  const p50 = percentile(sorted, 0.5);
  const p95 = percentile(sorted, 0.95);
  const chromaMean = chromaCount > 0 ? Math.sqrt(chromaSumSq / chromaCount) : 0;

  // Classify the histogram. The thresholds are conservative — a healthy
  // scan that has been already corrected by the publisher reads as
  // "healthy" and no further correction is applied.
  let scanClass: ScanColourClass = 'healthy';
  let reason = `Histogram healthy (p5=${p5.toFixed(2)}, p95=${p95.toFixed(2)}). No correction needed.`;
  let settings: RgbAppearance = { ...IDENTITY_RGB_APPEARANCE } as RgbAppearance;

  if (p95 < 0.70 && p50 < 0.45) {
    scanClass = 'underexposed';
    // Lift the brightest tones to about 0.80, with a small gamma assist.
    const exposure = Math.min(1.6, 0.80 / Math.max(0.01, p95));
    settings = {
      exposure,
      contrast: 1.05,
      saturation: 1.05,
      gamma: 1.1,
      temperature: 0,
      tint: 0,
    };
    reason = `Underexposed (p5=${p5.toFixed(2)}, p95=${p95.toFixed(2)}). Suggested exposure ${exposure.toFixed(2)}, gamma 1.10.`;
  } else if (p5 > 0.40 && p50 > 0.60) {
    scanClass = 'overexposed';
    // Pull the darkest tones back toward 0.15 and add a steeper gamma.
    const exposure = Math.max(0.6, 0.15 / Math.max(0.01, p5));
    settings = {
      exposure,
      contrast: 1.0,
      saturation: 0.95,
      gamma: 0.9,
      temperature: 0,
      tint: 0,
    };
    reason = `Overexposed (p5=${p5.toFixed(2)}, p95=${p95.toFixed(2)}). Suggested exposure ${exposure.toFixed(2)}, gamma 0.90.`;
  } else if (p95 - p5 < 0.35) {
    scanClass = 'low-contrast';
    // Spread the range — bump contrast and a hint of saturation.
    settings = {
      exposure: 1.0,
      contrast: 1.30,
      saturation: 1.05,
      gamma: 1.0,
      temperature: 0,
      tint: 0,
    };
    reason = `Low contrast (span ${(p95 - p5).toFixed(2)}). Suggested contrast 1.30.`;
  } else if (chromaMean < 0.12) {
    scanClass = 'washed-out';
    settings = {
      exposure: 1.0,
      contrast: 1.05,
      saturation: 1.30,
      gamma: 1.0,
      temperature: 0,
      tint: 0,
    };
    reason = `Washed-out chroma (σ=${chromaMean.toFixed(2)}). Suggested saturation 1.30.`;
  }

  return {
    stats: {
      sampleCount: lums.length,
      p5,
      p50,
      p95,
      chromaStdDev: chromaMean,
      scanClass,
      reason,
    },
    settings,
  };
}
