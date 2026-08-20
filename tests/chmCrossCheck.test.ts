/**
 * chmCrossCheck.test.ts — CHM against an independent implementation.
 *
 * CHM (canopy height model) is DSM − DTM per cell, clamped at zero. Both parents
 * are E4: DSM (max return) and DTM (min return) each agree with PDAL
 * `writers.gdal` on the structure fixtures (tests/groundFilterPdalAgreement.test.ts).
 * This file closes the last step — that OLV's `heightAboveGround` (the production
 * CHM) agrees with PDAL's DSM minus PDAL's DTM on the same cells.
 *
 * The reference is DIFFERENCED, not a new tool. `run-pdal-chm-reference.mjs`
 * writes the `output_type: min` grid for each structure fixture beside the
 * existing `output_type: max` grid, and this file subtracts the two committed
 * PDAL grids. Because the structure fixtures place a ground return in every cell
 * plus roof/facade returns above it, the per-cell minimum is the ground and the
 * maximum is the top surface, so max − min is a real height above ground.
 *
 * WHY THIS SKIPS RATHER THAN FAILS WHEN THE REFERENCE IS ABSENT. Producing the
 * DTM-min grids needs PDAL, which is not a dependency of this project and is not
 * installed in CI. The skip is conditional on files that either exist or do not.
 * The moment they land the assertions run, and the CHM slot stays `pending`
 * until then, so no claim is promoted by a test that did not execute.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildDsm, heightAboveGround } from '../src/terrain/surface/buildDsm';
import { rasterizeDtm } from '../src/terrain/ground/rasterizeDtm';
import { crossCheck, REFERENCE_SLOTS } from '../src/validation/crossCheck';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';
import { FIXTURES, parseFixtureCsv, EXTENT_M, DTM_CELL_M } from '../scripts/generate-point-cloud-fixtures.mjs';

const PDAL_DIR = resolve(__dirname, '../validation/cross-implementation/pdal-pipeline/pdal');
const FIXTURE_DIR = resolve(__dirname, '../validation/cross-implementation/pdal-pipeline/fixtures');

const CELLS = Math.round(EXTENT_M / DTM_CELL_M);
const GRID = { originH1: 0, originH2: 0, cols: CELLS, rows: CELLS, cellSizeM: DTM_CELL_M } as const;
const NODATA = -9999;

const SLOT = REFERENCE_SLOTS.find((s) => s.claimId === 'CHM')!;
const STRUCTURE = FIXTURES.filter((f: { role: string }) => f.role === 'surface') as Array<{
  id: string;
  datasetId: string;
}>;

interface AsciiGrid {
  ncols: number;
  nrows: number;
  cellsize: number;
  nodata: number;
  /** Row-major, row 0 = NORTHERNMOST (ASCII Grid order). */
  values: Float64Array;
}

/** Minimal, strict ESRI ASCII Grid reader — a bad header or cell count throws. */
function readAsciiGrid(path: string): AsciiGrid {
  const text = readFileSync(path, 'utf8');
  const header: Record<string, number> = {};
  const lines = text.split('\n');
  let i = 0;
  for (; i < lines.length; i++) {
    const m = /^\s*([A-Za-z_]+)\s+(-?[\d.eE+-]+)\s*$/.exec(lines[i]);
    if (!m) break;
    header[m[1].toLowerCase()] = Number(m[2]);
  }
  for (const k of ['ncols', 'nrows', 'cellsize']) {
    if (!Number.isFinite(header[k])) throw new Error(`${path}: header missing "${k}"`);
  }
  const ncols = header.ncols;
  const nrows = header.nrows;
  const nums = lines.slice(i).join(' ').trim().split(/\s+/).filter(Boolean);
  if (nums.length !== ncols * nrows) {
    throw new Error(`${path}: ${nums.length} values, expected ${ncols * nrows} (${ncols} x ${nrows})`);
  }
  const values = new Float64Array(nums.length);
  for (let j = 0; j < nums.length; j++) values[j] = Number(nums[j]);
  return { ncols, nrows, cellsize: header.cellsize, nodata: header.nodata_value ?? NODATA, values };
}

/** Flip an ASCII Grid (north-first) to OLV's south-first row order. */
function flipRows(values: Float64Array, ncols: number, nrows: number): Float64Array {
  const out = new Float64Array(values.length);
  for (let r = 0; r < nrows; r++) {
    const src = r * ncols;
    const dst = (nrows - 1 - r) * ncols;
    for (let c = 0; c < ncols; c++) out[dst + c] = values[src + c];
  }
  return out;
}

/** PDAL's canopy height for a fixture: max grid − min grid, clamped at zero, in OLV row order. */
function referenceChm(id: string): Float64Array | null {
  const dsmPath = resolve(PDAL_DIR, `${id}__dsm-max.asc`);
  const dtmPath = resolve(PDAL_DIR, `${id}__dtm-min.asc`);
  if (!existsSync(dsmPath) || !existsSync(dtmPath)) return null;
  const dsm = readAsciiGrid(dsmPath);
  const dtm = readAsciiGrid(dtmPath);
  if (dsm.ncols !== CELLS || dsm.nrows !== CELLS || dtm.ncols !== CELLS || dtm.nrows !== CELLS) {
    throw new Error(`${id}: PDAL grids are not ${CELLS}x${CELLS}`);
  }
  const dsmZ = flipRows(dsm.values, CELLS, CELLS);
  const dtmZ = flipRows(dtm.values, CELLS, CELLS);
  const chm = new Float64Array(dsmZ.length).fill(Number.NaN);
  for (let i = 0; i < dsmZ.length; i++) {
    const a = dsmZ[i];
    const b = dtmZ[i];
    if (a === dsm.nodata || b === dtm.nodata || !Number.isFinite(a) || !Number.isFinite(b)) continue;
    chm[i] = Math.max(0, a - b);
  }
  return chm;
}

/** OLV's canopy height for a fixture, through the production path. */
function olvChm(id: string): Float64Array {
  const points = parseFixtureCsv(readFileSync(resolve(FIXTURE_DIR, `${id}.csv`), 'utf8')) as TerrainPoint[];
  const dsm = buildDsm(points, { grid: GRID, verticalAxis: 'z' });
  const dtm = rasterizeDtm(points, new Uint8Array(points.length).fill(1), {
    aggregation: 'min',
    grid: GRID,
    verticalAxis: 'z',
  });
  // Per-cell coverage: a cell is covered when it received a ground return.
  // `DemRaster.coverage` is the coverage MODE string, not a per-cell mask.
  const dtmCov = new Uint8Array(dtm.z.length);
  for (let i = 0; i < dtm.z.length; i++) dtmCov[i] = dtm.counts[i] > 0 && Number.isFinite(dtm.z[i]) ? 1 : 0;
  const canopy = heightAboveGround(dsm, dtm.z, dtmCov);
  return Float64Array.from(canopy.heightM);
}

const haveReference = STRUCTURE.every((s) => existsSync(resolve(PDAL_DIR, `${s.id}__dtm-min.asc`)));

describe('CHM cross-implementation', () => {
  it('has a declared PDAL slot with a pre-registered tolerance', () => {
    expect(SLOT.referenceTool).toBe('PDAL');
    expect(SLOT.toleranceAbs).toBe(0.1);
    expect(SLOT.unit).toBe('m');
  });

  const withReference = haveReference ? it : it.skip;

  withReference('agrees with PDAL (DSM − DTM) across every structure fixture', () => {
    const ours: number[] = [];
    const theirs: number[] = [];
    let comparable = 0;
    for (const spec of STRUCTURE) {
      const ref = referenceChm(spec.id)!;
      const olv = olvChm(spec.id);
      expect(olv.length, `${spec.id}: grid length`).toBe(ref.length);
      for (let i = 0; i < ref.length; i++) {
        // Both sides define CHM on every covered cell; a cell either side leaves
        // undefined is skipped rather than compared against a fabricated zero.
        if (!Number.isFinite(ref[i]) || !Number.isFinite(olv[i])) continue;
        ours.push(olv[i]);
        theirs.push(ref[i]);
        comparable++;
      }
    }
    // Three fixtures, 2500 cells each, all covered by construction.
    expect(comparable).toBe(STRUCTURE.length * CELLS * CELLS);

    const report = crossCheck(ours, theirs, { toleranceAbs: SLOT.toleranceAbs, minCells: 7500 });
    expect(report.verdict, report.summary).toBe('agree');
    // Printed so the published figure is read off a run, not typed in.
    console.log(`CHM  ours vs PDAL(DSM-DTM): ${report.summary}`);
  });

  withReference('a row flip on the reference breaks the agreement (no hidden symmetry)', () => {
    // CHM is not symmetric under a north-south flip on these fixtures — the
    // structures are placed off-centre — so a reference read in the wrong row
    // order must disagree, or the test would pass on a mis-oriented grid.
    const spec = STRUCTURE[0];
    const ref = referenceChm(spec.id)!;
    const olv = olvChm(spec.id);
    const flipped = flipRows(ref, CELLS, CELLS);
    const ours: number[] = [];
    const theirs: number[] = [];
    for (let i = 0; i < ref.length; i++) {
      if (!Number.isFinite(flipped[i]) || !Number.isFinite(olv[i])) continue;
      ours.push(olv[i]);
      theirs.push(flipped[i]);
    }
    const report = crossCheck(ours, theirs, { toleranceAbs: SLOT.toleranceAbs, minCells: 2000 });
    expect(report.verdict, `flipped reference still agreed: ${report.summary}`).not.toBe('agree');
  });

  it('keeps the slot pending until the reference is actually supplied', () => {
    expect(SLOT.status).toBe(haveReference ? 'supplied' : 'pending');
  });
});
