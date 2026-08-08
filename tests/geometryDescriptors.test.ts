/**
 * geometryDescriptors.test.ts — shape descriptors validated on canonical shapes.
 */

import { describe, it, expect } from 'vitest';
import { descriptorsForNeighborhood } from '../src/classification/geometryDescriptors';
import { SpatialHash3d } from '../src/classification/spatialHash3d';

function flat(pts: Array<[number, number, number]>): Float32Array {
  const a = new Float32Array(pts.length * 3);
  pts.forEach((p, i) => { a[i * 3] = p[0]; a[i * 3 + 1] = p[1]; a[i * 3 + 2] = p[2]; });
  return a;
}
const ids = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

describe('canonical shapes produce the expected descriptor signatures', () => {
  it('a collinear set is linear (linearity high, planarity/sphericity low)', () => {
    const pts = flat(Array.from({ length: 21 }, (_, i) => [i * 0.1, 0, 0] as [number, number, number]));
    const d = descriptorsForNeighborhood(pts, ids(21))!;
    expect(d.linearity).toBeGreaterThan(0.98);
    expect(d.planarity).toBeLessThan(0.05);
    expect(d.sphericity).toBeLessThan(0.05);
  });

  it('a horizontal plane is planar with LOW verticality (normal points up)', () => {
    const pts: Array<[number, number, number]> = [];
    for (let x = 0; x < 7; x++) for (let y = 0; y < 7; y++) pts.push([x, y, 0]);
    const d = descriptorsForNeighborhood(flat(pts), ids(pts.length))!;
    expect(d.planarity).toBeGreaterThan(0.9);
    expect(d.linearity).toBeLessThan(0.1);
    expect(d.verticality).toBeLessThan(0.05); // roof-like
  });

  it('a vertical plane is planar with HIGH verticality (normal is horizontal)', () => {
    const pts: Array<[number, number, number]> = [];
    for (let x = 0; x < 7; x++) for (let z = 0; z < 7; z++) pts.push([x, 0, z]); // x-z plane, normal ±y
    const d = descriptorsForNeighborhood(flat(pts), ids(pts.length))!;
    expect(d.planarity).toBeGreaterThan(0.9);
    expect(d.verticality).toBeGreaterThan(0.95); // wall-like
  });

  it('an isotropic blob is spherical (sphericity high, linearity/planarity low)', () => {
    const pts: Array<[number, number, number]> = [];
    for (let x = -2; x <= 2; x++) for (let y = -2; y <= 2; y++) for (let z = -2; z <= 2; z++) pts.push([x, y, z]);
    const d = descriptorsForNeighborhood(flat(pts), ids(pts.length))!;
    expect(d.sphericity).toBeGreaterThan(0.5);
    expect(d.linearity).toBeLessThan(0.2);
    expect(d.planarity).toBeLessThan(0.2);
  });

  it('returns null for a degenerate (<3 point) neighbourhood', () => {
    expect(descriptorsForNeighborhood(flat([[0, 0, 0], [1, 1, 1]]), [0, 1])).toBeNull();
  });

  it('feeds off the spatial hash: descriptors on a wire vs a roof neighbourhood differ as expected', () => {
    // A horizontal wire (linear) and a roof patch (planar) in one cloud.
    const wire: Array<[number, number, number]> = Array.from({ length: 15 }, (_, i) => [i * 0.2, 50, 10]);
    const roof: Array<[number, number, number]> = [];
    for (let x = 0; x < 6; x++) for (let y = 0; y < 6; y++) roof.push([x * 0.2, y * 0.2, 3]);
    const all = flat([...wire, ...roof]);
    const hash = new SpatialHash3d(all, 1.0);
    // A point on the wire.
    const wIds = hash.queryRadius(wire[7][0], wire[7][1], wire[7][2], 1.0);
    const wD = descriptorsForNeighborhood(all, wIds)!;
    expect(wD.linearity).toBeGreaterThan(wD.planarity);
    // A point on the roof.
    const rIds = hash.queryRadius(roof[18][0], roof[18][1], roof[18][2], 1.0);
    const rD = descriptorsForNeighborhood(all, rIds)!;
    expect(rD.planarity).toBeGreaterThan(rD.linearity);
  });
});
