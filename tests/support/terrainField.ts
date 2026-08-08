/**
 * tests/support/terrainField.ts — shared readers for the committed terrain-field
 * fixtures (White Sands 3DEP ground, StREAM Lab survey crop, ASCII references).
 *
 * The harness legs all decode the same compact fixtures; centralising the
 * readers here keeps every new quick-win leg reading them the same way.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TerrainPoint } from '../../src/terrain/TerrainContracts';

export const DIR = resolve(__dirname, '../../validation/terrain-field');

// ── White Sands (bare-earth dunes) ───────────────────────────────────────────
export const WS_GROUND = resolve(DIR, 'crops/whitesands-dune__ground.f32');
export const WS_REF_BINCELL = resolve(DIR, 'references/whitesands-dune__bincell-dtm.asc');
export const WS_REF_PDAL = resolve(DIR, 'references/whitesands-dune__pdal-dtm.asc');
export const WS_GRID = { originH1: 360100, originH2: 3636100, cols: 100, rows: 100, cellSizeM: 1 } as const;

/** Read the White Sands ground fixture (Float32 x,y,z relative to the grid origin). */
export function readWhiteSandsGround(): TerrainPoint[] {
  const buf = readFileSync(WS_GROUND);
  const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const n = f.length / 3;
  const pts: TerrainPoint[] = new Array(n);
  for (let i = 0; i < n; i++) {
    pts[i] = { x: f[i * 3] + WS_GRID.originH1, y: f[i * 3 + 1] + WS_GRID.originH2, z: f[i * 3 + 2] };
  }
  return pts;
}

// ── StREAM Lab (survey-classified riparian) ──────────────────────────────────
export const SL_BIN = resolve(DIR, 'crops/sl-field.bin');
export const SL_REF_BINCELL = resolve(DIR, 'references/sl-field__bincell-dtm.asc');
export const SL_GRID = { originH1: 549240, originH2: 4118390, cols: 40, rows: 40, cellSizeM: 1 } as const;

/** Decode the packed SL crop: [xyz f32 n*3][rgb u16 n*3][rn u8][nr u8][cls u8]. */
export function readStreamLab(): {
  n: number; xyz: Float32Array; rgb: Uint16Array; rn: Uint8Array; nr: Uint8Array; cls: Uint8Array;
} {
  const buf = readFileSync(SL_BIN);
  const n = buf.byteLength / 21;
  let off = buf.byteOffset;
  const xyz = new Float32Array(buf.buffer, off, n * 3); off += n * 12;
  const rgb = new Uint16Array(buf.buffer, off, n * 3); off += n * 6;
  const rn = new Uint8Array(buf.buffer, off, n); off += n;
  const nr = new Uint8Array(buf.buffer, off, n); off += n;
  const cls = new Uint8Array(buf.buffer, off, n);
  return { n, xyz, rgb, rn, nr, cls };
}

/** StREAM class-2 ground returns as absolute TerrainPoints. */
export function streamLabGround(): TerrainPoint[] {
  const { n, xyz, cls } = readStreamLab();
  const pts: TerrainPoint[] = [];
  for (let i = 0; i < n; i++) {
    if (cls[i] === 2) pts.push({ x: xyz[i * 3] + SL_GRID.originH1, y: xyz[i * 3 + 1] + SL_GRID.originH2, z: xyz[i * 3 + 2] });
  }
  return pts;
}

// ── ESRI ASCII grid (south-up) ───────────────────────────────────────────────
export function readAsciiSouthUp(path: string): { cols: number; rows: number; nodata: number; z: Float64Array } {
  const lines = readFileSync(path, 'utf8').split('\n');
  const h: Record<string, number> = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const m = /^\s*([A-Za-z_]+)\s+(-?[\d.eE+-]+)\s*$/.exec(lines[i]);
    if (!m) break;
    h[m[1].toLowerCase()] = Number(m[2]);
  }
  const cols = h.ncols, rows = h.nrows, nodata = h.nodata_value ?? -9999;
  const nums = lines.slice(i).join(' ').trim().split(/\s+/).filter(Boolean).map(Number);
  const z = new Float64Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const fileRow = rows - 1 - r;
    for (let c = 0; c < cols; c++) z[r * cols + c] = nums[fileRow * cols + c];
  }
  return { cols, rows, nodata, z };
}

export const hasWhiteSands = (): boolean => existsSync(WS_GROUND);
export const hasStreamLab = (): boolean => existsSync(SL_BIN);
