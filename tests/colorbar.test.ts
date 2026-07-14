/**
 * colorbar.test.ts
 *
 * Pins the pure colorbar/legend generator: nice ticks, ramp-matched stops, and
 * a self-contained, XML-safe SVG. A colorbar that disagreed with the on-screen
 * ramp — or that broke on an odd field name — would undermine every figure it
 * labels, so both are checked here.
 */

import { describe, it, expect } from 'vitest';
import { colorbarStops, niceTicks, buildColorbarSvg } from '../src/render/colorbar';
import { elevationRampColor } from '../src/render/colorModes';

describe('niceTicks', () => {
  it('produces round 1/2/5 ticks spanning the range', () => {
    expect(niceTicks(0, 100, 5)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(0, 10, 5)).toEqual([0, 2, 4, 6, 8, 10]);
  });

  it('handles negative and fractional ranges without FP dust', () => {
    expect(niceTicks(-10, 10, 4)).toEqual([-10, -5, 0, 5, 10]);
    // 0 is snapped exactly (no -0 or 1e-15).
    expect(niceTicks(-1, 1, 4).includes(0)).toBe(true);
  });

  it('degenerates safely for a flat or non-finite range', () => {
    expect(niceTicks(5, 5)).toEqual([5]);
    expect(niceTicks(Number.NaN, 10)).toEqual([]);
  });
});

describe('colorbarStops', () => {
  it('samples the ramp inclusively from 0 to 1', () => {
    const stops = colorbarStops('cividis', 8);
    expect(stops).toHaveLength(8);
    expect(stops[0].t).toBe(0);
    expect(stops[stops.length - 1].t).toBe(1);
  });

  it('matches the SAME ramp the points use (legend can never disagree)', () => {
    const stops = colorbarStops('viridis', 5);
    for (const s of stops) {
      expect(s.rgb).toEqual(elevationRampColor(s.t, 'viridis'));
    }
  });
});

describe('buildColorbarSvg', () => {
  it('emits a self-contained SVG with a gradient, title, unit and tick labels', () => {
    const svg = buildColorbarSvg({ palette: 'cividis', min: 0, max: 100, label: 'Elevation', unit: 'm' });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('linearGradient');
    expect(svg).toContain('Elevation m');
    expect(svg).toContain('>100<'); // a tick label
    expect(svg).toContain('stop-color="rgb(');
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
  });

  it('supports a horizontal orientation', () => {
    const svg = buildColorbarSvg({ palette: 'turbo', min: 0, max: 1, label: 'Intensity', orientation: 'horizontal' });
    expect(svg).toContain('x2="100%" y2="0%"'); // horizontal gradient
    expect(svg).toContain('Intensity');
  });

  it('XML-escapes the field label so an odd name can never break the SVG', () => {
    const svg = buildColorbarSvg({ palette: 'inferno', min: 0, max: 1, label: 'a<b>&"c' });
    expect(svg).toContain('a&lt;b&gt;&amp;&quot;c');
    expect(svg).not.toContain('<b>');
  });
});

describe('grayscale ramp (intensity legend)', () => {
  // The live intensity colouring is GRAYSCALE (`colorByIntensity` without a
  // palette maps t → round(t·255) on all three channels). The legend must
  // sample the same mapping, or it would label pixels with colours the
  // renderer never painted.
  it('colorbarStops("grayscale") mirrors colorByIntensity exactly', () => {
    const stops = colorbarStops('grayscale', 9);
    expect(stops).toHaveLength(9);
    for (const s of stops) {
      const grey = Math.round(s.t * 255);
      expect(s.rgb).toEqual([grey, grey, grey]);
    }
  });

  it('buildColorbarSvg renders a grayscale gradient', () => {
    const svg = buildColorbarSvg({ palette: 'grayscale', min: 0, max: 65535, label: 'Intensity' });
    expect(svg).toContain('stop-color="rgb(0,0,0)"');
    expect(svg).toContain('stop-color="rgb(255,255,255)"');
    // No unit was given, so no suffix may appear after the label.
    expect(svg).toContain('>Intensity</text>');
  });
});
