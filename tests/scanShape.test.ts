/**
 * scanShape.test.ts — terrain (2.5-D height field) vs object (compact 3-D).
 */

import { describe, it, expect } from 'vitest';
import { classifyScanShape } from '../src/terrain/scanShape';

/** Interleave xyz triples into a Float32Array. */
function pts(triples: Array<[number, number, number]>): Float32Array {
  const a = new Float32Array(triples.length * 3);
  triples.forEach(([x, y, z], i) => { a[i * 3] = x; a[i * 3 + 1] = y; a[i * 3 + 2] = z; });
  return a;
}

describe('classifyScanShape', () => {
  it('flat, wide, single-surface terrain → terrain', () => {
    const t: Array<[number, number, number]> = [];
    for (let x = 0; x <= 100; x += 2)
      for (let y = 0; y <= 100; y += 2) t.push([x, y, 2 * Math.sin(x / 20) + Math.cos(y / 25)]);
    const s = classifyScanShape(pts(t));
    expect(s.kind).toBe('terrain');
    expect(s.up).toBe('z');
    expect(s.aspect).toBeLessThan(0.2);
    expect(s.overhangFraction).toBeLessThan(0.1);
  });

  it('detects a Y-up flat terrain (phone/glTF frame) without being told', () => {
    // Same flat field but with Y as the vertical axis — the up-axis must be
    // detected from geometry, not assumed to be Z.
    const t: Array<[number, number, number]> = [];
    for (let x = 0; x <= 100; x += 2)
      for (let z = 0; z <= 100; z += 2) t.push([x, 2 * Math.sin(x / 20) + Math.cos(z / 25), z]);
    const s = classifyScanShape(pts(t));
    expect(s.up).toBe('y');
    expect(s.kind).toBe('terrain');
  });

  it('a full cube shell → object regardless of detected up axis', () => {
    // All six faces: every axis sees two stacked faces, so the object verdict
    // doesn't depend on which axis is picked as up.
    const t: Array<[number, number, number]> = [];
    for (let u = 0; u <= 10; u += 0.5)
      for (let w = 0; w <= 10; w += 0.5) {
        t.push([u, w, 0], [u, w, 10]); // z faces
        t.push([u, 0, w], [u, 10, w]); // y faces
        t.push([0, u, w], [10, u, w]); // x faces
      }
    const s = classifyScanShape(pts(t));
    expect(s.kind).toBe('object');
    expect(s.aspect).toBeGreaterThan(0.65);
    expect(s.overhangFraction).toBeGreaterThan(0.2);
  });

  it('a steep single-surface dome is ambiguous (one signal only)', () => {
    // Compact aspect (tall relative to footprint) but a single surface with no
    // overhangs — could be a steep hill or an object, so don't claim terrain.
    const t: Array<[number, number, number]> = [];
    for (let x = -10; x <= 10; x += 0.5)
      for (let y = -10; y <= 10; y += 0.5) {
        const r = Math.hypot(x, y);
        if (r <= 10) t.push([x, y, 15 * (1 - r / 10)]); // cone, height 15, footprint 20
      }
    const s = classifyScanShape(pts(t));
    expect(s.aspect).toBeGreaterThan(0.65);
    expect(s.overhangFraction).toBeLessThan(0.2);
    expect(s.kind).toBe('ambiguous');
  });

  it('an explicit verticalAxis override is honoured', () => {
    // Force Z-up on a Y-up flat field: now the (wrong) axis sees the lateral
    // extent stacked, so it no longer reads as clean terrain.
    const t: Array<[number, number, number]> = [];
    for (let x = 0; x <= 100; x += 2)
      for (let z = 0; z <= 100; z += 2) t.push([x, Math.sin(x / 20), z]);
    const forced = classifyScanShape(pts(t), { verticalAxis: 'z' });
    expect(forced.up).toBe('z');
    expect(forced.kind).not.toBe('terrain');
  });

  it('too few points is ambiguous', () => {
    expect(classifyScanShape(pts([[0, 0, 0], [1, 1, 1]])).kind).toBe('ambiguous');
  });
});
