#!/usr/bin/env node
/**
 * lint-palette-lightness.mjs — the default colour ramps must rise in lightness.
 *
 * A ramp that brightens and then darkens encodes two different values at the
 * same luminance. On a sequential quantity like elevation that is a defect, not
 * a preference: the low and high ends become indistinguishable in greyscale, in
 * print, and to a viewer with colour-vision deficiency, and the mid-ramp
 * lightness peak reads as a ridge the terrain does not have. Turbo, the default
 * this gate was written against, reversed lightness on 19 of 63 sampled steps
 * and ended nearly as dark as it began (L* 12 to 24, peaking at 91).
 *
 * The rule is deliberately narrow. It governs only the DEFAULT ramps, because
 * those are what an analyst reads without choosing anything; the catalogue
 * keeps every palette, including the non-monotonic ones, for a reader who picks
 * one on purpose. And it tests monotonicity rather than full perceptual
 * uniformity: uniformity is a stronger property that would need a tolerance
 * argued from a discrimination study, while "never goes backwards" is a
 * property a sequential ramp either has or does not.
 *
 * Reads the palette control points out of `src/render/colorModes.ts` rather
 * than importing them, because the constants are module-private there and a
 * lint that forced them to be exported would change the surface it audits.
 */

import { readFileSync } from 'node:fs';

const SOURCE = 'src/render/colorModes.ts';

/** Sampled points along each ramp. 64 is dense enough to catch a local dip. */
const SAMPLES = 64;

/**
 * How much backwards travel counts as a reversal, in L* units.
 *
 * Not zero: the control points are 8-bit sRGB, so a ramp that is monotonic by
 * construction can still show a fractional dip where two stops round to
 * neighbouring integers. One L* is far below a just-noticeable difference and
 * far above that rounding noise.
 */
const REVERSAL_TOLERANCE = 1.0;

/** The defaults this gate governs, and the constant each is declared in. */
const GOVERNED = [
  { constant: 'DEFAULT_ELEVATION_PALETTE', role: 'elevation' },
  { constant: 'DEFAULT_SCALAR_PALETTE', role: 'scalar' },
];

const src = readFileSync(SOURCE, 'utf8');

/** The palette id a default constant is set to. */
function defaultPaletteId(constant) {
  const m = new RegExp(`export const ${constant}: ElevationPalette = '([a-z]+)'`).exec(src);
  if (!m) throw new Error(`${constant} not found in ${SOURCE}`);
  return m[1];
}

/** The [t, r, g, b] control points of a named palette. */
function controlPoints(id) {
  const marker = `const PALETTE_${id.toUpperCase()}: RampControlPoints = [`;
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`palette stops for '${id}' not found in ${SOURCE}`);
  const body = src.slice(start, src.indexOf('];', start));
  const stops = [...body.matchAll(/\[\s*([\d.]+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]/g)].map(
    (m) => [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])],
  );
  if (stops.length < 2) throw new Error(`palette '${id}' has fewer than two stops`);
  return stops;
}

/** sRGB channel to linear light. */
const toLinear = (u) => {
  const c = u / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** CIE L* (0 black, 100 white) for an sRGB triplet, via relative luminance. */
function lightness(r, g, b) {
  const y = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
}

/** Linearly interpolate the ramp at `t`, matching how the renderer samples it. */
function sampleAt(stops, t) {
  let lo = stops[0];
  let hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) {
      lo = stops[i];
      hi = stops[i + 1];
      break;
    }
  }
  const span = hi[0] - lo[0] || 1;
  const f = (t - lo[0]) / span;
  return [lo[1] + (hi[1] - lo[1]) * f, lo[2] + (hi[2] - lo[2]) * f, lo[3] + (hi[3] - lo[3]) * f];
}

const failures = [];
const report = [];

for (const { constant, role } of GOVERNED) {
  const id = defaultPaletteId(constant);
  const stops = controlPoints(id);
  const profile = [];
  for (let i = 0; i < SAMPLES; i++) {
    const [r, g, b] = sampleAt(stops, i / (SAMPLES - 1));
    profile.push(lightness(r, g, b));
  }

  let reversals = 0;
  let worst = 0;
  for (let i = 1; i < profile.length; i++) {
    const delta = profile[i] - profile[i - 1];
    if (delta < -REVERSAL_TOLERANCE) {
      reversals++;
      worst = Math.min(worst, delta);
    }
  }

  const first = profile[0];
  const last = profile[profile.length - 1];
  const peak = Math.max(...profile);
  report.push(
    `  ${role} default '${id}': L* ${first.toFixed(0)} to ${last.toFixed(0)}, ` +
      `peak ${peak.toFixed(0)}, ${reversals} reversal(s)`,
  );

  if (reversals > 0) {
    failures.push(
      `${constant} is '${id}', which reverses lightness on ${reversals} of ${SAMPLES - 1} steps ` +
        `(worst ${worst.toFixed(1)} L*). A sequential ramp must not brighten and then darken: ` +
        `two different values would share a luminance. Pick a monotonic ramp for the default, ` +
        `or move '${id}' to a palette the reader selects deliberately.`,
    );
  }

  // A ramp can climb the whole way and still waste its range. Reported, not
  // enforced: the floor below which the span is too small to read is a
  // judgement this gate has no measurement to defend.
  if (peak - Math.min(...profile) < 40) {
    report.push(`    note: '${id}' spans under 40 L*, which is little contrast to read a scan by`);
  }
}

if (failures.length > 0) {
  console.error('lint:palette-lightness FAILED');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('lint:palette-lightness OK — default ramps rise monotonically in lightness.');
for (const line of report) console.log(line);
