/**
 * dtmFlowGrid.test.ts: the DTM crosses into routing without gaining ground.
 *
 * One translation carries the whole honesty burden here. `rasterizeDtm`
 * leaves a cell with no ground return as NaN, and a routing grid that copied
 * that straight across would read it as an elevation. Float32Array is
 * zero-filled, so the cell would become 0 m: a hole at sea level under every
 * gap in the survey, which is lower than any real terrain around it and
 * therefore collects the flow of the whole neighbourhood.
 *
 * The test builds a raster with a genuine NaN gap and asserts the gap stays a
 * wall through routing, rather than asserting the adapter's internals.
 */
import { describe, expect, it } from 'vitest';

import { CELL_NODATA, d8Flow } from '../src/simulation/flowPulse/d8Flow';
import {
  dtmToFlowGrid, terrainDtmToFlowGrid, type HorizontalScale,
} from '../src/simulation/flowPulse/dtmFlowGrid';
import { basisLimitations } from '../src/simulation/simulationInputBasis';
import type { DemRaster } from '../src/terrain/ground/rasterizeDtm';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

/** A raster from a row-major elevation list; `null` becomes NaN, as the rasteriser writes it. */
function demOf(
  rows: readonly (readonly (number | null)[])[],
  over: Partial<DemRaster> = {},
): DemRaster {
  const h = rows.length;
  const w = rows[0].length;
  const z = new Float32Array(w * h);
  const counts = new Uint32Array(w * h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const v = rows[r][c];
      z[r * w + c] = v === null ? Number.NaN : v;
      counts[r * w + c] = v === null ? 0 : 1;
    }
  }
  return {
    z, counts, cols: w, rows: h, cellSizeM: 1, originH1: 0, originH2: 0,
    coverage: 'full', sourcePointCount: w * h, analyzedPointCount: w * h,
    filledCellCount: [...counts].filter((n) => n > 0).length, warnings: [],
    ...over,
  };
}

const projected: HorizontalScale = {
  isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: true,
};

describe('a cell with no ground return is a wall, not sea level', () => {
  const dem = demOf([
    [5, null, 3],
    [5, null, 3],
  ]);

  it('marks the NaN cell invalid rather than giving it an elevation of zero', () => {
    const { grid } = dtmToFlowGrid(dem, projected);
    expect(grid.valid[1]).toBe(0);
    expect(grid.valid[4]).toBe(0);
    expect(grid.valid[0]).toBe(1);
  });

  it('keeps flow out of the gap once routed', () => {
    const { grid } = dtmToFlowGrid(dem, projected);
    const res = d8Flow(grid);
    expect(res.status[1]).toBe(CELL_NODATA);
    for (let i = 0; i < res.receiver.length; i++) {
      if (res.receiver[i] >= 0) expect(grid.valid[res.receiver[i]]).toBe(1);
    }
  });

  it('counts only the cells that carry an elevation', () => {
    const { basis } = dtmToFlowGrid(dem, projected);
    expect(basis.measuredCells).toBe(4);
    expect(basis.totalCells).toBe(6);
  });
});

describe('cell size becomes two metric lengths', () => {
  it('is isotropic in a projected frame', () => {
    const { grid } = dtmToFlowGrid(demOf([[1, 2]], { cellSizeM: 2 }), projected);
    expect(grid.cellMetresX).toBeCloseTo(2, 10);
    expect(grid.cellMetresY).toBeCloseTo(2, 10);
  });

  it('shortens the east–west axis by cos latitude in a geographic frame', () => {
    // The case a single scalar cell size gets wrong: a degree of longitude is
    // shorter than a degree of latitude everywhere but the equator.
    const { grid } = dtmToFlowGrid(demOf([[1, 2]]), {
      isGeographic: true, latitudeDeg: 60, unitToMetres: 1, resolved: true,
    });
    expect(grid.cellMetresX).toBeLessThan(grid.cellMetresY);
    expect(grid.cellMetresX / grid.cellMetresY).toBeCloseTo(Math.cos(60 * Math.PI / 180), 6);
  });
});

describe('the basis travels with the grid', () => {
  it('carries the raster coverage rather than assuming a full walk', () => {
    const { basis } = dtmToFlowGrid(demOf([[1]], { coverage: 'resident-only' }), projected);
    expect(basis.coverage).toBe('resident-only');
    expect(basis.complete).toBe(false);
  });

  it('leaves Withheld undeclared, because the raster carries no such field', () => {
    expect(dtmToFlowGrid(demOf([[1]]), projected).basis.withheldExcluded).toBeNull();
  });

  it('passes a caller declaration through unchanged', () => {
    expect(dtmToFlowGrid(demOf([[1]]), projected, true).basis.withheldExcluded).toBe(true);
    expect(dtmToFlowGrid(demOf([[1]]), projected, false).basis.withheldExcluded).toBe(false);
  });

  it('records an unresolved scale, while still producing a routable grid', () => {
    const { grid, basis } = dtmToFlowGrid(demOf([[3, 1]]), { ...projected, resolved: false });
    expect(basis.horizontalScaleResolved).toBe(false);
    // Direction is still computable: relative lengths are all routing needs.
    expect(d8Flow(grid).receiver[0]).toBe(1);
  });
});

/** A filled DtmGrid: every cell carries a height, provenance lives in `coverage`. */
function dtmOf(
  rows: readonly (readonly (number | null)[])[],
  interp: readonly (readonly boolean[])[] = [],
  over: Partial<DtmGrid> = {},
): DtmGrid {
  const h = rows.length;
  const w = rows[0].length;
  const n = w * h;
  const z = new Float32Array(n);
  const coverage = new Uint8Array(n);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const v = rows[r][c];
      const i = r * w + c;
      if (v === null) { coverage[i] = 0; continue; }
      // Filled even where interpolated: that is the point of the type.
      z[i] = v;
      coverage[i] = interp[r]?.[c] ? 1 : 2;
    }
  }
  return {
    z, coverage, confidence: new Float32Array(n), counts: new Uint32Array(n),
    interpDistanceCells: new Float32Array(n), cols: w, rows: h, cellSizeM: 1,
    originH1: 0, originH2: 0, crs: null, verticalDatum: null,
    coverageMode: 'full', ...over,
  } as DtmGrid;
}

describe('the analysed DTM reads its provenance, not NaN', () => {
  it('treats a coverage-none cell as absent although it carries a height', () => {
    // The trap: DtmGrid fills every cell, so a NaN test finds nothing absent.
    const dtm = dtmOf([[5, null, 3]]);
    expect(Number.isFinite(dtm.z[1])).toBe(true); // the height is there
    const { grid, basis } = terrainDtmToFlowGrid(dtm, projected);
    expect(grid.valid[1]).toBe(0); // and it is still not surface
    expect(basis.measuredCells).toBe(2);
  });

  it('routes over interpolated cells by default and counts them', () => {
    const dtm = dtmOf([[3, 2, 1]], [[false, true, false]]);
    const { grid, basis } = terrainDtmToFlowGrid(dtm, projected);
    expect(grid.valid[1]).toBe(1);
    expect(basis.interpolatedCells).toBe(1);
    expect(basisLimitations(basis).join(' ')).toMatch(/interpolated elevation/);
  });

  it('blocks them when the caller asks for measured ground only', () => {
    const dtm = dtmOf([[3, 2, 1]], [[false, true, false]]);
    const { grid, basis } = terrainDtmToFlowGrid(dtm, projected, { interpolated: 'block' });
    expect(grid.valid[1]).toBe(0);
    expect(basis.measuredCells).toBe(2);
    expect(basis.interpolatedCells).toBe(0);
  });

  it('carries the analysis coverage mode rather than assuming a full walk', () => {
    const dtm = dtmOf([[1, 2]], [], { coverageMode: 'resident-only' });
    const { basis } = terrainDtmToFlowGrid(dtm, projected);
    expect(basis.coverage).toBe('resident-only');
    expect(basis.complete).toBe(false);
  });
});
