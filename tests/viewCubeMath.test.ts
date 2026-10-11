import { describe, test, expect } from 'vitest';
import {
  compassHeadingDeg,
  nearestCardinal,
  roseRotationDeg,
  COMPASS_FACES,
  compassFaceLabel,
  unwrapAngleDeg,
  stableHeadingDeg,
  NEAR_VERTICAL_HORIZONTAL_EPS,
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
    // Looking grid north (the rose's top face) frames the scan from the back.
    expect(byGeo['Grid N']).toBe('back');
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
  test('a known frame shows cardinals, with the top face labelled grid north', () => {
    // The rose follows the scan's +Y axis, which is grid north on a projected
    // CRS (1.29 degrees off true north in UTM 12N at 109 W, 40 N), never a
    // bare "N" that reads as true north.
    expect(COMPASS_FACES.map((f) => compassFaceLabel(f, true))).toEqual(['Grid N', 'E', 'S', 'W']);
  });
  test('local / unknown frame shows truthful local labels, never cardinals', () => {
    const local = COMPASS_FACES.map((f) => compassFaceLabel(f, false));
    expect(local).toEqual(['B', 'R', 'F', 'L']);
    // The whole point: no geographic letter leaks into the local frame.
    expect(local.some((l) => ['N', 'E', 'S', 'W'].includes(l))).toBe(false);
  });
});

describe('unwrapAngleDeg — continuous display heading (spec 6A)', () => {
  test('crossing north takes the short way', () => {
    expect(unwrapAngleDeg(359, 1)).toBe(361);
    expect(unwrapAngleDeg(1, 359)).toBe(-1);
  });
  test('repeated rotations stay continuous', () => {
    let d = 0;
    for (let turn = 0; turn < 3; turn++) for (let h = 10; h <= 360; h += 10) d = unwrapAngleDeg(d, h % 360);
    expect(d).toBe(1080);
    for (let i = 0; i < 36; i++) d = unwrapAngleDeg(d, ((360 - (i + 1) * 10) % 360 + 360) % 360);
    expect(d).toBe(720);
  });
  test('a display many turns in still lands on the congruent angle', () => {
    expect(unwrapAngleDeg(725, 10)).toBe(730);
    expect(unwrapAngleDeg(-725, 350)).toBe(-730);
  });
  test('non-finite next keeps prev; non-finite prev starts from next', () => {
    expect(unwrapAngleDeg(42, Number.NaN)).toBe(42);
    expect(unwrapAngleDeg(42, Number.POSITIVE_INFINITY)).toBe(42);
    expect(unwrapAngleDeg(Number.NaN, 90)).toBe(90);
  });
});

describe('stableHeadingDeg — near-vertical guard (spec 6A)', () => {
  test('a usable horizontal component gives the canonical heading', () => {
    expect(stableHeadingDeg(1, 0)).toBe(compassHeadingDeg(1, 0));
    expect(stableHeadingDeg(0, -0.5, 10)).toBe(180);
  });
  test('looking straight down keeps the last reliable heading instead of 0', () => {
    const tiny = NEAR_VERTICAL_HORIZONTAL_EPS / 10;
    expect(stableHeadingDeg(tiny, -tiny, 123)).toBe(123);
    expect(stableHeadingDeg(0, 0, 77)).toBe(77);
    expect(Number.isNaN(stableHeadingDeg(0, 0))).toBe(true);
    expect(stableHeadingDeg(Number.NaN, 1, 5)).toBe(5);
  });
  test('canonical outputs for existing consumers are unchanged', () => {
    expect(compassHeadingDeg(0, 0)).toBe(0);
    expect(roseRotationDeg(90)).toBe(-90);
  });
});
