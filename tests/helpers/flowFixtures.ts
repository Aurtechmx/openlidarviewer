/**
 * flowFixtures.ts — the Flow Pulse test fixture shared across the routing,
 * click-guard, overlay-geometry, three.js-overlay and package specs: one
 * projected horizontal scale, one run identity, and one row-major DTM
 * builder (`null` marks a cell with no reachable data). Each spec used to
 * carry its own byte-identical copy; kept here once so a change to the
 * `DtmGrid` shape only needs updating in one place.
 */
import type { DtmGrid } from '../../src/terrain/ground/cellConfidence';
import type { HorizontalScale } from '../../src/simulation/flowPulse/dtmFlowGrid';
import type { FlowRunIdentity } from '../../src/simulation/flowPulse/flowPulseRunner';

/** A projected (non-geographic), horizontally-resolved frame. */
export const FLOW_PROJECTED_SCALE: HorizontalScale = {
  isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: true,
};

/** A stable run identity for a fixture run. */
export const FLOW_TEST_IDENTITY: FlowRunIdentity = {
  layerId: 'layer-a', filename: 'site.laz', sourceDigest: 'aaaa',
  analysisInputDigest: 'bbbb', build: '0.7.0-alpha.1', id: 'run-1',
  generatedAt: '2026-09-22T00:00:00.000Z', processingManifestHead: null,
};

/**
 * A filled `DtmGrid` from a row-major grid of elevations; `null` marks a
 * cell with no reachable data. `over` replaces any field on the base grid
 * (cell size, origin, coverage mode, …) for a fixture that needs one.
 */
export function flowDtmOf(
  rows: readonly (readonly (number | null)[])[],
  over: Partial<DtmGrid> = {},
): DtmGrid {
  const h = rows.length, w = rows[0].length, n = w * h;
  const z = new Float32Array(n);
  const coverage = new Uint8Array(n);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const v = rows[r][c];
      if (v === null) continue;
      z[r * w + c] = v;
      coverage[r * w + c] = 2; // measured
    }
  }
  return {
    z, coverage, confidence: new Float32Array(n), counts: new Uint32Array(n),
    interpDistanceCells: new Float32Array(n), cols: w, rows: h, cellSizeM: 1,
    originH1: 0, originH2: 0, crs: null, verticalDatum: null, coverageMode: 'full',
    ...over,
  } as DtmGrid;
}

/**
 * A fully-measured `DtmGrid` (no NoData cells, non-nullable rows) that also
 * declares the point-count/confidence fields some fixtures state explicitly.
 * Used by specs that build a Lab input directly from `DtmGrid`, rather than
 * through a `runFlowPulse` result.
 */
export function flowDtmOfCounted(rows: readonly (readonly number[])[]): DtmGrid {
  const h = rows.length, w = rows[0].length, n = w * h;
  const z = new Float32Array(n);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) z[r * w + c] = rows[r][c];
  return {
    z, coverage: new Uint8Array(n).fill(2), confidence: new Float32Array(n),
    counts: new Uint32Array(n), interpDistanceCells: new Float32Array(n),
    cols: w, rows: h, cellSizeM: 1, originH1: 0, originH2: 0, crs: null,
    verticalDatum: null, coverageMode: 'full', sourcePointCount: n,
    analyzedPointCount: n, meanConfidence: 1, warnings: [],
  } as DtmGrid;
}
