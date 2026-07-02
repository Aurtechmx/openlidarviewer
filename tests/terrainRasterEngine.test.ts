/**
 * terrainRasterEngine.test.ts
 *
 * The TerrainRasterEngine seam — the equivalence gate that lets a GPU
 * backend exist at all under the honesty contract:
 *
 *   1. CPU backend is PURE DELEGATION: byte-identical to calling the
 *      existing functions (groundFilter / rasterizeDtm / derivatives /
 *      hillshade) directly. Same for the engine's sync entries the live
 *      pipeline uses.
 *   2. Equivalence harness: both backends on synthetic grids must agree
 *      per-cell within 1e-4 (slope rise/run, aspect radians-angular,
 *      shade ±1 grey). In Node there is no real GPU, so the f32 kernel
 *      transcription (hornDerivativesF32Reference) stands in for the WGSL
 *      arithmetic — it bounds the f32-vs-f64 float-order gap the tolerance
 *      exists for. Real-device agreement is the per-session probe + the
 *      browser e2e (tests/e2e/gpuDerivatives.spec.ts).
 *   3. Auto-fallback: no navigator.gpu / device failure / probe mismatch /
 *      later dispatch failure each pin the session to CPU, silently to the
 *      user but RECORDED in the compute-path telemetry, and the caller
 *      always receives the CPU-correct answer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TerrainRasterEngine,
  getTerrainRasterEngine,
  setTerrainRasterEngineForTests,
  getLastTerrainRasterComputePath,
  runEquivalenceProbe,
  buildProbeGrid,
  compareDerivativeGrids,
  EQUIVALENCE_SLOPE_TOLERANCE,
  EQUIVALENCE_ASPECT_TOLERANCE_RAD,
  EQUIVALENCE_ASPECT_SLOPE_FLOOR,
  EQUIVALENCE_SHADE_TOLERANCE,
  PROBE_GRID_SIZE,
  buildScatterProbe,
  compareScatterGrids,
  type TerrainRasterBackend,
  type GpuBackendFactory,
} from '../src/terrain/engine/TerrainRasterEngine';
import { createCpuBackend } from '../src/terrain/engine/cpuBackend';
import { hornDerivativesF32Reference } from '../src/terrain/engine/gpuBackend';
import {
  scatterMinCountReference,
  f32ToOrderedKey,
  orderedKeyToF32,
  floatBitsToOrderedU32,
  type ScatterPoints,
  type ScatterGrid,
} from '../src/terrain/engine/dtmScatter';
import { classifyGroundSmrf } from '../src/terrain/ground/groundFilter';
import { rasterizeDtm } from '../src/terrain/ground/rasterizeDtm';
import { hornSlopeAspect } from '../src/terrain/ground/terrainDerivatives';
import { shadeFromSlopeAspect } from '../src/terrain/surface/hillshade';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

/** Byte-identical comparison for typed arrays (NaN-safe, unlike ===). */
function bytesEqual(
  a: { buffer: ArrayBufferLike; byteOffset: number; byteLength: number },
  b: { buffer: ArrayBufferLike; byteOffset: number; byteLength: number },
): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const ua = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const ub = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
  return true;
}

/** A small deterministic point cloud with structure (mound + outliers). */
function syntheticPoints(): TerrainPoint[] {
  const pts: TerrainPoint[] = [];
  for (let i = 0; i < 400; i++) {
    const x = (i % 20) * 0.5;
    const y = Math.floor(i / 20) * 0.5;
    const z = Math.sin(x * 0.7) + Math.cos(y * 0.5) + (i % 7 === 0 ? 3 : 0);
    pts.push({ x, y, z });
  }
  return pts;
}

/** A 'gpu'-flavoured backend that mirrors the CPU exactly (passes the probe). */
function faithfulFakeGpu(calls?: {
  derivatives: number;
  hillshade: number;
  scatter?: number;
}): TerrainRasterBackend {
  return {
    kind: 'gpu',
    groundFilterPass: classifyGroundSmrf,
    gridFromPoints: rasterizeDtm,
    scatterMinCount: (points, grid) => {
      if (calls && calls.scatter != null) calls.scatter++;
      return Promise.resolve(scatterMinCountReference(points, grid));
    },
    derivatives: (z, cols, rows, cell, cellY) => {
      if (calls) calls.derivatives++;
      // A faithful backend honours the per-axis cell size — the probe's
      // anisotropic pass rejects one that ignores it (tested below).
      return Promise.resolve(hornSlopeAspect(z, cols, rows, cell, cellY));
    },
    hillshade: (s, a, cov, cols, rows, params) => {
      if (calls) calls.hillshade++;
      return Promise.resolve(shadeFromSlopeAspect(s, a, cov, cols, rows, params));
    },
  };
}

const okFactory =
  (backend: TerrainRasterBackend): GpuBackendFactory =>
  () =>
    Promise.resolve({ ok: true as const, backend });

describe('cpuBackend — pure delegation, byte-identical', () => {
  const backend = createCpuBackend();
  const pts = syntheticPoints();
  const filterParams = {
    cellSizeM: 1,
    maxWindowCells: 4,
    slope: 0.15,
    elevationThresholdM: 0.5,
  };

  it('groundFilterPass IS classifyGroundSmrf (same function, same output)', () => {
    expect(backend.groundFilterPass).toBe(classifyGroundSmrf);
    const a = backend.groundFilterPass(pts, filterParams);
    const b = classifyGroundSmrf(pts, filterParams);
    expect(Array.from(a.isGround)).toEqual(Array.from(b.isGround));
  });

  it('gridFromPoints IS rasterizeDtm (same function, same output)', () => {
    expect(backend.gridFromPoints).toBe(rasterizeDtm);
    const mask = new Uint8Array(pts.length).fill(1);
    const a = backend.gridFromPoints(pts, mask, { cellSizeM: 1 });
    const b = rasterizeDtm(pts, mask, { cellSizeM: 1 });
    expect(a.cols).toBe(b.cols);
    expect(a.rows).toBe(b.rows);
    // Byte-identical including NaN cells.
    expect(bytesEqual(a.z, b.z)).toBe(true);
    expect(Array.from(a.counts)).toEqual(Array.from(b.counts));
  });

  it('derivatives delegates to hornSlopeAspect, byte-identical', async () => {
    const { z, cols, rows, cellSizeM } = buildProbeGrid(32, 24);
    const a = await backend.derivatives(z, cols, rows, cellSizeM);
    const b = hornSlopeAspect(z, cols, rows, cellSizeM);
    expect(bytesEqual(a.slope, b.slope)).toBe(true);
    expect(bytesEqual(a.aspect, b.aspect)).toBe(true);
  });

  it('derivatives passes the anisotropic cell pair through, byte-identical', async () => {
    const { z, cols, rows } = buildProbeGrid(32, 24);
    const a = await backend.derivatives(z, cols, rows, 0.5, 1);
    const b = hornSlopeAspect(z, cols, rows, 0.5, 1);
    expect(bytesEqual(a.slope, b.slope)).toBe(true);
    expect(bytesEqual(a.aspect, b.aspect)).toBe(true);
  });

  it('hillshade delegates to shadeFromSlopeAspect, byte-identical', async () => {
    const { z, cols, rows, cellSizeM } = buildProbeGrid(32, 24);
    const sa = hornSlopeAspect(z, cols, rows, cellSizeM);
    const cov = new Uint8Array(cols * rows).fill(1);
    const a = await backend.hillshade(sa.slope, sa.aspect, cov, cols, rows, { azimuthDeg: 270 });
    const b = shadeFromSlopeAspect(sa.slope, sa.aspect, cov, cols, rows, { azimuthDeg: 270 });
    expect(Array.from(a.shade)).toEqual(Array.from(b.shade));
    expect(Array.from(a.coverage)).toEqual(Array.from(b.coverage));
  });
});

describe('engine sync entries — the live pipeline path is the CPU reference', () => {
  it('derivativesSync is byte-identical to hornSlopeAspect', () => {
    const engine = new TerrainRasterEngine();
    const { z, cols, rows, cellSizeM } = buildProbeGrid();
    const a = engine.derivativesSync(z, cols, rows, cellSizeM);
    const b = hornSlopeAspect(z, cols, rows, cellSizeM);
    expect(bytesEqual(a.slope, b.slope)).toBe(true);
    expect(bytesEqual(a.aspect, b.aspect)).toBe(true);
    expect(engine.getComputePath().lastCall).toBe('cpu');
  });

  it('derivativesSync threads the per-axis (anisotropic) cell size through', () => {
    // The cos φ geographic geometry: E–W cell half the N–S cell. Byte-
    // identical to calling the reference with both axes — the engine seam
    // must not collapse the pair back to a square cell.
    const engine = new TerrainRasterEngine();
    const { z, cols, rows } = buildProbeGrid();
    const a = engine.derivativesSync(z, cols, rows, 0.5, 1);
    const b = hornSlopeAspect(z, cols, rows, 0.5, 1);
    expect(bytesEqual(a.slope, b.slope)).toBe(true);
    expect(bytesEqual(a.aspect, b.aspect)).toBe(true);
    // And the pair genuinely differs from the square-cell result (guards
    // against a seam that silently drops the Y size).
    const square = engine.derivativesSync(z, cols, rows, 0.5);
    expect(bytesEqual(a.slope, square.slope)).toBe(false);
  });

  it('hillshadeSync is byte-identical to shadeFromSlopeAspect', () => {
    const engine = new TerrainRasterEngine();
    const { z, cols, rows, cellSizeM } = buildProbeGrid();
    const sa = hornSlopeAspect(z, cols, rows, cellSizeM);
    const cov = new Uint8Array(cols * rows).fill(1);
    const a = engine.hillshadeSync(sa.slope, sa.aspect, cov, cols, rows);
    const b = shadeFromSlopeAspect(sa.slope, sa.aspect, cov, cols, rows);
    expect(Array.from(a.shade)).toEqual(Array.from(b.shade));
  });
});

describe('equivalence harness — f32 kernel arithmetic vs the f64 CPU reference', () => {
  // The probe grid plus extra shapes: a pure ramp (constant gradient), a
  // steep deterministic "rough" field, and an all-NaN-border grid. Each must
  // stay inside the 1e-4 gate; this is the float-order caveat made testable.
  const grids: Array<{ name: string; z: Float32Array; cols: number; rows: number; cell: number }> =
    [];
  {
    const probe = buildProbeGrid();
    grids.push({ name: 'probe 64x64', z: probe.z, cols: probe.cols, rows: probe.rows, cell: 1 });
  }
  {
    const cols = 33;
    const rows = 21;
    const z = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) z[r * cols + c] = 0.4 * c - 0.25 * r + 10;
    grids.push({ name: 'linear ramp', z, cols, rows, cell: 0.5 });
  }
  {
    const cols = 40;
    const rows = 40;
    const z = new Float32Array(cols * rows);
    let s = 1234567;
    for (let i = 0; i < z.length; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff; // deterministic LCG
      z[i] = ((s % 1000) / 1000) * 8 - 4;
      if (i % 37 === 0) z[i] = Number.NaN;
    }
    grids.push({ name: 'rough + NaN holes', z, cols, rows, cell: 2 });
  }

  for (const g of grids) {
    it(`f32 transcription agrees with CPU within tolerance on "${g.name}"`, () => {
      const ref = hornSlopeAspect(g.z, g.cols, g.rows, g.cell);
      const got = hornDerivativesF32Reference(g.z, g.cols, g.rows, g.cell);
      const d = compareDerivativeGrids(ref, got);
      expect(d.maxSlopeErr).toBeLessThanOrEqual(EQUIVALENCE_SLOPE_TOLERANCE);
      expect(d.maxAspectErr).toBeLessThanOrEqual(EQUIVALENCE_ASPECT_TOLERANCE_RAD);
      // The harness must actually be comparing aspect somewhere — a gate
      // that never compares is not a gate.
      expect(d.comparedAspectCells).toBeGreaterThan(0);
    });
  }

  it('f32 transcription agrees with CPU on ANISOTROPIC cells (cos 60° pair)', () => {
    // Same harness as above but with the probe's anisotropic geometry
    // (E–W 0.5 m, N–S 1 m) — bounds the f32-vs-f64 gap on the per-axis
    // denominators the new kernel path introduces.
    const { z, cols, rows } = buildProbeGrid();
    const ref = hornSlopeAspect(z, cols, rows, 0.5, 1);
    const got = hornDerivativesF32Reference(z, cols, rows, 0.5, 1);
    const d = compareDerivativeGrids(ref, got);
    expect(d.maxSlopeErr).toBeLessThanOrEqual(EQUIVALENCE_SLOPE_TOLERANCE);
    expect(d.maxAspectErr).toBeLessThanOrEqual(EQUIVALENCE_ASPECT_TOLERANCE_RAD);
    expect(d.comparedAspectCells).toBeGreaterThan(0);
  });

  it('flat cells keep the EXACT slope-0/aspect-0 convention in both', () => {
    const { z, cols, rows, cellSizeM } = buildProbeGrid();
    const ref = hornSlopeAspect(z, cols, rows, cellSizeM);
    const got = hornDerivativesF32Reference(z, cols, rows, cellSizeM);
    // Interior of the flat patch (rows/cols 41..46 are fully surrounded).
    for (let r = 42; r < 46; r++) {
      for (let c = 42; c < 46; c++) {
        const i = r * cols + c;
        if (!Number.isFinite(z[i])) continue; // NaN holes stay convention-0 too
        expect(ref.slope[i]).toBe(0);
        expect(got.slope[i]).toBe(0);
        expect(ref.aspect[i]).toBe(0);
        expect(got.aspect[i]).toBe(0);
      }
    }
  });

  it('compareDerivativeGrids treats NaN output as divergence, not a pass', () => {
    const { z, cols, rows, cellSizeM } = buildProbeGrid(8, 8);
    const ref = hornSlopeAspect(z, cols, rows, cellSizeM);
    const bad = {
      slope: new Float32Array(ref.slope.length).fill(Number.NaN),
      aspect: new Float32Array(ref.aspect.length),
    };
    expect(compareDerivativeGrids(ref, bad).maxSlopeErr).toBe(Infinity);
  });

  it('probe grid exercises holes, flats, and gradients', () => {
    const { z, cols, rows } = buildProbeGrid();
    expect(cols).toBe(PROBE_GRID_SIZE);
    expect(rows).toBe(PROBE_GRID_SIZE);
    const nans = Array.from(z).filter((v) => Number.isNaN(v)).length;
    expect(nans).toBeGreaterThan(10);
    expect(nans).toBeLessThan(z.length / 4);
    const sa = hornSlopeAspect(z, cols, rows, 1);
    const sloped = Array.from(sa.slope).filter((s) => s > EQUIVALENCE_ASPECT_SLOPE_FLOOR).length;
    expect(sloped).toBeGreaterThan(z.length / 2); // aspect genuinely compared
  });
});

describe('the equivalence gate + auto-fallback (probe at init)', () => {
  // These fixtures EXPECT the engine to announce probe failures / init
  // errors on console.warn — that is the honesty contract under test, and
  // the assertions read the returned ComputePathInfo, not the console.
  // Silence the expected announcements so a green run stays clean.
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  it('a faithful gpu backend passes the probe and serves async calls', async () => {
    const calls = { derivatives: 0, hillshade: 0 };
    const engine = new TerrainRasterEngine({ gpuFactory: okFactory(faithfulFakeGpu(calls)) });
    const info = await engine.init();
    expect(info.path).toBe('gpu');
    expect(info.reason).toBe('gpu-active');
    expect(info.probe?.passed).toBe(true);
    expect(info.probe?.maxSlopeErr).toBe(0);
    expect(info.probe?.maxShadeErr).toBe(0);

    const { z, cols, rows, cellSizeM } = buildProbeGrid(16, 16);
    const got = await engine.derivatives(z, cols, rows, cellSizeM);
    const ref = hornSlopeAspect(z, cols, rows, cellSizeM);
    expect(bytesEqual(got.slope, ref.slope)).toBe(true);
    expect(engine.getComputePath().lastCall).toBe('gpu');
    expect(calls.derivatives).toBeGreaterThanOrEqual(2); // probe + call
  });

  it('a diverging gpu backend FAILS the probe → CPU, recorded, results correct', async () => {
    const corrupt: TerrainRasterBackend = {
      ...faithfulFakeGpu(),
      derivatives: async (z, cols, rows, cell, cellY) => {
        const out = hornSlopeAspect(z, cols, rows, cell, cellY);
        const slope = out.slope.slice();
        for (let i = 0; i < slope.length; i++) slope[i] += 0.01; // 100× the gate
        return { slope, aspect: out.aspect };
      },
    };
    const engine = new TerrainRasterEngine({ gpuFactory: okFactory(corrupt) });
    const info = await engine.init();
    expect(info.path).toBe('cpu');
    expect(info.reason).toBe('probe-mismatch');
    expect(info.probe?.passed).toBe(false);
    expect(info.probe!.maxSlopeErr).toBeGreaterThan(EQUIVALENCE_SLOPE_TOLERANCE);

    // The async entry must now serve the CPU truth, not the diverging GPU.
    const { z, cols, rows, cellSizeM } = buildProbeGrid(16, 16);
    const got = await engine.derivatives(z, cols, rows, cellSizeM);
    const ref = hornSlopeAspect(z, cols, rows, cellSizeM);
    expect(bytesEqual(got.slope, ref.slope)).toBe(true);
    expect(engine.getComputePath().lastCall).toBe('cpu');
  });

  it('a backend that IGNORES the per-axis cell size FAILS the probe', async () => {
    // The exact failure mode the anisotropic probe pass exists for: a kernel
    // that computes a correct isotropic estimate (passes the square-cell
    // pass bit-for-bit) but silently drops `cellSizeYM` — on a geographic
    // grid it would overstate dz/dy 2× at the probe's cos 60° geometry.
    const isotropicOnly: TerrainRasterBackend = {
      ...faithfulFakeGpu(),
      derivatives: async (z, cols, rows, cell) => hornSlopeAspect(z, cols, rows, cell),
    };
    const engine = new TerrainRasterEngine({ gpuFactory: okFactory(isotropicOnly) });
    const info = await engine.init();
    expect(info.path).toBe('cpu');
    expect(info.reason).toBe('probe-mismatch');
    expect(info.probe?.passed).toBe(false);
    expect(info.probe!.maxSlopeErr).toBeGreaterThan(EQUIVALENCE_SLOPE_TOLERANCE);

    // The caller still gets the CPU truth on the anisotropic path.
    const { z, cols, rows } = buildProbeGrid(16, 16);
    const got = await engine.derivatives(z, cols, rows, 0.5, 1);
    const ref = hornSlopeAspect(z, cols, rows, 0.5, 1);
    expect(bytesEqual(got.slope, ref.slope)).toBe(true);
    expect(engine.getComputePath().lastCall).toBe('cpu');
  });

  it('a hillshade-diverging backend also fails the probe (shade gate ±1)', async () => {
    const badShade: TerrainRasterBackend = {
      ...faithfulFakeGpu(),
      hillshade: async (s, a, cov, cols, rows, params) => {
        const out = shadeFromSlopeAspect(s, a, cov, cols, rows, params);
        const shade = out.shade.slice();
        for (let i = 0; i < shade.length; i++) {
          if (out.coverage[i] === 1) shade[i] = Math.min(255, shade[i] + EQUIVALENCE_SHADE_TOLERANCE + 1);
        }
        return { shade, coverage: out.coverage, cols, rows };
      },
    };
    const engine = new TerrainRasterEngine({ gpuFactory: okFactory(badShade) });
    const info = await engine.init();
    expect(info.reason).toBe('probe-mismatch');
    expect(info.probe!.maxShadeErr).toBeGreaterThan(EQUIVALENCE_SHADE_TOLERANCE);
  });

  it('webgpu absent → CPU with reason recorded (Node has no navigator.gpu)', async () => {
    const engine = new TerrainRasterEngine(); // default factory, real detection
    const info = await engine.init();
    expect(info.path).toBe('cpu');
    expect(info.reason).toBe('webgpu-unavailable');
    expect(info.probe).toBeNull();
    // The async entries still work — CPU truth.
    const { z, cols, rows, cellSizeM } = buildProbeGrid(8, 8);
    const got = await engine.derivatives(z, cols, rows, cellSizeM);
    const ref = hornSlopeAspect(z, cols, rows, cellSizeM);
    expect(Array.from(got.slope)).toEqual(Array.from(ref.slope));
  });

  it('device request failure → CPU with reason recorded', async () => {
    const engine = new TerrainRasterEngine({
      gpuFactory: () =>
        Promise.resolve({ ok: false as const, failure: 'device-request-failed' as const }),
    });
    const info = await engine.init();
    expect(info.reason).toBe('device-request-failed');
    expect(info.path).toBe('cpu');
  });

  it('a factory that THROWS still resolves to CPU (init never rejects)', async () => {
    const engine = new TerrainRasterEngine({
      gpuFactory: () => Promise.reject(new Error('driver exploded')),
    });
    const info = await engine.init();
    expect(info.path).toBe('cpu');
    expect(info.reason).toBe('device-request-failed');
  });

  it('a later dispatch failure demotes the session and recomputes on CPU', async () => {
    let disposed = false;
    const flaky: TerrainRasterBackend = {
      ...faithfulFakeGpu(),
      derivatives: async (z, cols, rows, cell, cellY) => {
        // Pass the 64×64 probe (both its passes), then blow up on real work.
        if (cols === PROBE_GRID_SIZE && rows === PROBE_GRID_SIZE) {
          return hornSlopeAspect(z, cols, rows, cell, cellY);
        }
        throw new Error('device lost');
      },
      dispose: () => {
        disposed = true;
      },
    };
    const engine = new TerrainRasterEngine({ gpuFactory: okFactory(flaky) });
    await engine.init();
    expect(engine.getComputePath().path).toBe('gpu');

    const { z, cols, rows, cellSizeM } = buildProbeGrid(16, 16);
    const got = await engine.derivatives(z, cols, rows, cellSizeM);
    const ref = hornSlopeAspect(z, cols, rows, cellSizeM);
    // Caller still gets the CPU truth…
    expect(bytesEqual(got.slope, ref.slope)).toBe(true);
    // …and the demotion is recorded + the dead backend disposed.
    const status = engine.getComputePath();
    expect(status.path).toBe('cpu');
    expect(status.reason).toBe('gpu-dispatch-failed');
    expect(status.lastCall).toBe('cpu');
    expect(disposed).toBe(true);
    // The probe evidence survives the demotion (it DID pass at init).
    expect(status.probe?.passed).toBe(true);
  });

  it('init is idempotent — one probe per session', async () => {
    let factoryCalls = 0;
    const engine = new TerrainRasterEngine({
      gpuFactory: () => {
        factoryCalls++;
        return Promise.resolve({ ok: true as const, backend: faithfulFakeGpu() });
      },
    });
    await Promise.all([engine.init(), engine.init(), engine.init()]);
    await engine.init();
    expect(factoryCalls).toBe(1);
  });

  it('runEquivalenceProbe against the CPU backend itself passes exactly', async () => {
    const report = await runEquivalenceProbe(createCpuBackend());
    expect(report.passed).toBe(true);
    expect(report.maxSlopeErr).toBe(0);
    expect(report.maxAspectErr).toBe(0);
    expect(report.maxShadeErr).toBe(0);
    expect(report.coverageMatches).toBe(true);
  });
});

describe('DTM min/count scatter (phase 2) — ordered-key + CPU reference', () => {
  // Same expected-announcement noise as the probe suite above — the
  // scatter-divergence fixtures make the engine warn by design.
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  it('the ordered-u32 key round-trips every finite float and preserves order', () => {
    // Round-trip: ordered key -> back to the same f32 value.
    const vals = [-1e30, -1000.5, -3.25, -1, -0.0, 0, 0.5, 3.25, 1000.5, 1e30];
    for (const x of vals) expect(orderedKeyToF32(f32ToOrderedKey(x))).toBe(Math.fround(x));
    // Monotonicity: a < b  ⇔  key(a) < key(b), so atomicMin picks the min.
    const sorted = [...vals].sort((a, b) => a - b);
    const keys = sorted.map(f32ToOrderedKey);
    for (let i = 1; i < keys.length; i++) {
      if (Math.fround(sorted[i - 1]) === Math.fround(sorted[i])) continue;
      expect(keys[i - 1]).toBeLessThan(keys[i]);
    }
    // The negative branch flips all bits; the non-negative branch flips sign.
    const neg = floatBitsToOrderedU32(0x80000000 | 0x00100000); // a negative
    expect(neg >>> 0).toBe(neg); // stays a valid u32
  });

  it('the min/count reference matches a HAND-COMPUTED tiny grid', () => {
    // 2×2 grid, origin (0,0), 1 m cells. Points (h1,h2,v):
    //   cell0 (0,0): 5, 2, 9   → min 2, count 3
    //   cell1 (1,0): -1, 4     → min -1, count 2
    //   cell2 (0,1): (none)    → NaN, count 0
    //   cell3 (1,1): 7         → min 7, count 1
    // Plus one out-of-grid point (h1=9) that EDGE-CLAMPS into cell1 (col→1).
    const grid: ScatterGrid = { originH1: 0, originH2: 0, cols: 2, rows: 2, cellSizeM: 1 };
    const pts: ScatterPoints = {
      h1: Float32Array.from([0.2, 0.7, 0.1, 1.5, 1.2, 1.6, 9.0]),
      h2: Float32Array.from([0.3, 0.1, 0.9, 0.4, 0.2, 1.5, 0.1]),
      v: Float32Array.from([5, 2, 9, -1, 4, 7, 8]),
      count: 7,
    };
    const out = scatterMinCountReference(pts, grid);
    expect(Array.from(out.counts)).toEqual([3, 3, 0, 1]); // cell1 gains the clamp
    expect(out.z[0]).toBe(2);
    expect(out.z[1]).toBe(-1);
    expect(Number.isNaN(out.z[2])).toBe(true);
    expect(out.z[3]).toBe(7);
  });

  it('the reference is byte-identical to rasterizeDtm("min") on f32 points', () => {
    // Source coords are f32-exact (from a Float32Array position buffer), so
    // the pure-f32 reference and rasterizeDtm's f64-vs-f32 min agree exactly.
    const tp = syntheticPoints().map((p) => ({
      x: Math.fround(p.x),
      y: Math.fround(p.y),
      z: Math.fround(p.z),
    }));
    const mask = new Uint8Array(tp.length).fill(1);
    const dem = rasterizeDtm(tp, mask, { cellSizeM: 1, aggregation: 'min' });
    const grid: ScatterGrid = {
      originH1: dem.originH1,
      originH2: dem.originH2,
      cols: dem.cols,
      rows: dem.rows,
      cellSizeM: dem.cellSizeM,
    };
    const sp: ScatterPoints = {
      h1: Float32Array.from(tp.map((p) => p.x)),
      h2: Float32Array.from(tp.map((p) => p.y)),
      v: Float32Array.from(tp.map((p) => p.z)),
      count: tp.length,
    };
    const ref = scatterMinCountReference(sp, grid);
    // Bit-equal z (NaN-for-NaN) and equal counts.
    expect(bytesEqual(ref.z, dem.z)).toBe(true);
    expect(Array.from(ref.counts)).toEqual(Array.from(dem.counts));
  });

  it('the engine routes scatter to a faithful GPU and the result is exact', async () => {
    const calls = { derivatives: 0, hillshade: 0, scatter: 0 };
    const engine = new TerrainRasterEngine({ gpuFactory: okFactory(faithfulFakeGpu(calls)) });
    const info = await engine.init();
    expect(info.path).toBe('gpu');
    expect(info.probe?.scatterExact).toBe(true);
    expect(info.probe?.scatterCells).toBeGreaterThan(0);

    const { points, grid } = buildScatterProbe();
    const got = await engine.scatterMinCount(points, grid);
    const ref = scatterMinCountReference(points, grid);
    expect(bytesEqual(got.z, ref.z)).toBe(true);
    expect(Array.from(got.counts)).toEqual(Array.from(ref.counts));
    expect(engine.getComputePath().lastCall).toBe('gpu');
    expect(calls.scatter).toBeGreaterThanOrEqual(2); // probe + the call
  });

  it('a scatter-diverging GPU fails the probe → scatter stays on CPU', async () => {
    const corrupt: TerrainRasterBackend = {
      ...faithfulFakeGpu(),
      scatterMinCount: (points, grid) => {
        const out = scatterMinCountReference(points, grid);
        const counts = out.counts.slice();
        // Corrupt one populated count — an exact gate must reject this.
        for (let i = 0; i < counts.length; i++) if (counts[i] > 0) { counts[i] += 1; break; }
        return Promise.resolve({ z: out.z, counts });
      },
    };
    const engine = new TerrainRasterEngine({ gpuFactory: okFactory(corrupt) });
    const info = await engine.init();
    expect(info.path).toBe('cpu');
    expect(info.reason).toBe('probe-mismatch');
    expect(info.probe?.scatterExact).toBe(false);

    // The caller still gets the exact CPU answer.
    const { points, grid } = buildScatterProbe();
    const got = await engine.scatterMinCount(points, grid);
    const ref = scatterMinCountReference(points, grid);
    expect(bytesEqual(got.z, ref.z)).toBe(true);
    expect(engine.getComputePath().lastCall).toBe('cpu');
  });

  it('a derivatives-trusted GPU without an EXACT scatter keeps scatter on CPU', async () => {
    // The derivative kernels pass, but the scatter is off by one count: the
    // whole probe fails, so NOTHING GPU is trusted — derivatives included.
    // (Scatter and derivatives share one session gate by design.)
    const partial: TerrainRasterBackend = {
      ...faithfulFakeGpu(),
      scatterMinCount: (points, grid) => {
        const out = scatterMinCountReference(points, grid);
        const z = out.z.slice();
        for (let i = 0; i < z.length; i++) if (Number.isFinite(z[i])) { z[i] += 1; break; }
        return Promise.resolve({ z, counts: out.counts });
      },
    };
    const engine = new TerrainRasterEngine({ gpuFactory: okFactory(partial) });
    const info = await engine.init();
    expect(info.probe?.scatterExact).toBe(false);
    expect(info.path).toBe('cpu');
    const { points, grid } = buildScatterProbe();
    expect(engine.getComputePath().lastCall).toBeNull();
    await engine.scatterMinCount(points, grid);
    expect(engine.getComputePath().lastCall).toBe('cpu');
  });

  it('compareScatterGrids is EXACT: any z or count mismatch fails', () => {
    const { points, grid } = buildScatterProbe();
    const a = scatterMinCountReference(points, grid);
    expect(compareScatterGrids(a, a).exact).toBe(true);
    const bz = { z: a.z.slice(), counts: a.counts };
    for (let i = 0; i < bz.z.length; i++) if (Number.isFinite(bz.z[i])) { bz.z[i] += 1e-6; break; }
    expect(compareScatterGrids(a, bz).exact).toBe(false);
    const bc = { z: a.z, counts: a.counts.slice() };
    bc.counts[0] = bc.counts[0] + 1;
    expect(compareScatterGrids(a, bc).exact).toBe(false);
  });

  it('the CPU backend scatter IS the reference (exact, with empties as NaN)', async () => {
    const backend = createCpuBackend();
    const { points, grid } = buildScatterProbe();
    const got = await backend.scatterMinCount!(points, grid);
    const ref = scatterMinCountReference(points, grid);
    expect(bytesEqual(got.z, ref.z)).toBe(true);
    expect(Array.from(got.counts)).toEqual(Array.from(ref.counts));
    // The probe grid has at least one genuinely empty cell (NaN, count 0).
    const empties = Array.from(got.counts).filter((c) => c === 0).length;
    expect(empties).toBeGreaterThan(0);
  });
});

describe('singleton + telemetry', () => {
  it('getTerrainRasterEngine returns one engine; telemetry reads through it', () => {
    setTerrainRasterEngineForTests(null);
    const a = getTerrainRasterEngine();
    const b = getTerrainRasterEngine();
    expect(a).toBe(b);
    const status = getLastTerrainRasterComputePath();
    expect(status.path).toBe('cpu');
    expect(status.reason).toBe('not-initialised');
    expect(status.lastCall).toBeNull();
    setTerrainRasterEngineForTests(null);
  });
});
