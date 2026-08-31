/**
 * hypsometricPalette.test.ts — sampling a named perceptual ramp into the
 * hypsometric stop list the surface renderer consumes.
 */

import { describe, it, expect } from 'vitest';
import { builtinHypsometricStops } from '../src/render/hypsometricPalette';
import { elevationRampColor } from '../src/render/colorModes';
import { hypsometricColor } from '../src/terrain/contour/hypsometric';

describe('builtinHypsometricStops', () => {
  it('spans t ∈ [0,1] inclusive with the requested number of stops', () => {
    const stops = builtinHypsometricStops('cividis', 5);
    expect(stops).toHaveLength(5);
    expect(stops[0].t).toBe(0);
    expect(stops.at(-1)!.t).toBe(1);
    expect(stops.map((s) => s.t)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it('samples the same colours the point cloud uses for that ramp', () => {
    const stops = builtinHypsometricStops('viridis', 3);
    for (const s of stops) {
      const [r, g, b] = elevationRampColor(s.t, 'viridis');
      expect(s.color).toEqual({ r, g, b });
    }
  });

  it('produces a ramp the surface renderer accepts end to end', () => {
    const stops = builtinHypsometricStops('inferno');
    const low = hypsometricColor(0, 0, 100, stops);
    const high = hypsometricColor(100, 0, 100, stops);
    // A perceptual ramp moves from dark to bright, so the two ends differ.
    expect(low).not.toEqual(high);
  });

  it('never returns fewer than two stops even when asked for one', () => {
    expect(builtinHypsometricStops('turbo', 1)).toHaveLength(2);
  });
});
