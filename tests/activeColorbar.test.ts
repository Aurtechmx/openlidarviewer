/**
 * activeColorbar.test.ts
 *
 * Pins the shared colorbar spec-builder — the SINGLE source both legend
 * consumers (the live on-screen overlay and the snapshot burn-in) read, so
 * the values burned into a figure can never disagree with the values shown
 * on screen. The per-mode rules matter scientifically:
 *
 *   - elevation carries a unit ONLY when the CRS declares one (honesty rule:
 *     an unknown unit shows NO suffix, never a guessed "m"), and discloses
 *     the percentile-trimmed window when trim is active;
 *   - intensity is a GRAYSCALE ramp because that is exactly how the points
 *     are painted (`colorByIntensity` without a palette) — a colour ramp on
 *     the legend would disagree with the pixels it labels;
 *   - gpsTime is normalised to seconds-from-window-start (absolute GPS
 *     times are ~3e8 s; raw ticks would be unreadable and the ramp already
 *     normalises against the cloud window) and says so;
 *   - the categorical / non-scalar modes produce NO colorbar at all —
 *     a continuous ramp legend on categorical data would invent an ordering.
 *
 * Also pins the pure burn-in layout math the snapshot path rasterises with.
 */

import { describe, it, expect } from 'vitest';
import {
  buildActiveColorbarSpec,
  burnInColorbarLayout,
  type ActiveColorbarSource,
} from '../src/render/activeColorbar';
import type { ColorMode } from '../src/render/colorModes';

function src(overrides: Partial<ActiveColorbarSource> & { mode: ColorMode }): ActiveColorbarSource {
  return { range: { min: 0, max: 100 }, ...overrides };
}

describe('buildActiveColorbarSpec — elevation', () => {
  it('builds a Turbo-ramp spec with the CRS unit when the unit is known', () => {
    const bar = buildActiveColorbarSpec(
      src({ mode: 'elevation', range: { min: 12.5, max: 87.5 }, elevationUnit: 'm' }),
    );
    expect(bar).not.toBeNull();
    expect(bar!.mode).toBe('elevation');
    // The live elevation colouring always uses the default elevation ramp
    // (colorByElevation's default palette) — the legend must sample the same.
    expect(bar!.spec.palette).toBe('turbo');
    expect(bar!.spec.label).toBe('Elevation');
    expect(bar!.spec.unit).toBe('m');
    expect(bar!.spec.min).toBe(12.5);
    expect(bar!.spec.max).toBe(87.5);
  });

  it('omits the unit entirely when the CRS unit is unknown (honesty rule)', () => {
    const bar = buildActiveColorbarSpec(
      src({ mode: 'elevation', elevationUnit: null }),
    );
    expect(bar!.spec.unit).toBeUndefined();
  });

  it('discloses the percentile-trimmed window when trim is active', () => {
    const bar = buildActiveColorbarSpec(
      src({ mode: 'elevation', trimPercent: 5, elevationUnit: 'ft' }),
    );
    expect(bar!.note).toContain('p5–p95');
  });

  it('carries no window note when trim is zero (true min/max shown)', () => {
    const bar = buildActiveColorbarSpec(
      src({ mode: 'elevation', trimPercent: 0 }),
    );
    expect(bar!.note).toBeUndefined();
  });

  it('reflects a non-default trim honestly (p10–p90)', () => {
    const bar = buildActiveColorbarSpec(src({ mode: 'elevation', trimPercent: 10 }));
    expect(bar!.note).toContain('p10–p90');
  });
});

describe('buildActiveColorbarSpec — intensity', () => {
  it('uses a grayscale ramp (matching colorByIntensity) and never a unit', () => {
    const bar = buildActiveColorbarSpec(
      src({ mode: 'intensity', range: { min: 0, max: 65535 }, elevationUnit: 'm' }),
    );
    expect(bar).not.toBeNull();
    // Intensity DN values have no physical unit the app can vouch for, and
    // the points are painted grayscale — the legend must mirror both facts.
    expect(bar!.spec.palette).toBe('grayscale');
    expect(bar!.spec.unit).toBeUndefined();
    expect(bar!.spec.label).toBe('Intensity');
    expect(bar!.spec.min).toBe(0);
    expect(bar!.spec.max).toBe(65535);
  });
});

describe('buildActiveColorbarSpec — gpsTime', () => {
  it('normalises to seconds-from-window-start and says so', () => {
    // Absolute GPS adjusted standard time — ~3e8 s. Raw ticks are unreadable
    // and the colour pass normalises against the window anyway.
    const bar = buildActiveColorbarSpec(
      src({
        mode: 'gpsTime',
        range: { min: 300_000_000.25, max: 300_000_480.75 },
        trimPercent: 5,
      }),
    );
    expect(bar).not.toBeNull();
    expect(bar!.spec.min).toBe(0);
    expect(bar!.spec.max).toBeCloseTo(480.5, 6);
    expect(bar!.spec.unit).toBe('s');
    expect(bar!.spec.label).toBe('GPS time');
    // The scalar modes ride the CVD-safe default scalar ramp.
    expect(bar!.spec.palette).toBe('cividis');
    expect(bar!.note).toContain('window start');
    expect(bar!.note).toContain('p5–p95');
  });
});

describe('buildActiveColorbarSpec — returnNumber', () => {
  it('shows the raw ordinal range on the scalar ramp with no unit', () => {
    const bar = buildActiveColorbarSpec(
      src({ mode: 'returnNumber', range: { min: 1, max: 5 } }),
    );
    expect(bar).not.toBeNull();
    expect(bar!.spec.palette).toBe('cividis');
    expect(bar!.spec.label).toBe('Return number');
    expect(bar!.spec.unit).toBeUndefined();
    expect(bar!.spec.min).toBe(1);
    expect(bar!.spec.max).toBe(5);
    expect(bar!.note).toBeUndefined();
  });
});

describe('buildActiveColorbarSpec — modes without a colorbar', () => {
  const noBarModes: ColorMode[] = [
    'rgb',
    'classification',
    'normal',
    'density',
    'coverage',
    'confidence',
  ];
  for (const mode of noBarModes) {
    it(`returns null for '${mode}' (categorical / non-global-scalar)`, () => {
      expect(buildActiveColorbarSpec(src({ mode }))).toBeNull();
    });
  }
});

describe('buildActiveColorbarSpec — degenerate ranges', () => {
  it('returns null when no range is available', () => {
    expect(buildActiveColorbarSpec(src({ mode: 'elevation', range: null }))).toBeNull();
  });

  it('returns null for a flat range (min === max) — a one-colour bar labels nothing', () => {
    expect(
      buildActiveColorbarSpec(src({ mode: 'elevation', range: { min: 5, max: 5 } })),
    ).toBeNull();
  });

  it('returns null for a non-finite range (poisoned data must not render)', () => {
    expect(
      buildActiveColorbarSpec(
        src({ mode: 'intensity', range: { min: 0, max: Number.NaN } }),
      ),
    ).toBeNull();
    expect(
      buildActiveColorbarSpec(
        src({ mode: 'intensity', range: { min: Number.NEGATIVE_INFINITY, max: 1 } }),
      ),
    ).toBeNull();
  });
});

describe('burnInColorbarLayout', () => {
  it('anchors the bar to the right edge inside the padding', () => {
    const L = burnInColorbarLayout(1920, 1080);
    expect(L.barX + L.barWidth + L.pad).toBe(1920);
    expect(L.barX).toBeGreaterThan(0);
  });

  it('centres the bar vertically and keeps it inside the canvas', () => {
    const L = burnInColorbarLayout(1920, 1080);
    expect(L.barY).toBeGreaterThanOrEqual(0);
    expect(L.barY + L.barHeight).toBeLessThanOrEqual(1080);
    // Vertical centring to within a pixel of rounding.
    expect(Math.abs(L.barY - (1080 - (L.barY + L.barHeight)))).toBeLessThanOrEqual(1);
  });

  it('scales with output height so a 4× supersampled export reads the same', () => {
    const one = burnInColorbarLayout(1920, 1080);
    const four = burnInColorbarLayout(1920 * 4, 1080 * 4);
    // Proportional within rounding — the ratio of every metric ≈ 4.
    expect(four.barHeight / one.barHeight).toBeGreaterThan(3.5);
    expect(four.barHeight / one.barHeight).toBeLessThan(4.5);
    expect(four.fontSize / one.fontSize).toBeGreaterThan(3.5);
    expect(four.barWidth / one.barWidth).toBeGreaterThan(3.5);
  });

  it('never overflows a small canvas', () => {
    const L = burnInColorbarLayout(320, 200);
    expect(L.barY).toBeGreaterThanOrEqual(0);
    expect(L.barY + L.barHeight).toBeLessThanOrEqual(200);
    expect(L.barX).toBeGreaterThanOrEqual(0);
  });

  it('enforces legibility floors at 1× resolution', () => {
    const L = burnInColorbarLayout(1280, 720);
    expect(L.fontSize).toBeGreaterThanOrEqual(11);
    expect(L.barWidth).toBeGreaterThanOrEqual(10);
    expect(L.pad).toBeGreaterThanOrEqual(12);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// rampRangeForMode — the range colorForMode actually paints with
// ────────────────────────────────────────────────────────────────────────────
import { rampRangeForMode, colorForMode, colorByIntensity, colorByScalar } from '../src/render/colorModes';
import { PointCloud } from '../src/model/PointCloud';

function makeScalarCloud(): PointCloud {
  return new PointCloud({
    positions: new Float32Array([0, 0, 0, 1, 0, 10, 2, 0, 20, 3, 0, 30]),
    intensity: new Uint16Array([7, 100, 200, 900]),
    returnNumber: new Uint8Array([1, 2, 2, 5]),
    gpsTime: new Float64Array([300_000_000, 300_000_100, 300_000_200, 300_000_400]),
    origin: [0, 0, 0],
    sourceFormat: 'las',
    name: 'scalars.las',
  });
}

describe('rampRangeForMode — single source with colorForMode', () => {
  it('intensity: raw finite min/max, and the colours prove it', () => {
    const cloud = makeScalarCloud();
    const r = rampRangeForMode('intensity', cloud);
    expect(r).toEqual({ min: 7, max: 900 });
    // colorForMode must paint against exactly this window: recomputing the
    // colours with the reported range is byte-identical.
    expect(colorForMode('intensity', cloud)).toEqual(
      colorByIntensity(cloud.intensity!, cloud.pointCount, r!.min, r!.max),
    );
  });

  it('returnNumber: raw finite min/max (deliberately unclipped ordinals)', () => {
    const cloud = makeScalarCloud();
    const r = rampRangeForMode('returnNumber', cloud);
    expect(r).toEqual({ min: 1, max: 5 });
    expect(colorForMode('returnNumber', cloud)).toEqual(
      colorByScalar(cloud.returnNumber!, cloud.pointCount, r!.min, r!.max),
    );
  });

  it('gpsTime: the percentile-clipped window colorForMode ramps across', () => {
    const cloud = makeScalarCloud();
    const r = rampRangeForMode('gpsTime', cloud);
    expect(r).not.toBeNull();
    expect(colorForMode('gpsTime', cloud)).toEqual(
      colorByScalar(cloud.gpsTime!, cloud.pointCount, r!.min, r!.max),
    );
  });

  it('elevation: honours the percentile trim + up-axis options', () => {
    const cloud = makeScalarCloud();
    const trimmed = rampRangeForMode('elevation', cloud, { heightPercentileTrim: 25 });
    const raw = rampRangeForMode('elevation', cloud, { heightPercentileTrim: 0 });
    expect(raw).toEqual({ min: 0, max: 30 });
    expect(trimmed!.min).toBeGreaterThanOrEqual(raw!.min);
    expect(trimmed!.max).toBeLessThanOrEqual(raw!.max);
  });

  it('returns null when the mode has no ramp range (missing attribute or categorical)', () => {
    const bare = new PointCloud({
      positions: new Float32Array([0, 0, 0, 1, 1, 1]),
      origin: [0, 0, 0],
      sourceFormat: 'obj',
      name: 'bare.obj',
    });
    expect(rampRangeForMode('intensity', bare)).toBeNull();
    expect(rampRangeForMode('gpsTime', bare)).toBeNull();
    expect(rampRangeForMode('returnNumber', bare)).toBeNull();
    expect(rampRangeForMode('rgb', makeScalarCloud())).toBeNull();
    expect(rampRangeForMode('classification', makeScalarCloud())).toBeNull();
  });
});
