/**
 * TerrainRasterEngine.ts
 *
 * THE seam for terrain raster construction (tech evaluation 2026-06 §2).
 * One interface owns the raster products — ground filtering
 * (`groundFilterPass`), DTM rasterisation (`gridFromPoints`), and the
 * grid-in → grid-out derivatives (slope / aspect / hillshade) — behind two
 * backends:
 *
 *   - `cpuBackend` — PURE DELEGATION to the existing, tested functions
 *     (`classifyGroundSmrf`, `rasterizeDtm`, `hornSlopeAspect`,
 *     `shadeFromSlopeAspect`). No logic moved, byte-identical outputs.
 *     This is the REFERENCE implementation and the always-available
 *     fallback — WebGL2-only devices never leave this path.
 *   - `gpuBackend` — WebGPU compute (WGSL) for the embarrassingly-parallel
 *     DERIVATIVES kernels only this phase; point→grid scatter and the
 *     ground filter stay on the CPU functions even when the GPU backend
 *     is active (see gpuBackend.ts).
 *
 * HONESTY CONTRACT (outranks speed, by mandate): a GPU result that
 * diverges from the CPU truth is a FAILURE, not a fast answer. The engine
 * therefore refuses to activate the GPU backend until it passes a
 * once-per-session EQUIVALENCE PROBE — both backends run on a synthetic
 * 64×64 grid (smooth hills + a linear ramp + NaN holes + an exactly-flat
 * patch) and must agree per-cell within the tolerances below. Any of the
 * following silently (to the user) demotes the session to CPU, recorded in
 * the compute-path telemetry (mirroring `getLastTerrainComputePath` in
 * computeTerrainCoreAsync.ts):
 *
 *   - `navigator.gpu` absent            → reason 'webgpu-unavailable'
 *   - adapter/device request fails      → reason 'device-request-failed'
 *   - the equivalence probe fails       → reason 'probe-mismatch'
 *   - a later GPU dispatch throws       → reason 'gpu-dispatch-failed'
 *     (the failed call is recomputed on CPU, so the caller still gets the
 *     reference answer; the GPU is not retried this session)
 *
 * FLOAT-ORDER CAVEATS (why the tolerance is 1e-4, not 0): the CPU path
 * does its arithmetic in f64 and stores f32; WGSL computes in f32 and may
 * fuse/reassociate (FMA), and its atan2/sqrt are implementation-precision.
 * Per-cell agreement is therefore asserted within 1e-4 (slope rise/run;
 * aspect radians) rather than bit-equality. Aspect is compared as an
 * ANGULAR distance (wrap at 2π) and only where the reference slope exceeds
 * `EQUIVALENCE_ASPECT_SLOPE_FLOOR` — on numerically-flat cells the
 * gradient direction is meaningless noise (atan2 of ±1e-9s) and hillshade
 * is insensitive to it (sin(slope)≈0). Exactly-flat cells are still
 * exercised: both backends must produce the exact slope-0/aspect-0
 * convention there. Hillshade (8-bit grey) is allowed ±1 level for the
 * Math.round (half-up) vs GPU rounding seam.
 *
 * SYNC vs ASYNC: WebGPU readback is inherently asynchronous, but the live
 * contour pipeline (`computeTerrainCore`) is synchronous inside the terrain
 * worker. Phase 1 therefore routes the pipeline's derivative stage through
 * `derivativesSync` / `hillshadeSync` — the CPU reference, byte-identical
 * to before — while `derivatives()` / `hillshade()` are the async,
 * GPU-eligible entry points (auto-init, probe-gated, auto-fallback) that
 * the pipeline switches to when its derivative stage goes async in the
 * next phase. Real-GPU verification runs in the browser e2e
 * (tests/e2e/gpuDerivatives.spec.ts); Node/vitest exercises the dispatch
 * logic via a mock device (see gpuBackend.ts / tests).
 *
 * Module is loadable in Node and in workers (no top-level DOM/GPU access).
 */

import type { TerrainPoint } from '../TerrainContracts';
import type { GroundFilterParams, GroundFilterResult } from '../ground/groundFilter';
import type { RasterizeDtmParams, DemRaster } from '../ground/rasterizeDtm';
import { hornSlopeAspect, type TerrainDerivatives } from '../ground/terrainDerivatives';
import {
  shadeFromSlopeAspect,
  type HillshadeParams,
  type HillshadeResult,
} from '../surface/hillshade';
import { createCpuBackend } from './cpuBackend';
import { defaultGpuBackendFactory, type GpuBackendFactory } from './gpuBackend';
import {
  scatterMinCountReference,
  type ScatterGrid,
  type ScatterPoints,
  type ScatterMinCount,
} from './dtmScatter';

// Re-exported so engine consumers (and tests) need only this seam module.
export type { GpuBackendFactory, GpuBackendFactoryResult } from './gpuBackend';
export type { ScatterGrid, ScatterPoints, ScatterMinCount } from './dtmScatter';

/** Which backend computed (or would compute) a raster product. */
export type TerrainRasterPath = 'cpu' | 'gpu';

/**
 * Why the engine is on its current path. `'gpu-active'` is the only value
 * for path `'gpu'`; every other value names the (recorded, silent-to-user)
 * reason the session is pinned to the CPU reference.
 */
export type TerrainRasterReason =
  | 'gpu-active'
  | 'not-initialised'
  | 'webgpu-unavailable'
  | 'device-request-failed'
  | 'probe-mismatch'
  | 'gpu-dispatch-failed';

/** Result of the once-per-session equivalence probe (or a test harness run). */
export interface TerrainEquivalenceReport {
  readonly passed: boolean;
  /** Probe grid cell count (64×64 = 4096). */
  readonly cells: number;
  /** Cells whose reference slope cleared the aspect floor (aspect compared). */
  readonly comparedAspectCells: number;
  /** Max per-cell |Δslope| (rise/run). */
  readonly maxSlopeErr: number;
  /** Max per-cell angular aspect distance (radians, wrap at 2π). */
  readonly maxAspectErr: number;
  /** Max per-cell |Δshade| (8-bit grey levels). */
  readonly maxShadeErr: number;
  /** Hillshade coverage masks agree cell-for-cell. */
  readonly coverageMatches: boolean;
  /**
   * Phase-2 DTM scatter probe (min/count): true when the GPU scatter grid is
   * EXACTLY equal to the CPU reference — both the per-cell min elevation
   * (bit-equal, NaN-for-NaN) and the per-cell count. Min and count are
   * order-independent integer-stable reductions, so this is an exact gate,
   * not a tolerance. Null when the backend does not implement the scatter.
   */
  readonly scatterExact: boolean | null;
  /** Probe scatter cell count (the synthetic scatter grid). */
  readonly scatterCells: number;
}

/** Session-level compute-path record. */
export interface TerrainRasterComputeInfo {
  readonly path: TerrainRasterPath;
  readonly reason: TerrainRasterReason;
  /** The probe report when a probe ran this session; null before/without one. */
  readonly probe: TerrainEquivalenceReport | null;
}

/** {@link TerrainRasterComputeInfo} plus the path of the most recent call. */
export interface TerrainRasterComputeStatus extends TerrainRasterComputeInfo {
  readonly lastCall: TerrainRasterPath | null;
}

/**
 * The backend contract. `groundFilterPass` and `gridFromPoints` are
 * synchronous (CPU functions in BOTH backends this phase — point→grid
 * scatter is atomics-bound on GPU and deferred); `derivatives` and
 * `hillshade` are async because WebGPU readback is.
 */
export interface TerrainRasterBackend {
  readonly kind: TerrainRasterPath;
  groundFilterPass(
    points: ReadonlyArray<TerrainPoint>,
    params: GroundFilterParams,
  ): GroundFilterResult;
  gridFromPoints(
    points: ReadonlyArray<TerrainPoint>,
    isGround: Uint8Array | ReadonlyArray<number>,
    params?: RasterizeDtmParams,
  ): DemRaster;
  /**
   * GPU-eligible point→cell scatter for the INTEGER-STABLE reductions only —
   * per-cell `min` elevation + per-cell `count` (density) — over a resolved
   * grid (phase 2). Async because WebGPU readback is. The CPU backend
   * implements this as the pure {@link scatterMinCountReference} (the
   * always-available fallback); the GPU backend dispatches the atomic-min /
   * atomic-add kernels. `mean`/`median`/`percentile`/`robust` do NOT route
   * here — they stay on {@link gridFromPoints} (CPU `rasterizeDtm`).
   */
  scatterMinCount(
    points: ScatterPoints,
    grid: ScatterGrid,
  ): Promise<ScatterMinCount>;
  derivatives(
    z: Float32Array,
    cols: number,
    rows: number,
    cellSizeM: number,
  ): Promise<TerrainDerivatives>;
  hillshade(
    slope: ArrayLike<number>,
    aspect: ArrayLike<number>,
    coverage: Uint8Array | ReadonlyArray<number>,
    cols: number,
    rows: number,
    params?: HillshadeParams,
  ): Promise<HillshadeResult>;
  dispose?(): void;
}

// ── Equivalence-gate constants ──────────────────────────────────────────────

/** Probe grid edge length (cells). 64×64 per the phase-1 mandate. */
export const PROBE_GRID_SIZE = 64;
/** Max allowed per-cell |Δslope| (rise/run) between backends. */
export const EQUIVALENCE_SLOPE_TOLERANCE = 1e-4;
/** Max allowed per-cell angular aspect distance (radians). */
export const EQUIVALENCE_ASPECT_TOLERANCE_RAD = 1e-4;
/**
 * Aspect is only compared where the REFERENCE slope exceeds this floor —
 * below it the gradient direction is numerical noise (see header). The
 * slope value itself is still compared on every cell.
 */
export const EQUIVALENCE_ASPECT_SLOPE_FLOOR = 1e-6;
/** Max allowed per-cell |Δshade| in 8-bit grey levels (rounding seam). */
export const EQUIVALENCE_SHADE_TOLERANCE = 1;

const TWO_PI = 2 * Math.PI;

/** The deterministic synthetic probe surface. */
export interface ProbeGrid {
  readonly z: Float32Array;
  readonly cols: number;
  readonly rows: number;
  readonly cellSizeM: number;
}

/**
 * Build the deterministic probe surface: gentle sinusoidal hills on a
 * linear ramp (every cell has a real gradient → aspect is well-defined),
 * an exactly-flat 8×8 patch (the slope-0/aspect-0 convention must hold
 * EXACTLY on both backends), and scattered NaN holes (the validity-mask /
 * fall-back-to-centre path must agree).
 */
export function buildProbeGrid(
  cols: number = PROBE_GRID_SIZE,
  rows: number = PROBE_GRID_SIZE,
): ProbeGrid {
  const z = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      let v = 5 * Math.sin(c * 0.23) + 4 * Math.cos(r * 0.19) + 0.03 * c + 0.02 * r;
      // Exactly-flat patch — interior cells must yield slope 0 / aspect 0.
      if (r >= 40 && r < 48 && c >= 40 && c < 48) v = 2.5;
      z[i] = v;
      // Deterministic NaN holes (~2 % of cells), avoiding none/all rows.
      if ((r * 31 + c * 17) % 53 === 0) z[i] = Number.NaN;
    }
  }
  return { z, cols, rows, cellSizeM: 1 };
}

/** The deterministic synthetic scatter probe: points + the grid to bin into. */
export interface ScatterProbe {
  readonly points: ScatterPoints;
  readonly grid: ScatterGrid;
}

/**
 * Build the deterministic scatter probe: a 24×24-cell grid and ~6 000
 * synthetic points scattered across it (a deterministic LCG), with:
 *   - cells holding MANY returns (the atomic-min / atomic-add contention the
 *     GPU kernel must get right under concurrency);
 *   - completely EMPTY cells (must stay NaN with count 0, the no-data state);
 *   - both POSITIVE and NEGATIVE elevations (the ordered-key sign handling);
 *   - returns that fall OUTSIDE the grid extent (the edge-clamp path).
 * Every coordinate is f32-exact (stored through a Float32Array) so the CPU
 * reference and the GPU agree without any f64-vs-f32 ambiguity (see
 * dtmScatter.ts).
 */
export function buildScatterProbe(): ScatterProbe {
  const cols = 24;
  const rows = 24;
  const cellSizeM = 1;
  const grid: ScatterGrid = { originH1: 0, originH2: 0, cols, rows, cellSizeM };
  const nPts = 6000;
  const h1 = new Float32Array(nPts);
  const h2 = new Float32Array(nPts);
  const v = new Float32Array(nPts);
  let s = 987654321;
  const next = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = 0; i < nPts; i++) {
    // Spread over [-2, cols+2) in h1 (a margin clamps onto edge cells), but
    // CONFINE h2 to the lower ~70% of the grid so the top rows stay genuinely
    // EMPTY — the no-data → NaN / count-0 path must be exercised by the probe.
    h1[i] = Math.fround(next() * (cols + 4) - 2);
    h2[i] = Math.fround(next() * (rows * 0.7));
    // Elevations straddle zero so the ordered-key sign branch is exercised;
    // a deterministic dip biases some cells low so the min is unambiguous.
    v[i] = Math.fround(next() * 20 - 10);
    // Force a cluster of MANY returns into one cell (atomic contention).
    if (i % 5 === 0) {
      h1[i] = Math.fround(3.5);
      h2[i] = Math.fround(3.5);
      v[i] = Math.fround(-i * 0.001 - 1); // strictly descending → clear min
    }
  }
  return { points: { h1, h2, v, count: nPts }, grid };
}

/**
 * EXACT per-cell agreement of a scatter result (min z + counts) against the
 * CPU reference. Min and count are order-independent, so a faithful GPU
 * scatter must match BIT-for-BIT (NaN-for-NaN on empty cells). Any mismatch
 * fails the gate — there is no tolerance here.
 */
export function compareScatterGrids(
  ref: ScatterMinCount,
  got: ScatterMinCount,
): { exact: boolean; cells: number } {
  const n = ref.z.length;
  if (got.z.length !== n || got.counts.length !== n || ref.counts.length !== n) {
    return { exact: false, cells: n };
  }
  // Bit-compare the elevation (so NaN==NaN and −0/+0 are caught) and the count.
  const refBits = new Uint32Array(ref.z.buffer, ref.z.byteOffset, n);
  const gotBits = new Uint32Array(got.z.buffer, got.z.byteOffset, n);
  for (let i = 0; i < n; i++) {
    if (refBits[i] !== gotBits[i]) return { exact: false, cells: n };
    if (ref.counts[i] !== got.counts[i]) return { exact: false, cells: n };
  }
  return { exact: true, cells: n };
}

/** Per-cell slope/aspect agreement between a reference and a candidate. */
export function compareDerivativeGrids(
  ref: TerrainDerivatives,
  got: TerrainDerivatives,
): { maxSlopeErr: number; maxAspectErr: number; comparedAspectCells: number } {
  const n = ref.slope.length;
  if (got.slope.length !== n || got.aspect.length !== n) {
    return { maxSlopeErr: Infinity, maxAspectErr: Infinity, comparedAspectCells: 0 };
  }
  let maxSlopeErr = 0;
  let maxAspectErr = 0;
  let compared = 0;
  for (let i = 0; i < n; i++) {
    const ds = Math.abs(ref.slope[i] - got.slope[i]);
    // NaN must count as divergence, not silently compare as "not greater".
    if (Number.isNaN(ds)) maxSlopeErr = Infinity;
    else if (ds > maxSlopeErr) maxSlopeErr = ds;
    if (ref.slope[i] > EQUIVALENCE_ASPECT_SLOPE_FLOOR) {
      compared++;
      let da = Math.abs(ref.aspect[i] - got.aspect[i]) % TWO_PI;
      if (da > Math.PI) da = TWO_PI - da;
      if (Number.isNaN(da)) maxAspectErr = Infinity;
      else if (da > maxAspectErr) maxAspectErr = da;
    }
  }
  return { maxSlopeErr, maxAspectErr, comparedAspectCells: compared };
}

/**
 * Run the equivalence probe against a candidate backend: derivatives on the
 * probe grid, then hillshade — fed the CPU slope/aspect on BOTH sides so the
 * shade kernel is judged in isolation from derivative noise. The CPU
 * functions are the reference by contract.
 */
export async function runEquivalenceProbe(
  backend: TerrainRasterBackend,
): Promise<TerrainEquivalenceReport> {
  const { z, cols, rows, cellSizeM } = buildProbeGrid();
  const ref = hornSlopeAspect(z, cols, rows, cellSizeM);
  const got = await backend.derivatives(z, cols, rows, cellSizeM);
  const d = compareDerivativeGrids(ref, got);

  const n = cols * rows;
  const cov = new Uint8Array(n);
  for (let i = 0; i < n; i++) cov[i] = Number.isFinite(z[i]) ? 1 : 0;
  const refShade = shadeFromSlopeAspect(ref.slope, ref.aspect, cov, cols, rows);
  const gotShade = await backend.hillshade(ref.slope, ref.aspect, cov, cols, rows);
  let maxShadeErr = 0;
  let coverageMatches =
    gotShade.shade.length === refShade.shade.length &&
    gotShade.coverage.length === refShade.coverage.length;
  if (coverageMatches) {
    for (let i = 0; i < n; i++) {
      const dsh = Math.abs(refShade.shade[i] - gotShade.shade[i]);
      if (dsh > maxShadeErr) maxShadeErr = dsh;
      if (refShade.coverage[i] !== gotShade.coverage[i]) coverageMatches = false;
    }
  } else {
    maxShadeErr = Infinity;
  }

  // ── Phase-2 DTM scatter (min/count): EXACT equality against the CPU
  //    reference. A backend without a scatter (older/partial) reports null and
  //    is judged on the derivative gates alone — the engine simply won't route
  //    scatter to it. ──
  let scatterExact: boolean | null = null;
  let scatterCells = 0;
  if (typeof backend.scatterMinCount === 'function') {
    const sp = buildScatterProbe();
    const refScatter = scatterMinCountReference(sp.points, sp.grid);
    const gotScatter = await backend.scatterMinCount(sp.points, sp.grid);
    const cmp = compareScatterGrids(refScatter, gotScatter);
    scatterExact = cmp.exact;
    scatterCells = cmp.cells;
  }

  const passed =
    d.maxSlopeErr <= EQUIVALENCE_SLOPE_TOLERANCE &&
    d.maxAspectErr <= EQUIVALENCE_ASPECT_TOLERANCE_RAD &&
    maxShadeErr <= EQUIVALENCE_SHADE_TOLERANCE &&
    coverageMatches &&
    // A backend that ships a scatter must pass it EXACTLY; null (no scatter)
    // is fine — only an actual mismatch fails the gate.
    scatterExact !== false;
  return {
    passed,
    cells: n,
    comparedAspectCells: d.comparedAspectCells,
    maxSlopeErr: d.maxSlopeErr,
    maxAspectErr: d.maxAspectErr,
    maxShadeErr,
    coverageMatches,
    scatterExact,
    scatterCells,
  };
}

// ── The engine ──────────────────────────────────────────────────────────────

/** Constructor options — test seams; production callers pass nothing. */
export interface TerrainRasterEngineOptions {
  /** Replace the WebGPU backend factory (tests inject fakes here). */
  readonly gpuFactory?: GpuBackendFactory;
  /** Replace the CPU backend (tests only; production uses the delegation one). */
  readonly cpuBackend?: TerrainRasterBackend;
}

export class TerrainRasterEngine {
  private readonly cpu: TerrainRasterBackend;
  private readonly gpuFactory: GpuBackendFactory;
  private gpu: TerrainRasterBackend | null = null;
  private info: TerrainRasterComputeInfo = {
    path: 'cpu',
    reason: 'not-initialised',
    probe: null,
  };
  private lastCall: TerrainRasterPath | null = null;
  private initPromise: Promise<TerrainRasterComputeInfo> | null = null;

  constructor(options: TerrainRasterEngineOptions = {}) {
    this.cpu = options.cpuBackend ?? createCpuBackend();
    this.gpuFactory = options.gpuFactory ?? defaultGpuBackendFactory;
  }

  /**
   * Initialise once per session: detect WebGPU, request a device, run the
   * equivalence probe. Idempotent — concurrent/repeat callers share one
   * promise. Never throws; every failure mode resolves to a CPU-path info
   * with the reason recorded.
   */
  init(): Promise<TerrainRasterComputeInfo> {
    this.initPromise ??= this.runInit();
    return this.initPromise;
  }

  private async runInit(): Promise<TerrainRasterComputeInfo> {
    try {
      const res = await this.gpuFactory();
      if (!res.ok) {
        this.info = { path: 'cpu', reason: res.failure, probe: null };
        return this.info;
      }
      const probe = await runEquivalenceProbe(res.backend);
      if (!probe.passed) {
        // The probe failing is exactly the divergence the honesty contract
        // forbids shipping — announce it to developers, stay on CPU.
        console.warn(
          '[terrain] WebGPU equivalence probe FAILED — terrain compute stays on the CPU reference path.',
          probe,
        );
        try {
          res.backend.dispose?.();
        } catch {
          // A backend that can't even dispose changes nothing — we are
          // already refusing to use it.
        }
        this.info = { path: 'cpu', reason: 'probe-mismatch', probe };
        return this.info;
      }
      this.gpu = res.backend;
      this.info = { path: 'gpu', reason: 'gpu-active', probe };
      return this.info;
    } catch (err) {
      console.warn('[terrain] WebGPU init failed; staying on the CPU reference path:', err);
      this.info = { path: 'cpu', reason: 'device-request-failed', probe: null };
      return this.info;
    }
  }

  /** Session path + reason + probe report + last-call path (telemetry). */
  getComputePath(): TerrainRasterComputeStatus {
    return { ...this.info, lastCall: this.lastCall };
  }

  // ── Raster construction (CPU functions in both backends this phase) ──────

  /** Ground filtering — pure delegation to `classifyGroundSmrf`. */
  groundFilterPass(
    points: ReadonlyArray<TerrainPoint>,
    params: GroundFilterParams,
  ): GroundFilterResult {
    return this.cpu.groundFilterPass(points, params);
  }

  /** DTM rasterisation — pure delegation to `rasterizeDtm`. */
  gridFromPoints(
    points: ReadonlyArray<TerrainPoint>,
    isGround: Uint8Array | ReadonlyArray<number>,
    params?: RasterizeDtmParams,
  ): DemRaster {
    return this.cpu.gridFromPoints(points, isGround, params);
  }

  // ── DTM scatter (phase 2): min/count on the GPU, probe-gated ─────────────

  /**
   * Point→cell scatter for the integer-stable reductions (`min` z + `count`),
   * GPU when the session probe passed its EXACT scatter gate, CPU otherwise.
   * Same auto-fallback contract as {@link derivatives}: a dispatch failure
   * demotes the session to CPU (recorded) and the failed call is recomputed
   * on the CPU reference, so the caller always gets the exact answer.
   *
   * The GPU is used only when `info.probe.scatterExact === true` — a backend
   * whose scatter did not prove exact (or that has no scatter) stays on the
   * CPU reference for this op even if its derivative kernels are trusted.
   */
  async scatterMinCount(points: ScatterPoints, grid: ScatterGrid): Promise<ScatterMinCount> {
    await this.init();
    const gpu = this.gpu;
    if (gpu && this.info.probe?.scatterExact === true && gpu.scatterMinCount) {
      try {
        const out = await gpu.scatterMinCount(points, grid);
        this.lastCall = 'gpu';
        return out;
      } catch (err) {
        this.demoteGpu('scatterMinCount', err);
      }
    }
    this.lastCall = 'cpu';
    return scatterMinCountReference(points, grid);
  }

  // ── Derivatives: sync CPU reference (live pipeline) ──────────────────────

  /**
   * The synchronous CPU REFERENCE path — what the (synchronous, worker-side)
   * contour pipeline calls today. Pure delegation to `hornSlopeAspect`;
   * byte-identical to calling it directly.
   */
  derivativesSync(
    z: Float32Array,
    cols: number,
    rows: number,
    cellSizeM: number,
  ): TerrainDerivatives {
    this.lastCall = 'cpu';
    return hornSlopeAspect(z, cols, rows, cellSizeM);
  }

  /** Synchronous CPU reference hillshade — delegates to `shadeFromSlopeAspect`. */
  hillshadeSync(
    slope: ArrayLike<number>,
    aspect: ArrayLike<number>,
    coverage: Uint8Array | ReadonlyArray<number>,
    cols: number,
    rows: number,
    params?: HillshadeParams,
  ): HillshadeResult {
    this.lastCall = 'cpu';
    return shadeFromSlopeAspect(slope, aspect, coverage, cols, rows, params);
  }

  // ── Derivatives: async, GPU-eligible (probe-gated, auto-fallback) ────────

  /**
   * Async derivatives — GPU when the session probe passed, CPU otherwise.
   * A GPU dispatch failure demotes the session to CPU (recorded) and the
   * failed call is recomputed on the CPU so the caller always gets the
   * reference answer.
   */
  async derivatives(
    z: Float32Array,
    cols: number,
    rows: number,
    cellSizeM: number,
  ): Promise<TerrainDerivatives> {
    await this.init();
    const gpu = this.gpu;
    if (gpu) {
      try {
        const out = await gpu.derivatives(z, cols, rows, cellSizeM);
        this.lastCall = 'gpu';
        return out;
      } catch (err) {
        this.demoteGpu('derivatives', err);
      }
    }
    this.lastCall = 'cpu';
    return hornSlopeAspect(z, cols, rows, cellSizeM);
  }

  /** Async hillshade — same routing/fallback contract as {@link derivatives}. */
  async hillshade(
    slope: ArrayLike<number>,
    aspect: ArrayLike<number>,
    coverage: Uint8Array | ReadonlyArray<number>,
    cols: number,
    rows: number,
    params?: HillshadeParams,
  ): Promise<HillshadeResult> {
    await this.init();
    const gpu = this.gpu;
    if (gpu) {
      try {
        const out = await gpu.hillshade(slope, aspect, coverage, cols, rows, params);
        this.lastCall = 'gpu';
        return out;
      } catch (err) {
        this.demoteGpu('hillshade', err);
      }
    }
    this.lastCall = 'cpu';
    return shadeFromSlopeAspect(slope, aspect, coverage, cols, rows, params);
  }

  /** A dispatch failure pins the rest of the session to CPU — announced. */
  private demoteGpu(what: string, err: unknown): void {
    console.warn(
      `[terrain] GPU ${what} dispatch failed; falling back to CPU for the rest of the session (CPU remains the reference):`,
      err,
    );
    try {
      this.gpu?.dispose?.();
    } catch {
      // Already demoting; a dispose failure adds nothing.
    }
    this.gpu = null;
    this.info = { path: 'cpu', reason: 'gpu-dispatch-failed', probe: this.info.probe };
  }
}

// ── Singleton + telemetry (per thread — main thread and worker each get one) ─

let singleton: TerrainRasterEngine | null = null;

/** The shared engine for this thread (lazily constructed; never throws). */
export function getTerrainRasterEngine(): TerrainRasterEngine {
  singleton ??= new TerrainRasterEngine();
  return singleton;
}

/** Replace/reset the singleton (tests only). Pass null to reset. */
export function setTerrainRasterEngineForTests(engine: TerrainRasterEngine | null): void {
  singleton = engine;
}

/**
 * Compute-path telemetry, mirroring `getLastTerrainComputePath` in
 * computeTerrainCoreAsync.ts: which backend the engine is on, why, the
 * probe evidence, and the path of the most recent call. Verification-only —
 * reading it changes nothing.
 */
export function getLastTerrainRasterComputePath(): TerrainRasterComputeStatus {
  return getTerrainRasterEngine().getComputePath();
}

// Verification-only browser hook for the deferred real-GPU e2e gate
// (tests/e2e/gpuDerivatives.spec.ts): lets the spec init the engine and read
// the probe verdict on a real WebGPU device. Main thread only (workers and
// Node have no `window`); registering a debug handle has no behavioural
// effect on the pipeline.
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__olvTerrainRasterEngine = {
    init: () => getTerrainRasterEngine().init(),
    getComputePath: getLastTerrainRasterComputePath,
    runProbe: (backend?: TerrainRasterBackend) =>
      backend ? runEquivalenceProbe(backend) : getTerrainRasterEngine().init(),
  };
}
