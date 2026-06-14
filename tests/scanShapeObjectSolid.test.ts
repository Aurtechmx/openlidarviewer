/**
 * scanShapeObjectSolid.test.ts
 *
 * Regression for the compact-3D-solid object gate (real-world: an iPhone scan
 * of a seated statue read as TERRAIN). A wide compact object can land just under
 * both single object signals — aspect < 0.65 AND overhang < 0.2 — yet it is
 * plainly an object, not a height field. The gate catches it by requiring a
 * MODERATE aspect AND any GENUINE overhang together; a terrain height field
 * reads 0% overhang however steep, so a steep slope must stay terrain.
 */

import { describe, it, expect } from 'vitest';
import { classifyScanShape } from '../src/terrain/scanShape';
import { uniformSlope } from './fixtures/terrainScenes';

function f32(pts: { x: number; y: number; z: number }[]): Float32Array {
  const a = new Float32Array(pts.length * 3);
  pts.forEach((p, i) => { a[i * 3] = p.x; a[i * 3 + 1] = p.y; a[i * 3 + 2] = p.z; });
  return a;
}

/**
 * A wide low dome (single surface, up = y, aspect ≈ 0.6) with a sparse base
 * disk under a small inner patch, so a few columns carry two returns (base +
 * dome) → ~5% overhang. Mirrors the statue case: aspect 0.55–0.65, a few % of
 * stacking — under BOTH single object bars, decided only by the combined gate.
 */
function compactSolid(): Float32Array {
  const obj: number[] = [];
  const R = 5;
  const H = 6; // aspect ≈ H / (2R) = 0.6
  for (let i = 0; i < 1400; i++) {
    const t = (i / 1400) * Math.PI * 2;
    const r = R * Math.sqrt((i % 50) / 50);
    const x = r * Math.cos(t);
    const z = r * Math.sin(t);
    const y = H * Math.sqrt(Math.max(0, 1 - (r * r) / (R * R)));
    obj.push(x, y, z);
    if (r < R * 0.3 && i % 9 === 0) obj.push(x, 0, z);
  }
  return Float32Array.from(obj);
}

describe('compact-3D-solid object gate', () => {
  it('classifies a compact solid as an object even under both single signals', () => {
    const s = classifyScanShape(compactSolid());
    // Neither single signal reaches its own bar …
    expect(s.aspect).toBeGreaterThanOrEqual(0.55);
    expect(s.aspect).toBeLessThan(0.65);
    expect(s.overhangFraction).toBeGreaterThanOrEqual(0.03);
    expect(s.overhangFraction).toBeLessThan(0.2);
    // … yet the combined gate routes it to object, off the terrain pipeline.
    expect(s.kind).toBe('object');
    expect(s.spaceKind).toBe('object');
    expect(s.nonTerrain).toBe(true);
  });

  it('does NOT over-reach: a steep single-surface slope stays terrain', () => {
    // Aspect 0.80 (higher than the statue) but 0% overhang — a height field.
    const s = classifyScanShape(f32(uniformSlope({ gradient: 0.8 })));
    expect(s.overhangFraction).toBe(0);
    expect(s.spaceKind).toBe('terrain');
    expect(s.nonTerrain).toBe(false);
  });
});
