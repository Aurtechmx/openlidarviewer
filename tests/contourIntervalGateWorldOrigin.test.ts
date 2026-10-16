/**
 * contourIntervalGateWorldOrigin.test.ts — the interval gate tests "yields no
 * contours" in the frame the levels are drawn in.
 *
 * Contour levels are anchored to WORLD elevation through `levelOriginZ`. The
 * gate's exact level-crossing rule ran on the LOCAL bounds, so it could
 * disable an interval whose world level is drawn, or offer one that draws
 * nothing.
 */
import { describe, it, expect } from 'vitest';
import { analyseContours, computeTerrainCore, contoursFromCore } from '../src/terrain/contour/analyseContours';
import { gateAtLevelOrigin, gateIntervals } from '../src/terrain/contour/intervalGate';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

function plane(lo: number, hi: number): TerrainPoint[] {
  const pts: TerrainPoint[] = [];
  for (let x = 0; x <= 50; x += 0.5) {
    for (let y = 0; y <= 20; y += 0.5) pts.push({ x, y, z: lo + ((hi - lo) * x) / 50 });
  }
  return pts;
}

const core = { cellSizeM: 1, crs: 'EPSG:32610', verticalDatum: 'EPSG:5703' } as const;

describe('interval gate vs world-anchored levels', () => {
  it('local 0.5..4.0 with origin 337 (world 337.5..341): a 5-unit interval crosses world 340', () => {
    const oz = 337;
    const r = analyseContours(plane(0.5, 4), { ...core, intervalM: 5, levelOriginZ: oz });
    const segs = r.contours.levels.reduce((n, l) => n + l.segments.length, 0);
    expect(r.contours.levels.map((l) => l.value + oz)).toEqual([340]);
    expect(segs).toBeGreaterThan(0);
    const opt5 = r.gate.options.find((o) => o.intervalM === 5)!;
    expect(opt5.supported).toBe(true);
    expect(opt5.reason).toBe('');
  });

  it('the reverse case: local bounds cross a multiple, world bounds do not, so the interval is disabled', () => {
    // Local 4.5..6 crosses local 5; with origin 337 the world span 341.5..343
    // holds no multiple of 5, and contoursAt draws nothing at that interval.
    const oz = 337;
    const r = analyseContours(plane(4.5, 6), { ...core, intervalM: 5, levelOriginZ: oz });
    expect(r.contours.levels).toHaveLength(0);
    const opt5 = r.gate.options.find((o) => o.intervalM === 5)!;
    expect(opt5.supported).toBe(false);
    expect(opt5.reason).toMatch(/yields no contours/);
  });

  it('origin 0 or omitted leaves the core gate untouched', () => {
    const c = computeTerrainCore(plane(0.5, 4), core);
    expect(contoursFromCore(c, { intervalM: 1 }).gate).toBe(c.gate);
    expect(contoursFromCore(c, { intervalM: 1, levelOriginZ: 0 }).gate).toBe(c.gate);
    expect(contoursFromCore(c, { intervalM: 1, levelOriginZ: null }).gate).toBe(c.gate);
  });

  it('gateAtLevelOrigin shifts only the bounds: local 0.5..4 at origin 337 supports 5', () => {
    const local = { cellSizeM: 1, elevationRangeM: 3.5, rmseM: 0.05, minZ: 0.5, maxZ: 4 };
    const localGate = gateIntervals(local);
    expect(localGate.options.find((o) => o.intervalM === 5)!.supported).toBe(false);
    const world = gateAtLevelOrigin(local, localGate, 337);
    expect(world.options.find((o) => o.intervalM === 5)!.supported).toBe(true);
    // Only the level-crossing answer changes: world 337.5..341 holds 340 (a
    // multiple of 5 and of 10), local 0.5..4 holds neither.
    const changed = world.options.filter((o, i) => o.supported !== localGate.options[i].supported);
    expect(changed.map((o) => o.intervalM)).toEqual([5, 10]);
    expect(world.recommendedM).toBe(localGate.recommendedM);
    expect(gateAtLevelOrigin(local, localGate, 0)).toBe(localGate);
    expect(gateAtLevelOrigin(null, localGate, 337)).toBe(localGate);
  });

  it('the quality verdict follows the world-bounds gate when the recommendation flips', () => {
    // Local 0.1..0.4 holds no multiple of any candidate (0.5 is the finest), so
    // the local gate recommends nothing and the surface reads "no reliable
    // interval". At origin 337.2 the world span 337.3..337.6 holds 337.5.
    const NO_INTERVAL = /No contour interval is reliable/;
    const c = computeTerrainCore(plane(0.1, 0.4), core);
    expect(c.gate.recommendedM).toBeNull();
    expect(c.quality.reasons.join(' ')).toMatch(NO_INTERVAL);
    const world = contoursFromCore(c, { levelOriginZ: 337.2 });
    expect(world.gate.recommendedM).toBe(0.5);
    expect(world.quality.reasons.join(' ')).not.toMatch(NO_INTERVAL);
    expect(c.quality.readiness).toBe('blocked');
    expect(world.quality.readiness).not.toBe('blocked');

    // The reverse: local 0.4..0.6 holds 0.5, world 337.6..337.8 holds none.
    const r = computeTerrainCore(plane(0.4, 0.6), core);
    expect(r.gate.recommendedM).toBe(0.5);
    const rw = contoursFromCore(r, { levelOriginZ: 337.2 });
    expect(rw.gate.recommendedM).toBeNull();
    expect(rw.quality.readiness).toBe('blocked');
    expect(rw.quality.reasons.join(' ')).toMatch(NO_INTERVAL);

    // Without an origin the core's own verdict is reused as is.
    expect(contoursFromCore(c, {}).quality).toBe(c.quality);
  });
});
