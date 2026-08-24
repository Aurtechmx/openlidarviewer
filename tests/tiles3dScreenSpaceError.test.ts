import { describe, expect, it } from 'vitest';

import {
  orthographicScreenSpaceError,
  perspectiveScreenSpaceError,
  screenSpaceError,
  shouldRefine,
} from '../src/io/tiles3d/screenSpaceError';

const TOL = 1e-6;

describe('perspective screen-space error', () => {
  it('matches the hand-computed value for a 60 degree vertical fov', () => {
    // geometricError 10, viewport 1000 px, distance 100, fov 60 deg = PI/3.
    // tan(30 deg) = 0.5773502691896257
    // 10 * 1000 / (2 * 100 * 0.5773502691896257)
    //   = 10000 / 115.47005383792515
    //   = 86.60254037844386
    const sse = perspectiveScreenSpaceError({
      geometricError: 10,
      viewportHeightPx: 1000,
      distance: 100,
      verticalFov: Math.PI / 3,
    });
    expect(sse).toBeCloseTo(86.60254037844386, 6);
    expect(Math.abs(sse - 86.60254037844386)).toBeLessThan(TOL);
  });

  it('matches the hand-computed value for a 90 degree vertical fov', () => {
    // geometricError 5, viewport 800 px, distance 50, fov 90 deg = PI/2.
    // tan(45 deg) = 1 exactly, so 5 * 800 / (2 * 50 * 1) = 4000 / 100 = 40
    const sse = perspectiveScreenSpaceError({
      geometricError: 5,
      viewportHeightPx: 800,
      distance: 50,
      verticalFov: Math.PI / 2,
    });
    expect(Math.abs(sse - 40)).toBeLessThan(TOL);
  });
});

describe('perspective monotonicity', () => {
  const base = {
    geometricError: 10,
    viewportHeightPx: 1000,
    distance: 100,
    verticalFov: Math.PI / 3,
  };

  it('falls as distance grows', () => {
    // Doubling distance to 200 halves the value:
    // 10 * 1000 / (2 * 200 * 0.5773502691896257) = 43.30127018922193
    const near = perspectiveScreenSpaceError(base);
    const far = perspectiveScreenSpaceError({ ...base, distance: 200 });
    expect(Math.abs(far - 43.30127018922193)).toBeLessThan(TOL);
    expect(far).toBeLessThan(near);
  });

  it('rises with geometric error', () => {
    // geometricError 20 doubles it:
    // 20 * 1000 / (2 * 100 * 0.5773502691896257) = 173.20508075688772
    const small = perspectiveScreenSpaceError(base);
    const large = perspectiveScreenSpaceError({ ...base, geometricError: 20 });
    expect(Math.abs(large - 173.20508075688772)).toBeLessThan(TOL);
    expect(large).toBeGreaterThan(small);
  });

  it('rises with viewport height', () => {
    // viewport 2000 px doubles it:
    // 10 * 2000 / (2 * 100 * 0.5773502691896257) = 173.20508075688772
    const short = perspectiveScreenSpaceError(base);
    const tall = perspectiveScreenSpaceError({ ...base, viewportHeightPx: 2000 });
    expect(Math.abs(tall - 173.20508075688772)).toBeLessThan(TOL);
    expect(tall).toBeGreaterThan(short);
  });
});

describe('orthographic screen-space error', () => {
  it('matches the hand-computed value', () => {
    // geometricError 10, viewport 1000 px, world height 500.
    // 10 * 1000 / 500 = 20
    const sse = orthographicScreenSpaceError({
      geometricError: 10,
      viewportHeightPx: 1000,
      orthographicWorldHeight: 500,
    });
    expect(Math.abs(sse - 20)).toBeLessThan(TOL);
  });

  it('is independent of distance, because the input has none', () => {
    // The orthographic input carries no distance at all. Routing three cameras
    // through the dispatcher with wildly different notional viewpoints must
    // give the identical number: 10 * 1000 / 500 = 20 in every case. This is
    // the case that catches the perspective formula being reused in Plan view.
    const values = [1, 100, 100000].map(() =>
      screenSpaceError({
        kind: 'orthographic',
        geometricError: 10,
        viewportHeightPx: 1000,
        orthographicWorldHeight: 500,
      }),
    );
    for (const v of values) {
      expect(Math.abs(v - 20)).toBeLessThan(TOL);
    }
    expect(values[0]).toBe(values[1]);
    expect(values[1]).toBe(values[2]);
  });

  it('rises when zooming in shrinks the world height', () => {
    // world height 500 -> 20 px; halved to 250 -> 10 * 1000 / 250 = 40 px.
    const out = orthographicScreenSpaceError({
      geometricError: 10,
      viewportHeightPx: 1000,
      orthographicWorldHeight: 500,
    });
    const zoomed = orthographicScreenSpaceError({
      geometricError: 10,
      viewportHeightPx: 1000,
      orthographicWorldHeight: 250,
    });
    expect(Math.abs(zoomed - 40)).toBeLessThan(TOL);
    expect(zoomed).toBeGreaterThan(out);
    // Refinement flips with zoom at a threshold of 30 px.
    expect(shouldRefine(out, 30)).toBe(false);
    expect(shouldRefine(zoomed, 30)).toBe(true);
  });

  it('rises with geometric error and with viewport height', () => {
    // 20 * 1000 / 500 = 40; 10 * 2000 / 500 = 40
    const moreError = orthographicScreenSpaceError({
      geometricError: 20,
      viewportHeightPx: 1000,
      orthographicWorldHeight: 500,
    });
    const tallerViewport = orthographicScreenSpaceError({
      geometricError: 10,
      viewportHeightPx: 2000,
      orthographicWorldHeight: 500,
    });
    expect(Math.abs(moreError - 40)).toBeLessThan(TOL);
    expect(Math.abs(tallerViewport - 40)).toBeLessThan(TOL);
  });
});

describe('dispatcher', () => {
  it('routes a perspective camera to the perspective formula', () => {
    // 10 * 1000 / (2 * 100 * tan(PI/6)) = 86.60254037844386
    const sse = screenSpaceError({
      kind: 'perspective',
      geometricError: 10,
      viewportHeightPx: 1000,
      distance: 100,
      verticalFov: Math.PI / 3,
    });
    expect(Math.abs(sse - 86.60254037844386)).toBeLessThan(TOL);
  });

  it('routes an orthographic camera to the orthographic formula', () => {
    // 10 * 1000 / 500 = 20, which is NOT the perspective answer above.
    const sse = screenSpaceError({
      kind: 'orthographic',
      geometricError: 10,
      viewportHeightPx: 1000,
      orthographicWorldHeight: 500,
    });
    expect(Math.abs(sse - 20)).toBeLessThan(TOL);
  });
});

describe('degenerate inputs', () => {
  it('returns Infinity, not NaN, when the camera is at distance 0', () => {
    const sse = perspectiveScreenSpaceError({
      geometricError: 10,
      viewportHeightPx: 1000,
      distance: 0,
      verticalFov: Math.PI / 3,
    });
    expect(Number.isNaN(sse)).toBe(false);
    expect(sse).toBe(Infinity);
    expect(shouldRefine(sse, 16)).toBe(true);
  });

  it('returns Infinity for a negative or non-finite distance', () => {
    for (const distance of [-1, Number.NaN, Infinity, -Infinity]) {
      expect(
        perspectiveScreenSpaceError({
          geometricError: 10,
          viewportHeightPx: 1000,
          distance,
          verticalFov: Math.PI / 3,
        }),
      ).toBe(Infinity);
    }
  });

  it('returns Infinity for a zero, negative or non-finite viewport height', () => {
    for (const viewportHeightPx of [0, -1000, Number.NaN, Infinity]) {
      expect(
        perspectiveScreenSpaceError({
          geometricError: 10,
          viewportHeightPx,
          distance: 100,
          verticalFov: Math.PI / 3,
        }),
      ).toBe(Infinity);
      expect(
        orthographicScreenSpaceError({
          geometricError: 10,
          viewportHeightPx,
          orthographicWorldHeight: 500,
        }),
      ).toBe(Infinity);
    }
  });

  it('returns Infinity for a fov at or beyond PI, or at or below zero', () => {
    for (const verticalFov of [Math.PI, Math.PI + 0.1, 0, -0.5, Number.NaN]) {
      expect(
        perspectiveScreenSpaceError({
          geometricError: 10,
          viewportHeightPx: 1000,
          distance: 100,
          verticalFov,
        }),
      ).toBe(Infinity);
    }
  });

  it('returns Infinity for a zero or negative orthographic world height', () => {
    for (const orthographicWorldHeight of [0, -500, Number.NaN, Infinity]) {
      expect(
        orthographicScreenSpaceError({
          geometricError: 10,
          viewportHeightPx: 1000,
          orthographicWorldHeight,
        }),
      ).toBe(Infinity);
    }
  });

  it('gives exactly 0 for a zero geometric error, in both cameras, never NaN', () => {
    const perspective = perspectiveScreenSpaceError({
      geometricError: 0,
      viewportHeightPx: 1000,
      distance: 100,
      verticalFov: Math.PI / 3,
    });
    const orthographic = orthographicScreenSpaceError({
      geometricError: 0,
      viewportHeightPx: 1000,
      orthographicWorldHeight: 500,
    });
    expect(perspective).toBe(0);
    expect(orthographic).toBe(0);
    // Zero error still gives 0 where the other inputs are themselves degenerate.
    expect(
      perspectiveScreenSpaceError({
        geometricError: 0,
        viewportHeightPx: 1000,
        distance: 0,
        verticalFov: Math.PI / 3,
      }),
    ).toBe(0);
    expect(shouldRefine(perspective, 16)).toBe(false);
  });

  it('returns Infinity for a negative or non-finite geometric error', () => {
    for (const geometricError of [-10, Number.NaN, Infinity]) {
      expect(
        perspectiveScreenSpaceError({
          geometricError,
          viewportHeightPx: 1000,
          distance: 100,
          verticalFov: Math.PI / 3,
        }),
      ).toBe(Infinity);
    }
  });
});

describe('shouldRefine', () => {
  it('refines only above the threshold', () => {
    expect(shouldRefine(20, 16)).toBe(true);
    expect(shouldRefine(16, 16)).toBe(false);
    expect(shouldRefine(4, 16)).toBe(false);
  });

  it('always refines on an infinite error', () => {
    expect(shouldRefine(Infinity, 16)).toBe(true);
    expect(shouldRefine(Infinity, 1e9)).toBe(true);
  });

  it('does not refine on NaN or an unusable threshold', () => {
    expect(shouldRefine(Number.NaN, 16)).toBe(false);
    expect(shouldRefine(100, 0)).toBe(false);
    expect(shouldRefine(100, -16)).toBe(false);
    expect(shouldRefine(100, Number.NaN)).toBe(false);
    expect(shouldRefine(100, Infinity)).toBe(false);
  });
});
