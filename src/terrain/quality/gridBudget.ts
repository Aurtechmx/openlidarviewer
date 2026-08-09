/**
 * gridBudget.ts — the one enforcement boundary before a terrain grid is
 * allocated.
 *
 * A caller can ask for an enormous extent over a tiny cell — hundreds of
 * millions of cells — and each terrain stage then allocates several arrays over
 * that grid (z, counts, accumulators, confidence, coverage, plus GPU buffers).
 * `recommendGrid` advises a size but is not a boundary; nothing stops a direct
 * caller (a manual grid, a mosaic, a bad request) from driving an allocation
 * that exhausts CPU memory or blows past a WebGPU buffer limit.
 *
 * This module is that boundary. It computes the cost of a proposed grid and
 * returns a verdict — `ready`, `coarsen` (over budget but a coarser grid would
 * fit), or `blocked` (invalid, or so large no reasonable grid helps) — so every
 * DTM / DSM / CHM / slope / aspect / hillshade / change-raster allocation can
 * refuse rather than crash. Pure data: no allocation, no DOM, no GPU calls.
 */

/** ready = allocate; coarsen = too fine, pick a coarser cell; blocked = refuse. */
export type GridBudgetVerdict = 'ready' | 'coarsen' | 'blocked';

export interface GridBudgetRequest {
  readonly cols: number;
  readonly rows: number;
  /**
   * Total CPU bytes a stage allocates per cell across all its arrays. Default 20
   * — a DTM stage holds z (Float32), counts (Uint32), an accumulator (Float32),
   * confidence (Float32) and a coverage byte, plus slack.
   */
  readonly bytesPerCell?: number;
  /** Soft cell-count budget: over it, coarsen. Default 16M (a 4000×4000 grid). */
  readonly softMaxCells?: number;
  /** Soft CPU-byte budget: over it, coarsen. Default 512 MiB. */
  readonly softMaxCpuBytes?: number;
  /**
   * Hard absolute cell ceiling: at or over it the request is blocked outright —
   * no reasonable coarsening produced it, so it is a bad request, not a fine
   * grid. Default 268,435,456 (a 16384×16384 grid).
   */
  readonly hardMaxCells?: number;
  /** WebGPU limits, when a GPU buffer of this grid will be created. */
  readonly gpu?: {
    /** Bytes per cell in the GPU buffer (e.g. 4 for an f32 height texture). */
    readonly bytesPerCell: number;
    /** `GPUSupportedLimits.maxBufferSize`. */
    readonly maxBufferSizeBytes: number;
    /** `GPUSupportedLimits.maxStorageBufferBindingSize`. */
    readonly maxStorageBufferBindingSizeBytes: number;
  };
}

export interface GridBudgetResult {
  readonly verdict: GridBudgetVerdict;
  readonly cellCount: number;
  readonly cpuBytes: number;
  readonly gpuBytes: number | null;
  /** One human sentence explaining the verdict. */
  readonly reason: string;
}

const DEFAULT_BYTES_PER_CELL = 20;
const DEFAULT_SOFT_MAX_CELLS = 16_000_000;
const DEFAULT_SOFT_MAX_CPU_BYTES = 512 * 1024 * 1024;
const DEFAULT_HARD_MAX_CELLS = 268_435_456; // 16384²

/**
 * Decide whether a proposed terrain grid may be allocated. Fail-closed: any
 * non-finite or non-positive dimension is `blocked`, never coerced.
 */
export function checkGridBudget(req: GridBudgetRequest): GridBudgetResult {
  const { cols, rows } = req;
  const bytesPerCell = req.bytesPerCell ?? DEFAULT_BYTES_PER_CELL;
  const softMaxCells = req.softMaxCells ?? DEFAULT_SOFT_MAX_CELLS;
  const softMaxCpuBytes = req.softMaxCpuBytes ?? DEFAULT_SOFT_MAX_CPU_BYTES;
  const hardMaxCells = req.hardMaxCells ?? DEFAULT_HARD_MAX_CELLS;

  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0
      || !Number.isInteger(cols) || !Number.isInteger(rows)) {
    return { verdict: 'blocked', cellCount: 0, cpuBytes: 0, gpuBytes: null,
      reason: `Invalid grid dimensions ${cols}×${rows}; a grid needs positive integer cols and rows.` };
  }

  const cellCount = cols * rows;
  const cpuBytes = cellCount * bytesPerCell;
  const gpuBytes = req.gpu ? cellCount * req.gpu.bytesPerCell : null;

  // Hard ceiling → blocked: this is a bad request, not a fine grid to coarsen.
  if (cellCount >= hardMaxCells || !Number.isSafeInteger(cellCount)) {
    return { verdict: 'blocked', cellCount, cpuBytes, gpuBytes,
      reason: `Grid ${cols}×${rows} = ${cellCount.toLocaleString()} cells is at or over the hard ceiling of ${hardMaxCells.toLocaleString()}; no reasonable grid is this large.` };
  }

  // GPU buffer limits are hard device limits — over them the allocation would
  // fail at buffer creation, so the grid is blocked for a GPU path.
  if (req.gpu != null && gpuBytes != null) {
    if (gpuBytes > req.gpu.maxBufferSizeBytes || gpuBytes > req.gpu.maxStorageBufferBindingSizeBytes) {
      const limit = Math.min(req.gpu.maxBufferSizeBytes, req.gpu.maxStorageBufferBindingSizeBytes);
      return { verdict: 'blocked', cellCount, cpuBytes, gpuBytes,
        reason: `GPU buffer of ${gpuBytes.toLocaleString()} bytes exceeds the device limit of ${limit.toLocaleString()}; coarsen the grid or use the CPU path.` };
    }
  }

  // Soft budget → coarsen: the grid is representable but too fine for comfort.
  if (cellCount > softMaxCells || cpuBytes > softMaxCpuBytes) {
    return { verdict: 'coarsen', cellCount, cpuBytes, gpuBytes,
      reason: `Grid ${cols}×${rows} = ${cellCount.toLocaleString()} cells (${(cpuBytes / (1024 * 1024)).toFixed(0)} MiB) is over the working budget; a coarser cell size is recommended.` };
  }

  return { verdict: 'ready', cellCount, cpuBytes, gpuBytes,
    reason: `Grid ${cols}×${rows} = ${cellCount.toLocaleString()} cells (${(cpuBytes / (1024 * 1024)).toFixed(1)} MiB) is within budget.` };
}
