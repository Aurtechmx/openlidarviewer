/**
 * terrainFieldValidation.test.ts — OLV terrain against real reference data.
 *
 * The synthetic cross-checks (slope/aspect/hillshade/contours) prove the
 * algorithms agree with GDAL on a surface whose answer is known in closed form.
 * This adds the other half: real airborne LiDAR, gridded by OLV and by an
 * independent implementation (PDAL) over a controlled boundary crop, compared
 * cell for cell.
 *
 * Dataset: USGS 3DEP LPC, White Sands NM 2020 (tile w3597n3635), a 100 m
 * interior crop of bare-earth dune terrain in NAD83(2011) / UTM 13N + NAVD88.
 * The crop's class-2 ground returns are committed as a compact fixture; the
 * PDAL mean-gridded DTM over the same crop is committed as the reference. Both
 * are public, agency-published data.
 *
 * WHY THIS IS NOT CIRCULAR. OLV and PDAL grid the SAME committed ground points
 * to the SAME grid, each with its own cell-mean implementation. Agreement means
 * OLV's rasteriser bins and averages real UTM coordinates the way an
 * independent tool does — cell assignment, edge handling, and the NAVD88
 * elevation range all exercised on data OLV did not generate.
 *
 * Skips when the reference is absent (a fresh checkout mid-generation); it is
 * committed, so the assertions run in CI with no PDAL or raw cloud present.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rasterizeDtm } from '../src/terrain/ground/rasterizeDtm';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';
import { crossCheck } from '../src/validation/crossCheck';
import { deriveClassification } from '../src/render/class/deriveClassification';

const DIR = resolve(__dirname, '../validation/terrain-field');
const GROUND = resolve(DIR, 'crops/whitesands-dune__ground.f32');
/** scipy binned_statistic_2d point-in-cell mean — the SAME operation OLV performs. */
const REF_BINCELL = resolve(DIR, 'references/whitesands-dune__bincell-dtm.asc');
/** PDAL writers.gdal windowed mean — a standard tool with a DIFFERENT aggregation window. */
const REF_PDAL = resolve(DIR, 'references/whitesands-dune__pdal-dtm.asc');

/** The crop's committed grid: 100 x 100 m at 1 m, lower-left UTM origin. */
const GRID = { originH1: 360100, originH2: 3636100, cols: 100, rows: 100, cellSizeM: 1 } as const;

/** Read the compact ground fixture (Float32 x,y,z, relative to the grid origin). */
function readGround(): TerrainPoint[] {
  const buf = readFileSync(GROUND);
  const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const n = f.length / 3;
  const pts: TerrainPoint[] = new Array(n);
  for (let i = 0; i < n; i++) {
    pts[i] = { x: f[i * 3] + GRID.originH1, y: f[i * 3 + 1] + GRID.originH2, z: f[i * 3 + 2] };
  }
  return pts;
}

/** ESRI ASCII Grid → row-major values with row 0 = SOUTH (flipped from the file's north-first order). */
function readAsciiSouthUp(path: string): { cols: number; rows: number; nodata: number; z: Float64Array } {
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
    const fileRow = rows - 1 - r; // file row 0 is north; flip to south-up
    for (let c = 0; c < cols; c++) z[r * cols + c] = nums[fileRow * cols + c];
  }
  return { cols, rows, nodata, z };
}

/** OLV's DTM over the committed crop, on the fixed grid. */
function olvDtm(): Float32Array {
  const pts = readGround();
  const isGround = new Uint8Array(pts.length).fill(1);
  return rasterizeDtm(pts, isGround, { grid: GRID, aggregation: 'mean' }).z;
}

/** Compare OLV's grid to an ASCII reference, cell for cell (both south-up). */
function compare(refPath: string, toleranceAbs: number, withinTolThreshold = 1) {
  const z = olvDtm();
  const ref = readAsciiSouthUp(refPath);
  const ours = Array.from(z, (v) => (Number.isFinite(v) ? v : NaN));
  const refArr = Array.from(ref.z, (v) => (v === ref.nodata ? NaN : v));
  return { ref, r: crossCheck(ours, refArr, { toleranceAbs, minCells: 1000, withinTolThreshold }) };
}

describe('OLV DTM vs real USGS 3DEP ground (White Sands dune crop)', () => {
  const hasGround = existsSync(GROUND);

  (hasGround ? it : it.skip)('grids real bare-earth ground into a DTM with true NAVD88 elevations', () => {
    const z = olvDtm();
    let zmin = Infinity, zmax = -Infinity, filled = 0;
    for (const v of z) if (Number.isFinite(v)) { zmin = Math.min(zmin, v); zmax = Math.max(zmax, v); filled++; }
    expect(filled).toBeGreaterThan(1000);
    expect(zmin).toBeGreaterThan(1230);
    expect(zmax).toBeLessThan(1245);
  });

  // Leg 1 — gridding correctness (E4). scipy binned_statistic_2d computes the
  // SAME point-in-cell mean in a separate codebase; agreement to a few mm proves
  // OLV bins and averages real UTM coordinates correctly. The small residual is
  // the Float32 crop fixture + the reference's 4-decimal rounding, not method.
  (existsSync(REF_BINCELL) && hasGround ? it : it.skip)(
    'agrees with an independent point-in-cell mean (scipy) to sub-cm',
    () => {
      const { r } = compare(REF_BINCELL, 0.005);
      // eslint-disable-next-line no-console
      console.log(`[terrain-field] OLV vs scipy point-in-cell: verdict=${r.verdict} cells=${r.count} max=${r.maxAbsDiff?.toExponential(3)} rmse=${r.rmse?.toExponential(3)}`);
      expect(r.count).toBeGreaterThan(1000);
      expect(r.verdict).toBe('agree');
    },
  );

  // Leg 2 — independent standard tool, DIFFERENT method (documented). PDAL
  // writers.gdal averages within a radial window (~1.41 m), so it differs from a
  // point-in-cell mean by the local slope across the window — measured here at
  // ~3 cm RMSE, far inside USGS 3DEP's stated vertical accuracy (~10 cm). The
  // tolerance is that data accuracy, set from the product spec, not the result.
  (existsSync(REF_PDAL) && hasGround ? it : it.skip)(
    'agrees with PDAL (windowed mean) within USGS 3DEP vertical accuracy',
    () => {
      const { r } = compare(REF_PDAL, 0.10, 0.98);
      // eslint-disable-next-line no-console
      console.log(`[terrain-field] OLV vs PDAL windowed: verdict=${r.verdict} cells=${r.count} max=${r.maxAbsDiff?.toExponential(3)} rmse=${r.rmse?.toExponential(3)} within=${r.withinTolFraction?.toFixed(4)}`);
      expect(r.count).toBeGreaterThan(1000);
      expect(r.verdict).toBe('agree');
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// StREAM Lab (VT drone survey) — a survey-CLASSIFIED riparian crop. Unlike the
// bare desert, it carries real above-ground truth (ground / high vegetation),
// so OLV's classifier and DTM can be checked against a published classification.
// ─────────────────────────────────────────────────────────────────────────────

const SL_BIN = resolve(DIR, 'crops/sl-field.bin');
const SL_REF_BINCELL = resolve(DIR, 'references/sl-field__bincell-dtm.asc');
const SL_REF_PUBLISHED = resolve(DIR, 'references/sl-field__published-dtm.asc');
const SL_GRID = { originH1: 549240, originH2: 4118390, cols: 40, rows: 40, cellSizeM: 1 } as const;

/** Decode the packed SL crop: [xyz f32 n*3][rgb u16 n*3][rn u8 n][nr u8 n][cls u8 n]. */
function readSl() {
  const buf = readFileSync(SL_BIN);
  // n from the total length: 12 (xyz) + 6 (rgb) + 1 + 1 + 1 = 21 bytes/point.
  const n = buf.byteLength / 21;
  let off = buf.byteOffset;
  const xyz = new Float32Array(buf.buffer, off, n * 3); off += n * 12;
  const rgb = new Uint16Array(buf.buffer, off, n * 3); off += n * 6;
  const rn = new Uint8Array(buf.buffer, off, n); off += n;
  const nr = new Uint8Array(buf.buffer, off, n); off += n;
  const cls = new Uint8Array(buf.buffer, off, n);
  return { n, xyz, rgb, rn, nr, cls };
}

describe('OLV on survey-classified drone data (StREAM Lab riparian crop)', () => {
  const has = existsSync(SL_BIN);

  // Leg A — ground classification against the survey. OLV's ground is more
  // INCLUSIVE than the survey's (the survey leaves ambiguous near-ground returns
  // Unclassified; OLV assigns them ground), so precision against the survey's
  // conservative class 2 is not the right metric — a definitional difference,
  // not an error. The robust checks are: OLV catches the survey's ground (high
  // recall), and when OLV calls a point vegetation it really is vegetation
  // (high precision). RGB and return counts are supplied, the same cues the
  // survey classifier had.
  (has ? it : it.skip)('catches survey ground and does not over-call vegetation', () => {
    const { n, xyz, rgb, rn, nr, cls } = readSl();
    const res = deriveClassification(new Float32Array(xyz), n, { colors: new Uint16Array(rgb), returnNumber: new Uint8Array(rn), returnCount: new Uint8Array(nr) });
    const codes = res.codes;
    let gtp = 0, gfn = 0, vtp = 0, vfp = 0;
    for (let i = 0; i < n; i++) {
      const refGround = cls[i] === 2, gotGround = codes[i] === 2;
      if (refGround && gotGround) gtp++; else if (refGround && !gotGround) gfn++;
      const refVeg = cls[i] >= 3 && cls[i] <= 5, gotVeg = codes[i] >= 3 && codes[i] <= 5;
      if (gotVeg && refVeg) vtp++; else if (gotVeg && !refVeg) vfp++;
    }
    const groundRecall = gtp / (gtp + gfn);
    const vegPrecision = vtp / (vtp + vfp);
    // eslint-disable-next-line no-console
    console.log(`[terrain-field] StREAM classification: groundRecall=${groundRecall.toFixed(3)} vegPrecision=${vegPrecision.toFixed(3)}`);
    expect(groundRecall).toBeGreaterThan(0.95);
    expect(vegPrecision).toBeGreaterThan(0.95);
  });

  // Leg B — DTM on the survey's ground returns (class 2), against the same
  // independent point-in-cell mean. Confirms OLV's gridding on ultra-dense drone
  // data at a different UTM zone (17N) matches the reference the way it does on
  // the sparse airborne desert.
  (existsSync(SL_REF_BINCELL) && has ? it : it.skip)(
    'grids survey ground into a DTM matching an independent point-in-cell mean',
    () => {
      const { n, xyz, cls } = readSl();
      const pts: TerrainPoint[] = [];
      for (let i = 0; i < n; i++) if (cls[i] === 2) pts.push({ x: xyz[i * 3] + SL_GRID.originH1, y: xyz[i * 3 + 1] + SL_GRID.originH2, z: xyz[i * 3 + 2] });
      const raster = rasterizeDtm(pts, new Uint8Array(pts.length).fill(1), { grid: SL_GRID, aggregation: 'mean' });
      const ref = readAsciiSouthUp(SL_REF_BINCELL);
      const ours = Array.from(raster.z, (v) => (Number.isFinite(v) ? v : NaN));
      const refArr = Array.from(ref.z, (v) => (v === ref.nodata ? NaN : v));
      const r = crossCheck(ours, refArr, { toleranceAbs: 0.005, minCells: 200 });
      // eslint-disable-next-line no-console
      console.log(`[terrain-field] StREAM DTM vs scipy: verdict=${r.verdict} cells=${r.count} max=${r.maxAbsDiff?.toExponential(3)} rmse=${r.rmse?.toExponential(3)}`);
      expect(r.count).toBeGreaterThan(200);
      expect(r.verdict).toBe('agree');
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Perturbation study — deterministic density reduction on the real White Sands
// ground. The spec's core chain: as support weakens, coverage must drop and the
// error must grow. No RNG — keep every k-th point, so the study is reproducible.
// ─────────────────────────────────────────────────────────────────────────────

import { gridErrorStats } from '../src/validation/terrainMetrics';
import { readEstoniaGround, readAsciiSouthUp as readAscii2, EST_GRID, EST_REF_BINCELL, hasEstonia } from './support/terrainField';

/** Keep every k-th point — a deterministic density reduction (no seed needed). */
function decimate(pts: TerrainPoint[], k: number): TerrainPoint[] {
  if (k <= 1) return pts;
  const out: TerrainPoint[] = [];
  for (let i = 0; i < pts.length; i += k) out.push(pts[i]);
  return out;
}

/**
 * OLV's DTM against the SURVEY'S OWN published product.
 *
 * The bin-cell check above is an implementation check: scipy and OLV compute
 * the same statistic, so they agree to millimetres. This one is different in
 * kind. The reference is the 0.1 m DTM the survey team published alongside the
 * point cloud (OpenTopography DOI 10.5069/G9NZ85W7), aggregated by mean onto
 * the crop's 1 m grid. Nothing about it shares a line of code or a method with
 * OLV.
 *
 * Three asymmetries make this a product-agreement bound and NOT an accuracy
 * figure, and the tolerance is set for them rather than against them:
 *
 *   1. Density. The committed crop is decimated 1:160, about 8 pts/m2 against
 *      the survey's 1,295 pts/m2. The published product saw 160 times more
 *      ground.
 *   2. Method. Theirs interpolates a continuous surface at 0.1 m; OLV takes
 *      the mean of the ground returns that actually fall in each 1 m cell.
 *   3. Fill. Their DTM covers all 1,600 cells because voids and the stream
 *      channel are interpolated (the channel carries interpolated bathymetry,
 *      not measured bed). OLV leaves a cell empty when no ground return lands
 *      in it. Only cells where BOTH carry a value are compared, so OLV is
 *      never scored against an invented elevation.
 *
 * What it establishes: on real riparian terrain, OLV's ground surface tracks
 * the surveyors' own product to within roughly a decimetre from a fraction of
 * the data. What it does not establish: accuracy against surveyed ground.
 * Neither surface here is a check shot, and agreement between two derived
 * products is not truth.
 */
describe('OLV DTM vs the survey team\'s published 0.1 m DTM (StREAM Lab)', () => {
  const has = existsSync(SL_BIN);
  (has ? it : it.skip)(
    'tracks the published product to within a decimetre on co-measured ground',
    () => {
      const { n, xyz, cls } = readSl();
      const pts: TerrainPoint[] = [];
      for (let i = 0; i < n; i++) {
        if (cls[i] !== 2) continue;
        pts.push({ x: xyz[i * 3] + SL_GRID.originH1, y: xyz[i * 3 + 1] + SL_GRID.originH2, z: xyz[i * 3 + 2] });
      }
      const raster = rasterizeDtm(pts, new Uint8Array(pts.length).fill(1), {
        grid: SL_GRID,
        aggregation: 'mean',
      });
      const ref = readAsciiSouthUp(SL_REF_PUBLISHED);
      const ours = Array.from(raster.z, (v) => (Number.isFinite(v) ? v : NaN));
      const theirs = Array.from(ref.z, (v) => (v === ref.nodata ? NaN : v));

      const diffs: number[] = [];
      for (let i = 0; i < ours.length; i++) {
        if (!Number.isFinite(ours[i]) || !Number.isFinite(theirs[i])) continue;
        diffs.push(ours[i] - theirs[i]);
      }
      expect(diffs.length, 'cells measured by both').toBeGreaterThan(500);

      const rmse = Math.sqrt(diffs.reduce((a, d) => a + d * d, 0) / diffs.length);
      const mean = diffs.reduce((a, d) => a + d, 0) / diffs.length;
      const within10cm = diffs.filter((d) => Math.abs(d) <= 0.1).length / diffs.length;

      // eslint-disable-next-line no-console
      console.log(
        `[terrain-field] StREAM DTM vs published product: cells=${diffs.length} ` +
          `mean=${mean.toFixed(4)} rmse=${rmse.toFixed(4)} within10cm=${(within10cm * 100).toFixed(1)}%`,
      );

      // Bounds chosen for the three asymmetries above, not fitted to the run.
      expect(rmse, 'RMSE against the published product').toBeLessThan(0.15);
      expect(Math.abs(mean), 'systematic offset').toBeLessThan(0.05);
      expect(within10cm, 'fraction within a decimetre').toBeGreaterThan(0.85);
    },
  );
});

describe('perturbation — density reduction degrades coverage and accuracy together', () => {
  const hasGround = existsSync(GROUND);
  const hasRef = existsSync(REF_BINCELL);

  (hasGround && hasRef ? it : it.skip)(
    'coverage falls and RMSE rises monotonically as ground density drops',
    () => {
      const full = readGround();
      const ref = readAsciiSouthUp(REF_BINCELL);
      const refArr = Array.from(ref.z, (v) => (v === ref.nodata ? NaN : v));
      const rows: Array<{ keep: number; cells: number; coverage: number; rmse: number }> = [];
      for (const k of [1, 4, 16, 64]) {
        const pts = decimate(full, k);
        const z = rasterizeDtm(pts, new Uint8Array(pts.length).fill(1), { grid: GRID, aggregation: 'mean' }).z;
        const ours = Array.from(z, (v) => (Number.isFinite(v) ? v : NaN));
        const s = gridErrorStats(ours, refArr, { nodata: NaN });
        rows.push({ keep: 1 / k, cells: s.n, coverage: s.coverage, rmse: s.rmse });
      }
      // eslint-disable-next-line no-console
      console.log('[terrain-field] density perturbation:', rows.map((r) => `1/${Math.round(1 / r.keep)}:cells=${r.cells},cov=${r.coverage.toFixed(2)},rmse=${r.rmse.toExponential(2)}`).join('  '));
      // Coverage is monotonically non-increasing as we drop points.
      for (let i = 1; i < rows.length; i++) expect(rows[i].coverage).toBeLessThanOrEqual(rows[i - 1].coverage + 1e-9);
      // The sparsest run covers materially less ground than the full-density run.
      expect(rows[rows.length - 1].coverage).toBeLessThan(rows[0].coverage);
      // And error grows: the sparsest run is worse than the full-density run
      // (which is ~0 against its own reference).
      expect(rows[rows.length - 1].rmse).toBeGreaterThan(rows[0].rmse);
    },
  );

  (hasGround && hasRef ? it : it.skip)('is deterministic — same decimation reproduces the same metrics', () => {
    const full = readGround();
    const ref = readAsciiSouthUp(REF_BINCELL);
    const refArr = Array.from(ref.z, (v) => (v === ref.nodata ? NaN : v));
    const run = () => {
      const pts = decimate(full, 8);
      const z = rasterizeDtm(pts, new Uint8Array(pts.length).fill(1), { grid: GRID, aggregation: 'mean' }).z;
      return gridErrorStats(Array.from(z, (v) => (Number.isFinite(v) ? v : NaN)), refArr, { nodata: NaN });
    };
    const a = run(), b = run();
    expect(a.n).toBe(b.n);
    expect(a.rmse).toBe(b.rmse);
    expect(a.coverage).toBe(b.coverage);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Estonia National LiDAR (Estonian Land Board, 2020) — a THIRD projection
// family. L-EST97 is a Lambert Conformal Conic grid (EPSG:3301) with an EH2000
// vertical datum, unlike the UTM/TM White Sands and StREAM crops. Gridding real
// class-2 ground here checks OLV bins and averages LCC easting/northing the way
// an independent tool does, on flat boreal-plain terrain (~1.6 m of relief).
// ─────────────────────────────────────────────────────────────────────────────

describe('OLV DTM vs real Estonia National LiDAR ground (Lambert Conformal Conic)', () => {
  const has = hasEstonia();

  (existsSync(EST_REF_BINCELL) && has ? it : it.skip)(
    'grids real class-2 ground into a DTM matching an independent point-in-cell mean (scipy)',
    () => {
      const pts = readEstoniaGround();
      const z = rasterizeDtm(pts, new Uint8Array(pts.length).fill(1), { grid: EST_GRID, aggregation: 'mean' }).z;
      const ref = readAscii2(EST_REF_BINCELL);
      const ours = Array.from(z, (v) => (Number.isFinite(v) ? v : NaN));
      const refArr = Array.from(ref.z, (v) => (v === ref.nodata ? NaN : v));
      const r = crossCheck(ours, refArr, { toleranceAbs: 0.005, minCells: 1000 });
      // eslint-disable-next-line no-console
      console.log(`[terrain-field] Estonia DTM vs scipy: verdict=${r.verdict} cells=${r.count} max=${r.maxAbsDiff?.toExponential(3)} rmse=${r.rmse?.toExponential(3)}`);
      expect(r.count).toBeGreaterThan(1000);
      expect(r.verdict).toBe('agree');
    },
  );

  (has ? it : it.skip)('carries the real EH2000 elevation range of the crop', () => {
    const z = rasterizeDtm(readEstoniaGround(), new Uint8Array(readEstoniaGround().length).fill(1), { grid: EST_GRID, aggregation: 'mean' }).z;
    let zmin = Infinity, zmax = -Infinity, filled = 0;
    for (const v of z) if (Number.isFinite(v)) { zmin = Math.min(zmin, v); zmax = Math.max(zmax, v); filled++; }
    expect(filled).toBeGreaterThan(1000);
    expect(zmin).toBeGreaterThan(47);
    expect(zmax).toBeLessThan(51);
  });
});
