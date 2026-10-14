import { describe, expect, it } from 'vitest';
import { ProjectSnapIndex, type SnapLayerSource } from '../src/render/measure/projectSnap';
import { buildPointSnapIndex, snapToNearestPoint } from '../src/render/measure/snap';

/** A dense 10 x 10 x 1 grid of returns at 0.1 spacing, in source-local space. */
function grid(): Float32Array {
  const out: number[] = [];
  for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) out.push(i * 0.1, j * 0.1, 0);
  return new Float32Array(out);
}

const BIG: [number, number, number] = [500000, 4200000, 35];
const A = grid();
const B = grid();
const layerA = (offset: [number, number, number] = [0, 0, 0]): SnapLayerSource => ({ id: 'a', local: A, offset });
const layerB = (offset: [number, number, number] = BIG): SnapLayerSource => ({ id: 'b', local: B, offset });

function make(layers: () => SnapLayerSource[]): ProjectSnapIndex {
  const s = new ProjectSnapIndex();
  s.setProvider(layers);
  return s;
}

// Project-frame position of local point (0.3, 0.4, 0) in a layer at `off`.
const at = (off: readonly number[]): [number, number, number] => [0.3 + off[0], 0.4 + off[1], off[2]];

describe('project-frame snapping across layers', () => {
  it('snaps and supports an endpoint on a real return of either scan (second scan translated far)', () => {
    const s = make(() => [layerA(), layerB()]);
    for (const [id, off] of [['a', [0, 0, 0]], ['b', BIG]] as const) {
      const p = at(off);
      const hit = s.nearest([p[0] + 0.001, p[1] - 0.001, p[2]], 0.05);
      expect(hit?.kind).toBe('point');
      expect(hit?.layerId).toBe(id);
      expect(hit?.pointIndex).toBe(3 * 10 + 4);
      expect(hit?.position[0]).toBeCloseTo(p[0], 6);
      expect(hit?.position[1]).toBeCloseTo(p[1], 6);
      const sup = s.support(p);
      expect(sup.snappedToPoint).toBe(true);
      expect(sup.pointsWithinRadius).toBeGreaterThan(1);
    }
  });

  it('a vertex in a void is not supported', () => {
    const s = make(() => [layerA(), layerB()]);
    const sup = s.support([250000, 2000000, 10]);
    expect(sup.snappedToPoint).toBe(false);
    expect(sup.pointsWithinRadius).toBe(0);
  });

  it('a single index over the translated layer\'s local positions misses its returns', () => {
    const local = buildPointSnapIndex(B);
    expect(snapToNearestPoint(local, at(BIG), 0.05)).toBeNull();
  });

  it('gives identical results for any load order', () => {
    const q = at(BIG);
    const one = make(() => [layerA(), layerB()]);
    const two = make(() => [layerB(), layerA()]);
    expect(two.nearest(q, 0.05)).toEqual(one.nearest(q, 0.05));
    expect(two.support(q)).toEqual(one.support(q));
    const origin = at([0, 0, 0]);
    expect(two.support(origin)).toEqual(one.support(origin));
  });

  it('is independent of which layer is active (the active layer is not an input)', () => {
    // The provider receives no active-layer information; the same set answers the same.
    const s = make(() => [layerA(), layerB()]);
    const before = s.support(at(BIG));
    s.invalidate();
    expect(s.support(at(BIG))).toEqual(before);
  });

  it('resolves an exact cross-layer tie by layer id, not by order', () => {
    const same = [[0, 0, 0]] as const;
    const mk = (id: string): SnapLayerSource => ({ id, local: new Float32Array([1, 1, 1]), offset: same[0] });
    const x = make(() => [mk('z'), mk('m')]).nearest([1, 1, 1], 1);
    const y = make(() => [mk('m'), mk('z')]).nearest([1, 1, 1], 1);
    expect(x?.layerId).toBe('m');
    expect(y?.layerId).toBe('m');
  });

  it('refreshes when a placement changes', () => {
    let off: [number, number, number] = [0, 0, 0];
    const s = make(() => [layerB(off)]);
    const moved = at(BIG);
    expect(s.nearest(moved, 0.05)).toBeNull();
    off = BIG;
    expect(s.nearest(moved, 0.05)).toBeNull(); // stale until invalidated
    s.invalidate();
    expect(s.nearest(moved, 0.05)?.layerId).toBe('b');
    expect(s.nearest(at([0, 0, 0]), 0.05)).toBeNull();
  });

  it('refreshes when a layer is hidden, locked or removed, and reuses the grid', () => {
    const layers = [layerA(), layerB()];
    const s = make(() => layers);
    expect(s.nearest(at(BIG), 0.05)?.layerId).toBe('b');
    layers.pop();
    s.invalidate();
    expect(s.nearest(at(BIG), 0.05)).toBeNull();
    expect(s.nearest(at([0, 0, 0]), 0.05)?.layerId).toBe('a');
    layers.length = 0;
    s.invalidate();
    expect(s.available).toBe(false);
    expect(s.support(at([0, 0, 0]))).toEqual({ snappedToPoint: false, pointsWithinRadius: 0 });
  });

  it('a single unplaced scan matches the plain index', () => {
    const plain = buildPointSnapIndex(A);
    const s = make(() => [layerA()]);
    for (const q of [[0.31, 0.39, 0], [0.5, 0.5, 0.2], [2, 2, 2]] as const) {
      const want = snapToNearestPoint(plain, q, 0.1);
      const got = s.nearest(q, 0.1);
      expect(got ? { ...got, layerId: undefined } : null).toEqual(want ? { ...want, layerId: undefined } : null);
    }
    expect(s.support([0.3, 0.4, 0]).snappedToPoint).toBe(true);
  });

  it('prefers a real return over constructed geometry on a near-tie, and takes closer geometry', () => {
    const s = make(() => [layerB()]);
    const p = at(BIG);
    expect(s.best([[p]], p, 0.05)?.kind).toBe('point');
    const far: [number, number, number] = [p[0] + 0.04, p[1], p[2]];
    expect(s.best([[far, [far[0] + 1, far[1], far[2]]]], far, 0.05)?.kind).toBe('endpoint');
  });

  it('turns off with no layers (streaming scan)', () => {
    const s = make(() => []);
    expect(s.available).toBe(false);
    expect(s.nearest([0, 0, 0], 10)).toBeNull();
  });
});

describe('deferred grid build', () => {
  it('builds one grid per task after a change and reuses it for queries', () => {
    const tasks: Array<() => void> = [];
    const s = new ProjectSnapIndex((t) => { tasks.push(t); });
    const C = grid();
    const D = grid();
    s.setProvider(() => [{ id: 'c', local: C, offset: [0, 0, 0] }, { id: 'd', local: D, offset: BIG }]);
    expect(tasks.length).toBe(1);
    tasks.shift()!();
    expect(tasks.length).toBe(1);
    tasks.shift()!();
    tasks.shift()!();
    expect(tasks.length).toBe(0);
    expect(s.nearest(at(BIG), 0.05)?.layerId).toBe('d');
  });
});
