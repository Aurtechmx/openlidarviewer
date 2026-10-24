/**
 * terrainCoverageFootprint.test.ts — a DTM cell carries a height only inside
 * the data's coverage.
 *
 * The fixture is a diagonal survey strip covering about a third of its square
 * bounding box, with a small hole in the middle of the strip. The fill used to
 * reach its full search radius outward from every edge of the strip, so the
 * empty corners of the box carried invented ground that contours, Flow Pulse
 * and Terrain Access then read as terrain. Every product here must treat those
 * cells as no data, while the interior hole is still filled.
 */
import { describe, expect, it } from 'vitest';

import { rasterizeDtm } from '../src/terrain/ground/rasterizeDtm';
import { buildSurfaceFromRaster, LIVE_COVERAGE_RADIUS_CELLS } from '../src/terrain/ground/surfaceFromRaster';
import { buildDtmGrid, isHonestDtm, type DtmGrid } from '../src/terrain/ground/cellConfidence';
import { coverageFootprint } from '../src/terrain/ground/coverageFootprint';
import { contoursAt } from '../src/terrain/contour/contoursAt';
import { FLOW_PULSE_DEFAULTS, runFlowPulse } from '../src/simulation/flowPulse/flowPulseRunner';
import { cellAnnouncement, describeCell } from '../src/simulation/flowPulse/flowGridCursor';
import { CELL_NODATA } from '../src/simulation/flowPulse/flowTypes';
import { terrainDtmToAccessGrid } from '../src/simulation/terrainAccess/dtmTerrainAccessGrid';
import { runTerrainAccess, TERRAIN_ACCESS_DEFAULTS } from '../src/simulation/terrainAccess/terrainAccessRunner';
import type { TerrainAccessProfile } from '../src/simulation/terrainAccess/terrainAccessTypes';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';
import { tallyDtmCellStatus } from '../src/terrain/quality/dtmCellStatus';
import { evaluateDtmQuality } from '../src/terrain/quality/dtmQualityGate';
import { FLOW_PROJECTED_SCALE, FLOW_TEST_IDENTITY } from './helpers/flowFixtures';

const SIZE = 120; // metres; 1 m cells
const HALF_WIDTH = 20; // |x − y| < 20 → a band over ~31 % of the box
const HOLE = { x: 60, y: 60, r: 4 };

function ground(x: number, y: number): number {
  return 100 + 0.05 * x + 0.02 * y + 0.5 * Math.sin(x / 9) * Math.cos(y / 11);
}

/** Two ground returns per square metre of the strip, none inside the hole. */
function stripPoints(): TerrainPoint[] {
  let s = 12345;
  const rand = (): number => {
    s = (s * 1103515245 + 12345) >>> 0;
    return s / 4294967296;
  };
  const pts: TerrainPoint[] = [];
  for (let gx = 0; gx < SIZE; gx++) {
    for (let gy = 0; gy < SIZE; gy++) {
      for (let k = 0; k < 2; k++) {
        const x = gx + rand();
        const y = gy + rand();
        if (Math.abs(x - y) >= HALF_WIDTH) continue;
        if (Math.hypot(x - HOLE.x, y - HOLE.y) < HOLE.r) continue;
        pts.push({ x, y, z: ground(x, y) } as TerrainPoint);
      }
    }
  }
  return pts;
}

function rasterOf(points: TerrainPoint[]) {
  return rasterizeDtm(points, new Uint8Array(points.length).fill(1), {
    grid: { originH1: 0, originH2: 0, cols: SIZE, rows: SIZE, cellSizeM: 1 },
    aggregation: 'median',
  });
}

/** Distance (cells) from cell centre (col,row) to the strip's centre line band. */
function bandDistance(col: number, row: number): number {
  const d = Math.abs(col + 0.5 - (row + 0.5)) / Math.SQRT2;
  return Math.max(0, d - HALF_WIDTH / Math.SQRT2);
}

const points = stripPoints();
const raster = rasterOf(points);
const { dtm } = buildSurfaceFromRaster(raster, { crs: 'EPSG:32610', verticalUnitToMetres: 1 });
const withDtm: DtmGrid = { ...dtm, verticalUnitToMetres: 1 };

const profile: TerrainAccessProfile = {
  name: 't', maxLongitudinalGrade: 100, maxCrossSlope: 100, maxStepHeight: 100, maxRuggedness: null,
  vehicleWidth: 0, vehicleLength: null, minimumTerrainConfidence: 0, unknownPolicy: 'block',
  obstacleHeightThreshold: null,
};

describe('coverageFootprint', () => {
  it('bridges gaps narrower than the disc and keeps a straight edge where it is', () => {
    // A 30 × 30 grid, measured everywhere left of column 15 except a 3-wide
    // slot that opens on the data edge.
    const cols = 30, rows = 30;
    const had = new Uint8Array(cols * rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < 15; c++) had[r * cols + c] = 1;
    for (let r = 12; r < 15; r++) for (let c = 8; c < 15; c++) had[r * cols + c] = 0;
    const fp = coverageFootprint(had, cols, rows, 4);
    // The slot (3 wide < 2 × 4) is bridged away from its mouth; at the mouth
    // an empty disc in the open area still reaches in.
    for (let r = 12; r < 15; r++) for (let c = 8; c < 11; c++) expect(fp[r * cols + c]).toBe(1);
    // Away from the grid border, nothing right of the data edge is added.
    for (let r = 5; r < 25; r++) for (let c = 15; c < 26; c++) expect(fp[r * cols + c]).toBe(0);
  });

  it('keeps a void the data encloses, however large', () => {
    const cols = 40, rows = 40;
    const had = new Uint8Array(cols * rows).fill(1);
    for (let r = 10; r < 30; r++) for (let c = 10; c < 30; c++) had[r * cols + c] = 0;
    const fp = coverageFootprint(had, cols, rows, 2);
    expect(fp.every((v) => v === 1)).toBe(true);
  });
});

describe('terrain outside a survey strip is no data', () => {
  it('fixture: the strip covers about a third of its box, and the old fill reached well past it', () => {
    let measured = 0;
    for (let i = 0; i < raster.counts.length; i++) if (raster.counts[i] > 0) measured++;
    const share = measured / raster.counts.length;
    expect(share).toBeGreaterThan(0.25);
    expect(share).toBeLessThan(0.4);
    // Without a footprint the fill covers far more than the strip.
    const unbounded = buildDtmGrid(raster, { interpolation: 'geodesic' });
    let filled = 0;
    for (let i = 0; i < unbounded.coverage.length; i++) if (unbounded.coverage[i] > 0) filled++;
    expect(filled / unbounded.coverage.length).toBeGreaterThan(share + 0.2);
  });

  it('leaves every cell away from the strip without a height', () => {
    expect(isHonestDtm(dtm)).toBe(true);
    let checked = 0;
    for (let row = 0; row < SIZE; row++) {
      for (let col = 0; col < SIZE; col++) {
        // Beyond a cell of edge raggedness, and clear of the grid border band
        // where the area past the box is unknown rather than empty.
        if (bandDistance(col, row) <= 2) continue;
        const nearBorder = Math.min(col, row, SIZE - 1 - col, SIZE - 1 - row) < LIVE_COVERAGE_RADIUS_CELLS;
        if (nearBorder) continue;
        const i = row * SIZE + col;
        expect(dtm.coverage[i], `cell ${col},${row}`).toBe(0);
        expect(Number.isNaN(dtm.z[i])).toBe(true);
        expect(dtm.confidence[i]).toBe(0);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(SIZE * SIZE * 0.4);
    // The empty corners of the box hold nothing.
    expect(dtm.coverage[SIZE - 1]).toBe(0); // col SIZE-1, row 0
    expect(dtm.coverage[(SIZE - 1) * SIZE]).toBe(0); // col 0, row SIZE-1
  });

  it('still fills the small hole inside the strip', () => {
    let holeCells = 0;
    for (let row = 0; row < SIZE; row++) {
      for (let col = 0; col < SIZE; col++) {
        if (Math.hypot(col + 0.5 - HOLE.x, row + 0.5 - HOLE.y) > HOLE.r - 1) continue;
        const i = row * SIZE + col;
        expect(raster.counts[i]).toBe(0);
        expect(dtm.coverage[i]).toBe(1);
        expect(Math.abs(dtm.z[i] - ground(col + 0.5, row + 0.5))).toBeLessThan(0.5);
        holeCells++;
      }
    }
    expect(holeCells).toBeGreaterThan(10);
  });

  it('draws no contour through a cell outside coverage', () => {
    const set = contoursAt(dtm, { intervalM: 0.5 });
    let segments = 0;
    for (const level of set.levels) {
      for (const s of level.segments) {
        const mx = (s.x1 + s.x2) / 2;
        const my = (s.y1 + s.y2) / 2;
        const col = Math.floor(mx - 0.5);
        const row = Math.floor(my - 0.5);
        for (const [dc, dr] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          expect(dtm.coverage[(row + dr) * SIZE + col + dc]).toBeGreaterThan(0);
        }
        segments++;
      }
    }
    expect(segments).toBeGreaterThan(100);
  });

  it('routes no Flow Pulse cell outside coverage, and reads them as no elevation', () => {
    const r = runFlowPulse(dtm, FLOW_PROJECTED_SCALE, FLOW_PULSE_DEFAULTS, FLOW_TEST_IDENTITY);
    if (!r.ok) throw new Error(r.reason);
    let readable = 0;
    for (let i = 0; i < dtm.coverage.length; i++) {
      if (dtm.coverage[i] === 0) {
        expect(r.grid.valid[i]).toBe(0);
        expect(r.routed.status[i]).toBe(CELL_NODATA);
        expect(r.accumulation.upstreamCells[i]).toBe(0);
      } else {
        readable++;
      }
      const to = r.routed.receiver[i];
      if (to >= 0) {
        expect(dtm.coverage[i]).toBeGreaterThan(0);
        expect(dtm.coverage[to]).toBeGreaterThan(0);
      }
    }
    expect(r.summary.readableCells).toBe(readable);
    const corner = describeCell(r.grid, r.routed, r.accumulation, r.contributingAreaM2, { col: SIZE - 1, row: 0 });
    expect(corner.readable).toBe(false);
    expect(corner.elevation).toBeNull();
    expect(cellAnnouncement(corner)).toBe(`Column ${SIZE - 1}, row 0, no elevation.`);
  });

  it('judges gaps over the surveyed area, not the empty corners of the grid', () => {
    const tally = tallyDtmCellStatus(dtm);
    // Every no-data cell here is outside the strip: none is a gap the data surrounds.
    expect(tally.outsideCoverage).toBe(tally.empty);
    expect(tally.empty / tally.total).toBeGreaterThan(0.5);
    const q = evaluateDtmQuality({
      tally, meanCellConfidence: dtm.meanConfidence, holdoutRmseM: 0.05, groundPointRatio: 1,
      coverageMode: 'full', crs: 'EPSG:32610', verticalDatum: 'EPSG:5703', recommendedIntervalM: 0.5,
    });
    expect(q.emptySurveyRatio).toBe(0);
    expect(q.emptyCellRatio).toBeGreaterThan(0.5);
    expect(q.reasons.join(' ')).not.toContain('has no data');
  });

  it('marks Terrain Access cells outside coverage unavailable', () => {
    const built = terrainDtmToAccessGrid(withDtm, FLOW_PROJECTED_SCALE);
    if (!built.ok) throw new Error(built.reason);
    for (let i = 0; i < dtm.coverage.length; i++) {
      if (dtm.coverage[i] === 0) {
        expect(built.grid.valid[i]).toBe(0);
        expect(Number.isNaN(built.grid.z[i])).toBe(true);
      }
    }
    const inStrip = 60 * SIZE + 50; // col 50, row 60
    const corner = SIZE - 1; // col SIZE-1, row 0
    const end = runTerrainAccess(withDtm, FLOW_PROJECTED_SCALE, profile, inStrip, corner, TERRAIN_ACCESS_DEFAULTS, FLOW_TEST_IDENTITY);
    expect(end.ok).toBe(false);
    if (!end.ok) expect(end.code).toBe('END_BLOCKED');
    // A route along the strip never leaves coverage.
    const along = runTerrainAccess(withDtm, FLOW_PROJECTED_SCALE, profile, 20 * SIZE + 20, 100 * SIZE + 100, TERRAIN_ACCESS_DEFAULTS, FLOW_TEST_IDENTITY);
    if (!along.ok) throw new Error(along.reason);
    for (const i of along.path) expect(dtm.coverage[i]).toBeGreaterThan(0);
  });
});
