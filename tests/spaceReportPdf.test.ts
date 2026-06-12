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
});
