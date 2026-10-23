/**
 * drawPrecision.test.ts: the per-draw precision bound wired as a diagnostic
 * (science/drawPrecision.ts, analysis/drawPrecisionRows.ts, the scan report and
 * app/drawPrecisionView.ts).
 *
 * A synthetic cloud far from the CRS origin (UTM-sized coordinates, 1 km reach)
 * is stored the way OLV stores it: binary64 source coordinates minus a binary64
 * origin, narrowed once to Float32. At a realistic camera it must PASS at 1 mm
 * on both verified backends, and an unverified draw path must be NOT_TESTED.
 */
import { describe, it, expect } from 'vitest';
import {
  DRAW_PRECISION_TAU_METRES,
  UNVERIFIED_EXPRESSION,
  evaluateDrawPrecision,
  shaderExpressionFor,
  tileFromFloat64,
  tileFromLocalFloat32,
  type DrawPrecisionView,
} from '../src/science/drawPrecision';
import { drawPrecisionRows } from '../src/analysis/drawPrecisionRows';
import { scanReport } from '../src/analysis/modules/scanReport';
import { drawPrecisionViewFor, withExactAffineRow } from '../src/app/drawPrecisionView';
import { PointCloud } from '../src/model/PointCloud';
import { composeModelView64, EXPRESSION_GLSL, EXPRESSION_WGSL } from '../src/vendor/spe-check/olv_preflight.mjs';
import type { CrsInfo } from '../src/io/crs';

const ORIGIN: [number, number, number] = [500_000, 4_500_000, 200];

/** Deterministic far-from-origin cloud: binary64 source values, and the Float32 local buffer OLV keeps. */
function farCloud(n = 4000): { p64: Float64Array; local: Float32Array } {
  let seed = 11;
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const p64 = new Float64Array(3 * n), local = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    p64[3 * i] = ORIGIN[0] + rnd() * 1000 + 0.123;
    p64[3 * i + 1] = ORIGIN[1] + rnd() * 1000 + 0.456;
    p64[3 * i + 2] = ORIGIN[2] + rnd() * 80 + 0.789;
    for (let k = 0; k < 3; k++) local[3 * i + k] = p64[3 * i + k] - ORIGIN[k];
  }
  return { p64, local };
}

/** A rigid camera (yaw 30 deg, pitch -35 deg) at a local position; returns the column-major view matrix. */
function viewAt(eye: [number, number, number]): Float64Array {
  const cy = Math.cos(Math.PI / 6), sy = Math.sin(Math.PI / 6);
  const cp = Math.cos(-0.61), sp = Math.sin(-0.61);
  // camera world rotation R = Rz(yaw) * Rx(pitch); view = [R^T | -R^T eye]
  const R = [
    [cy, -sy * cp, sy * sp],
    [sy, cy * cp, -cy * sp],
    [0, sp, cp],
  ];
  const v = new Float64Array(16);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) v[4 * c + r] = R[c][r];
    v[12 + r] = -(R[0][r] * eye[0] + R[1][r] * eye[1] + R[2][r] * eye[2]);
  }
  v[15] = 1;
  return v;
}

const IDENTITY = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const METRES = { linearUnitKnown: true, linearUnitToMetres: 1 };

function view(backend: 'webgpu' | 'webgl2', path: DrawPrecisionView['path'] = 'instanced-quad-highp'): DrawPrecisionView {
  return { modelView64: composeModelView64(viewAt([300, -400, 250]), IDENTITY), backend, path };
}

describe('shader expression mapping', () => {
  it('maps the verified path to the backend expression and anything else to the unverified marker', () => {
    expect(shaderExpressionFor('webgpu', 'instanced-quad-highp')).toBe(EXPRESSION_WGSL);
    expect(shaderExpressionFor('webgl2', 'instanced-quad-highp')).toBe(EXPRESSION_GLSL);
    expect(shaderExpressionFor('webgpu', 'unverified')).toBe(UNVERIFIED_EXPRESSION);
    expect(shaderExpressionFor('webgl2', 'unverified')).toBe(UNVERIFIED_EXPRESSION);
  });
});

describe('tile quantities', () => {
  it('the Float32 narrowing bound covers the measured storage error and matches the reach', () => {
    const { p64, local } = farCloud();
    const measured = tileFromFloat64(p64, ORIGIN);
    const bound = tileFromLocalFloat32(local);
    for (let k = 0; k < 3; k++) {
      expect(bound.r[k]).toBe(measured.r[k]);
      expect(bound.rho[k]).toBeGreaterThanOrEqual(measured.rho[k]);
    }
    expect(bound.basis).toBe('narrowing-bound');
    expect(measured.basis).toBe('measured');
  });

  it('is cached per buffer', () => {
    const { local } = farCloud(10);
    expect(tileFromLocalFloat32(local)).toBe(tileFromLocalFloat32(local));
  });
});

describe('evaluateDrawPrecision', () => {
  const { p64, local } = farCloud();

  it.each(['webgpu', 'webgl2'] as const)('a far-from-origin cloud PASSes 1 mm on %s', (backend) => {
    for (const tile of [tileFromLocalFloat32(local), tileFromFloat64(p64, ORIGIN)]) {
      const d = evaluateDrawPrecision(tile, view(backend), METRES);
      expect(d.state).toBe('PASS');
      expect(d.boundMetres).not.toBeNull();
      expect(d.boundMetres!).toBeLessThan(DRAW_PRECISION_TAU_METRES);
      expect(d.tauMetres).toBe(DRAW_PRECISION_TAU_METRES);
    }
  });

  it('an unverified draw path is NOT_TESTED with no bound reported', () => {
    const d = evaluateDrawPrecision(tileFromLocalFloat32(local), view('webgpu', 'unverified'), METRES);
    expect(d.state).toBe('NOT_TESTED');
    expect(d.boundMetres).toBeNull();
    expect(d.boundSourceUnits).toBeNull();
    expect(d.reason).toMatch(/not verified/);
  });

  it('a projective matrix is NOT_TESTED, not an error', () => {
    const mv = Float64Array.from(view('webgl2').modelView64);
    mv[3] = 0.5; // bottom row no longer [0,0,0,1]
    const d = evaluateDrawPrecision(tileFromLocalFloat32(local), { modelView64: mv, backend: 'webgl2', path: 'instanced-quad-highp' }, METRES);
    expect(d.state).toBe('NOT_TESTED');
  });

  it('with no linear unit the bound is reported in source units and not graded', () => {
    const d = evaluateDrawPrecision(tileFromLocalFloat32(local), view('webgl2'), { linearUnitKnown: false, linearUnitToMetres: 1 });
    expect(d.state).toBe('UNGRADED');
    expect(d.boundSourceUnits).toBeGreaterThan(0);
    expect(d.boundMetres).toBeNull();
  });

  it('a different vertical unit leaves the bound ungraded', () => {
    const d = evaluateDrawPrecision(tileFromLocalFloat32(local), view('webgl2'), { linearUnitKnown: true, linearUnitToMetres: 1, verticalUnitToMetres: 0.3048 });
    expect(d.state).toBe('UNGRADED');
  });

  it('converts the tolerance through the linear unit (US survey feet)', () => {
    const ft = 1200 / 3937;
    const d = evaluateDrawPrecision(tileFromLocalFloat32(local), view('webgpu'), { linearUnitKnown: true, linearUnitToMetres: ft });
    expect(d.boundMetres).toBeCloseTo(d.boundSourceUnits! * ft, 15);
  });

  it('a cloud far from its own local origin is NOT_CERTIFIED at 1 mm', () => {
    // Positions stored with the origin left at zero: 5,000 km reach in Float32.
    const raw = new Float32Array(p64);
    const d = evaluateDrawPrecision(tileFromLocalFloat32(raw), {
      modelView64: composeModelView64(viewAt([500_300, 4_499_600, 450]), IDENTITY), backend: 'webgpu', path: 'instanced-quad-highp',
    }, METRES);
    expect(d.state).toBe('NOT_CERTIFIED');
  });
});

describe('report rows', () => {
  const { local } = farCloud();
  it('state the outcome, the scope, and the citation', () => {
    const rows = drawPrecisionRows(evaluateDrawPrecision(tileFromLocalFloat32(local), view('webgpu'), METRES));
    expect(rows[0].label).toBe('Draw precision bound');
    expect(rows[0].value).toMatch(/within 1\.00 mm \(WebGPU, WGSL f32; round-to-nearest\)/);
    expect(rows[1].advanced).toBe(true);
    expect(rows[1].value).toMatch(/eye-space point position before projection/);
    expect(rows[1].value).toMatch(/divide by w/);
    expect(rows[1].value).toMatch(/survey accuracy are not covered/);
    expect(rows[1].value).toContain('A. Urias, "Per-Draw Precision Bounds for Large-Coordinate Rendering in WebGL2 and WebGPU"');
  });
  it('say Not tested for an unverified path', () => {
    const rows = drawPrecisionRows(evaluateDrawPrecision(tileFromLocalFloat32(local), view('webgl2', 'unverified'), METRES));
    expect(rows[0].value).toMatch(/^Not tested:/);
  });
});

const METRE_CRS: CrsInfo = { source: 'wkt', epsg: 32633, name: 'WGS 84 / UTM zone 33N', isGeographic: false, linearUnit: 'metre', linearUnitToMetres: 1 };

describe('scan report wiring', () => {
  const { local } = farCloud();
  const cloud = new PointCloud({ positions: local, origin: ORIGIN, sourceFormat: 'las', name: 'far', metadata: { crs: METRE_CRS } });

  it('adds the rows when the composition root supplies the draw', () => {
    const rows = scanReport.run(cloud, undefined, { drawPrecision: view('webgpu') }).rows;
    const row = rows.find((r) => r.label === 'Draw precision bound');
    expect(row?.value).toMatch(/within 1\.00 mm/);
  });

  it('omits them without a draw, leaving the report unchanged', () => {
    const rows = scanReport.run(cloud).rows;
    expect(rows.some((r) => r.label.startsWith('Draw '))).toBe(false);
  });
});

describe('drawPrecisionViewFor', () => {
  const { local } = farCloud(10);
  const cloud = new PointCloud({ positions: local, origin: ORIGIN, sourceFormat: 'las', name: 'v' });
  const viewer = {
    activeBackend: () => 'webgl2' as const,
    cloudModelView64: (id: string) => (id === 'cloud_0' ? IDENTITY : null),
    getCloud: (id: string) => (id === 'cloud_0' ? cloud : undefined),
  };
  it('reads the verified static path for the drawn cloud', () => {
    expect(drawPrecisionViewFor(viewer, 'cloud_0', cloud)).toEqual({ modelView64: IDENTITY, backend: 'webgl2', path: 'instanced-quad-highp' });
  });
  it('returns undefined for no id or a cloud the viewer does not draw under that id', () => {
    expect(drawPrecisionViewFor(viewer, null, cloud)).toBeUndefined();
    expect(drawPrecisionViewFor(viewer, 'cloud_1', cloud)).toBeUndefined();
  });
});

describe('withExactAffineRow', () => {
  it('reads a bottom row within rounding of (0, 0, 0, 1) as exact, which only sets w', () => {
    const m = Float64Array.from(IDENTITY);
    m[3] = 1e-17; m[15] = 1 - 1e-16;
    const out = withExactAffineRow(m);
    expect([out[3], out[7], out[11], out[15]]).toEqual([0, 0, 0, 1]);
    expect(evaluateDrawPrecision(tileFromLocalFloat32(farCloud(10).local), { modelView64: out, backend: 'webgpu', path: 'instanced-quad-highp' }, METRES).state).not.toBe('NOT_TESTED');
  });
  it('leaves a projective row for the checker to refuse', () => {
    const m = Float64Array.from(IDENTITY);
    m[11] = -1;
    expect(withExactAffineRow(m)).toBe(m);
  });
});
