import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pickLoader, parseBuffer } from '../src/io/parseBuffer';
import type { LoadPlan } from '../src/io/loadPlan';

const here = dirname(fileURLToPath(import.meta.url));

function fixture(name: string): ArrayBuffer {
  const u8 = readFileSync(resolve(here, 'fixtures', name));
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

test('pickLoader returns a loader function for every supported format', () => {
  for (const format of ['ply', 'las', 'laz', 'obj', 'glb', 'gltf'] as const) {
    expect(typeof pickLoader(format)).toBe('function');
  }
});

test('pickLoader throws on an unknown format', () => {
  expect(() => pickLoader('unknown')).toThrow();
});

test('parseBuffer parses a PLY buffer into a PointCloud', async () => {
  const result = await parseBuffer(fixture('tiny.ply'), 'ply', 'tiny.ply');
  expect(result.cloud.pointCount).toBeGreaterThan(0);
  expect(result.downsampled).toBe(false);
  expect(result.originalPointCount).toBe(result.cloud.pointCount);
});

test('parseBuffer downsamples when a cloud exceeds the budget', async () => {
  // A deliberately tiny budget forces the 10-point fixture down the downsample path.
  const result = await parseBuffer(fixture('tiny.ply'), 'ply', 'tiny.ply', 4);
  expect(result.downsampled).toBe(true);
  expect(result.originalPointCount).toBeGreaterThan(result.cloud.pointCount);
});

/** Hand-build a LoadPlan; only the fields parseBuffer reads need be realistic. */
function plan(over: Partial<LoadPlan>): LoadPlan {
  return {
    mode: 'all',
    sourceCount: 12,
    stride: 1,
    targetCount: 12,
    budget: 4_000_000,
    memoryEstimateBytes: 0,
    memoryGuardTriggered: false,
    ...over,
  };
}

describe('parseBuffer — budget-aware fast load (LAS plan)', () => {
  test("'all' mode decodes every point and reports no downsampling", async () => {
    const result = await parseBuffer(
      fixture('tiny.las'), 'las', 'tiny.las', 4_000_000, plan({ mode: 'all' }),
    );
    expect(result.cloud.pointCount).toBe(12);
    expect(result.downsampled).toBe(false);
    expect(result.originalPointCount).toBe(12);
  });

  test("'stride' mode decodes a sparse sample but keeps the source count", async () => {
    const result = await parseBuffer(
      fixture('tiny.las'), 'las', 'tiny.las', 4_000_000,
      plan({ mode: 'stride', stride: 3, sourceCount: 12 }),
    );
    expect(result.cloud.pointCount).toBe(4); // ceil(12 / 3)
    expect(result.downsampled).toBe(true);
    expect(result.originalPointCount).toBe(12); // source count, not the sample
  });

  test("'voxel' mode decodes fully then reduces to the plan budget", async () => {
    const result = await parseBuffer(
      fixture('tiny.las'), 'las', 'tiny.las', 4_000_000, plan({ mode: 'voxel', budget: 5 }),
    );
    expect(result.originalPointCount).toBe(12); // the full decoded count
    expect(result.cloud.pointCount).toBeLessThanOrEqual(5);
    expect(result.downsampled).toBe(true);
  });
});
