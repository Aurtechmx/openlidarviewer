/**
 * spaceReportPdf.test.ts
 *
 * Smoke test for the lazy Space / Object Report PDF builder: it produces a valid
 * (non-empty, %PDF-headed) document for both an interior scan (with the embedded
 * floor plan) and an object scan, driven from real metrics. Asserts bytes only —
 * the field-level content is covered by spaceReportLayout.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { buildSpaceReportPdf } from '../src/render/measure/spaceReportPdf';
import { extractFloorPlan } from '../src/terrain/space/floorplan/extractFloorPlan';
import { spaceMetrics } from '../src/terrain/spaceMetrics';
import { objectMetrics } from '../src/terrain/objectMetrics';
import { classifyScanShape } from '../src/terrain/scanShape';

// 0.1 m sampling: dense enough that the wall-extraction pipeline produces a
// real plan to embed (0.5 m walls would be sparser than the 5 cm wall mask).
function room(W = 14, D = 29, H = 5, step = 0.1): Float32Array {
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

/** A z-up 10 × 8 × 2.5 m PARTITIONED two-room scan (divider at x = 5 with a
 * 0.9 m door gap), so the floor plan segments into two distinct rooms — the
 * room-drawing path the PDF embed exercises. FIX 1: a single open room reads
 * as 'open-space' instead, so the room path needs a genuinely partitioned scan. */
function twoRoomCloud(step = 0.05): Float32Array {
  const W = 10, D = 8, H = 2.5;
  const gapY: readonly [number, number] = [3.5, 4.4];
  const t: number[] = [];
  for (let x = 0; x <= W + 1e-9; x += step)
    for (let y = 0; y <= D + 1e-9; y += step) t.push(x, y, 0);
  for (let z = 0; z <= H + 1e-9; z += step) {
    for (let x = 0; x <= W + 1e-9; x += step) { t.push(x, 0, z); t.push(x, D, z); }
    for (let y = step; y < D - 1e-9; y += step) {
      t.push(0, y, z); t.push(W, y, z);
      if (y < gapY[0] - 1e-9 || y > gapY[1] + 1e-9) t.push(5, y, z); // divider
    }
  }
  return Float32Array.from(t);
}

function cubeShell(): Float32Array {
  const cube: number[] = [];
  for (let u = 0; u <= 4; u += 0.5)
    for (let w = 0; w <= 4; w += 0.5) {
      cube.push(u, w, 0, u, w, 4, u, 0, w, u, 4, w, 0, u, w, 4, u, w);
    }
  return Float32Array.from(cube);
}

const isPdf = (bytes: Uint8Array): boolean =>
  bytes.length > 800 &&
  bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF

describe('buildSpaceReportPdf', () => {
  it('builds an interior report with the embedded floor plan', async () => {
    const pos = room();
    const shape = classifyScanShape(pos);
    const space = spaceMetrics(pos, { upAxis: shape.up, spaceKind: 'interior', hasRgb: true });
    const floorPlan = extractFloorPlan(pos, { upAxis: shape.up });
    expect(floorPlan.wallRings.length).toBeGreaterThan(0); // the plan IS embedded
    const bytes = await buildSpaceReportPdf({
      space,
      name: 'House 360',
      softwareVersion: '0.4.3',
      metricVersion: 'v0.4.1',
      floorPlan,
    });
    expect(isPdf(bytes)).toBe(true);
  });

  it('builds an object report (no floor plan)', async () => {
    const pos = cubeShell();
    const space = spaceMetrics(pos, { upAxis: 'z', spaceKind: 'object', hasRgb: false });
    const bytes = await buildSpaceReportPdf({
      space,
      object: objectMetrics(pos),
      name: 'Sculpture',
      softwareVersion: '0.4.3',
      metricVersion: 'v0.4.1',
    });
    expect(isPdf(bytes)).toBe(true);
  });

  it('is graceful with null metrics', async () => {
    const bytes = await buildSpaceReportPdf({ space: null, name: 'Empty' });
    expect(isPdf(bytes)).toBe(true);
  });

  it('builds the imperial-unit interior report with rooms in the embed', async () => {
    // v0.4.6: the embedded plan's dimension line follows the caller's unit
    // system, and segmented rooms draw their labels — smoke both paths in one
    // build (text-level wording is covered by the SVG tests; pdf-lib content
    // streams are compressed, so this pins bytes + model preconditions).
    const pos = twoRoomCloud();
    const shape = classifyScanShape(pos);
    const space = spaceMetrics(pos, { upAxis: shape.up, spaceKind: 'interior', hasRgb: true });
    const floorPlan = extractFloorPlan(pos, { upAxis: shape.up });
    expect(floorPlan.rooms.length).toBeGreaterThanOrEqual(1); // rooms ARE drawn
    const bytes = await buildSpaceReportPdf({
      space,
      name: 'House 360',
      softwareVersion: '0.4.5',
      metricVersion: 'v0.4.1',
      floorPlan,
      unitSystem: 'imperial',
    });
    expect(isPdf(bytes)).toBe(true);
  });
});
