/**
 * gpuBackend.ts
 *
 * The WebGPU compute backend of the {@link TerrainRasterEngine}. Phase 1
 * scope (tech evaluation 2026-06 §1): the embarrassingly-parallel
 * DERIVATIVES kernels only — Horn slope/aspect and ESRI hillshade as WGSL
 * compute over a grid. Point→grid scatter (`gridFromPoints`) and the
 * ground filter (`groundFilterPass`) DELIBERATELY delegate to the same CPU
 * functions as the CPU backend: float-min scatter is atomics-bound on GPU
 * (u32 bit-cast tricks, 3–15× at best) and is deferred until the
 * derivatives path has proven out in production.
 *
 * KERNEL FIDELITY — the WGSL mirrors terrainDerivatives.ts /
 * surface/hillshade.ts operation-for-operation:
 *   - edge handling: index clamp (replicate border);
 *   - non-finite neighbours fall back to the CENTRE value;
 *   - non-finite centre cells yield slope 0 / aspect 0;
 *   - aspect = atan2(−dzdy, −dzdx) on the NORTHING-UP grid (row+1 = north),
 *     with the exact-zero-gradient → aspect 0 convention;
 *   - hillshade rounds half-UP (floor(x + 0.5)) to match Math.round, and
 *     returns the same coverage mask semantics.
 *
 * NaN HANDLING: WGSL implementations may assume floats are non-NaN
 * (fast-math), so `v != v` tests are not reliable on every driver. The
 * backend therefore pre-computes a u32 VALIDITY MASK on the CPU (an O(n)
 * pass) and uploads a NaN-free copy of the grid; the kernels branch on the
 * mask, never on NaN. {@link buildValidityMask} is exported and unit-tested.
 *
 * FLOAT-ORDER CAVEATS (documented for the equivalence gate): the CPU
 * reference computes in f64 and stores f32; the GPU computes in f32 and
 * may fuse multiply-adds or reassociate, and WGSL atan2/sqrt precision is
 * implementation-defined. {@link hornDerivativesF32Reference} is a
 * Math.fround-faithful TypeScript transcription of the WGSL kernel used by
 * the Node test harness to bound that gap on synthetic grids (within the
 * engine's 1e-4 gate); REAL-device agreement is verified by the
 * once-per-session probe in TerrainRasterEngine.ts and the browser e2e.
 *
 * Node-testability: the device is consumed through the minimal structural
 * {@link GpuDeviceLike} interface (this project does not pull in
 * @webgpu/types), so vitest exercises the dispatch logic — buffer sizes,
 * bind-group layout, workgroup counts, readback plumbing — against a mock
 * device. No top-level `navigator` access: the module loads in Node.
 */

import { classifyGroundSmrf } from '../ground/groundFilter';
import { rasterizeDtm } from '../ground/rasterizeDtm';
import type { TerrainDerivatives } from '../ground/terrainDerivatives';
import {
  azimuthToMathRad,
  type HillshadeParams,
  type HillshadeResult,
} from '../surface/hillshade';
import { SCATTER_MIN_SENTINEL, type ScatterMinCount } from './dtmScatter';
import type { TerrainRasterBackend } from './TerrainRasterEngine';

// ── Minimal structural WebGPU types (subset; mockable in Node) ──────────────

export interface GpuBufferLike {
  mapAsync(mode: number): Promise<void>;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
  destroy?(): void;
}

export interface GpuComputePipelineLike {
  getBindGroupLayout(index: number): unknown;
}

export interface GpuComputePassLike {
  setPipeline(pipeline: GpuComputePipelineLike): void;
  setBindGroup(index: number, group: unknown): void;
  dispatchWorkgroups(x: number, y?: number, z?: number): void;
  end(): void;
}

export interface GpuCommandEncoderLike {
  beginComputePass(): GpuComputePassLike;
  copyBufferToBuffer(
    src: GpuBufferLike,
    srcOffset: number,
    dst: GpuBufferLike,
    dstOffset: number,
    size: number,
  ): void;
  finish(): unknown;
}

export interface GpuQueueLike {
  writeBuffer(buffer: GpuBufferLike, offset: number, data: ArrayBufferView): void;
  submit(commands: unknown[]): void;
}

export interface GpuDeviceLike {
  createShaderModule(desc: { code: string }): unknown;
  createComputePipeline(desc: {
    layout: 'auto';
    compute: { module: unknown; entryPoint: string };
  }): GpuComputePipelineLike;
  createBuffer(desc: { size: number; usage: number }): GpuBufferLike;
  createBindGroup(desc: {
    layout: unknown;
    entries: Array<{ binding: number; resource: { buffer: GpuBufferLike } }>;
  }): unknown;
  createCommandEncoder(): GpuCommandEncoderLike;
  readonly queue: GpuQueueLike;
  destroy?(): void;
}

/**
 * GPUBufferUsage / GPUMapMode flag values from the WebGPU spec — inlined
 * because the globals only exist in a browser and this module must load in
 * Node for the mock-device tests.
 */
export const GPU_USAGE = {
  MAP_READ: 0x0001,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  UNIFORM: 0x0040,
  STORAGE: 0x0080,
} as const;
export const GPU_MAP_READ = 0x0001;

// ── Dispatch geometry (pure, unit-tested) ───────────────────────────────────

/** Horn kernel workgroup edge (16×16 threads per group). */
export const HORN_WORKGROUP_DIM = 16;
/** Hillshade kernel workgroup size (1-D, 256 threads per group). */
export const SHADE_WORKGROUP_SIZE = 256;

/** Workgroup grid for the 2-D Horn kernel. */
export function dispatchDims2d(cols: number, rows: number): { x: number; y: number } {
  return {
    x: Math.max(1, Math.ceil(cols / HORN_WORKGROUP_DIM)),
    y: Math.max(1, Math.ceil(rows / HORN_WORKGROUP_DIM)),
  };
}

/** Workgroup count for the 1-D hillshade kernel. */
export function dispatchDims1d(n: number): number {
  return Math.max(1, Math.ceil(n / SHADE_WORKGROUP_SIZE));
}

/**
 * CPU pre-pass: a NaN-free copy of the grid plus a u32 validity mask
 * (1 = finite). The kernels branch on the mask, never on NaN (see header).
 */
export function buildValidityMask(z: ArrayLike<number>): {
  zClean: Float32Array;
  valid: Uint32Array;
} {
  const n = z.length;
  const zClean = new Float32Array(n);
  const valid = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const v = z[i];
    if (Number.isFinite(v)) {
      zClean[i] = v;
      valid[i] = 1;
    }
  }
  return { zClean, valid };
}

// ── WGSL kernels ────────────────────────────────────────────────────────────

/**
 * Horn (1981) slope/aspect — the WGSL twin of `hornSlopeAspect`
 * (terrainDerivatives.ts). Grid convention is NORTHING-UP: row+1 is north,
 * so dzdy is +∂z/∂northing and aspect negates BOTH gradient components.
 */
export const HORN_DERIVATIVES_WGSL = /* wgsl */ `
struct Params {
  cols : u32,
  rows : u32,
  cellX : f32,
  cellY : f32,
};

@group(0) @binding(0) var<storage, read> zin : array<f32>;
@group(0) @binding(1) var<storage, read> valid : array<u32>;
@group(0) @binding(2) var<storage, read_write> slopeOut : array<f32>;
@group(0) @binding(3) var<storage, read_write> aspectOut : array<f32>;
@group(0) @binding(4) var<uniform> p : Params;

// Edge-clamped sample; invalid (originally non-finite) cells fall back to
// the centre value — mirrors at() in terrainDerivatives.ts.
fn sample(r : i32, c : i32, fallback : f32) -> f32 {
  let rr = clamp(r, 0, i32(p.rows) - 1);
  let cc = clamp(c, 0, i32(p.cols) - 1);
  let i = u32(rr) * p.cols + u32(cc);
  if (valid[i] == 1u) { return zin[i]; }
  return fallback;
}

@compute @workgroup_size(16, 16)
fn horn_main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= p.cols || gid.y >= p.rows) { return; }
  let idx = gid.y * p.cols + gid.x;
  if (valid[idx] == 0u) {
    slopeOut[idx] = 0.0;
    aspectOut[idx] = 0.0;
    return;
  }
  let e = zin[idx];
  let row = i32(gid.y);
  let col = i32(gid.x);
  // 3x3 neighbourhood (a b c / d e f / g h i2), edge-clamped, invalid->centre.
  let a  = sample(row - 1, col - 1, e);
  let b  = sample(row - 1, col,     e);
  let c  = sample(row - 1, col + 1, e);
  let d  = sample(row,     col - 1, e);
  let f  = sample(row,     col + 1, e);
  let g  = sample(row + 1, col - 1, e);
  let h  = sample(row + 1, col,     e);
  let i2 = sample(row + 1, col + 1, e);
  // Per-axis cell sizes: a geographic grid's E–W (column) spacing is
  // cos φ × the N–S (row) spacing, so each gradient divides by ITS axis.
  let dzdx = (c + 2.0 * f + i2 - (a + 2.0 * d + g)) / (8.0 * p.cellX);
  let dzdy = (g + 2.0 * h + i2 - (a + 2.0 * b + c)) / (8.0 * p.cellY);
  slopeOut[idx] = sqrt(dzdx * dzdx + dzdy * dzdy);
  if (dzdx == 0.0 && dzdy == 0.0) {
    aspectOut[idx] = 0.0;
  } else {
    aspectOut[idx] = atan2(-dzdy, -dzdx);
  }
}
`;

/**
 * ESRI hillshade from cached slope/aspect — the WGSL twin of
 * `shadeFromSlopeAspect` (surface/hillshade.ts). Coverage AND finiteness
 * are pre-folded into `cov` on the CPU. floor(x + 0.5) reproduces JS
 * Math.round (half-up) — WGSL round() is half-to-even and would diverge.
 */
export const HILLSHADE_WGSL = /* wgsl */ `
struct ShadeParams {
  n : u32,
  cosZen : f32,
  sinZen : f32,
  azimuth : f32,
  zFactor : f32,
  _pad0 : f32,
  _pad1 : f32,
  _pad2 : f32,
};

@group(0) @binding(0) var<storage, read> slopeIn : array<f32>;
@group(0) @binding(1) var<storage, read> aspectIn : array<f32>;
@group(0) @binding(2) var<storage, read> cov : array<u32>;
@group(0) @binding(3) var<storage, read_write> shadeOut : array<u32>;
@group(0) @binding(4) var<uniform> sp : ShadeParams;

@compute @workgroup_size(256)
fn hillshade_main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= sp.n) { return; }
  if (cov[i] == 0u) {
    shadeOut[i] = 0u;
    return;
  }
  let slopeRad = atan(sp.zFactor * slopeIn[i]);
  let hs = sp.cosZen * cos(slopeRad) + sp.sinZen * sin(slopeRad) * cos(sp.azimuth - aspectIn[i]);
  shadeOut[i] = u32(clamp(floor(255.0 * hs + 0.5), 0.0, 255.0));
}
`;

/** Scatter / finalize kernel workgroup size (1-D, 256 threads per group). */
export const SCATTER_WORKGROUP_SIZE = 256;

/** Workgroup count for a 1-D scatter over `nPoints` (or `nCells` finalize). */
export function dispatchScatter1d(n: number): number {
  return Math.max(1, Math.ceil(n / SCATTER_WORKGROUP_SIZE));
}

/**
 * DTM min/count SCATTER — phase 2 (tech evaluation §2). One thread per
 * point: bin (h1, h2) into a cell with the SAME floor-divide + edge-clamp as
 * `rasterizeDtm` / `cellIndex`, then
 *   - `atomicMin` the elevation's ORDER-PRESERVING u32 key into the cell's
 *     key slot (the float-min-via-u32 trick: u32 key order == f32 numeric
 *     order, so the smallest float wins — see dtmScatter.ts), and
 *   - `atomicAdd(1)` the cell's count (order-independent integer add).
 * Min and count are both order-independent, so the parallel result is
 * EXACTLY the CPU's sequential result (the probe asserts bit-equality).
 *
 * NaN never reaches the GPU: the caller drops non-finite returns first, the
 * same `Number.isFinite` gate the CPU rasteriser applies.
 */
export const SCATTER_MINCOUNT_WGSL = /* wgsl */ `
struct ScatterParams {
  originH1 : f32,
  originH2 : f32,
  cols : u32,
  rows : u32,
  cell : f32,
  nPoints : u32,
  _pad0 : u32,
  _pad1 : u32,
};

@group(0) @binding(0) var<storage, read> h1in : array<f32>;
@group(0) @binding(1) var<storage, read> h2in : array<f32>;
@group(0) @binding(2) var<storage, read> vin : array<f32>;
@group(0) @binding(3) var<storage, read_write> keyOut : array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> countOut : array<atomic<u32>>;
@group(0) @binding(5) var<uniform> sp : ScatterParams;

// f32 bit pattern -> order-preserving u32 key (radix-sort key); mirrors
// floatBitsToOrderedU32 in dtmScatter.ts exactly.
fn ordered_key(value : f32) -> u32 {
  let bits = bitcast<u32>(value);
  if ((bits & 0x80000000u) != 0u) { return ~bits; }       // negative: flip all
  return bits | 0x80000000u;                               // non-neg: flip sign
}

// Same cell indexing as rasterizeDtm / cellIndex: floor-divide then clamp.
fn cell_index(h1 : f32, h2 : f32) -> u32 {
  let fc = floor((h1 - sp.originH1) / sp.cell);
  let fr = floor((h2 - sp.originH2) / sp.cell);
  // clamp into [0, cols) x [0, rows). f32 floor of an in-range value is exact
  // for these grid sizes; the i32 round-trip matches the JS Math.floor path.
  var col = i32(fc);
  var row = i32(fr);
  col = clamp(col, 0, i32(sp.cols) - 1);
  row = clamp(row, 0, i32(sp.rows) - 1);
  return u32(row) * sp.cols + u32(col);
}

@compute @workgroup_size(256)
fn scatter_main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= sp.nPoints) { return; }
  let c = cell_index(h1in[i], h2in[i]);
  atomicMin(&keyOut[c], ordered_key(vin[i]));
  atomicAdd(&countOut[c], 1u);
}
`;

/**
 * Finalize the scatter: one thread per CELL decodes the winning ordered key
 * back to its f32 elevation, or writes the CANONICAL NaN bit pattern
 * (0x7FC00000 — the same one `Float32Array.fill(NaN)` stores, so the probe's
 * bit-compare matches) when the cell received no return (key still the
 * sentinel / count 0). The decode mirrors orderedU32ToFloatBits exactly.
 */
export const SCATTER_FINALIZE_WGSL = /* wgsl */ `
struct FinalizeParams {
  nCells : u32,
  sentinel : u32,
  _pad0 : u32,
  _pad1 : u32,
};

@group(0) @binding(0) var<storage, read> keyIn : array<u32>;
@group(0) @binding(1) var<storage, read> countIn : array<u32>;
@group(0) @binding(2) var<storage, read_write> zOut : array<u32>; // f32 bits
@group(0) @binding(3) var<uniform> fp : FinalizeParams;

// ordered u32 key -> f32 bit pattern (inverse of ordered_key).
fn key_to_bits(key : u32) -> u32 {
  if ((key & 0x80000000u) != 0u) { return key & 0x7fffffffu; } // was non-neg
  return ~key;                                                  // was negative
}

@compute @workgroup_size(256)
fn finalize_main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= fp.nCells) { return; }
  if (countIn[i] == 0u) {
    zOut[i] = 0x7fc00000u; // canonical NaN — matches Float32Array.fill(NaN)
    return;
  }
  zOut[i] = key_to_bits(keyIn[i]);
}
`;

// ── f32 reference transcription (test harness; see header caveats) ──────────

/**
 * A Math.fround-faithful TypeScript transcription of the Horn WGSL kernel —
 * every intermediate rounded to f32 in the kernel's operation order. The
 * Node equivalence harness runs THIS against the f64 CPU reference to bound
 * the f32-vs-f64 gap within the 1e-4 gate on synthetic grids; it cannot
 * capture driver-specific FMA/reassociation or atan2 precision, which is
 * exactly why the real device must still pass the per-session probe.
 */
export function hornDerivativesF32Reference(
  z: Float32Array,
  cols: number,
  rows: number,
  cellSizeM: number,
  cellSizeYM: number = cellSizeM,
): TerrainDerivatives {
  const n = cols * rows;
  const slope = new Float32Array(n);
  const aspect = new Float32Array(n);
  if (n === 0 || !(cellSizeM > 0) || !(cellSizeYM > 0)) return { slope, aspect };
  const { zClean, valid } = buildValidityMask(z);
  const fr = Math.fround;
  // Per-axis denominators, mirroring the kernel's cellX / cellY uniforms.
  const denomX = fr(8 * fr(cellSizeM));
  const denomY = fr(8 * fr(cellSizeYM));
  const sample = (r: number, c: number, fallback: number): number => {
    const rr = r < 0 ? 0 : r >= rows ? rows - 1 : r;
    const cc = c < 0 ? 0 : c >= cols ? cols - 1 : c;
    const i = rr * cols + cc;
    return valid[i] === 1 ? zClean[i] : fallback;
  };
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      if (valid[idx] === 0) continue; // slope/aspect stay 0
      const e = zClean[idx];
      const zA = sample(row - 1, col - 1, e);
      const zB = sample(row - 1, col, e);
      const zC = sample(row - 1, col + 1, e);
      const zD = sample(row, col - 1, e);
      const zF = sample(row, col + 1, e);
      const zG = sample(row + 1, col - 1, e);
      const zH = sample(row + 1, col, e);
      const zI = sample(row + 1, col + 1, e);
      // (c + 2f + i2 − (a + 2d + g)) / (8·cell), f32 at every step, per axis.
      const dzdx = fr(fr(fr(fr(zC + fr(2 * zF)) + zI) - fr(fr(zA + fr(2 * zD)) + zG)) / denomX);
      const dzdy = fr(fr(fr(fr(zG + fr(2 * zH)) + zI) - fr(fr(zA + fr(2 * zB)) + zC)) / denomY);
      slope[idx] = fr(Math.sqrt(fr(fr(dzdx * dzdx) + fr(dzdy * dzdy))));
      aspect[idx] = dzdx === 0 && dzdy === 0 ? 0 : fr(Math.atan2(-dzdy, -dzdx));
    }
  }
  return { slope, aspect };
}

// ── The backend ─────────────────────────────────────────────────────────────

/** Read a buffer back as a copy (staging buffer + mapAsync). */
async function readBack(
  device: GpuDeviceLike,
  src: GpuBufferLike,
  byteLength: number,
  encoder?: GpuCommandEncoderLike,
): Promise<ArrayBuffer> {
  const staging = device.createBuffer({
    size: byteLength,
    usage: GPU_USAGE.MAP_READ | GPU_USAGE.COPY_DST,
  });
  const enc = encoder ?? device.createCommandEncoder();
  enc.copyBufferToBuffer(src, 0, staging, 0, byteLength);
  device.queue.submit([enc.finish()]);
  await staging.mapAsync(GPU_MAP_READ);
  const data = staging.getMappedRange().slice(0);
  staging.unmap();
  staging.destroy?.();
  return data;
}

function destroyAll(buffers: GpuBufferLike[]): void {
  for (const b of buffers) {
    try {
      b.destroy?.();
    } catch {
      // Best-effort cleanup; a destroy failure must not mask the result.
    }
  }
}

/**
 * Wrap a WebGPU(-like) device as a TerrainRasterBackend. Pipelines compile
 * lazily on first use and are cached for the backend's lifetime.
 */
export function createGpuBackend(device: GpuDeviceLike): TerrainRasterBackend {
  let hornPipeline: GpuComputePipelineLike | null = null;
  let shadePipeline: GpuComputePipelineLike | null = null;
  let scatterPipeline: GpuComputePipelineLike | null = null;
  let finalizePipeline: GpuComputePipelineLike | null = null;
  const horn = (): GpuComputePipelineLike =>
    (hornPipeline ??= device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: HORN_DERIVATIVES_WGSL }),
        entryPoint: 'horn_main',
      },
    }));
  const shade = (): GpuComputePipelineLike =>
    (shadePipeline ??= device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: HILLSHADE_WGSL }),
        entryPoint: 'hillshade_main',
      },
    }));
  const scatter = (): GpuComputePipelineLike =>
    (scatterPipeline ??= device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: SCATTER_MINCOUNT_WGSL }),
        entryPoint: 'scatter_main',
      },
    }));
  const finalize = (): GpuComputePipelineLike =>
    (finalizePipeline ??= device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: SCATTER_FINALIZE_WGSL }),
        entryPoint: 'finalize_main',
      },
    }));

  return {
    kind: 'gpu',
    // Ground filtering and the FULL DemRaster construction stay on the CPU
    // functions (mean/median/percentile/robust are not atomics-tractable);
    // only the integer-stable min/count scatter below moves to the GPU.
    groundFilterPass: classifyGroundSmrf,
    gridFromPoints: rasterizeDtm,

    // ── DTM min/count scatter (phase 2): atomic-min on the ordered float key
    //    + atomic-add on the count, then a finalize pass decoding keys → f32
    //    (NaN where empty). EXACT vs the CPU reference (min/count are
    //    order-independent), so the engine probe gates it on bit-equality. ──
    async scatterMinCount(points, grid): Promise<ScatterMinCount> {
      const nCells = grid.cols * grid.rows;
      // Mirror the CPU guards: an empty grid scatters nothing.
      if (nCells === 0) {
        return { z: new Float32Array(0), counts: new Uint32Array(0) };
      }
      const nPts = Math.max(0, Math.floor(points.count));
      const cellBytes = nCells * 4;
      // Per-point inputs as compact f32 arrays (the kernels read f32). An
      // empty scatter still finalises (all cells → NaN/0), so we always run.
      const h1 = Float32Array.from(
        { length: nPts },
        (_v, i) => (points.h1 as ArrayLike<number>)[i],
      );
      const h2 = Float32Array.from(
        { length: nPts },
        (_v, i) => (points.h2 as ArrayLike<number>)[i],
      );
      const vv = Float32Array.from(
        { length: nPts },
        (_v, i) => (points.v as ArrayLike<number>)[i],
      );
      const ptBytes = Math.max(4, nPts * 4); // WebGPU disallows zero-size buffers

      const h1Buf = device.createBuffer({
        size: ptBytes,
        usage: GPU_USAGE.STORAGE | GPU_USAGE.COPY_DST,
      });
      const h2Buf = device.createBuffer({
        size: ptBytes,
        usage: GPU_USAGE.STORAGE | GPU_USAGE.COPY_DST,
      });
      const vBuf = device.createBuffer({
        size: ptBytes,
        usage: GPU_USAGE.STORAGE | GPU_USAGE.COPY_DST,
      });
      const keyBuf = device.createBuffer({
        size: cellBytes,
        usage: GPU_USAGE.STORAGE | GPU_USAGE.COPY_DST | GPU_USAGE.COPY_SRC,
      });
      const countBuf = device.createBuffer({
        size: cellBytes,
        usage: GPU_USAGE.STORAGE | GPU_USAGE.COPY_DST | GPU_USAGE.COPY_SRC,
      });
      const zBuf = device.createBuffer({
        size: cellBytes,
        usage: GPU_USAGE.STORAGE | GPU_USAGE.COPY_SRC,
      });
      const scatterUni = device.createBuffer({
        size: 32,
        usage: GPU_USAGE.UNIFORM | GPU_USAGE.COPY_DST,
      });
      const finalizeUni = device.createBuffer({
        size: 16,
        usage: GPU_USAGE.UNIFORM | GPU_USAGE.COPY_DST,
      });

      if (nPts > 0) {
        device.queue.writeBuffer(h1Buf, 0, h1);
        device.queue.writeBuffer(h2Buf, 0, h2);
        device.queue.writeBuffer(vBuf, 0, vv);
      }
      // Initialise the atomic-min keys to the +∞ sentinel and counts to 0 —
      // the first real value displaces the sentinel, and a cell still holding
      // it (count 0) finalises to NaN.
      device.queue.writeBuffer(keyBuf, 0, new Uint32Array(nCells).fill(SCATTER_MIN_SENTINEL));
      device.queue.writeBuffer(countBuf, 0, new Uint32Array(nCells));

      const sUni = new ArrayBuffer(32);
      new Float32Array(sUni, 0, 2).set([grid.originH1, grid.originH2]);
      new Uint32Array(sUni, 8, 2).set([grid.cols, grid.rows]);
      new Float32Array(sUni, 16, 1)[0] = grid.cellSizeM;
      new Uint32Array(sUni, 20, 1)[0] = nPts;
      device.queue.writeBuffer(scatterUni, 0, new Uint8Array(sUni));

      const fUni = new ArrayBuffer(16);
      new Uint32Array(fUni, 0, 2).set([nCells, SCATTER_MIN_SENTINEL]);
      device.queue.writeBuffer(finalizeUni, 0, new Uint8Array(fUni));

      const enc = device.createCommandEncoder();
      // Pass 1: scatter (skipped device-side when there are no points, but the
      // dispatch is cheap and keeps the encoder uniform).
      if (nPts > 0) {
        const sPipe = scatter();
        const sBind = device.createBindGroup({
          layout: sPipe.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: h1Buf } },
            { binding: 1, resource: { buffer: h2Buf } },
            { binding: 2, resource: { buffer: vBuf } },
            { binding: 3, resource: { buffer: keyBuf } },
            { binding: 4, resource: { buffer: countBuf } },
            { binding: 5, resource: { buffer: scatterUni } },
          ],
        });
        const sPass = enc.beginComputePass();
        sPass.setPipeline(sPipe);
        sPass.setBindGroup(0, sBind);
        sPass.dispatchWorkgroups(dispatchScatter1d(nPts));
        sPass.end();
      }
      // Pass 2: finalize keys → f32 (NaN where empty).
      const fPipe = finalize();
      const fBind = device.createBindGroup({
        layout: fPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: keyBuf } },
          { binding: 1, resource: { buffer: countBuf } },
          { binding: 2, resource: { buffer: zBuf } },
          { binding: 3, resource: { buffer: finalizeUni } },
        ],
      });
      const fPass = enc.beginComputePass();
      fPass.setPipeline(fPipe);
      fPass.setBindGroup(0, fBind);
      fPass.dispatchWorkgroups(dispatchScatter1d(nCells));
      fPass.end();

      const zData = readBack(device, zBuf, cellBytes, enc);
      const z = new Float32Array(await zData);
      const counts = new Uint32Array(await readBack(device, countBuf, cellBytes));
      destroyAll([h1Buf, h2Buf, vBuf, keyBuf, countBuf, zBuf, scatterUni, finalizeUni]);
      return { z, counts };
    },

    async derivatives(z, cols, rows, cellSizeM, cellSizeYM): Promise<TerrainDerivatives> {
      const n = cols * rows;
      // Omitted Y cell = square cells (identical to the historical call).
      const cellY = cellSizeYM ?? cellSizeM;
      // Mirror the CPU guards exactly: empty / non-positive cell → zeros.
      if (n === 0 || !(cellSizeM > 0) || !(cellY > 0)) {
        return { slope: new Float32Array(n), aspect: new Float32Array(n) };
      }
      const { zClean, valid } = buildValidityMask(z);
      const bytes = n * 4;
      const zBuf = device.createBuffer({
        size: bytes,
        usage: GPU_USAGE.STORAGE | GPU_USAGE.COPY_DST,
      });
      const validBuf = device.createBuffer({
        size: bytes,
        usage: GPU_USAGE.STORAGE | GPU_USAGE.COPY_DST,
      });
      const slopeBuf = device.createBuffer({
        size: bytes,
        usage: GPU_USAGE.STORAGE | GPU_USAGE.COPY_SRC,
      });
      const aspectBuf = device.createBuffer({
        size: bytes,
        usage: GPU_USAGE.STORAGE | GPU_USAGE.COPY_SRC,
      });
      const uniBuf = device.createBuffer({
        size: 16,
        usage: GPU_USAGE.UNIFORM | GPU_USAGE.COPY_DST,
      });
      device.queue.writeBuffer(zBuf, 0, zClean);
      device.queue.writeBuffer(validBuf, 0, valid);
      const uni = new ArrayBuffer(16);
      new Uint32Array(uni, 0, 2).set([cols, rows]);
      // Per-axis cell sizes (cellX at byte 8, cellY at byte 12) — the WGSL
      // Params struct; the probe's anisotropic pass verifies the kernel
      // actually divides each gradient by its own axis.
      new Float32Array(uni, 8, 2).set([cellSizeM, cellY]);
      device.queue.writeBuffer(uniBuf, 0, new Uint8Array(uni));

      const pipeline = horn();
      const bind = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: zBuf } },
          { binding: 1, resource: { buffer: validBuf } },
          { binding: 2, resource: { buffer: slopeBuf } },
          { binding: 3, resource: { buffer: aspectBuf } },
          { binding: 4, resource: { buffer: uniBuf } },
        ],
      });
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind);
      const dims = dispatchDims2d(cols, rows);
      pass.dispatchWorkgroups(dims.x, dims.y);
      pass.end();
      // Both copies ride the dispatch encoder; one submit, two readbacks.
      const slopeData = readBack(device, slopeBuf, bytes, enc);
      const slope = new Float32Array(await slopeData);
      const aspect = new Float32Array(await readBack(device, aspectBuf, bytes));
      destroyAll([zBuf, validBuf, slopeBuf, aspectBuf, uniBuf]);
      return { slope, aspect };
    },

    async hillshade(
      slopeIn,
      aspectIn,
      coverage,
      cols,
      rows,
      params?: HillshadeParams,
    ): Promise<HillshadeResult> {
      const n = cols * rows;
      if (n === 0) {
        return { shade: new Uint8Array(0), coverage: new Uint8Array(0), cols, rows };
      }
      // CPU pre-fold, mirroring shadeFromSlopeAspect's per-cell skip rule:
      // covered AND finite slope AND finite aspect. The kernel sees only a
      // mask plus NaN-free inputs (see module header on WGSL NaN).
      const slopeClean = new Float32Array(n);
      const aspectClean = new Float32Array(n);
      const covMask = new Uint32Array(n);
      const cov8 = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        if (coverage[i] === 0) continue;
        const sl = Number(slopeIn[i]);
        const asp = Number(aspectIn[i]);
        if (!Number.isFinite(sl) || !Number.isFinite(asp)) continue;
        slopeClean[i] = sl;
        aspectClean[i] = asp;
        covMask[i] = 1;
        cov8[i] = 1;
      }
      const altitudeDeg = params?.altitudeDeg ?? 45;
      const zFactor = params?.zFactor ?? 1;
      const zenith = ((90 - altitudeDeg) * Math.PI) / 180;
      const azimuth = azimuthToMathRad(params?.azimuthDeg ?? 315);

      const bytes = n * 4;
      const slopeBuf = device.createBuffer({
        size: bytes,
        usage: GPU_USAGE.STORAGE | GPU_USAGE.COPY_DST,
      });
      const aspectBuf = device.createBuffer({
        size: bytes,
        usage: GPU_USAGE.STORAGE | GPU_USAGE.COPY_DST,
      });
      const covBuf = device.createBuffer({
        size: bytes,
        usage: GPU_USAGE.STORAGE | GPU_USAGE.COPY_DST,
      });
      const shadeBuf = device.createBuffer({
        size: bytes,
        usage: GPU_USAGE.STORAGE | GPU_USAGE.COPY_SRC,
      });
      const uniBuf = device.createBuffer({
        size: 32,
        usage: GPU_USAGE.UNIFORM | GPU_USAGE.COPY_DST,
      });
      device.queue.writeBuffer(slopeBuf, 0, slopeClean);
      device.queue.writeBuffer(aspectBuf, 0, aspectClean);
      device.queue.writeBuffer(covBuf, 0, covMask);
      const uni = new ArrayBuffer(32);
      new Uint32Array(uni, 0, 1)[0] = n;
      new Float32Array(uni, 4, 4).set([
        Math.cos(zenith),
        Math.sin(zenith),
        azimuth,
        zFactor,
      ]);
      device.queue.writeBuffer(uniBuf, 0, new Uint8Array(uni));

      const pipeline = shade();
      const bind = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: slopeBuf } },
          { binding: 1, resource: { buffer: aspectBuf } },
          { binding: 2, resource: { buffer: covBuf } },
          { binding: 3, resource: { buffer: shadeBuf } },
          { binding: 4, resource: { buffer: uniBuf } },
        ],
      });
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(dispatchDims1d(n));
      pass.end();
      const shadeU32 = new Uint32Array(await readBack(device, shadeBuf, bytes, enc));
      destroyAll([slopeBuf, aspectBuf, covBuf, shadeBuf, uniBuf]);
      const shadeOut = new Uint8Array(n);
      for (let i = 0; i < n; i++) shadeOut[i] = shadeU32[i] & 255;
      return { shade: shadeOut, coverage: cov8, cols, rows };
    },

    dispose(): void {
      device.destroy?.();
    },
  };
}

// ── Device acquisition (browser; never throws out of the factory) ───────────

/** Discriminated factory result so the engine can record WHY GPU is absent. */
export type GpuBackendFactoryResult =
  | { readonly ok: true; readonly backend: TerrainRasterBackend }
  | {
      readonly ok: false;
      readonly failure: 'webgpu-unavailable' | 'device-request-failed';
      readonly detail?: string;
    };

export type GpuBackendFactory = () => Promise<GpuBackendFactoryResult>;

/** Shape of `navigator.gpu` we rely on (typed locally; no @webgpu/types). */
interface NavigatorGpuLike {
  requestAdapter(): Promise<{ requestDevice(): Promise<GpuDeviceLike> } | null>;
}

/**
 * The production factory: feature-detect `navigator.gpu`, request an
 * adapter and device. Every failure resolves (never rejects) to a
 * discriminated reason the engine records as telemetry.
 */
export async function defaultGpuBackendFactory(): Promise<GpuBackendFactoryResult> {
  const nav = (globalThis as { navigator?: { gpu?: NavigatorGpuLike } }).navigator;
  const gpu = nav?.gpu;
  if (!gpu) return { ok: false, failure: 'webgpu-unavailable' };
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) {
      return { ok: false, failure: 'device-request-failed', detail: 'no adapter' };
    }
    const device = await adapter.requestDevice();
    return { ok: true, backend: createGpuBackend(device) };
  } catch (err) {
    return {
      ok: false,
      failure: 'device-request-failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
