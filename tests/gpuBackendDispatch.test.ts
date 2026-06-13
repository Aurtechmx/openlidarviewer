/**
 * gpuBackendDispatch.test.ts
 *
 * Dispatch logic of the WebGPU terrain backend, exercised against a MOCK
 * device — Node/vitest has no WebGPU, so what is testable here is exactly
 * the plumbing: buffer sizes and usages, uniform packing, bind-group
 * wiring, workgroup geometry, readback staging, and resource cleanup.
 * Kernel ARITHMETIC equivalence is covered by the f32 transcription
 * harness in terrainRasterEngine.test.ts; REAL-device equivalence is the
 * per-session probe plus the browser e2e (tests/e2e/gpuDerivatives.spec.ts).
 */

import { describe, it, expect } from 'vitest';
import {
  createGpuBackend,
  defaultGpuBackendFactory,
  buildValidityMask,
  dispatchDims2d,
  dispatchDims1d,
  HORN_WORKGROUP_DIM,
  SHADE_WORKGROUP_SIZE,
  HORN_DERIVATIVES_WGSL,
  HILLSHADE_WGSL,
  SCATTER_MINCOUNT_WGSL,
  SCATTER_FINALIZE_WGSL,
  SCATTER_WORKGROUP_SIZE,
  dispatchScatter1d,
  GPU_USAGE,
  GPU_MAP_READ,
  type GpuDeviceLike,
  type GpuBufferLike,
  type GpuComputePipelineLike,
} from '../src/terrain/engine/gpuBackend';
import { SCATTER_MIN_SENTINEL, type ScatterPoints, type ScatterGrid } from '../src/terrain/engine/dtmScatter';

// ── Recording mock device ───────────────────────────────────────────────────

interface MockBuffer extends GpuBufferLike {
  readonly size: number;
  readonly usage: number;
  destroyed: boolean;
  written: ArrayBufferView | null;
}

function makeMockDevice(): {
  device: GpuDeviceLike;
  log: {
    buffers: MockBuffer[];
    shaderCodes: string[];
    entryPoints: string[];
    dispatches: Array<{ x: number; y?: number; z?: number }>;
    bindings: number[][];
    submits: number;
    copies: Array<{ size: number }>;
  };
} {
  const log = {
    buffers: [] as MockBuffer[],
    shaderCodes: [] as string[],
    entryPoints: [] as string[],
    dispatches: [] as Array<{ x: number; y?: number; z?: number }>,
    bindings: [] as number[][],
    submits: 0,
    copies: [] as Array<{ size: number }>,
  };
  const device: GpuDeviceLike = {
    createShaderModule: (desc) => {
      log.shaderCodes.push(desc.code);
      return { code: desc.code };
    },
    createComputePipeline: (desc): GpuComputePipelineLike => {
      log.entryPoints.push(desc.compute.entryPoint);
      return { getBindGroupLayout: (index: number) => ({ index }) };
    },
    createBuffer: (desc) => {
      const buf: MockBuffer = {
        size: desc.size,
        usage: desc.usage,
        destroyed: false,
        written: null,
        mapAsync: () => Promise.resolve(),
        // Readback yields zeros — dispatch-logic test, not arithmetic.
        getMappedRange: () => new ArrayBuffer(desc.size),
        unmap: () => {},
        destroy: () => {
          buf.destroyed = true;
        },
      };
      log.buffers.push(buf);
      return buf;
    },
    createBindGroup: (desc) => {
      log.bindings.push(desc.entries.map((e) => e.binding));
      return desc;
    },
    createCommandEncoder: () => ({
      beginComputePass: () => ({
        setPipeline: () => {},
        setBindGroup: () => {},
        dispatchWorkgroups: (x: number, y?: number, z?: number) => {
          log.dispatches.push({ x, y, z });
        },
        end: () => {},
      }),
      copyBufferToBuffer: (_src, _so, _dst, _do, size) => {
        log.copies.push({ size });
      },
      finish: () => ({}),
    }),
    queue: {
      writeBuffer: (buffer, _offset, data) => {
        (buffer as MockBuffer).written = data;
      },
      submit: () => {
        log.submits++;
      },
    },
  };
  return { device, log };
}

// ── Pure helpers ────────────────────────────────────────────────────────────

describe('gpu dispatch helpers (pure)', () => {
  it('dispatchDims2d ceil-divides by the 16×16 workgroup', () => {
    expect(dispatchDims2d(64, 64)).toEqual({ x: 4, y: 4 });
    expect(dispatchDims2d(65, 1)).toEqual({ x: 5, y: 1 });
    expect(dispatchDims2d(1, 17)).toEqual({ x: 1, y: 2 });
    expect(HORN_WORKGROUP_DIM).toBe(16);
  });

  it('dispatchDims1d ceil-divides by 256', () => {
    expect(dispatchDims1d(256)).toBe(1);
    expect(dispatchDims1d(257)).toBe(2);
    expect(dispatchDims1d(1)).toBe(1);
    expect(SHADE_WORKGROUP_SIZE).toBe(256);
  });

  it('buildValidityMask zeroes non-finite cells and flags the rest', () => {
    const z = new Float32Array([1.5, Number.NaN, Infinity, -2, -Infinity, 0]);
    const { zClean, valid } = buildValidityMask(z);
    expect(Array.from(valid)).toEqual([1, 0, 0, 1, 0, 1]);
    expect(Array.from(zClean)).toEqual([1.5, 0, 0, -2, 0, 0]);
  });

  it('the WGSL kernels declare the expected entry points and stages', () => {
    expect(HORN_DERIVATIVES_WGSL).toContain('@compute @workgroup_size(16, 16)');
    expect(HORN_DERIVATIVES_WGSL).toContain('fn horn_main');
    expect(HILLSHADE_WGSL).toContain('@compute @workgroup_size(256)');
    expect(HILLSHADE_WGSL).toContain('fn hillshade_main');
    // The honesty-critical conventions are in the shader text itself:
    expect(HORN_DERIVATIVES_WGSL).toContain('atan2(-dzdy, -dzdx)'); // northing-up aspect
    expect(HILLSHADE_WGSL).toContain('floor(255.0 * hs + 0.5)'); // Math.round, not WGSL round()
  });
});

// ── derivatives dispatch ────────────────────────────────────────────────────

describe('gpuBackend.derivatives — dispatch plumbing on a mock device', () => {
  it('uploads grid + mask, dispatches the right workgroup grid, reads both outputs', async () => {
    const { device, log } = makeMockDevice();
    const backend = createGpuBackend(device);
    const cols = 40;
    const rows = 33;
    const z = new Float32Array(cols * rows).fill(1);
    z[5] = Number.NaN;

    const out = await backend.derivatives(z, cols, rows, 0.5);

    // Output shape (zeros from the mock readback, but correctly sized).
    expect(out.slope.length).toBe(cols * rows);
    expect(out.aspect.length).toBe(cols * rows);

    // One compute dispatch with ceil(40/16)=3 × ceil(33/16)=3 groups.
    expect(log.dispatches).toEqual([{ x: 3, y: 3, z: undefined }]);
    expect(log.entryPoints).toEqual(['horn_main']);

    // Bind group covers bindings 0..4 (z, valid, slope, aspect, params).
    expect(log.bindings[0]).toEqual([0, 1, 2, 3, 4]);

    // Buffer inventory: 4 storage (n·4 bytes) + 1 uniform (16) + 2 staging.
    const bytes = cols * rows * 4;
    const storage = log.buffers.filter((b) => (b.usage & GPU_USAGE.STORAGE) !== 0);
    expect(storage).toHaveLength(4);
    for (const b of storage) expect(b.size).toBe(bytes);
    const uniform = log.buffers.filter((b) => (b.usage & GPU_USAGE.UNIFORM) !== 0);
    expect(uniform).toHaveLength(1);
    expect(uniform[0].size).toBe(16);
    const staging = log.buffers.filter((b) => (b.usage & GPU_USAGE.MAP_READ) !== 0);
    expect(staging).toHaveLength(2);
    expect(log.copies.map((c) => c.size)).toEqual([bytes, bytes]);

    // The uniform packs cols, rows then the f32 cell size.
    const uniData = uniform[0].written as Uint8Array;
    const u32 = new Uint32Array(uniData.buffer, 0, 2);
    expect(Array.from(u32)).toEqual([cols, rows]);
    expect(new Float32Array(uniData.buffer, 8, 1)[0]).toBeCloseTo(0.5, 6);

    // The uploaded grid is the NaN-FREE copy plus the validity mask.
    const zUpload = storage[0].written as Float32Array;
    expect(zUpload[5]).toBe(0);
    const mask = storage[1].written as Uint32Array;
    expect(mask[5]).toBe(0);
    expect(mask[4]).toBe(1);

    // Every working buffer is destroyed after readback.
    for (const b of log.buffers) expect(b.destroyed).toBe(true);
  });

  it('mirrors the CPU guards without touching the device (n=0, bad cell size)', async () => {
    const { device, log } = makeMockDevice();
    const backend = createGpuBackend(device);
    const empty = await backend.derivatives(new Float32Array(0), 0, 0, 1);
    expect(empty.slope.length).toBe(0);
    const badCell = await backend.derivatives(new Float32Array(4), 2, 2, 0);
    expect(Array.from(badCell.slope)).toEqual([0, 0, 0, 0]);
    expect(log.dispatches).toHaveLength(0);
    expect(log.buffers).toHaveLength(0);
  });

  it('compiles each pipeline once and reuses it across calls', async () => {
    const { device, log } = makeMockDevice();
    const backend = createGpuBackend(device);
    const z = new Float32Array(16).fill(2);
    await backend.derivatives(z, 4, 4, 1);
    await backend.derivatives(z, 4, 4, 1);
    expect(log.entryPoints).toEqual(['horn_main']);
  });
});

// ── hillshade dispatch ──────────────────────────────────────────────────────

describe('gpuBackend.hillshade — dispatch plumbing on a mock device', () => {
  it('pre-folds coverage+finiteness, dispatches 1-D, returns 8-bit shade', async () => {
    const { device, log } = makeMockDevice();
    const backend = createGpuBackend(device);
    const n = 300; // → ceil(300/256) = 2 workgroups
    const cols = 30;
    const rows = 10;
    const slope = new Float32Array(n).fill(0.2);
    const aspect = new Float32Array(n);
    slope[7] = Number.NaN; // finiteness fold
    const cov = new Uint8Array(n).fill(1);
    cov[3] = 0; // coverage fold

    const out = await backend.hillshade(slope, aspect, cov, cols, rows, { azimuthDeg: 315 });

    expect(out.shade.length).toBe(n);
    expect(out.cols).toBe(cols);
    expect(out.rows).toBe(rows);
    // Coverage mask reproduces shadeFromSlopeAspect's skip rule.
    expect(out.coverage[3]).toBe(0);
    expect(out.coverage[7]).toBe(0);
    expect(out.coverage[8]).toBe(1);

    expect(log.dispatches).toEqual([{ x: 2, y: undefined, z: undefined }]);
    expect(log.entryPoints).toEqual(['hillshade_main']);
    expect(log.bindings[0]).toEqual([0, 1, 2, 3, 4]);

    const uniform = log.buffers.filter((b) => (b.usage & GPU_USAGE.UNIFORM) !== 0);
    expect(uniform).toHaveLength(1);
    expect(uniform[0].size).toBe(32);
    const uniData = uniform[0].written as Uint8Array;
    expect(new Uint32Array(uniData.buffer, 0, 1)[0]).toBe(n);
    const f = new Float32Array(uniData.buffer, 4, 4);
    // Defaults: altitude 45° → zenith 45°; zFactor 1.
    expect(f[0]).toBeCloseTo(Math.cos(Math.PI / 4), 6);
    expect(f[1]).toBeCloseTo(Math.sin(Math.PI / 4), 6);
    expect(f[3]).toBe(1);

    for (const b of log.buffers) expect(b.destroyed).toBe(true);
  });

  it('returns an empty result without touching the device when n = 0', async () => {
    const { device, log } = makeMockDevice();
    const backend = createGpuBackend(device);
    const out = await backend.hillshade(new Float32Array(0), new Float32Array(0), new Uint8Array(0), 0, 0);
    expect(out.shade.length).toBe(0);
    expect(log.buffers).toHaveLength(0);
  });
});

// ── scatter (min/count) dispatch ────────────────────────────────────────────

describe('gpuBackend.scatterMinCount — dispatch plumbing on a mock device', () => {
  it('uploads points, seeds the key buffer to the sentinel, runs scatter+finalize', async () => {
    const { device, log } = makeMockDevice();
    const backend = createGpuBackend(device);
    const grid: ScatterGrid = { originH1: 0, originH2: 0, cols: 24, rows: 16, cellSizeM: 0.5 };
    const nCells = grid.cols * grid.rows; // 384
    const nPts = 600; // → ceil(600/256) = 3 scatter groups
    const pts: ScatterPoints = {
      h1: new Float32Array(nPts).fill(2),
      h2: new Float32Array(nPts).fill(2),
      v: new Float32Array(nPts).fill(1),
      count: nPts,
    };

    const out = await backend.scatterMinCount!(pts, grid);
    expect(out.z.length).toBe(nCells);
    expect(out.counts.length).toBe(nCells);

    // Two compute passes: scatter (ceil 600/256 = 3) then finalize
    // (ceil 384/256 = 2). Entry points in order.
    expect(log.entryPoints).toEqual(['scatter_main', 'finalize_main']);
    expect(log.dispatches).toEqual([
      { x: dispatchScatter1d(nPts), y: undefined, z: undefined },
      { x: dispatchScatter1d(nCells), y: undefined, z: undefined },
    ]);
    expect(log.dispatches[0].x).toBe(3);
    expect(log.dispatches[1].x).toBe(2);

    // Bind groups: scatter has 6 bindings (h1,h2,v,key,count,uni), finalize 4.
    expect(log.bindings[0]).toEqual([0, 1, 2, 3, 4, 5]);
    expect(log.bindings[1]).toEqual([0, 1, 2, 3]);

    // The key buffer is seeded with the +∞ sentinel for every cell.
    const cellBytes = nCells * 4;
    const keyBufs = log.buffers.filter(
      (b) =>
        b.size === cellBytes &&
        (b.usage & GPU_USAGE.COPY_SRC) !== 0 &&
        b.written instanceof Uint32Array &&
        (b.written as Uint32Array)[0] === SCATTER_MIN_SENTINEL,
    );
    expect(keyBufs.length).toBeGreaterThanOrEqual(1);
    const seeded = keyBufs[0].written as Uint32Array;
    expect(seeded.length).toBe(nCells);
    expect(seeded.every((k) => k === SCATTER_MIN_SENTINEL)).toBe(true);

    // The scatter uniform (32 bytes) packs origin (f32×2), cols/rows (u32×2),
    // cell (f32), nPoints (u32).
    const sUni = log.buffers.find((b) => b.size === 32 && (b.usage & GPU_USAGE.UNIFORM) !== 0);
    expect(sUni).toBeDefined();
    const sData = (sUni!.written as Uint8Array).buffer;
    expect(Array.from(new Float32Array(sData, 0, 2))).toEqual([0, 0]);
    expect(Array.from(new Uint32Array(sData, 8, 2))).toEqual([grid.cols, grid.rows]);
    expect(new Float32Array(sData, 16, 1)[0]).toBeCloseTo(0.5, 6);
    expect(new Uint32Array(sData, 20, 1)[0]).toBe(nPts);

    // The finalize uniform (16 bytes) packs nCells + the sentinel.
    const fUni = log.buffers.find((b) => b.size === 16 && (b.usage & GPU_USAGE.UNIFORM) !== 0);
    expect(fUni).toBeDefined();
    const fData = (fUni!.written as Uint8Array).buffer;
    expect(Array.from(new Uint32Array(fData, 0, 2))).toEqual([nCells, SCATTER_MIN_SENTINEL]);

    // Two readbacks (z + counts), both cell-sized; every buffer destroyed.
    expect(log.copies.map((c) => c.size)).toEqual([cellBytes, cellBytes]);
    for (const b of log.buffers) expect(b.destroyed).toBe(true);
  });

  it('runs the finalize pass even with zero points (all cells → empty)', async () => {
    const { device, log } = makeMockDevice();
    const backend = createGpuBackend(device);
    const grid: ScatterGrid = { originH1: 0, originH2: 0, cols: 4, rows: 4, cellSizeM: 1 };
    const out = await backend.scatterMinCount!(
      { h1: new Float32Array(0), h2: new Float32Array(0), v: new Float32Array(0), count: 0 },
      grid,
    );
    expect(out.z.length).toBe(16);
    // No scatter dispatch (no points); finalize still runs.
    expect(log.entryPoints).toEqual(['finalize_main']);
    expect(log.dispatches).toEqual([{ x: 1, y: undefined, z: undefined }]);
  });

  it('returns empty without touching the device when the grid has no cells', async () => {
    const { device, log } = makeMockDevice();
    const backend = createGpuBackend(device);
    const out = await backend.scatterMinCount!(
      { h1: new Float32Array(0), h2: new Float32Array(0), v: new Float32Array(0), count: 0 },
      { originH1: 0, originH2: 0, cols: 0, rows: 0, cellSizeM: 1 },
    );
    expect(out.z.length).toBe(0);
    expect(log.buffers).toHaveLength(0);
  });

  it('the scatter WGSL declares both entry points and the ordered-key trick', () => {
    expect(SCATTER_MINCOUNT_WGSL).toContain('@compute @workgroup_size(256)');
    expect(SCATTER_MINCOUNT_WGSL).toContain('fn scatter_main');
    expect(SCATTER_MINCOUNT_WGSL).toContain('atomicMin');
    expect(SCATTER_MINCOUNT_WGSL).toContain('atomicAdd');
    expect(SCATTER_MINCOUNT_WGSL).toContain('bitcast<u32>'); // float-min-via-u32
    expect(SCATTER_FINALIZE_WGSL).toContain('fn finalize_main');
    expect(SCATTER_FINALIZE_WGSL).toContain('0x7fc00000u'); // canonical NaN
    expect(SCATTER_WORKGROUP_SIZE).toBe(256);
    expect(GPU_MAP_READ).toBe(0x0001);
  });
});

// ── factory feature detection ───────────────────────────────────────────────

describe('defaultGpuBackendFactory — feature detection in Node', () => {
  it('resolves webgpu-unavailable (Node has no navigator.gpu) without throwing', async () => {
    const res = await defaultGpuBackendFactory();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure).toBe('webgpu-unavailable');
  });
});
