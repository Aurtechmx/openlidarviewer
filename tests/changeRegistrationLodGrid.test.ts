/**
 * Regression tests for three change-detection defects found by an external
 * audit (v0.7.0):
 *  1. the alignment reported the SOLVER residual (yaw + x/y/z) while applying
 *     only yaw + x/y, and that residual was fed into the LoD as σreg;
 *  2. a missing LoD term dropped the threshold to the 0.10 m fallback even when
 *     the known σz terms implied a much larger one;
 *  3. the grid-origin check used |coord|·1e-9 (5 mm at northing 5e6), passing a
 *     4 mm offset on a 1 cm grid as co-registered.
 */
import { describe, expect, it } from 'vitest';
import { alignEpochClouds, summarizeAlignment } from '../src/terrain/change/alignEpochs';
import { describeLevelOfDetection, propagatedLevelOfDetection } from '../src/terrain/change/propagatedLod';
import { compareDtms, gridTolerance, summarizeChange } from '../src/terrain/change/compareDtms';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

describe('registration residuals describe the transform they name', () => {
  // A local-frame pair (no CRS) on a surface that constrains yaw, x, y and z,
  // so the fit is observable and runs. A common-CRS pair keeps its coordinates
  // and is not fitted at all (last test).
  const lattice = (dz: number): Float32Array => {
    const out: number[] = [];
    for (let x = 0; x <= 30; x++) for (let y = 0; y <= 30; y++) out.push(x, y, 2 * Math.sin(x / 4) + 1.5 * Math.cos(y / 3) + dz);
    return new Float32Array(out);
  };
  const before = { positions: lattice(0), crs: null, verticalDatum: null, linearUnitToMetres: 1 };
  const after = { ...before, positions: lattice(1) };

  it('a pure 1 m vertical offset: applied residual 1 m, solver residual 0 m', () => {
    const r = alignEpochClouds(before, after, { maxResidualM: 0.1 });
    expect(r.alignment.appliedDof).toBe('yaw+xy');
    expect(r.after.positions[2]).toBeCloseTo(after.positions[2], 4); // z was kept
    expect(r.alignment.appliedTransformResidualM).toBeCloseTo(1, 2);
    expect(r.alignment.solverResidualM).toBeCloseTo(0, 3);
    const s = summarizeAlignment(r.alignment);
    expect(s).toMatch(/Residual at the applied pose 1\.00 m/);
    expect(s).toMatch(/solver fit residual \(yaw \+ x\/y\/z, not what was applied\) 0\.00 m/);
    expect(s).toMatch(/registration uncertainty is not quantified/);
  });

  it('the full 3-D path re-measures at its own pose', () => {
    const r = alignEpochClouds(before, after, { maxResidualM: 0.1, horizontalOnly: false });
    expect(r.alignment.appliedDof).toBe('yaw+xyz');
    expect(r.alignment.appliedTransformResidualM).toBeCloseTo(0, 3);
  });

  it('a common-CRS pair is not fitted: no residual is reported as if it were one', () => {
    const geo = { ...before, crs: 'EPSG:32612', verticalDatum: 'NAVD88' };
    const r = alignEpochClouds(geo, { ...geo, positions: lattice(1) }, { maxResidualM: 0.1 });
    expect(r.alignment.frameKept).toBe(true);
    expect(r.alignment.appliedDof).toBe('none');
    expect(r.alignment.solverResidualM).toBe(Infinity);
    expect(summarizeAlignment(r.alignment)).toMatch(/not estimated/);
  });
});

describe('level of detection: missing information never shrinks known uncertainty', () => {
  it('audit repro: σz 1 m and 1 m, σreg unavailable → at least 1.96·√2', () => {
    const lod = propagatedLevelOfDetection({ sigmaZBeforeM: 1, sigmaZAfterM: 1, sigmaRegM: null });
    expect(lod.valueM).toBeGreaterThanOrEqual(1.96 * Math.hypot(1, 1));
    expect(lod.valueM).toBeCloseTo(2.772, 3);
    expect(lod.basis).toBe('incomplete');
    // The volume band's per-cell σ never implies a larger LoD than the one applied.
    expect(lod.t * lod.cellSigmaM).toBeLessThanOrEqual(lod.valueM + 1e-12);
    expect(describeLevelOfDetection(lod)[0]).toMatch(/incomplete — lower bound, missing: registration σreg/);
  });

  it('all terms present → propagated', () => {
    const lod = propagatedLevelOfDetection({ sigmaZBeforeM: 0.03, sigmaZAfterM: 0.04, sigmaRegM: 0.12 });
    expect(lod.basis).toBe('propagated');
    expect(lod.valueM).toBeCloseTo(1.96 * Math.sqrt(0.03 ** 2 + 0.04 ** 2 + 0.12 ** 2), 12);
  });

  it('partial terms below the floor keep the floor', () => {
    const lod = propagatedLevelOfDetection({ sigmaZBeforeM: 0.01, sigmaZAfterM: null, sigmaRegM: null });
    expect(lod.basis).toBe('incomplete');
    expect(lod.knownComponentM).toBeCloseTo(0.0196, 12);
    expect(lod.valueM).toBe(0.1);
  });

  it('no terms known → assumed, not measured', () => {
    const lod = propagatedLevelOfDetection({});
    expect(lod.basis).toBe('assumed');
    expect(lod.valueM).toBe(0.1);
    expect(lod.knownComponentM).toBeNull();
  });

  it('a user override below the known component is kept but warned', () => {
    const lod = propagatedLevelOfDetection({ sigmaZBeforeM: 1, sigmaZAfterM: 1, userLodM: 0.5 });
    expect(lod.basis).toBe('user-set');
    expect(lod.valueM).toBe(0.5);
    expect(lod.belowKnownComponent).toBe(true);
    expect(describeLevelOfDetection(lod).join('\n')).toMatch(/below the 2\.772 m that the known/);
    expect(propagatedLevelOfDetection({ sigmaZBeforeM: 0.01, userLodM: 0.5 }).belowKnownComponent).toBe(false);
  });

  it('counts and detectable volumes under an incomplete threshold are labelled, raw net is not', () => {
    const g = (z: number): DtmGrid =>
      ({ cols: 2, rows: 2, cellSizeM: 1, originH1: 0, originH2: 0, crs: 'EPSG:32612', verticalDatum: 'NAVD88',
        z: new Float32Array(4).fill(z), coverage: new Uint8Array(4).fill(2), confidence: new Float32Array(4).fill(100) }) as unknown as DtmGrid;
    const lod = propagatedLevelOfDetection({ sigmaZBeforeM: 0.1, sigmaZAfterM: 0.1, sigmaRegM: null });
    const lines = summarizeChange(compareDtms(g(0), g(1), { levelOfDetection: lod }), { horizontalUnitToMetres: 1 });
    expect(lines.find((l) => l.startsWith('Net volume change (raw'))).not.toMatch(/incomplete/);
    expect(lines.find((l) => l.startsWith('Detectable gross change'))).toMatch(/incomplete, lower-bound threshold/);
    expect(lines.find((l) => /of comparable cells changed/.test(l))).toMatch(/incomplete, lower-bound threshold/);
  });
});

describe('grid identity is checked to float64 representation, not millimetres', () => {
  const base = {
    cols: 1, rows: 1, cellSizeM: 0.01, originH1: 400000, originH2: 5000000,
    crs: 'EPSG:32612', verticalDatum: 'NAVD88',
    z: new Float32Array([0]), coverage: new Uint8Array([2]), confidence: new Float32Array([100]),
  } as DtmGrid;

  it('identical grids pass', () => {
    const cmp = compareDtms(base, { ...base });
    expect(cmp.coregistered).toBe(true);
    expect(cmp.gridMisaligned).toBe(false);
  });

  it('audit repro: a 4 mm offset on 10 mm cells is refused', () => {
    const cmp = compareDtms(base, { ...base, originH1: base.originH1 + 0.004, z: new Float32Array([0.004]) });
    expect(cmp.coregistered).toBe(false);
    expect(cmp.gridMisaligned).toBe(true);
    expect(summarizeChange(cmp, { horizontalUnitToMetres: 1 })[0]).toMatch(/Not comparable — the two epochs are not on one grid/);
  });

  it('ULP-level jitter at northing 5e6 passes', () => {
    const jitter = 2 * Number.EPSILON * 2 ** 22; // two ulps at 5e6
    const b = { ...base, originH2: base.originH2 + jitter, originH1: base.originH1 - Number.EPSILON * 2 ** 18 };
    expect(b.originH2).not.toBe(base.originH2);
    const cmp = compareDtms(base, b);
    expect(cmp.gridMisaligned).toBe(false);
    expect(cmp.coregistered).toBe(true);
  });

  it('the tolerance is the stricter of a few ulps and 1e-6 of a cell', () => {
    expect(gridTolerance(5e6, 0.01)).toBeLessThan(1e-8);
    expect(gridTolerance(5e6, 0.01)).toBeGreaterThan(0);
    expect(gridTolerance(5e6, 1e-6)).toBeCloseTo(1e-12, 20);
  });
});
