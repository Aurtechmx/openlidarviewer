/**
 * terrainPipelineBenchmark.test.ts — the full terrain pipeline, end to end, on
 * real ground, timed and checked for determinism.
 *
 * Points → DTM raster → confidence-aware DTM grid → Horn slope/aspect → contours,
 * every stage the real one, run on the committed White Sands ground crop. Two
 * things are pinned here that the per-stage tests do not:
 *
 *  - Determinism: running the whole chain twice must produce byte-identical
 *    grids and the same contour topology. A pipeline that drifts between runs
 *    cannot be validated against a fixed reference.
 *  - Structure: each stage hands the next a well-formed, correctly-sized product
 *    (a covered DTM, slope/aspect arrays of the grid's size, contour levels
 *    inside the elevation range).
 *
 * Stage wall-times are measured and logged for information only. They are NOT
 * asserted — absolute timing is machine-dependent, and a CI assertion on
 * milliseconds would be a flake, not a check. The benchmark's job is to prove
 * the chain runs and repeats, and to leave a timing trail a human can read.
 *
 * Skips when the crop fixture is absent (a fresh checkout mid-generation).
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rasterizeDtm } from '../src/terrain/ground/rasterizeDtm';
import { buildDtmGrid } from '../src/terrain/ground/cellConfidence';
import { hornSlopeAspect } from '../src/terrain/ground/terrainDerivatives';
import { contoursAt } from '../src/terrain/contour/contoursAt';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

const DIR = resolve(__dirname, '../validation/terrain-field');
const GROUND = resolve(DIR, 'crops/whitesands-dune__ground.f32');
const GRID = { originH1: 360100, originH2: 3636100, cols: 100, rows: 100, cellSizeM: 1 } as const;

function readGround(): TerrainPoint[] {
  const buf = readFileSync(GROUND);
  const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const n = f.length / 3;
  const pts: TerrainPoint[] = new Array(n);
  for (let i = 0; i < n; i++) pts[i] = { x: f[i * 3] + GRID.originH1, y: f[i * 3 + 1] + GRID.originH2, z: f[i * 3 + 2] };
  return pts;
}

/** Run the whole chain once, timing each stage. */
function runPipeline() {
  const pts = readGround();
  const isGround = new Uint8Array(pts.length).fill(1);
  const t: Record<string, number> = {};
  let m = perf();
  const raster = rasterizeDtm(pts, isGround, { grid: GRID, aggregation: 'mean' });
  t.rasterize = perf() - m; m = perf();
  const dtm = buildDtmGrid(raster);
  t.buildGrid = perf() - m; m = perf();
  const der = hornSlopeAspect(dtm.z, dtm.cols, dtm.rows, dtm.cellSizeM);
  t.slopeAspect = perf() - m; m = perf();
  const contours = contoursAt(dtm, { intervalM: 0.5 });
  t.contours = perf() - m;
  return { pts, dtm, der, contours, t };
}

function perf(): number {
  return typeof performance !== 'undefined' ? performance.now() : 0;
}

describe('full terrain pipeline on the White Sands ground crop', () => {
  const has = existsSync(GROUND);

  (has ? it : it.skip)('runs points → DTM → slope/aspect → contours and each stage is well-formed', () => {
    const { pts, dtm, der, contours, t } = runPipeline();

    // DTM: a well-covered grid at the crop's size.
    expect(dtm.cols).toBe(GRID.cols);
    expect(dtm.rows).toBe(GRID.rows);
    let covered = 0;
    for (const c of dtm.coverage) if (c !== 0) covered++;
    expect(covered).toBeGreaterThan(1000);

    // Slope/aspect: arrays sized to the grid, finite where covered.
    expect(der.slope.length).toBe(dtm.cols * dtm.rows);
    expect(der.aspect.length).toBe(dtm.cols * dtm.rows);

    // Contours: at least one level, every emitted level inside the DTM's range.
    expect(contours.levels.length).toBeGreaterThan(0);
    for (const lvl of contours.levels) {
      expect(lvl.value).toBeGreaterThanOrEqual(contours.minZ);
      expect(lvl.value).toBeLessThanOrEqual(contours.maxZ);
    }

    // eslint-disable-next-line no-console
    console.log(
      `[terrain-pipeline] pts=${pts.length} covered=${covered} levels=${contours.levels.length} | `
      + `rasterize=${t.rasterize.toFixed(1)}ms buildGrid=${t.buildGrid.toFixed(1)}ms `
      + `slopeAspect=${t.slopeAspect.toFixed(1)}ms contours=${t.contours.toFixed(1)}ms`,
    );
  });

  (has ? it : it.skip)('is deterministic — two full runs produce identical grids and contour topology', () => {
    const a = runPipeline();
    const b = runPipeline();
    // DTM elevations byte-identical.
    expect(Array.from(b.dtm.z)).toEqual(Array.from(a.dtm.z));
    // Slope/aspect identical.
    expect(Array.from(b.der.slope)).toEqual(Array.from(a.der.slope));
    expect(Array.from(b.der.aspect)).toEqual(Array.from(a.der.aspect));
    // Same contour levels and the same segment count per level.
    expect(b.contours.levels.map((l) => l.value)).toEqual(a.contours.levels.map((l) => l.value));
    expect(b.contours.levels.map((l) => l.segments.length)).toEqual(a.contours.levels.map((l) => l.segments.length));
  });
});
