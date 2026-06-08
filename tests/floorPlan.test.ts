/**
 * floorPlan.test.ts
 *
 * The density-derived interior floor-plan sketch: a synthetic room yields an
 * outline that roughly matches its footprint extent, dominant wall directions
 * are detected, and the SVG renderer emits the outline path, scale bar,
 * dimensions (m + ft), the "approximate / not a survey" caption, and is
 * XML-escaped.
 */

import { describe, it, expect } from 'vitest';
import { computeFloorPlan } from '../src/terrain/space/floorPlan';
import { floorPlanSvg, escapeXml } from '../src/terrain/space/floorPlanSvg';

/** A z-up rectangular room shell (floor, ceiling, four walls). W × D × H. */
function room(W = 6, D = 10, H = 3, step = 0.25): Float32Array {
  const t: number[] = [];
  const push = (x: number, y: number, z: number): void => { t.push(x, y, z); };
  for (let x = 0; x <= W; x += step)
    for (let y = 0; y <= D; y += step) { push(x, y, 0); push(x, y, H); }
  for (let z = 0; z <= H; z += step)
    for (let x = 0; x <= W; x += step) { push(x, 0, z); push(x, D, z); }
  for (let z = 0; z <= H; z += step)
    for (let y = 0; y <= D; y += step) { push(0, y, z); push(W, y, z); }
  return Float32Array.from(t);
}

describe('computeFloorPlan', () => {
  it('traces an outline roughly matching the footprint extent', () => {
    const plan = computeFloorPlan(room(6, 10, 3), { upAxis: 'z' });
    expect(plan.outline.length).toBeGreaterThanOrEqual(4);
    // Dimensions ~ the room footprint (within a cell of slack).
    expect(plan.widthM).toBeGreaterThan(5);
    expect(plan.widthM).toBeLessThan(7);
    expect(plan.depthM).toBeGreaterThan(9);
    expect(plan.depthM).toBeLessThan(11);
    // The traced outline's bbox spans close to the full footprint.
    const xs = plan.outline.map((p) => p[0]);
    const ys = plan.outline.map((p) => p[1]);
    const ow = Math.max(...xs) - Math.min(...xs);
    const od = Math.max(...ys) - Math.min(...ys);
    expect(ow).toBeGreaterThan(5);
    expect(od).toBeGreaterThan(9);
  });

  it('detects dominant wall directions', () => {
    const plan = computeFloorPlan(room(6, 10, 3), { upAxis: 'z' });
    expect(plan.walls.length).toBeGreaterThanOrEqual(2);
    const sides = new Set(plan.walls.map((w) => w.side));
    // A closed room has near-full-height columns on all four sides.
    expect(sides.size).toBeGreaterThanOrEqual(2);
  });

  it('carries the honesty caveats and is graceful on too-few points', () => {
    const plan = computeFloorPlan(room(6, 10, 3), { upAxis: 'z' });
    expect(plan.reasons.join(' ')).toMatch(/not a measured floor plan/i);
    const tiny = computeFloorPlan(Float32Array.from([0, 0, 0, 1, 1, 1]), { upAxis: 'z' });
    expect(tiny.outline.length).toBe(0);
    expect(tiny.widthM).toBe(0);
  });

  it('respects the unit-to-metres scale', () => {
    // Same room geometry but in feet — 0.3048 m/ft should shrink the dims.
    const plan = computeFloorPlan(room(6, 10, 3), { upAxis: 'z', unitToMetres: 0.3048 });
    expect(plan.widthM).toBeGreaterThan(5 * 0.3048);
    expect(plan.widthM).toBeLessThan(7 * 0.3048);
  });
});

describe('floorPlanSvg', () => {
  it('emits outline path, scale bar, dimensions, and the not-a-survey caption', () => {
    const plan = computeFloorPlan(room(6, 10, 3), { upAxis: 'z' });
    const svg = floorPlanSvg(plan, { title: 'My Room' });
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
    expect(svg).toContain('<path'); // footprint outline
    expect(svg).toContain('<rect'); // scale bar (and background)
    expect(svg).toMatch(/Width .* m \(.* ft\)/); // dimensions m + ft
    expect(svg).toMatch(/not a measured floor plan \/ survey/i);
    expect(svg).toMatch(/not aligned to true north/i);
    expect(svg).toContain('My Room');
  });

  it('XML-escapes the title', () => {
    const plan = computeFloorPlan(room(6, 10, 3), { upAxis: 'z' });
    const svg = floorPlanSvg(plan, { title: 'A & B <bad> "x"' });
    expect(svg).toContain('A &amp; B &lt;bad&gt; &quot;x&quot;');
    expect(svg).not.toContain('<bad>');
  });

  it('escapeXml handles the metacharacters', () => {
    expect(escapeXml('<a>&"\'')).toBe('&lt;a&gt;&amp;&quot;&#39;');
  });
});
