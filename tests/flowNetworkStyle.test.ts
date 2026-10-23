/**
 * flowNetworkStyle.test.ts — the drainage-network style (in flowOverlayGeometry.ts) shared by the 3D
 * overlay, the Lab grid and its particles: the channel threshold, the link
 * widths, and the water colour ramp's stops.
 */
import { describe, expect, it } from 'vitest';

import {
  FLOW_CHANNEL_THRESHOLD,
  FLOW_RIBBON_MAX_WIDTH_CELLS,
  FLOW_RIBBON_MIN_WIDTH_CELLS,
  WATER_RAMP_STOPS,
  channelMinCount,
  channelStrength,
  isChannel,
  ribbonWidthCells,
  waterRampColor,
  widthForStrength,
  logScale,
} from '../src/render/flowOverlayGeometry';
import { rgbToLab, simulateCvd, type Deficiency } from '../src/ui/fieldSimulation/labColormaps';

describe('channel threshold', () => {
  it('is 0.4 of the log scale, inclusive', () => {
    expect(FLOW_CHANNEL_THRESHOLD).toBe(0.4);
    expect(isChannel(0.4)).toBe(true);
    expect(isChannel(0.3999)).toBe(false);
    expect(isChannel(1)).toBe(true);
  });

  it('maps the drawn range onto strength 0..1', () => {
    expect(channelStrength(FLOW_CHANNEL_THRESHOLD)).toBe(0);
    expect(channelStrength(1)).toBe(1);
    expect(channelStrength(0.1)).toBe(0);
    expect(channelStrength(0.7)).toBeCloseTo(0.5, 9);
  });

  it('names the smallest whole count drawn as a line', () => {
    for (const max of [2, 10, 77, 3629, 100000]) {
      const m = channelMinCount(max);
      expect(logScale(m, max)).toBeGreaterThanOrEqual(FLOW_CHANNEL_THRESHOLD);
      if (m > 1) expect(logScale(m - 1, max)).toBeLessThan(FLOW_CHANNEL_THRESHOLD);
    }
    expect(channelMinCount(1)).toBe(1);
    expect(channelMinCount(3629)).toBe(26);
  });
});

describe('ribbon widths', () => {
  it('run from a thin rill at the threshold to a wide trunk at the maximum', () => {
    expect(FLOW_RIBBON_MIN_WIDTH_CELLS).toBe(0.25);
    expect(FLOW_RIBBON_MAX_WIDTH_CELLS).toBe(1.1);
    expect(ribbonWidthCells(FLOW_CHANNEL_THRESHOLD)).toBeCloseTo(0.25, 9);
    expect(ribbonWidthCells(1)).toBeCloseTo(1.1, 9);
    expect(ribbonWidthCells(0.7)).toBeCloseTo(0.675, 9);
  });

  it('rise monotonically and stay within bounds', () => {
    let last = 0;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const w = ribbonWidthCells(t);
      expect(w).toBeGreaterThanOrEqual(last);
      expect(w).toBeGreaterThanOrEqual(0.25);
      expect(w).toBeLessThanOrEqual(1.1);
      last = w;
    }
    expect(widthForStrength(-1)).toBe(0.25);
    expect(widthForStrength(2)).toBe(1.1);
  });
});

describe('water ramp', () => {
  it('has the documented stops: deep blue, blue, cyan, near white', () => {
    expect(WATER_RAMP_STOPS.map((s) => s.t)).toEqual([0, 0.4, 0.75, 1]);
    for (const s of WATER_RAMP_STOPS) expect(waterRampColor(s.t)).toEqual(s.rgb);
    const [r0, g0, b0] = waterRampColor(0);
    expect(b0).toBeGreaterThan(r0 + 60); // blue-dominant at the low end
    expect(b0).toBeGreaterThan(g0 + 60);
    const top = waterRampColor(1);
    expect(Math.min(...top)).toBeGreaterThan(220); // near white at the trunk
  });

  it('clamps out-of-range and non-finite input', () => {
    expect(waterRampColor(-1)).toEqual(WATER_RAMP_STOPS[0]!.rgb);
    expect(waterRampColor(5)).toEqual(WATER_RAMP_STOPS[3]!.rgb);
    expect(waterRampColor(Number.NaN)).toEqual(WATER_RAMP_STOPS[0]!.rgb);
  });

  it('rises in CIELAB lightness at every step, including under colour-vision deficiencies', () => {
    const samples = Array.from({ length: 21 }, (_, k) => waterRampColor(k / 20));
    const views: Array<(c: readonly [number, number, number]) => readonly [number, number, number]> = [
      (c) => c,
      ...(['protan', 'deutan', 'tritan'] as Deficiency[]).map((d) => (c: readonly [number, number, number]) => simulateCvd(c, d)),
    ];
    for (const view of views) {
      const L = samples.map((c) => rgbToLab(view(c))[0]);
      for (let k = 1; k < L.length; k++) expect(L[k]!).toBeGreaterThan(L[k - 1]!);
    }
  });
});
