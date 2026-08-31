/**
 * coordinateHudLazy.test.ts — the coordinate HUD is deferred to the first hover.
 *
 * The HUD is hidden until a point is under the cursor, so its mount rides a lazy
 * chunk. These cases pin the wrapper's contract: a clear before any point loads
 * nothing, the first real hover loads the mount and replays that hover, and once
 * loaded every hover goes straight to the real sink.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const wired = vi.fn();
const wireCoordinateHud = vi.fn(() => wired);
const loadCoordinateHudMount = vi.fn(() => Promise.resolve({ wireCoordinateHud }));

vi.mock('../src/lazyChunks', () => ({
  loadCoordinateHudMount: () => loadCoordinateHudMount(),
}));

import { lazyCoordinateHud } from '../src/app/coordinateHudLazy';
import type { PointInfo } from '../src/render/pointInfo';

const deps = { mount: vi.fn(), activeCrs: () => undefined, upAxis: () => 'unknown' as const };
const point = (x: number): PointInfo => ({ layer: 'a', index: 0, x, y: 0, z: 0 }) as PointInfo;

beforeEach(() => {
  wired.mockClear();
  wireCoordinateHud.mockClear();
  loadCoordinateHudMount.mockClear();
});

describe('lazyCoordinateHud', () => {
  it('loads nothing for a clear before the first point', () => {
    const sink = lazyCoordinateHud(deps);
    sink(null);
    expect(loadCoordinateHudMount).not.toHaveBeenCalled();
  });

  it('loads the mount on the first point and replays that hover into the built sink', async () => {
    const sink = lazyCoordinateHud(deps);
    sink(point(5));
    expect(loadCoordinateHudMount).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(wireCoordinateHud).toHaveBeenCalledWith(deps);
    expect(wired).toHaveBeenCalledWith(point(5));
  });

  it('loads once, then forwards every later hover straight to the real sink', async () => {
    const sink = lazyCoordinateHud(deps);
    sink(point(1));
    await Promise.resolve();
    await Promise.resolve();
    sink(point(2));
    sink(null);
    expect(loadCoordinateHudMount).toHaveBeenCalledTimes(1);
    expect(wired).toHaveBeenCalledWith(point(2));
    expect(wired).toHaveBeenCalledWith(null);
  });
});
