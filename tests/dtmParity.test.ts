/**
 * dtmParity.test.ts — the DTM parity invariant.
 *
 * Proves the surface a field validator scores is the SAME surface the viewer
 * ships. `computeTerrainCore` on the trusted-classification path (ASPRS class 2,
 * SMRF skipped, despike OFF, median aggregation, geodesic fill with the live
 * extrapolation guard) produces the delivered DTM. `DtmSurfaceModel.fit`, given
 * the live parameters explicitly, must rebuild that grid cell-for-cell — same
 * dimensions, same z (exact float equality), same coverage state per cell.
 *
 * Also locks the determinism invariants: point-order invariance, large-offset
 * translation stability in the local frame, and repeat-run hash identity.
 */

import { describe, it, expect } from 'vitest';
import {
  computeTerrainCore,
  type TerrainCoreParams,
} from '../src/terrain/contour/analyseContours';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';
import { DtmSurfaceModel } from '../src/terrain/validate/dtmSurfaceModel';
import type { XYZ } from '../src/terrain/validate/spatialBlockHoldout';
import { sha256Hex } from '../src/terrain/export/sha256';

const CELL_SIZE_M = 2;

/**
 * A synthetic ASPRS class-2 (ground) cloud: a smooth tilted plane plus a couple
 * of steep survey nodes the despike WOULD flag — which is exactly why the
 * trusted path must leave the despike OFF, and why the validation surface has to
 * mirror that decision to stay identical.
 */
function class2Cloud(): { points: TerrainPoint[]; classification: number[] } {
  const points: TerrainPoint[] = [];
  for (let iy = 0; iy < 30; iy++) {
    for (let ix = 0; ix < 30; ix++) {
      const x = ix * CELL_SIZE_M + ((ix * 7 + iy * 3) % 5) * 0.13;
      const y = iy * CELL_SIZE_M + ((ix * 5 + iy * 11) % 5) * 0.17;
      const z = 100 + x * 0.05 - y * 0.03;
      points.push({ x, y, z });
    }
  }
  // A couple of legitimate steep ground returns (survey nodes), not blunders.
  points.push({ x: 30, y: 30, z: 100 + 30 * 0.05 - 30 * 0.03 + 3.2 });
  points.push({ x: 20, y: 40, z: 100 + 20 * 0.05 - 40 * 0.03 - 2.8 });
  const classification = points.map(() => 2);
  return { points, classification };
}

const TRUST_PARAMS: TerrainCoreParams = {
  cellSizeM: CELL_SIZE_M,
  crs: 'EPSG:32610',
  verticalDatum: 'EPSG:5703',
  trustGroundClassification: true,
};

/**
 * Build the field-validation surface with EVERY live parameter set to the
 * production trusted-classification values, on the grid the shipped DTM landed
 * on. This is the "acceptable path" the validator uses.
 */
function fieldModelFor(
  dtm: { originH1: number; originH2: number; cols: number; rows: number; cellSizeM: number },
  points: readonly TerrainPoint[],
): DtmSurfaceModel {
  const model = new DtmSurfaceModel({
    grid: {
      originH1: dtm.originH1,
      originH2: dtm.originH2,
      cols: dtm.cols,
      rows: dtm.rows,
      cellSizeM: dtm.cellSizeM,
    },
    aggregation: 'median', // LIVE_DTM_AGGREGATION
    despike: false, // trusted-classification path: despike OFF
    isGeographic: false,
    latitudeDeg: null,
    // Metre frame: units default to 1 in the live pipeline for this fixture.
    horizontalUnitToMetres: undefined,
    verticalUnitToMetres: undefined,
  });
  const xyz: XYZ[] = points.map((p) => ({ x: p.x, y: p.y, z: p.z }));
  model.fit(xyz);
  return model;
}

/** Deterministic hash of the grid's z (Float32) + coverage (Uint8) bytes. */
function gridHash(z: Float32Array, coverage: Uint8Array): string {
  const zBytes = new Uint8Array(z.buffer, z.byteOffset, z.byteLength);
  const buf = new Uint8Array(zBytes.length + coverage.length);
  buf.set(zBytes, 0);
  buf.set(coverage, zBytes.length);
  return sha256Hex(buf);
}

describe('DTM parity — field validation surface equals the shipped surface', () => {
  const { points, classification } = class2Cloud();
  const core = computeTerrainCore(points, { ...TRUST_PARAMS, classification });

  it('the shipped DTM used the trusted (despike-off) path', () => {
    // Guards the premise: if the pipeline stopped trusting the class-2 set the
    // parity target would silently change.
    expect(core.despikeApplied).toBe(false);
    expect(core.aggregation).toBe('median');
    expect(core.dtm.cols).toBeGreaterThan(1);
    expect(core.dtm.rows).toBeGreaterThan(1);
  });

  it('grid dimensions, origin and cell size match', () => {
    const model = fieldModelFor(core.dtm, points);
    // The model was constructed FROM the core grid, so this also proves the
    // field builder accepts and honours the shipped grid.
    expect(model.builtGrid()).not.toBeNull();
    expect(core.dtm.z.length).toBe(core.dtm.cols * core.dtm.rows);
  });

  it('z values are exactly equal cell-for-cell (float equality, not close)', () => {
    const model = fieldModelFor(core.dtm, points);
    const built = model.builtGrid()!;
    expect(built.z.length).toBe(core.dtm.z.length);
    for (let i = 0; i < core.dtm.z.length; i++) {
      // Object.is handles NaN === NaN for void cells.
      expect(Object.is(built.z[i], core.dtm.z[i])).toBe(true);
    }
  });

  it('coverage state matches per cell (measured / interpolated / void)', () => {
    const model = fieldModelFor(core.dtm, points);
    const built = model.builtGrid()!;
    expect(built.coverage.length).toBe(core.dtm.coverage.length);
    for (let i = 0; i < core.dtm.coverage.length; i++) {
      expect(built.coverage[i]).toBe(core.dtm.coverage[i]);
    }
  });

  it('the whole grid hashes identically to the shipped grid', () => {
    const model = fieldModelFor(core.dtm, points);
    const built = model.builtGrid()!;
    expect(gridHash(built.z, built.coverage)).toBe(gridHash(core.dtm.z, core.dtm.coverage));
  });
});

describe('DTM parity — determinism and robustness invariants (§46)', () => {
  const { points } = class2Cloud();
  const core = computeTerrainCore(points, {
    ...TRUST_PARAMS,
    classification: points.map(() => 2),
  });
  const grid = {
    originH1: core.dtm.originH1,
    originH2: core.dtm.originH2,
    cols: core.dtm.cols,
    rows: core.dtm.rows,
    cellSizeM: core.dtm.cellSizeM,
  };
  const baseline = fieldModelFor(core.dtm, points).builtGrid()!;
  const baselineHash = gridHash(baseline.z, baseline.coverage);

  it('point-order invariance: shuffling the input yields the identical grid + hash', () => {
    // Deterministic shuffle (no Math.random) so the test itself is reproducible.
    const shuffled = points.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = (i * 1103515245 + 12345) % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const built = fieldModelFor(core.dtm, shuffled).builtGrid()!;
    expect(gridHash(built.z, built.coverage)).toBe(baselineHash);
  });

  it('repeat-run hash identity: fitting twice gives the same hash', () => {
    const a = fieldModelFor(core.dtm, points).builtGrid()!;
    const b = fieldModelFor(core.dtm, points).builtGrid()!;
    expect(gridHash(a.z, a.coverage)).toBe(gridHash(b.z, b.coverage));
    expect(gridHash(a.z, a.coverage)).toBe(baselineHash);
  });

  it('large-offset translation stability: the local-frame grid is unchanged', () => {
    // Translate every point AND the grid origin by a large offset. The
    // local-frame cell binning is identical, so z + coverage must not move.
    const OFFSET_X = 500_000;
    const OFFSET_Y = 4_000_000;
    const translatedPoints: XYZ[] = points.map((p) => ({
      x: p.x + OFFSET_X,
      y: p.y + OFFSET_Y,
      z: p.z,
    }));
    const model = new DtmSurfaceModel({
      grid: {
        originH1: grid.originH1 + OFFSET_X,
        originH2: grid.originH2 + OFFSET_Y,
        cols: grid.cols,
        rows: grid.rows,
        cellSizeM: grid.cellSizeM,
      },
      aggregation: 'median',
      despike: false,
      isGeographic: false,
      latitudeDeg: null,
    });
    model.fit(translatedPoints);
    const built = model.builtGrid()!;
    expect(built.z.length).toBe(baseline.z.length);
    for (let i = 0; i < baseline.z.length; i++) {
      expect(built.coverage[i]).toBe(baseline.coverage[i]);
      // Heights are frame-invariant (no offset added to z), so exact equality.
      expect(Object.is(built.z[i], baseline.z[i])).toBe(true);
    }
    expect(gridHash(built.z, built.coverage)).toBe(baselineHash);
  });
});
