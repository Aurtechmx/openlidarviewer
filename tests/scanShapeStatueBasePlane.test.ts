/**
 * scanShapeStatueBasePlane.test.ts
 *
 * Regression for the base-plane misroute (real-world: a second iPhone statue
 * scan — the same class of object as the one the object gate was first tuned on
 * — read as TERRAIN). The object was captured together with a large flat ground
 * slab, which widens the footprint and pulls height/footprint (aspect) DOWN. On
 * the real file the shape router measured aspect 0.506 / overhang 4.4%, which
 * slipped just under the original ASPECT_SOLID bar of 0.55 and misrouted to the
 * terrain pipeline.
 *
 * The fix lowered ASPECT_SOLID to 0.45. This is safe because the load-bearing
 * guard for terrain is OVERHANG_SOLID, not the aspect bar: a height field reads
 * ~0% overhang however steep, so no slope can be promoted no matter how low the
 * aspect bar goes. This test pins BOTH halves:
 *   1. a compact object on a wide captured base slab (aspect in the 0.45–0.55
 *      band that used to misroute) now routes to object; and
 *   2. a terrain slope whose aspect lands in that SAME band stays terrain,
 *      because its overhang is 0%.
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
 * A compact dome (the object, up = y, R = 5, H = 6) sitting on a WIDER sparse
 * flat base slab (radius 6.2 — the captured ground plane). The slab widens the
 * footprint so aspect falls to ~0.50 (below the old 0.55 bar), while the dome
 * over the slab still stacks columns for a genuine overhang signal. Mirrors the
 * real Statue2 scan: aspect ~0.50, a few-to-mid % overhang — an object that
 * used to misroute to terrain purely because of its base plane.
 */
function statueOnBasePlane(): Float32Array {
  const obj: number[] = [];
  const R = 5, H = 6;
  const RB = 6.2; // wider captured ground slab
  for (let i = 0; i < 1400; i++) {
    const t = (i / 1400) * Math.PI * 2;
    const r = R * Math.sqrt((i % 50) / 50);
    const x = r * Math.cos(t), z = r * Math.sin(t);
    const y = H * Math.sqrt(Math.max(0, 1 - (r * r) / (R * R)));
    obj.push(x, y, z);
  }
  // sparse flat base slab out to RB — the ground captured around the object
  for (let i = 0; i < 900; i++) {
    const t = (i / 900) * Math.PI * 2 * 7.3;
    const r = RB * Math.sqrt((i % 90) / 90);
    obj.push(r * Math.cos(t), 0, r * Math.sin(t));
  }
  return Float32Array.from(obj);
}

describe('object-on-base-plane routing (statue misroute regression)', () => {
  it('routes a compact object on a wide captured base slab to object, not terrain', () => {
    const s = classifyScanShape(statueOnBasePlane());
    // Aspect lands in the band that used to misroute (< the old 0.55 bar) …
    expect(s.aspect).toBeGreaterThanOrEqual(0.45);
    expect(s.aspect).toBeLessThan(0.55);
    // … with a genuine overhang below the single-signal object bar (0.2), so
    // ONLY the combined solid gate (now at aspect ≥ 0.45) can promote it.
    expect(s.overhangFraction).toBeGreaterThanOrEqual(0.03);
    expect(s.overhangFraction).toBeLessThan(0.2);
    expect(s.spaceKind).toBe('object');
    expect(s.nonTerrain).toBe(true);
  });

  it('does NOT over-reach: a slope whose aspect is in the same band stays terrain', () => {
    // gradient 0.5 → aspect ~0.50 (inside the lowered band) but 0% overhang.
    // The overhang guard, not the aspect bar, keeps it terrain.
    const s = classifyScanShape(f32(uniformSlope({ gradient: 0.5 })));
    expect(s.aspect).toBeGreaterThanOrEqual(0.45);
    expect(s.aspect).toBeLessThan(0.55);
    expect(s.overhangFraction).toBe(0);
    expect(s.spaceKind).toBe('terrain');
    expect(s.nonTerrain).toBe(false);
  });
});
