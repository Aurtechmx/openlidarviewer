/**
 * clipBox.test.ts
 *
 * Pins the pure clip-region core: enabled/disabled keep-everything, keep-inside
 * vs keep-outside partitioning, inclusive faces, and the mask/count helpers
 * agreeing with the per-point predicate.
 */

import { describe, it, expect } from 'vitest';
import { clipFromBoxMeasurement, type BoxMeasurementLike } from '../src/render/clip/clipFromMeasurement';
import { useBoxAsClip } from '../src/app/boxToClip';
import type { Vec3 } from '../src/render/measure/types';
import {
  makeClipBox,
  clipKeepsPoint,
  clipMaskArray,
  countKept,
  type ClipBox,
} from '../src/render/clip/clipBox';
import type { BoxBounds } from '../src/render/measure/geometry';

const BOX: BoxBounds = { min: [0, 0, 0], max: [10, 10, 10] };
const inside: [number, number, number] = [5, 5, 5];
const outside: [number, number, number] = [20, 5, 5];

function clip(mode: ClipBox['mode'], enabled = true): ClipBox {
  return { box: BOX, mode, enabled };
}

describe('makeClipBox', () => {
  it('is disabled and keep-inside by default', () => {
    const c = makeClipBox(BOX);
    expect(c.enabled).toBe(false);
    expect(c.mode).toBe('keep-inside');
  });
});

describe('clipKeepsPoint', () => {
  it('a disabled clip keeps every point', () => {
    const c = makeClipBox(BOX);
    expect(clipKeepsPoint(c, inside)).toBe(true);
    expect(clipKeepsPoint(c, outside)).toBe(true);
  });

  it('keep-inside keeps interior, culls exterior', () => {
    const c = clip('keep-inside');
    expect(clipKeepsPoint(c, inside)).toBe(true);
    expect(clipKeepsPoint(c, outside)).toBe(false);
  });

  it('keep-outside inverts the decision', () => {
    const c = clip('keep-outside');
    expect(clipKeepsPoint(c, inside)).toBe(false);
    expect(clipKeepsPoint(c, outside)).toBe(true);
  });

  it('box faces are inclusive', () => {
    const c = clip('keep-inside');
    expect(clipKeepsPoint(c, [0, 0, 0])).toBe(true);
    expect(clipKeepsPoint(c, [10, 10, 10])).toBe(true);
  });
});

describe('clipMaskArray / countKept', () => {
  // four points: two inside (5,5,5),(1,1,1); two outside (20,..),(−1,..).
  const pts = new Float32Array([5, 5, 5, 1, 1, 1, 20, 5, 5, -1, 5, 5]);

  it('disabled → all ones, count = N', () => {
    const c = makeClipBox(BOX);
    expect(Array.from(clipMaskArray(c, pts))).toEqual([1, 1, 1, 1]);
    expect(countKept(c, pts)).toBe(4);
  });

  it('keep-inside masks the two interior points', () => {
    const c = clip('keep-inside');
    expect(Array.from(clipMaskArray(c, pts))).toEqual([1, 1, 0, 0]);
    expect(countKept(c, pts)).toBe(2);
  });

  it('keep-outside masks the two exterior points', () => {
    const c = clip('keep-outside');
    expect(Array.from(clipMaskArray(c, pts))).toEqual([0, 0, 1, 1]);
    expect(countKept(c, pts)).toBe(2);
  });

  it('countKept agrees with the predicate over every point', () => {
    const c = clip('keep-outside');
    let expected = 0;
    for (let i = 0; i < pts.length / 3; i++) {
      if (clipKeepsPoint(c, [pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]])) expected++;
    }
    expect(countKept(c, pts)).toBe(expected);
  });
});

// ── Box measurement → clipping region (spec 3) ─────────────────────────────

const one = { activeLayerId: 'L1', layerCount: 1 };
const boxM = (a: Vec3, b: Vec3, extra: Partial<BoxMeasurementLike> = {}): BoxMeasurementLike =>
  ({ id: 'm1', kind: 'box', points: [a, b], ...extra });

describe('clipFromBoxMeasurement', () => {
  it('builds an enabled keep-inside clip; reversed corners give the same box', () => {
    const r1 = clipFromBoxMeasurement(boxM([0, 0, 0], [2, 3, 4]), one);
    const r2 = clipFromBoxMeasurement(boxM([2, 3, 4], [0, 0, 0]), one);
    const r3 = clipFromBoxMeasurement(boxM([2, 0, 4], [0, 3, 0]), one);
    const want = { box: { min: [0, 0, 0], max: [2, 3, 4] }, mode: 'keep-inside', enabled: true };
    for (const r of [r1, r2, r3]) expect(r).toEqual({ ok: true, clip: want });
  });

  it('refuses non-finite or missing corners', () => {
    expect(clipFromBoxMeasurement(boxM([0, 0, Number.NaN], [1, 1, 1]), one).ok).toBe(false);
    expect(clipFromBoxMeasurement(boxM([0, 0, 0], [Infinity, 1, 1]), one).ok).toBe(false);
    expect(clipFromBoxMeasurement({ id: 'm1', kind: 'box', points: [[0, 0, 0]] }, one).ok).toBe(false);
    expect(clipFromBoxMeasurement(null, one).ok).toBe(false);
    expect(clipFromBoxMeasurement({ id: 'd', kind: 'distance', points: [[0, 0, 0], [1, 1, 1]] }, one).ok).toBe(false);
  });

  it('refuses a degenerate box with a zero extent on any axis', () => {
    for (const b of [[0, 1, 1], [1, 0, 1], [1, 1, 0]] as Vec3[]) {
      const r = clipFromBoxMeasurement(boxM([0, 0, 0], b), one);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/flat along [XYZ]/);
    }
  });

  it('refuses a box owned by another scan, and an unowned box among several scans', () => {
    expect(clipFromBoxMeasurement(boxM([0, 0, 0], [1, 1, 1], { owner: { layerId: 'L2' } }), { activeLayerId: 'L1', layerCount: 2 }).ok).toBe(false);
    expect(clipFromBoxMeasurement(boxM([0, 0, 0], [1, 1, 1]), { activeLayerId: 'L1', layerCount: 2 }).ok).toBe(false);
    expect(clipFromBoxMeasurement(boxM([0, 0, 0], [1, 1, 1], { owner: { layerId: 'L1' } }), { activeLayerId: 'L1', layerCount: 2 }).ok).toBe(true);
    expect(clipFromBoxMeasurement(boxM([0, 0, 0], [1, 1, 1]), { activeLayerId: null, layerCount: 0 }).ok).toBe(false);
  });

  it('is an independent copy both ways', () => {
    const a: Vec3 = [0, 0, 0];
    const b: Vec3 = [1, 1, 1];
    const r = clipFromBoxMeasurement(boxM(a, b), one);
    if (!r.ok) throw new Error('expected ok');
    a[0] = -5; // editing the measurement afterwards...
    expect(r.clip.box.min[0]).toBe(0); // ...does not move the clip
    (r.clip.box.max as number[])[0] = 9; // editing the clip...
    expect(b[0]).toBe(1); // ...does not move the measurement
  });

  it('the clip survives a session-style JSON round trip unchanged', () => {
    const r = clipFromBoxMeasurement(boxM([0, 0, 0], [1, 2, 3]), one);
    if (!r.ok) throw new Error('expected ok');
    expect(JSON.parse(JSON.stringify(r.clip))).toEqual(r.clip);
  });
});

describe('useBoxAsClip', () => {
  function deps(ms: BoxMeasurementLike[], ctx = one) {
    const log = { adopted: [] as ClipBox[], opened: 0, toasts: [] as string[] };
    return {
      log,
      d: {
        measurements: () => ms,
        activeLayerId: () => ctx.activeLayerId,
        layerCount: () => ctx.layerCount,
        adoptClip: (c: ClipBox) => log.adopted.push(c),
        openClipPage: () => { log.opened++; },
        toast: (m: string) => log.toasts.push(m),
      },
    };
  }
  it('resolves by id, adopts the clip, opens Tools → Clip and toasts', () => {
    const { d, log } = deps([boxM([0, 0, 0], [1, 1, 1]), { ...boxM([5, 5, 5], [6, 7, 8]), id: 'm2' }]);
    expect(useBoxAsClip(d, 'm2')).toBe(true);
    expect(log.adopted[0].box).toEqual({ min: [5, 5, 5], max: [6, 7, 8] });
    expect(log.opened).toBe(1);
    expect(log.toasts).toHaveLength(1);
  });
  it('a refusal applies nothing and opens nothing, but explains', () => {
    const { d, log } = deps([boxM([0, 0, 0], [1, 1, 0])]);
    expect(useBoxAsClip(d, 'm1')).toBe(false);
    expect(useBoxAsClip(d, 'gone')).toBe(false);
    expect(log.adopted).toHaveLength(0);
    expect(log.opened).toBe(0);
    expect(log.toasts).toHaveLength(2);
  });
});
