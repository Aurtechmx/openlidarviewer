/**
 * contourCrossCheck.test.ts — CONTOURS against an independent implementation.
 *
 * Our marching-squares isolines (`contoursAt`) against GDAL's `gdal_contour`
 * on the SAME analytic DEM. This is the E4 rung: agreement with a second
 * implementation we did not write, on a surface whose true contours are known
 * in closed form (see docs/validation/cross-implementation.md).
 *
 * THREE-WAY, NOT PAIRWISE. The DEM is a tilted plane (see
 * scripts/make-contour-fixture.mjs), so its contour at level L is the exact
 * world line sx·(X−Xc) + sy·(Y−Yc) + z0 = L. On a plane, linear interpolation
 * along cell edges is exact, so all three answers should coincide:
 *
 *   ours  vs analytic — is our contour on the true level?
 *   GDAL  vs analytic — did the operator run the command we think, on this DEM?
 *   ours  vs GDAL     — the cross-implementation claim itself.
 *
 * The middle leg is what makes it worth doing: a GDAL run on the wrong DEM, or
 * with a half-cell georeferencing offset, shows up there rather than being
 * averaged into a plausible agreement.
 *
 * WHY THIS SKIPS WHEN THE REFERENCE IS ABSENT. Producing `contour-gdal.geojson`
 * needs GDAL, which is not a dependency of this project and is not installed in
 * CI. The skip is conditional on a file that either exists or does not. The
 * moment it lands the assertions run; `REFERENCE_SLOTS` keeps CONTOURS at its
 * recorded level until then, so no claim is promoted by a test that did not run.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { contoursAt } from '../src/terrain/contour/contoursAt';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';
import { REFERENCE_SLOTS } from '../src/validation/crossCheck';
import { GRID, analyticElevation } from '../scripts/make-contour-fixture.mjs';

const DIR = resolve(__dirname, 'fixtures/reference/contour');
const DEM = resolve(DIR, 'input-dem.asc');
const REF = resolve(DIR, 'contour-gdal.geojson');

/** The slot tolerance CONTOURS is validated at (metres). */
const TOL = 0.05;

/** Minimal ESRI ASCII Grid reader (row 0 = NORTH). */
function readAscii(path: string): { ncols: number; nrows: number; values: Float64Array } {
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  const header: Record<string, number> = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const m = /^\s*([A-Za-z_]+)\s+(-?[\d.eE+-]+)\s*$/.exec(lines[i]);
    if (!m) break;
    header[m[1].toLowerCase()] = Number(m[2]);
  }
  const ncols = header.ncols, nrows = header.nrows;
  const nums = lines.slice(i).join(' ').trim().split(/\s+/).filter(Boolean).map(Number);
  if (nums.length !== ncols * nrows) throw new Error(`${path}: ${nums.length} values, expected ${ncols * nrows}`);
  return { ncols, nrows, values: Float64Array.from(nums) };
}

/**
 * Build our DtmGrid from the ASCII grid. ASCII Grid writes the NORTH row first
 * and our grid is south-up (row 0 = low Y), so the rows are flipped; the origin
 * is the file's lower-left corner so our world coordinates match GDAL's.
 */
function dtmFromAscii(): DtmGrid {
  const { ncols, nrows, values } = readAscii(DEM);
  const n = ncols * nrows;
  const z = new Float32Array(n);
  for (let r = 0; r < nrows; r++) {
    const fileRow = nrows - 1 - r; // flip north-first → south-up
    for (let c = 0; c < ncols; c++) z[r * ncols + c] = values[fileRow * ncols + c];
  }
  return {
    z,
    confidence: new Float32Array(n).fill(100),
    coverage: new Uint8Array(n).fill(2),
    counts: new Uint32Array(n).fill(1),
    interpDistanceCells: new Float32Array(n),
    cols: ncols, rows: nrows, cellSizeM: GRID.cellsize,
    originH1: GRID.xllcorner, originH2: GRID.yllcorner,
    crs: 'EPSG:32610', verticalDatum: null, coverageMode: 'full',
    sourcePointCount: n, analyzedPointCount: n, meanConfidence: 100, warnings: [],
  } as DtmGrid;
}

interface Seg { x1: number; y1: number; x2: number; y2: number }
/** GDAL contour lines grouped by level. */
function gdalSegmentsByLevel(): Map<number, Seg[]> {
  const gj = JSON.parse(readFileSync(REF, 'utf8')) as {
    features: Array<{ properties: { elev: number }; geometry: { type: string; coordinates: number[][] } }>;
  };
  const byLevel = new Map<number, Seg[]>();
  for (const f of gj.features) {
    const L = f.properties.elev;
    const arr = byLevel.get(L) ?? [];
    const c = f.geometry.coordinates;
    for (let i = 1; i < c.length; i++) arr.push({ x1: c[i - 1][0], y1: c[i - 1][1], x2: c[i][0], y2: c[i][1] });
    byLevel.set(L, arr);
  }
  return byLevel;
}

/** Distance from a point to a segment. */
function pointToSeg(px: number, py: number, s: Seg): number {
  const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - s.x1) * dx + (py - s.y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (s.x1 + t * dx), py - (s.y1 + t * dy));
}

describe('CONTOURS cross-implementation (ours vs GDAL vs analytic)', () => {
  const set = contoursAt(dtmFromAscii(), { intervalM: 0.5 });
  const ourVerts: Array<{ x: number; y: number; L: number }> = [];
  for (const level of set.levels) {
    for (const s of level.segments) {
      ourVerts.push({ x: s.x1, y: s.y1, L: level.value }, { x: s.x2, y: s.y2, L: level.value });
    }
  }

  it('produces contour levels across the surface', () => {
    expect(set.levels.length).toBeGreaterThanOrEqual(5);
    expect(ourVerts.length).toBeGreaterThan(100);
  });

  it('ours: every contour vertex sits on its analytic level', () => {
    let maxRes = 0;
    for (const v of ourVerts) maxRes = Math.max(maxRes, Math.abs(analyticElevation(v.x, v.y) - v.L));
    expect(maxRes).toBeLessThan(TOL);
  });

  const hasRef = existsSync(REF);
  (hasRef ? it : it.skip)('GDAL: every reference vertex sits on its analytic level', () => {
    const gj = JSON.parse(readFileSync(REF, 'utf8')) as {
      features: Array<{ properties: { elev: number }; geometry: { coordinates: number[][] } }>;
    };
    let maxRes = 0;
    for (const f of gj.features) {
      for (const [X, Y] of f.geometry.coordinates) maxRes = Math.max(maxRes, Math.abs(analyticElevation(X, Y) - f.properties.elev));
    }
    expect(maxRes).toBeLessThan(TOL);
  });

  (hasRef ? it : it.skip)('ours vs GDAL: every one of our vertices lies on a GDAL contour of the same level', () => {
    const gdal = gdalSegmentsByLevel();
    let maxDist = 0;
    let compared = 0;
    for (const v of ourVerts) {
      const segs = gdal.get(v.L);
      if (!segs || segs.length === 0) continue; // a level GDAL clipped at the edge
      let best = Infinity;
      for (const s of segs) best = Math.min(best, pointToSeg(v.x, v.y, s));
      maxDist = Math.max(maxDist, best);
      compared++;
    }
    expect(compared).toBeGreaterThan(100);
    expect(maxDist).toBeLessThan(TOL);
  });

  it('CONTOURS slot records its state honestly', () => {
    const slot = REFERENCE_SLOTS.find((s) => s.claimId === 'CONTOURS');
    expect(slot).toBeDefined();
    // When the GDAL reference is committed the slot is 'supplied'; otherwise the
    // cross-check has not run here and the slot must stay 'pending'.
    if (!hasRef) expect(slot!.status).toBe('pending');
  });
});
