/**
 * rogueDtmSeam.test.ts — a tile-SEAM regression harness for the trusted
 * Class-2 DTM, developed as pre-freeze methodology on the Rogue 3DEP tiles.
 *
 * WHY. The delivered bare-earth DTM is normally built per loaded cloud. When a
 * survey is tiled (as 3DEP LAZ tiles are), the surface near a tile's edge is
 * interpolated / extrapolation-guarded from ground returns present ONLY inside
 * that tile — the neighbouring tile's returns, which sit just across the shared
 * edge, are not there to support it. Building the SAME area from the MOSAIC of
 * both tiles restores that neighbouring support. Comparing the two over the seam
 * band separates two very different things:
 *   - EXPECTED improvement: near the edge the mosaic has real returns the single
 *     tile had to interpolate across, so a modest Δz there is the surface getting
 *     BETTER with more evidence — not a defect.
 *   - UNEXPLAINED inconsistency: a large Δz over cells that were MEASURED in both
 *     builds (identical ground returns, identical grid) would indicate an
 *     edge/interpolation defect in the builder itself. That is a FINDING.
 * This harness surfaces both and labels them; it does NOT gate on a Δz threshold
 * (there is no survey truth here — the mosaic is not ground truth, it is more
 * evidence). It is a diagnostic run before the DTM is frozen, never a knob to
 * tune the DTM against any particular scene.
 *
 * WHAT IT BUILDS. For an ADJACENT pair A,B it builds three DTMs on ONE shared
 * grid (same origin, cell size and alignment) through the PRODUCTION leaves —
 * `rasterizeDtm` (median aggregation, `LIVE_DTM_AGGREGATION`) then
 * `buildSurfaceFromRaster` with `despike:false` (the trusted-Class-2 contract:
 * every measured ground node kept, geodesic void fill, extrapolation guard):
 *   DTM_A  — from tile A's Class-2 ground returns only
 *   DTM_B  — from tile B's Class-2 ground returns only
 *   DTM_AB — from the union of both tiles' Class-2 ground returns
 * Sharing the grid means cell [r,c] indexes the same ground square in all three,
 * so Δz = DTM_owner − DTM_AB is a like-for-like per-cell difference.
 *
 * RECENTRING. Both tiles are decoded in the SAME local frame — origin =
 * `computeOrigin(min over the two header minima)` (the production
 * `coordinateBridge` rule) — so the shared UTM easting/northing (hundreds of
 * thousands of metres) is subtracted in Float64 before the Float32 downcast.
 * Decoding UTM straight into Float32 with a [0,0,0] origin would snap every
 * coordinate to a ~0.5 m grid and manufacture a seam artefact that is not in the
 * data; the common origin is load-bearing for a metre-scale seam comparison.
 *
 * REPRODUCIBILITY. Env-gated, skips cleanly when unset (never a false PASS):
 *   ROGUE_DIR=/dir/of/USGS_LPC_OR_RogueSiskiyouNF_*.laz \
 *   [ SEAM_PAIR=<tileA>,<tileB> ] [ GF_STRIDE=N ] [ SEAM_CELL=1 ] [ SEAM_BAND=4 ] \
 *   npx vitest run tests/rogueDtmSeam.test.ts
 * Adjacency is detected from `validation/e5/manifests/ROGUE25.input.json` tile
 * bounds: two tiles are adjacent when they abut within `EDGE_TOL_M` along one
 * axis and overlap along the other. The first adjacent pair whose files both
 * exist under ROGUE_DIR is used unless SEAM_PAIR names one.
 *
 * OFFLINE RESULT (Rogue B19 tiles 3846 / 3847, shared Y edge at ~4647000;
 * GF_STRIDE=8 to bound a Node run; cell 1 m, band ±4 cells → 8 lines × 1000 =
 * 8000 comparable cells). The harness runs end to end and is deterministic (same
 * inputs → identical seam stats). Δz (tile − mosaic): bias −0.18 m, RMSE 0.92 m,
 * MAE 0.53 m, P95|Δ| 2.2 m, max|Δ| 4.7 m. Coverage transitions owner→mosaic:
 * i→i 6897, m→m 962, i→m 141. The band is dominated by cells INTERPOLATED in
 * BOTH builds (i→i): at stride 8 the dense-canopy Rogue ground is sparse near
 * the seam, and the single tile's one-sided interpolation there simply differs
 * from the mosaic's two-sided fill — expected edge behaviour, not a defect, and
 * where most of the Δz spread lives. The 962 cells MEASURED in both (m→m) carry
 * identical ground returns on an identical grid, so a large Δz there would be a
 * builder defect: that subset is the regression this guards. Numbers scale with
 * stride and are logged, never asserted.
 *
 * MEMORY. Tiles decode one at a time; per-tile only Class-2 returns are boxed
 * into TerrainPoint[]. It does NOT require all 25 tiles resident — just the two
 * of the chosen pair. A large tile should be strided (GF_STRIDE) on a laptop.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLasHeader } from '../src/io/lasHeader';
import { decodeLaz } from '../src/io/lazDecode';
import { computeOrigin } from '../src/io/coordinateBridge';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';
import { rasterizeDtm, type GridSpec, type DtmAggregation } from '../src/terrain/ground/rasterizeDtm';
import { buildSurfaceFromRaster } from '../src/terrain/ground/surfaceFromRaster';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';
import manifest from '../validation/e5/manifests/ROGUE25.input.json';

// Production trusted-Class-2 DTM contract (mirror of analyseContours):
// MEDIAN cell aggregation, despike OFF, geodesic fill + extrapolation guard
// (the last two live inside buildSurfaceFromRaster).
const AGG: DtmAggregation = 'median';
const GROUND_CLASS = 2; // ASPRS class 2 = ground

const ROGUE_DIR = process.env.ROGUE_DIR;
const STRIDE = Math.max(1, Math.floor(Number(process.env.GF_STRIDE ?? '1')));
const CELL_M = finitePos(Number(process.env.SEAM_CELL ?? '1'), 1);
const BAND = Math.max(1, Math.floor(Number(process.env.SEAM_BAND ?? '4')));
const EDGE_TOL_M = 1.5; // tiles abut within this gap along the shared edge

interface TileBounds {
  readonly basename: string;
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}
interface Pair {
  readonly a: TileBounds;
  readonly b: TileBounds;
  readonly axis: 'x' | 'y'; // axis the shared edge cuts across
  readonly boundaryWorld: number; // world coord of the shared edge on that axis
}

function finitePos(v: number, fallback: number): number {
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

interface ManifestBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}
const TILES: TileBounds[] = (
  manifest as unknown as { tiles: Array<{ basename: string; bounds: ManifestBounds }> }
).tiles.map((t) => ({
  basename: t.basename,
  minX: t.bounds.minX,
  maxX: t.bounds.maxX,
  minY: t.bounds.minY,
  maxY: t.bounds.maxY,
}));

/** Do the ranges [a0,a1] and [b0,b1] overlap by more than `min`? */
function overlaps(a0: number, a1: number, b0: number, b1: number, min: number): boolean {
  return Math.min(a1, b1) - Math.max(a0, b0) > min;
}

/**
 * Adjacent when the two tiles abut within EDGE_TOL_M on one axis (one's max ≈
 * the other's min) and share a real span on the other. Returns the seam
 * orientation and the world coordinate of the shared edge, or null.
 */
function adjacency(a: TileBounds, b: TileBounds): Pair | null {
  // Shared vertical edge (east–west neighbours): a.maxX ≈ b.minX (or vice
  // versa), and their Y spans overlap.
  for (const [w, e] of [[a, b], [b, a]] as const) {
    if (Math.abs(w.maxX - e.minX) <= EDGE_TOL_M && overlaps(a.minY, a.maxY, b.minY, b.maxY, CELL_M)) {
      return { a, b, axis: 'x', boundaryWorld: (w.maxX + e.minX) / 2 };
    }
  }
  // Shared horizontal edge (south–north neighbours): a.maxY ≈ b.minY.
  for (const [s, n] of [[a, b], [b, a]] as const) {
    if (Math.abs(s.maxY - n.minY) <= EDGE_TOL_M && overlaps(a.minX, a.maxX, b.minX, b.maxX, CELL_M)) {
      return { a, b, axis: 'y', boundaryWorld: (s.maxY + n.minY) / 2 };
    }
  }
  return null;
}

/** All adjacent pairs found in the manifest bounds. */
function allAdjacentPairs(): Pair[] {
  const pairs: Pair[] = [];
  for (let i = 0; i < TILES.length; i++) {
    for (let j = i + 1; j < TILES.length; j++) {
      const p = adjacency(TILES[i], TILES[j]);
      if (p) pairs.push(p);
    }
  }
  return pairs;
}

function pathFor(basename: string): string | null {
  if (!ROGUE_DIR) return null;
  const p = join(ROGUE_DIR, basename);
  return existsSync(p) ? p : null;
}

/** Resolve the pair to run: SEAM_PAIR override, else first pair both files present. */
function resolvePair(): { pair: Pair; pathA: string; pathB: string } | null {
  const pairs = allAdjacentPairs();
  const want = process.env.SEAM_PAIR;
  const norm = (s: string) => s.replace(/\.laz$/i, '');
  const candidates = want
    ? pairs.filter((p) => {
        const ids = want.split(',').map((s) => norm(s.trim()));
        const names = [norm(p.a.basename), norm(p.b.basename)];
        return ids.every((id) => names.some((n) => n.endsWith(id) || n.includes(id)));
      })
    : pairs;
  for (const pair of candidates) {
    const pathA = pathFor(pair.a.basename);
    const pathB = pathFor(pair.b.basename);
    if (pathA && pathB) return { pair, pathA, pathB };
  }
  return null;
}

/** Decode a tile's Class-2 ground returns into TerrainPoint[] in the shared frame. */
async function decodeGround(path: string, origin: [number, number, number]): Promise<TerrainPoint[]> {
  const bytes = readFileSync(path);
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const header = parseLasHeader(buf);
  const raw = await decodeLaz(buf, header, origin, STRIDE);
  const n = raw.classification.length;
  const pts: TerrainPoint[] = [];
  for (let i = 0; i < n; i++) {
    if (raw.classification[i] !== GROUND_CLASS) continue;
    pts.push({ x: raw.positions[i * 3], y: raw.positions[i * 3 + 1], z: raw.positions[i * 3 + 2] });
  }
  return pts;
}

/** A shared grid covering the union extent of two ground-point sets. */
function unionGrid(a: readonly TerrainPoint[], b: readonly TerrainPoint[], cellSizeM: number): GridSpec {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const set of [a, b]) {
    for (const p of set) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  const originH1 = Math.floor(minX);
  const originH2 = Math.floor(minY);
  return {
    originH1,
    originH2,
    cols: Math.max(1, Math.floor((maxX - originH1) / cellSizeM) + 1),
    rows: Math.max(1, Math.floor((maxY - originH2) / cellSizeM) + 1),
    cellSizeM,
  };
}

/** Build a trusted-Class-2 DTM on `grid` from ground points (production leaves). */
function buildDtm(pts: readonly TerrainPoint[], grid: GridSpec): DtmGrid {
  const ones = new Uint8Array(pts.length).fill(1); // points are already ground-only
  const raster = rasterizeDtm(pts, ones, { grid, aggregation: AGG, verticalAxis: 'z' });
  return buildSurfaceFromRaster(raster, { despike: false }).dtm;
}

interface SeamStats {
  bandCols: number;
  comparable: number; // cells finite in both owner-tile DTM and mosaic
  bias: number;
  rmse: number;
  mae: number;
  p95: number;
  maxAbs: number;
  overlapAreaM2: number;
  // coverage-state transitions owner→mosaic, keyed "<owner><mosaic>" of {v,i,m}
  transitions: Record<string, number>;
}

const COV = ['v', 'i', 'm'] as const; // 0 void, 1 interpolated, 2 measured

/**
 * Compare, over the seam band, each band cell's OWNER-tile DTM against the
 * mosaic DTM. Owner = the tile whose side of the shared edge the cell sits on.
 */
function seamCompare(
  pair: Pair,
  grid: GridSpec,
  origin: [number, number, number],
  dtmA: DtmGrid,
  dtmB: DtmGrid,
  dtmAB: DtmGrid,
): SeamStats {
  const { cols, rows, cellSizeM } = grid;
  // Local coordinate + grid index of the shared edge.
  const worldToLocal = pair.axis === 'x' ? pair.boundaryWorld - origin[0] : pair.boundaryWorld - origin[1];
  const originOnAxis = pair.axis === 'x' ? grid.originH1 : grid.originH2;
  const boundaryIdx = Math.floor((worldToLocal - originOnAxis) / cellSizeM);
  // Which tile owns the "low" side (smaller coord on the seam axis)?
  const lowIsA = pair.axis === 'x' ? pair.a.minX < pair.b.minX : pair.a.minY < pair.b.minY;
  const dtmLow = lowIsA ? dtmA : dtmB;
  const dtmHigh = lowIsA ? dtmB : dtmA;

  const diffs: number[] = [];
  const transitions: Record<string, number> = {};
  let bandCols = 0;
  let comparable = 0;
  const idxLo = boundaryIdx - BAND;
  const idxHi = boundaryIdx + BAND - 1;

  // Iterate the band's lines (columns for an x-seam, rows for a y-seam).
  for (let line = idxLo; line <= idxHi; line++) {
    if (line < 0 || (pair.axis === 'x' ? line >= cols : line >= rows)) continue;
    bandCols++;
    const owner = line < boundaryIdx ? dtmLow : dtmHigh;
    const span = pair.axis === 'x' ? rows : cols;
    for (let k = 0; k < span; k++) {
      const c = pair.axis === 'x' ? k * cols + line : line * cols + k;
      const zo = owner.z[c];
      const zm = dtmAB.z[c];
      const covO = owner.coverage[c];
      const covM = dtmAB.coverage[c];
      // Coverage-state transition tally over the whole band (all cells).
      const key = `${COV[covO]}->${COV[covM]}`;
      transitions[key] = (transitions[key] ?? 0) + 1;
      // Δz only over cells finite (non-void) in BOTH builds — a comparable cell.
      if (covO === 0 || covM === 0 || !Number.isFinite(zo) || !Number.isFinite(zm)) continue;
      diffs.push(zo - zm);
      comparable++;
    }
  }

  const n = diffs.length;
  let sum = 0;
  let sumSq = 0;
  let sumAbs = 0;
  let maxAbs = 0;
  for (const d of diffs) {
    sum += d;
    sumSq += d * d;
    const a = Math.abs(d);
    sumAbs += a;
    if (a > maxAbs) maxAbs = a;
  }
  const absSorted = diffs.map((d) => Math.abs(d)).sort((x, y) => x - y);
  const p95 = n === 0 ? 0 : absSorted[Math.min(n - 1, Math.floor(0.95 * (n - 1)))];
  return {
    bandCols,
    comparable,
    bias: n === 0 ? 0 : sum / n,
    rmse: n === 0 ? 0 : Math.sqrt(sumSq / n),
    mae: n === 0 ? 0 : sumAbs / n,
    p95,
    maxAbs,
    overlapAreaM2: n * cellSizeM * cellSizeM,
    transitions,
  };
}

describe.skipIf(!(ROGUE_DIR && resolvePair()))(
  'Rogue DTM tile-seam regression harness',
  () => {
    it('reports seam Δz + coverage-state changes between per-tile and mosaic DTMs', async () => {
      const resolved = resolvePair()!;
      const { pair, pathA, pathB } = resolved;

      // Shared local frame: origin over BOTH tiles' header minima.
      const ha = parseLasHeader(sliceOf(pathA));
      const hb = parseLasHeader(sliceOf(pathB));
      const origin = computeOrigin([
        Math.min(ha.min[0], hb.min[0]),
        Math.min(ha.min[1], hb.min[1]),
        Math.min(ha.min[2], hb.min[2]),
      ]);

      // Decode one tile at a time; keep only Class-2 returns.
      const gA = await decodeGround(pathA, origin);
      const gB = await decodeGround(pathB, origin);
      expect(gA.length).toBeGreaterThan(0);
      expect(gB.length).toBeGreaterThan(0);

      const grid = unionGrid(gA, gB, CELL_M);
      const dtmA = buildDtm(gA, grid);
      const dtmB = buildDtm(gB, grid);
      const dtmAB = buildDtm(gA.concat(gB), grid);

      const stats = seamCompare(pair, grid, origin, dtmA, dtmB, dtmAB);
      // Determinism: same inputs → identical seam stats.
      const stats2 = seamCompare(pair, grid, origin, dtmA, dtmB, dtmAB);

      // eslint-disable-next-line no-console
      console.log(
        [
          `pair: ${pair.a.basename.split('_').pop()} / ${pair.b.basename.split('_').pop()}  seam-axis=${pair.axis} @world=${pair.boundaryWorld}`,
          `ground pts: A=${gA.length.toLocaleString('en-US')} B=${gB.length.toLocaleString('en-US')}  stride=${STRIDE}`,
          `grid: ${grid.cols}x${grid.rows} @${grid.cellSizeM} m  band=+/-${BAND} cells (${stats.bandCols} lines)`,
          `comparable cells: ${stats.comparable}  overlap=${stats.overlapAreaM2.toFixed(0)} m^2`,
          `Δz (tile - mosaic):  bias=${stats.bias.toFixed(4)}  RMSE=${stats.rmse.toFixed(4)}  MAE=${stats.mae.toFixed(4)}  P95|Δ|=${stats.p95.toFixed(4)}  max|Δ|=${stats.maxAbs.toFixed(4)}  (m)`,
          `coverage transitions owner->mosaic: ${JSON.stringify(stats.transitions)}`,
        ].join('\n'),
      );

      // SANITY ONLY — this is a diagnostic, not a gate. No Δz threshold: the
      // mosaic is more evidence, not survey truth, so a large seam Δz is a
      // finding to read (interp-vs-measured vs jointly-measured), never a fail.
      expect(stats.bandCols).toBeGreaterThan(0);
      expect(stats.comparable).toBeGreaterThan(0);
      expect(stats2.bias).toBe(stats.bias);
      expect(stats2.rmse).toBe(stats.rmse);
      expect(stats2.comparable).toBe(stats.comparable);
    }, 600_000); // decode of two multi-million-point LAZ tiles + three DTM builds
  },
);

/** Read a file into an ArrayBuffer sized exactly to its bytes. */
function sliceOf(path: string): ArrayBuffer {
  const bytes = readFileSync(path);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
