/**
 * gen-storage-history-fixture.ts — regenerates `tests/fixtures/storage-history-regridded.las`.
 *
 * The e2e spec `tests/e2e/storageHistoryRow.spec.ts` needs a LAS whose stored integers carry an
 * earlier grid, so the scan report's "Storage history" row settles on a supported grid through the
 * real worker. 20 000 points are placed uniformly at random (fixed seed) over a 60 m square, rounded
 * to a 0.01 m grid, and then stored with the file's own 0.001 m scale (EPSG:32610, metres). About
 * 400 KB. Nothing in it comes from real data.
 *
 * Run: npx tsx scripts/gen-storage-history-fixture.ts
 */
(globalThis as Record<string, unknown>).__BUILD_IDENTITY__ = {
  version: 'fixture-gen', commit: '0000000', dirty: false,
};

import { writeFileSync } from 'node:fs';

const { writeLas } = await import('../src/convert/writeLas');

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const N = 20_000;
const SIZE = 60;
const OFFSET: [number, number, number] = [500_000, 4_200_000, 100];
const SCALE: [number, number, number] = [0.001, 0.001, 0.001];
const GRID = 0.01;

const r = rng(21);
const x = new Float64Array(N);
const y = new Float64Array(N);
const z = new Float64Array(N);
for (let i = 0; i < N; i++) {
  x[i] = OFFSET[0] + 0.001 * Math.round((GRID * Math.round((r() * SIZE) / GRID)) / 0.001);
  y[i] = OFFSET[1] + 0.001 * Math.round((GRID * Math.round((r() * SIZE) / GRID)) / 0.001);
  z[i] = OFFSET[2] + r() * 5;
}

const bytes = writeLas(
  { count: N, x, y, z },
  { epsg: 32610, isGeographic: false, linearUnitCode: 9001, quantisation: { scale: SCALE, offset: OFFSET } },
);
writeFileSync('tests/fixtures/storage-history-regridded.las', bytes);
console.log('wrote', bytes.length, 'bytes to tests/fixtures/storage-history-regridded.las');
