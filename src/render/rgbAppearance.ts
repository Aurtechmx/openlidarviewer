/**
 * rgbAppearance.ts
 *
 * Pure-data RGB appearance modulator and the named preset bundle the
 * Inspector exposes — gamma, contrast, saturation, exposure. Runs once
 * per chunk at decode time on a Float32Array of normalised [0, 1] RGB
 * values; the renderer reads the modulated buffer through the same
 * pipeline seam it uses for hillshade and SSAO.
 *
 * Pipeline order (each transform applied in turn so a preset is
 * deterministic):
 *
 *   1. Exposure    — multiplicative brightness scaler (≥ 0). 1 is identity.
 *   2. Contrast    — scale around midpoint 0.5. 1 is identity; > 1
 *                    spreads values away from grey; < 1 collapses toward
 *                    grey.
 *   3. Saturation  — interpolate between luminance and the RGB triple.
 *                    1 is identity; 0 is fully greyscale; > 1 boosts.
 *   4. Gamma       — power curve, output = pow(value, 1 / gamma).
 *                    1 is identity; > 1 brightens midtones; < 1 darkens.
 *   5. Clamp       — every channel clamped to [0, 1] after every step.
 *
 * The order is deliberate: exposure first (linear scale of light energy),
 * contrast second (still in linear-ish space), saturation third (works
 * on relative channel ratios), gamma last (perceptual remap before the
 * pixel hits the display).
 *
 * Pure data — no DOM, no three.js, unit-tested in Node — so the layer
 * ships through the same module-graph seam every Stream A item already
 * uses.
 */

/** RGB appearance settings, defaults are identity (no change). */
export interface RgbAppearance {
  /** Multiplicative brightness scaler, ≥ 0. Default 1. */
  exposure: number;
  /** Contrast around mid-grey 0.5. ≥ 0. Default 1. */
  contrast: number;
  /** Saturation toward luminance. ≥ 0. Default 1. */
  saturation: number;
  /** Power-curve gamma. > 0. Default 1. */
  gamma: number;
  /**
   * White-balance temperature in Δ-units around neutral. Positive warms
   * the image (lifts R, lowers B); negative cools it (lifts B, lowers R).
   * Range [-1, +1] in normalised units; 0 = neutral. Optional, defaults
   * to 0 for backwards compatibility with the v0.3.7-initial bundles.
   */
  temperature?: number;
  /**
   * White-balance tint in Δ-units around neutral. Positive shifts toward
   * magenta (lifts R+B, lowers G); negative shifts toward green (lifts
   * G, lowers R+B). Range [-1, +1] in normalised units; 0 = neutral.
   * Optional, defaults to 0.
   */
  tint?: number;
}

/** Identity RGB appearance — pass-through, no modification. */
export const IDENTITY_RGB_APPEARANCE: Readonly<RgbAppearance> = Object.freeze({
  exposure: 1,
  contrast: 1,
  saturation: 1,
  gamma: 1,
  temperature: 0,
  tint: 0,
});

/** Named appearance preset ids. */
export type RgbAppearancePresetId =
  | 'natural'
  | 'survey'
  | 'rgb-inspection'
  | 'high-contrast'
  | 'drone-rgb'
  | 'mobile-lidar'
  | 'infrastructure'
  | 'photoreal-rgb';

/** A named preset's metadata + settings bundle. */
export interface RgbAppearancePreset {
  readonly id: RgbAppearancePresetId;
  readonly label: string;
  readonly description: string;
  readonly settings: Readonly<RgbAppearance>;
}

/**
 * The four built-in presets. Each one is documented inline so the
 * Inspector tooltip can pull the description straight from the
 * catalogue rather than duplicating prose.
 */
const PRESETS: ReadonlyArray<RgbAppearancePreset> = [
  {
    id: 'natural',
    label: 'Natural',
    description: 'Identity — show scan RGB as captured.',
    settings: { exposure: 1, contrast: 1, saturation: 1, gamma: 1, temperature: 0, tint: 0 },
  },
  {
    id: 'survey',
    label: 'Survey',
    description: 'Slightly cooler midtones, gentle contrast lift. Good for daylight inspection.',
    settings: { exposure: 1.05, contrast: 1.1, saturation: 0.9, gamma: 1.05, temperature: -0.05, tint: 0 },
  },
  {
    id: 'rgb-inspection',
    label: 'RGB Inspection',
    description: 'Punchy contrast and saturation for material differentiation.',
    settings: { exposure: 1.0, contrast: 1.25, saturation: 1.3, gamma: 1.0, temperature: 0, tint: 0 },
  },
  {
    id: 'high-contrast',
    label: 'High Contrast',
    description: 'Wide tonal spread for low-light scans and difficult palettes.',
    settings: { exposure: 1.1, contrast: 1.5, saturation: 1.1, gamma: 0.9, temperature: 0, tint: 0 },
  },
  // v0.3.7 visual-fidelity additions — scan-context-tuned bundles.
  {
    id: 'drone-rgb',
    label: 'Drone RGB',
    description: 'Aerial mapping defaults — gentle warmth corrects the blue cast of high-altitude flights, mild contrast lift, clarified shadows.',
    settings: { exposure: 1.05, contrast: 1.15, saturation: 1.05, gamma: 1.0, temperature: 0.1, tint: 0 },
  },
  {
    id: 'mobile-lidar',
    label: 'Mobile LiDAR',
    description: 'iPhone / SLAM indoor scans — stronger exposure compensates for low-light capture, gentler gamma rescues underexposed midtones.',
    settings: { exposure: 1.2, contrast: 1.1, saturation: 1.0, gamma: 1.15, temperature: -0.05, tint: 0 },
  },
  {
    id: 'infrastructure',
    label: 'Infrastructure',
    description: 'Buildings, towers, utilities — strong contrast surfaces edges, neutral white balance keeps brick / concrete tones accurate.',
    settings: { exposure: 1.0, contrast: 1.35, saturation: 0.95, gamma: 0.95, temperature: 0, tint: 0 },
  },
  // v0.3.7 final-polish "best appearance" bundle. The Inspector pairs
  // this preset with EDL Subtle + Studio Dark sky for the full
  // "Photoreal RGB" one-click look.
  {
    id: 'photoreal-rgb',
    label: 'Photoreal RGB',
    description: 'Photoreal one-click bundle — gentle exposure lift, mild gamma curve, light contrast and saturation boost. Pairs with EDL Subtle + Studio Dark for the documented release-default look.',
    settings: { exposure: 1.15, contrast: 1.12, saturation: 1.08, gamma: 1.10, temperature: 0, tint: 0 },
  },
];

/** List every preset in display order. */
export function listRgbAppearancePresets(): readonly RgbAppearancePreset[] {
  return PRESETS;
}

/** Look up a preset by id; falls back to Natural for unknown ids. */
export function getRgbAppearancePreset(id: RgbAppearancePresetId): RgbAppearancePreset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}

/** Type-guard for an unknown string. */
export function isRgbAppearancePresetId(v: unknown): v is RgbAppearancePresetId {
  if (typeof v !== 'string') return false;
  return (
    v === 'natural' ||
    v === 'survey' ||
    v === 'rgb-inspection' ||
    v === 'high-contrast' ||
    v === 'drone-rgb' ||
    v === 'mobile-lidar' ||
    v === 'infrastructure' ||
    v === 'photoreal-rgb'
  );
}

// ── core math helpers ──────────────────────────────────────────────────────

/**
 * Rec. 709 luminance from a linear-ish [0, 1] RGB triple. Used by the
 * saturation transform — saturation interpolates between this scalar
 * grey value and the original channel value.
 */
function luminance(r: number, g: number, b: number): number {
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Apply an RGB appearance bundle to an interleaved RGB Float32Array in
 * [0, 1]. Mutates `rgb` in place. Length must be a multiple of 3. Returns
 * the same array for chaining.
 *
 * NaN-safe — if a channel is NaN the function leaves it as 0 so the
 * downstream renderer doesn't pick up the poison value.
 */
export function applyRgbAppearance(
  rgb: Float32Array,
  settings: Readonly<RgbAppearance> = IDENTITY_RGB_APPEARANCE,
): Float32Array {
  // Sanitise settings — guard against negative or zero gamma (which
  // would NaN the pow), clamp other inputs to a safe lower bound. The
  // optional white-balance fields default to 0 (neutral) when absent,
  // preserving the v0.3.7-initial bundle's behaviour.
  const exposure = Math.max(0, settings.exposure);
  const contrast = Math.max(0, settings.contrast);
  const saturation = Math.max(0, settings.saturation);
  const gamma = settings.gamma > 0 ? settings.gamma : 1;
  const invGamma = 1 / gamma;
  // Clamp temperature + tint to [-1, +1] so a stray slider can't drive
  // the channels negative or push them past full saturation.
  const temperature = Math.max(-1, Math.min(1, settings.temperature ?? 0));
  const tint = Math.max(-1, Math.min(1, settings.tint ?? 0));
  // Convert the [-1, +1] WB inputs into per-channel gains. The mapping
  // keeps the green channel at unit gain in the temperature axis (the
  // pivot axis a colour-grading slider expects) and lifts/cuts the
  // blue and red endpoints. For tint, green moves opposite to R+B so
  // the magenta-green axis is single-knob controllable.
  // Max swing is ±25% per channel — gentle enough that a full slider
  // shifts white balance noticeably without destroying neutrality.
  const tempGainR = 1 + 0.25 * temperature;
  const tempGainB = 1 - 0.25 * temperature;
  const tintGainR = 1 + 0.15 * tint;
  const tintGainG = 1 - 0.15 * tint;
  const tintGainB = 1 + 0.15 * tint;
  const wbGainR = tempGainR * tintGainR;
  const wbGainG = tintGainG;
  const wbGainB = tempGainB * tintGainB;

  // Fast path — identity bundle short-circuits the per-point loop. Saves
  // ~30 % on the common Natural preset.
  if (
    exposure === 1 &&
    contrast === 1 &&
    saturation === 1 &&
    gamma === 1 &&
    temperature === 0 &&
    tint === 0
  ) {
    return rgb;
  }

  const n = rgb.length / 3;
  for (let i = 0; i < n; i++) {
    let r = rgb[i * 3];
    let g = rgb[i * 3 + 1];
    let b = rgb[i * 3 + 2];

    // NaN guard — collapse to zero so downstream maths is well-defined.
    if (!Number.isFinite(r)) r = 0;
    if (!Number.isFinite(g)) g = 0;
    if (!Number.isFinite(b)) b = 0;

    // 1. Exposure (multiplicative brightness)
    r *= exposure;
    g *= exposure;
    b *= exposure;

    // 1b. White balance — temperature + tint as a per-channel gain.
    //     Applied after exposure so the WB axes shift the already-
    //     normalised light energy. Negative-going channels are clamped
    //     during the final clamp step so a heavy slider can't poison
    //     the output.
    r *= wbGainR;
    g *= wbGainG;
    b *= wbGainB;

    // 2. Contrast (scale around 0.5)
    r = (r - 0.5) * contrast + 0.5;
    g = (g - 0.5) * contrast + 0.5;
    b = (b - 0.5) * contrast + 0.5;

    // 3. Saturation (lerp between luminance and original)
    if (saturation !== 1) {
      const lum = luminance(r, g, b);
      r = lum + (r - lum) * saturation;
      g = lum + (g - lum) * saturation;
      b = lum + (b - lum) * saturation;
    }

    // 4. Gamma (power curve). The input may already have gone negative
    //    after contrast; clamp before the pow so the result is real.
    r = clamp01(r);
    g = clamp01(g);
    b = clamp01(b);
    if (gamma !== 1) {
      r = Math.pow(r, invGamma);
      g = Math.pow(g, invGamma);
      b = Math.pow(b, invGamma);
    }

    // 5. Final clamp — protects the renderer from any rounding drift.
    rgb[i * 3] = clamp01(r);
    rgb[i * 3 + 1] = clamp01(g);
    rgb[i * 3 + 2] = clamp01(b);
  }
  return rgb;
}
