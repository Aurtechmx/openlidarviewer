import { afterEach, describe, expect, it } from 'vitest';
import {
  classColor,
  colorByClassification,
  setColorblindSafeClasses,
  colorblindSafeClasses,
} from '../src/render/colorModes';

// The palette is a module-level switch; reset to the default after each test so
// one case can't leak its state into another.
afterEach(() => setColorblindSafeClasses(false));

describe('colourblind-safe classification palette', () => {
  it('defaults to the standard palette', () => {
    expect(colorblindSafeClasses()).toBe(false);
  });

  it('toggles the active palette and reports its state', () => {
    setColorblindSafeClasses(true);
    expect(colorblindSafeClasses()).toBe(true);
    setColorblindSafeClasses(false);
    expect(colorblindSafeClasses()).toBe(false);
  });

  it('recolours ground away from the default brown to Okabe-Ito orange', () => {
    const def = classColor(2); // ground
    setColorblindSafeClasses(true);
    const cvd = classColor(2);
    expect(cvd).not.toEqual(def);
    expect(cvd).toEqual([230, 159, 0]); // Okabe-Ito orange
  });

  it('separates the three vegetation classes by lightness (CVD-distinguishable)', () => {
    setColorblindSafeClasses(true);
    const low = classColor(3);
    const med = classColor(4);
    const high = classColor(5);
    // Same hue family (bluish-green) but monotonically darkening green channel.
    expect(low[1]).toBeGreaterThan(med[1]);
    expect(med[1]).toBeGreaterThan(high[1]);
  });

  it('drives colorByClassification through the active palette', () => {
    const classes = Uint8Array.from([2, 6]); // ground, building
    const def = colorByClassification(classes, 2);
    setColorblindSafeClasses(true);
    const cvd = colorByClassification(classes, 2);
    expect(Array.from(cvd)).not.toEqual(Array.from(def));
    // Ground point now carries the Okabe-Ito orange.
    expect([cvd[0], cvd[1], cvd[2]]).toEqual([230, 159, 0]);
  });
});
