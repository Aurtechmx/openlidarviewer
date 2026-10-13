/**
 * A Box measurement drawn from two picks on the ground is flat: its corners
 * differ in height by centimetres. Isolating that box gave a slab a few
 * centimetres thick, a 2D slice of the scan. These pin the rule that gives a
 * flat box the scan's height, and the pick predicate that keeps clipped-away
 * points from being picked.
 */
import { describe, it, expect } from 'vitest';
import { clipFromBoxMeasurement, FLAT_BOX_FRACTION } from '../src/render/clip/clipFromMeasurement';
import { clipFrameBounds, clipPickAccept, verticalExtentOf, type ClipBox } from '../src/render/clip/clipBox';
import { useBoxAsClip } from '../src/app/boxToClip';
import type { Vec3 } from '../src/render/measure/types';

const box = (a: Vec3, b: Vec3) => ({ id: 'm1', kind: 'box', points: [a, b] });
const one = { activeLayerId: 'L1', layerCount: 1 } as const;
const zUp = { axis: 2, min: 0, max: 10 } as const;

describe('flat box gets the scan height', () => {
  it('two ground picks (cm apart in height) span the whole vertical extent', () => {
    const r = clipFromBoxMeasurement(box([2, 2, 0.012], [8, 9, -0.011]), { ...one, vertical: zUp });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.clip.box.min[0]).toBe(2);
    expect(r.clip.box.max[1]).toBe(9);
    expect(r.clip.box.min[2]).toBeLessThanOrEqual(0);
    expect(r.clip.box.max[2]).toBeGreaterThanOrEqual(10);
    expect(r.heightExtended?.axis).toBe(2);
    expect(r.heightExtended?.drawn).toBeCloseTo(0.023, 6);
  });
  it('a box with exactly equal corner heights is extended, not refused', () => {
    const r = clipFromBoxMeasurement(box([0, 0, 3], [4, 4, 3]), { ...one, vertical: zUp });
    expect(r.ok && r.heightExtended !== undefined).toBe(true);
  });
  it('a box taller than the flat fraction keeps its drawn height', () => {
    const h = 10 * FLAT_BOX_FRACTION + 0.01;
    const r = clipFromBoxMeasurement(box([0, 0, 2], [4, 4, 2 + h]), { ...one, vertical: zUp });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.heightExtended).toBeUndefined();
    expect(r.clip.box.min[2]).toBe(2);
    expect(r.clip.box.max[2]).toBeCloseTo(2 + h, 9);
  });
  it('uses the up axis the scan declares (Y-up)', () => {
    const r = clipFromBoxMeasurement(box([0, 5, 0], [4, 5.001, 4]), { ...one, vertical: { axis: 1, min: 0, max: 20 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.clip.box.min[1]).toBeLessThanOrEqual(0);
    expect(r.clip.box.max[1]).toBeGreaterThanOrEqual(20);
    expect(r.clip.box.min[2]).toBe(0);
    expect(r.clip.box.max[2]).toBe(4);
  });
  it('zero extent on a horizontal axis is still refused', () => {
    expect(clipFromBoxMeasurement(box([0, 0, 0], [4, 0, 5]), { ...one, vertical: zUp }).ok).toBe(false);
    expect(clipFromBoxMeasurement(box([0, 0, 0], [0, 4, 5]), { ...one, vertical: zUp }).ok).toBe(false);
  });
  it('without a vertical extent an exactly flat box is refused', () => {
    expect(clipFromBoxMeasurement(box([0, 0, 3], [4, 4, 3]), one).ok).toBe(false);
    expect(clipFromBoxMeasurement(box([0, 0, 3], [4, 4, 3]), { ...one, vertical: null }).ok).toBe(false);
  });
  it('a degenerate vertical extent is ignored', () => {
    expect(clipFromBoxMeasurement(box([0, 0, 3], [4, 4, 3]), { ...one, vertical: { axis: 2, min: 5, max: 5 } }).ok).toBe(false);
  });
  it('the measurement is left as drawn: the clip never aliases its corners', () => {
    const m = box([0, 0, 1], [4, 4, 1.001]);
    const before = JSON.stringify(m.points);
    clipFromBoxMeasurement(m, { ...one, vertical: zUp });
    expect(JSON.stringify(m.points)).toBe(before);
  });
  it('useBoxAsClip says the height was extended', () => {
    const toasts: string[] = [];
    const adopted: ClipBox[] = [];
    const ok = useBoxAsClip({
      measurements: () => [box([0, 0, 1], [4, 4, 1.001])],
      activeLayerId: () => 'L1', layerCount: () => 1, verticalExtent: () => zUp,
      adoptClip: (c) => adopted.push(c), openClipPage: () => undefined, toast: (m) => toasts.push(m),
    }, 'm1');
    expect(ok).toBe(true);
    expect(adopted[0].box.max[2]).toBeGreaterThanOrEqual(10);
    expect(toasts[0]).toMatch(/flat, so its height now spans the whole scan/);
  });
});

describe('useBoxAsClip frames the kept volume', () => {
  const mk = (ms: ReturnType<typeof box>[], log: string[]) => ({
    measurements: () => ms, activeLayerId: () => 'L1', layerCount: () => 1, verticalExtent: () => zUp,
    adoptClip: () => { log.push('adopt'); }, openClipPage: () => { log.push('open'); },
    frameClip: () => { log.push('frame'); }, toast: () => { log.push('toast'); },
  });
  it('frames after adopting, once', () => {
    const log: string[] = [];
    expect(useBoxAsClip(mk([box([0, 0, 1], [4, 4, 1.001])], log), 'm1')).toBe(true);
    expect(log).toEqual(['adopt', 'open', 'frame', 'toast']);
  });
  it('does not frame when the box is refused', () => {
    const log: string[] = [];
    expect(useBoxAsClip(mk([box([0, 0, 1], [0, 4, 1.001])], log), 'm1')).toBe(false);
    expect(log).toEqual(['toast']);
  });
});

describe('clipPickAccept', () => {
  const positions = new Float32Array([1, 1, 1, 9, 9, 9, 5, 5, 5]);
  const inside: ClipBox = { box: { min: [0, 0, 0], max: [6, 6, 6] }, mode: 'keep-inside', enabled: true };
  it('is the inner predicate untouched when no clip is active', () => {
    const inner = () => true;
    expect(clipPickAccept(null, positions, [0, 0, 0], inner)).toBe(inner);
    expect(clipPickAccept({ ...inside, enabled: false }, positions, [0, 0, 0])).toBeUndefined();
  });
  it('refuses points the clip hides (inside mode)', () => {
    const a = clipPickAccept(inside, positions, [0, 0, 0])!;
    expect([a(0), a(1), a(2)]).toEqual([true, false, true]);
  });
  it('refuses the box interior in outside mode', () => {
    const a = clipPickAccept({ ...inside, mode: 'keep-outside' }, positions, [0, 0, 0])!;
    expect([a(0), a(1), a(2)]).toEqual([false, true, false]);
  });
  it('tests points in the clip frame through the layer offset', () => {
    const a = clipPickAccept(inside, positions, [-8, -8, -8])!;
    expect([a(0), a(1), a(2)]).toEqual([false, true, false]);
  });
  it('also honours the inner predicate', () => {
    const a = clipPickAccept(inside, positions, [0, 0, 0], (i) => i !== 0)!;
    expect([a(0), a(1), a(2)]).toEqual([false, false, true]);
  });
});

describe('clip framing helpers', () => {
  const kept: ClipBox = { box: { min: [0, 0, -5], max: [10, 10, 50] }, mode: 'keep-inside', enabled: true };
  it('verticalExtentOf reads the up axis of the bounds', () => {
    expect(verticalExtentOf([0, 1, 2, 10, 11, 12], 2)).toEqual({ axis: 2, min: 2, max: 12 });
    expect(verticalExtentOf([0, 1, 2, 10, 11, 12], 1)).toEqual({ axis: 1, min: 1, max: 11 });
    expect(verticalExtentOf(null, 2)).toBeNull();
  });
  it('frames the clip trimmed to the data, so a height margin is not framed', () => {
    expect(clipFrameBounds(kept, [2, 2, 0, 8, 20, 9])).toEqual({ min: [2, 2, 0], max: [8, 10, 9] });
  });
  it('frames nothing for no clip, a disabled clip, Outside, no data or a clip that misses the data', () => {
    const data = [0, 0, 0, 5, 5, 5];
    expect(clipFrameBounds(null, data)).toBeNull();
    expect(clipFrameBounds({ ...kept, enabled: false }, data)).toBeNull();
    expect(clipFrameBounds({ ...kept, mode: 'keep-outside' }, data)).toBeNull();
    expect(clipFrameBounds(kept, null)).toBeNull();
    expect(clipFrameBounds(kept, [20, 20, 0, 30, 30, 5])).toBeNull();
  });
});
