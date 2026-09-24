/**
 * gen-terrain-access-fixture.ts — regenerates `tests/fixtures/terrain-access-utm.las`.
 *
 * The e2e drag-and-drop fixture used elsewhere in the suite (`dropDenseGridPly`)
 * is a local, unreferenced PLY; Terrain Access refuses outright on an
 * unresolved horizontal scale (UNITS_UNRESOLVED), so that fixture can never
 * reach the routing/export happy path in `tests/e2e/terrainAccessLab.spec.ts`.
 * This writes a small (30x30, 900-point) LAS file georeferenced to WGS 84 /
 * UTM zone 13N via a GeoKeys VLR, using the app's own LAS writer, so CI
 * exercises the real preview/selection/run/export surface instead of only
 * unit-testing it against a hand-built grid.
 *
 * Run: npx tsx scripts/gen-terrain-access-fixture.ts
 */
// `writeLas.ts` reads the vite-injected `__BUILD_IDENTITY__` global; stub it
// before importing, since this script runs outside the vite/vitest pipeline.
(globalThis as Record<string, unknown>).__BUILD_IDENTITY__ = {
  version: 'fixture-gen', commit: '0000000', dirty: false,
};

import { writeFileSync } from 'node:fs';

const { writeLas } = await import('../src/convert/writeLas');

interface GlobalPoints {
  readonly count: number;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly z: Float64Array;
  readonly classification?: Uint8Array;
}

const N = 30;
const CELL = 1.0; // metres
const ORIGIN_X = 500000.0; // UTM-like easting
const ORIGIN_Y = 4100000.0; // UTM-like northing
const ORIGIN_Z = 200.0;

const count = N * N;
const x = new Float64Array(count);
const y = new Float64Array(count);
const z = new Float64Array(count);
const classification = new Uint8Array(count).fill(2); // ground

let k = 0;
for (let i = 0; i < N; i++) {
  for (let j = 0; j < N; j++) {
    const u = i / (N - 1);
    const v = j / (N - 1);
    x[k] = ORIGIN_X + i * CELL;
    y[k] = ORIGIN_Y + j * CELL;
    // Gentle sinusoidal surface, well within any mobility-profile default.
    z[k] = ORIGIN_Z + Math.sin(u * 3.14159) * Math.cos(v * 3.14159) * 1.2;
    k++;
  }
}

const g: GlobalPoints = { count, x, y, z, classification };

const bytes = writeLas(g, {
  epsg: 32613, // WGS84 / UTM zone 13N — a real projected CRS
  isGeographic: false,
  linearUnitCode: 9001, // metre
});

writeFileSync('tests/fixtures/terrain-access-utm.las', bytes);
console.log('wrote', bytes.length, 'bytes to tests/fixtures/terrain-access-utm.las');
