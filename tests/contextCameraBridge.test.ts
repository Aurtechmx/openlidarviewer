/**
 * contextCameraBridge.test.ts
 *
 * Pins the viewer-camera-to-map bridge and the compass labelling that goes with
 * it. Both guard the same promise the camera model makes: the marker on the
 * world map says only what the camera state actually supports.
 *
 * The bridge is a pass-through, and that is precisely what needs testing — a
 * wrapper that quietly re-derived a heading, swallowed a refusal into a
 * plausible-looking placement, or converted a caller's non-finite input into a
 * data condition would be invisible at the call site and wrong on screen. So
 * every case here compares the bridge against the model it wraps rather than
 * against a hand-written expectation.
 *
 * The labelling is tested at all eight sector centres AND at all eight
 * boundaries, because a boundary that drifts by one sector renames a bearing
 * without anything failing. The null case has its own cases: a camera looking
 * straight down has no heading, and 'N' would be a fabricated bearing wearing
 * the clothes of a measurement — 0° IS north.
 */

import { describe, it, expect } from 'vitest';
import {
  contextCameraFrom,
  headingLabel,
  UNKNOWN_HEADING_LABEL,
  type CompassPoint,
} from '../src/geo/context/cameraBridge';
import { mapCameraToContext } from '../src/geo/context/cameraModel';
import type { LonLatTransform } from '../src/geo/context/footprintModel';

/** Identity-ish fake transform: metres → tiny degrees. Deterministic, no proj4. */
const fakeTransform: LonLatTransform = (x, y) => [x / 1000, y / 1000];

/** A transform that can place nothing — the refusal path. */
const refusingTransform: LonLatTransform = () => null;

describe('contextCameraFrom — routes through the camera model', () => {
  it('returns the camera model’s placement unchanged', () => {
    const viaBridge = contextCameraFrom(1500, 2500, 0, 1, fakeTransform);
    const direct = mapCameraToContext(1500, 2500, 0, 1, fakeTransform);
    expect(viaBridge).toEqual(direct);
    if ('failed' in viaBridge) throw new Error('expected a placement');
    expect(viaBridge.position).toEqual([1.5, 2.5]);
    expect(viaBridge.headingDeg).toBe(0);
  });

  it('agrees with the model across a spread of positions and directions', () => {
    const cases: readonly (readonly [number, number, number, number])[] = [
      [0, 0, 0, 1],
      [1000, -2000, 1, 0],
      [-500, 750, -1, -1],
      [12_345, 67_890, 0.5, -0.25],
      [1, 1, 0, 0],
    ];
    for (const [x, y, dx, dy] of cases) {
      expect(contextCameraFrom(x, y, dx, dy, fakeTransform)).toEqual(
        mapCameraToContext(x, y, dx, dy, fakeTransform),
      );
    }
  });

  it('keeps the model’s heading convention: clockwise from north', () => {
    const heading = (dx: number, dy: number): number | null => {
      const r = contextCameraFrom(0, 0, dx, dy, fakeTransform);
      if ('failed' in r) throw new Error('expected a placement');
      return r.headingDeg;
    };
    expect(heading(0, 1)).toBe(0);
    expect(heading(1, 0)).toBe(90);
    expect(heading(0, -1)).toBe(180);
    expect(heading(-1, 0)).toBe(270);
  });

  it('passes a degenerate view direction through as a null heading, not a bearing', () => {
    const r = contextCameraFrom(10, 10, 0, 0, fakeTransform);
    if ('failed' in r) throw new Error('expected a placement');
    expect(r.headingDeg).toBeNull();
  });
});

describe('contextCameraFrom — refusal passthrough', () => {
  it('returns the model’s refusal exactly, with no placement invented', () => {
    const r = contextCameraFrom(1, 2, 0, 1, refusingTransform);
    expect(r).toEqual({ failed: true });
    expect('position' in r).toBe(false);
    expect('headingDeg' in r).toBe(false);
  });

  it('refuses even when the direction is perfectly good', () => {
    // A known heading is no reason to place a camera whose position failed.
    expect(contextCameraFrom(0, 0, 1, 1, refusingTransform)).toEqual({ failed: true });
  });

  it('refuses when the transform yields non-finite degrees', () => {
    const nan: LonLatTransform = () => [Number.NaN, 0];
    expect(contextCameraFrom(0, 0, 0, 1, nan)).toEqual({ failed: true });
  });

  it('lets the model’s TypeError propagate instead of masking it as a refusal', () => {
    expect(() => contextCameraFrom(Number.NaN, 0, 0, 1, fakeTransform)).toThrowError(TypeError);
    expect(() => contextCameraFrom(0, Infinity, 0, 1, fakeTransform)).toThrowError(TypeError);
    expect(() => contextCameraFrom(0, 0, Number.NaN, 1, fakeTransform)).toThrowError(TypeError);
    expect(() => contextCameraFrom(0, 0, 0, -Infinity, fakeTransform)).toThrowError(TypeError);
  });
});

describe('headingLabel — the eight sectors', () => {
  it('names each sector centre', () => {
    expect(headingLabel(0)).toBe('N');
    expect(headingLabel(45)).toBe('NE');
    expect(headingLabel(90)).toBe('E');
    expect(headingLabel(135)).toBe('SE');
    expect(headingLabel(180)).toBe('S');
    expect(headingLabel(225)).toBe('SW');
    expect(headingLabel(270)).toBe('W');
    expect(headingLabel(315)).toBe('NW');
  });

  it('places a bearing near a centre in that same sector', () => {
    expect(headingLabel(1)).toBe('N');
    expect(headingLabel(44)).toBe('NE');
    expect(headingLabel(91.5)).toBe('E');
    expect(headingLabel(314.9)).toBe('NW');
  });

  it('assigns every boundary to the clockwise-next sector', () => {
    expect(headingLabel(22.5)).toBe('NE');
    expect(headingLabel(67.5)).toBe('E');
    expect(headingLabel(112.5)).toBe('SE');
    expect(headingLabel(157.5)).toBe('S');
    expect(headingLabel(202.5)).toBe('SW');
    expect(headingLabel(247.5)).toBe('W');
    expect(headingLabel(292.5)).toBe('NW');
    expect(headingLabel(337.5)).toBe('N');
  });

  it('keeps a bearing just below a boundary in the previous sector', () => {
    expect(headingLabel(22.4)).toBe('N');
    expect(headingLabel(67.4)).toBe('NE');
    expect(headingLabel(112.4)).toBe('E');
    expect(headingLabel(157.4)).toBe('SE');
    expect(headingLabel(202.4)).toBe('S');
    expect(headingLabel(247.4)).toBe('SW');
    expect(headingLabel(292.4)).toBe('W');
    expect(headingLabel(337.4)).toBe('NW');
  });

  it('wraps the top of the circle back to north', () => {
    expect(headingLabel(359.9)).toBe('N');
    expect(headingLabel(360)).toBe('N');
  });

  it('normalises bearings outside [0, 360) rather than refusing them', () => {
    expect(headingLabel(-45)).toBe('NW');
    expect(headingLabel(-90)).toBe('W');
    expect(headingLabel(-0.1)).toBe('N');
    expect(headingLabel(450)).toBe('E');
    expect(headingLabel(720)).toBe('N');
    expect(headingLabel(-720 + 180)).toBe('S');
  });

  it('gives each of the eight points exactly 45 of the 360 whole-degree bearings', () => {
    const tally = new Map<string, number>();
    for (let deg = 0; deg < 360; deg += 1) {
      const label = headingLabel(deg);
      tally.set(label, (tally.get(label) ?? 0) + 1);
    }
    const points: readonly CompassPoint[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    expect(tally.size).toBe(points.length);
    for (const point of points) {
      expect(tally.get(point)).toBe(45);
    }
  });
});

describe('headingLabel — the unknown heading', () => {
  it('answers the literal unknown-heading string for null', () => {
    expect(headingLabel(null)).toBe('unknown heading');
    expect(headingLabel(null)).toBe(UNKNOWN_HEADING_LABEL);
  });

  it('never fabricates a compass point for a missing heading', () => {
    const points: readonly string[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    expect(points).not.toContain(headingLabel(null));
    expect(headingLabel(null)).not.toBe('N');
  });

  it('treats a non-finite number as a caller bug, not a missing heading', () => {
    expect(() => headingLabel(Number.NaN)).toThrowError(TypeError);
    expect(() => headingLabel(Number.NaN)).toThrowError(/"headingDeg"/);
    expect(() => headingLabel(Infinity)).toThrowError(TypeError);
    expect(() => headingLabel(-Infinity)).toThrowError(TypeError);
  });
});

describe('bridge and label together', () => {
  it('a camera looking straight down reads as an unknown heading end to end', () => {
    const placed = contextCameraFrom(500, 500, 0, 0, fakeTransform);
    if ('failed' in placed) throw new Error('expected a placement');
    expect(headingLabel(placed.headingDeg)).toBe(UNKNOWN_HEADING_LABEL);
  });

  it('a camera looking north-east reads as NE', () => {
    const placed = contextCameraFrom(0, 0, 1, 1, fakeTransform);
    if ('failed' in placed) throw new Error('expected a placement');
    expect(placed.headingDeg).toBeCloseTo(45, 10);
    expect(headingLabel(placed.headingDeg)).toBe('NE');
  });

  it('a camera looking west-north-west reads as NW at the sector boundary', () => {
    // atan2(-1, 0.4142…) — the direction 292.5° clockwise from north.
    const rad = (292.5 * Math.PI) / 180;
    const placed = contextCameraFrom(0, 0, Math.sin(rad), Math.cos(rad), fakeTransform);
    if ('failed' in placed) throw new Error('expected a placement');
    expect(placed.headingDeg).toBeCloseTo(292.5, 10);
    expect(headingLabel(placed.headingDeg)).toBe('NW');
  });
});
