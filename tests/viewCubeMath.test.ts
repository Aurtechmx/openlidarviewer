import { describe, test, expect } from 'vitest';
import {
  compassHeadingDeg,
  nearestCardinal,
  roseRotationDeg,
  COMPASS_FACES,
  compassFaceLabel,
} from '../src/render/viewCubeMath';

describe('compassHeadingDeg', () => {
  test('north / east / south / west', () => {
    expect(compassHeadingDeg(0, 1)).toBeCloseTo(0); // +North
    expect(compassHeadingDeg(1, 0)).toBeCloseTo(90); // +East
    expect(compassHeadingDeg(0, -1)).toBeCloseTo(180); // +South
    expect(compassHeadingDeg(-1, 0)).toBeCloseTo(270); // +West
  });
  test('always in [0,360)', () => {
    for (let e = -3; e <= 3; e++)
      for (let n = -3; n <= 3; n++) {
        const h = compassHeadingDeg(e, n);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThan(360);
      }
  });
  test('degenerate / non-finite input → 0', () => {
    expect(compassHeadingDeg(0, 0)).toBe(0);
    expect(compassHeadingDeg(NaN, 1)).toBe(0);
    expect(compassHeadingDeg(1, Infinity)).toBe(0);
  });
});

describe('nearestCardinal', () => {
  test('cardinal bins', () => {
    expect(nearestCardinal(0)).toBe('N');
    expect(nearestCardinal(44)).toBe('N');
    expect(nearestCardinal(46)).toBe('E');
    expect(nearestCardinal(134)).toBe('E');
    expect(nearestCardinal(180)).toBe('S');
    expect(nearestCardinal(270)).toBe('W');
    expect(nearestCardinal(316)).toBe('N');
  });
  test('wraps negatives and >360', () => {
    expect(nearestCardinal(-10)).toBe('N');
    expect(nearestCardinal(450)).toBe('E');
  });
});

describe('roseRotationDeg', () => {
  test('counter-rotates the heading', () => {
    expect(roseRotationDeg(90)).toBe(-90);
    expect(roseRotationDeg(0)).toBe(-0);
    expect(roseRotationDeg(-30)).toBe(-330);
  });
});

describe('COMPASS_FACES', () => {
  test('cardinals map to opposite standard views (geographic labels)', () => {
    const byGeo = Object.fromEntries(COMPASS_FACES.map((f) => [f.geo, f.view]));
    // Looking north (the rose N) frames the scan from the back.
    expect(byGeo.N).toBe('back');
    expect(byGeo.S).toBe('front');
    expect(byGeo.E).toBe('right');
    expect(byGeo.W).toBe('left');
  });

  test('each face sits at a distinct rose position', () => {
    const positions = COMPASS_FACES.map((f) => f.position);
    expect(new Set(positions).size).toBe(4);
    expect(positions).toEqual(['top', 'right', 'bottom', 'left']);
  });
});

describe('compassFaceLabel — geography only when the frame is known', () => {
  test('geographic frame shows cardinals', () => {
    expect(COMPASS_FACES.map((f) => compassFaceLabel(f, true))).toEqual(['N', 'E', 'S', 'W']);
  });
  test('local / unknown frame shows truthful local labels, never cardinals', () => {
    const local = COMPASS_FACES.map((f) => compassFaceLabel(f, false));
    expect(local).toEqual(['B', 'R', 'F', 'L']);
    // The whole point: no geographic letter leaks into the local frame.
    expect(local.some((l) => ['N', 'E', 'S', 'W'].includes(l))).toBe(false);
  });
});
