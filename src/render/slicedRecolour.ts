/**
 * slicedRecolour.ts — colour-mode switch for large clouds, spread across frames.
 *
 * Loaded on demand by `recolourEntry` (colorModes.ts) when a cloud is at or
 * above `SLICED_RECOLOUR_MIN_POINTS`. The whole-cloud work (ramp ranges, the
 * density bins) runs once up front; the per-point pass then runs in chunks
 * under a time budget, one batch per animation frame, and each batch uploads
 * only the range it wrote. The bytes are the ones `colorForMode` +
 * `writeFloatColorsInto` would write synchronously: every per-point kernel is
 * called on a subarray with the same range the whole-cloud call resolves.
 *
 * A job stops at its next batch when `entry.recolourJob` no longer holds its
 * token — a newer mode switch, or any whole-buffer write, replaced it.
 */

import { writeFloatColorsInto } from './colorEncode';
import { countDensityCells, densityBins, densityCellSizeFor, densityScale, paintDensity } from './densityColors';
import {
  colorByClassification,
  colorByConfidence,
  colorByCoverage,
  colorByElevation,
  colorByIntensity,
  colorByNormal,
  colorByScalar,
  colorForMode,
  rampRangeForMode,
  type ColorForModeOptions,
  type ColorMode,
  type SliceableEntry,
} from './colorModes';
import type { PointCloud } from '../model/PointCloud';


/** Colours for points `[start, end)`, 3 sRGB bytes per point. */
export type SliceKernel = (start: number, end: number) => Uint8Array;

/**
 * A kernel plus an optional whole-cloud pass that must finish first (the
 * density count). `count` runs over every chunk, then `paint` does.
 */
export interface SlicePlan {
  count?: (start: number, end: number) => void;
  paint: () => SliceKernel;
}

/** Points per kernel call; the budget is checked between chunks. */
export const SLICE_CHUNK_POINTS = 32_768;
/** Main-thread time one batch may spend before yielding to the next frame. */
export const SLICE_BUDGET_MS = 6;

/** How a job yields and reads the clock; injectable for tests. */
export interface SliceScheduler {
  next(run: () => void): void;
  now(): number;
}

const frameScheduler: SliceScheduler = {
  // One-shot per batch; the chain ends when the job finishes or is replaced.
  next: (run) => { requestAnimationFrame(() => run()); },
  now: () => performance.now(),
};


/**
 * The per-point kernel for `mode`, with every whole-cloud quantity resolved.
 * A trust overlay without a grid and any cloud missing the mode's attribute
 * fall back to one `colorForMode` call sliced afterwards, which also keeps its
 * missing-attribute throw. Density is planned separately (`slicePlanFor`).
 */
export function sliceKernelFor(mode: ColorMode, cloud: PointCloud, opts: ColorForModeOptions): SliceKernel {
  const pos = cloud.positions;
  const up = opts.upAxis ?? 2;
  switch (mode) {
    case 'rgb':
      if (cloud.colors) { const c = cloud.colors; return (s, e) => c.subarray(s * 3, e * 3); }
      break;
    case 'intensity': {
      const v = cloud.intensity; const r = rampRangeForMode(mode, cloud, opts);
      if (v && r) return (s, e) => colorByIntensity(v.subarray(s, e), e - s, r.min, r.max);
      break;
    }
    case 'gpsTime': {
      const v = cloud.gpsTime; const r = rampRangeForMode(mode, cloud, opts);
      if (v && r) return (s, e) => colorByScalar(v.subarray(s, e), e - s, r.min, r.max);
      break;
    }
    case 'returnNumber': {
      const v = cloud.returnNumber; const r = rampRangeForMode(mode, cloud, opts);
      if (v && r) return (s, e) => colorByScalar(v.subarray(s, e), e - s, r.min, r.max);
      break;
    }
    case 'elevation': {
      const r = rampRangeForMode(mode, cloud, opts);
      if (r) return (s, e) => colorByElevation(pos.subarray(s * 3, e * 3), e - s, r.min, r.max, undefined, up);
      break;
    }
    case 'normal':
      if (cloud.normals) { const v = cloud.normals; return (s, e) => colorByNormal(v.subarray(s * 3, e * 3), e - s); }
      break;
    case 'classification':
      if (cloud.classification) { const v = cloud.classification; return (s, e) => colorByClassification(v.subarray(s, e), e - s); }
      break;
    case 'coverage':
    case 'confidence': {
      const g = opts.coverageGrid;
      const f = mode === 'coverage' ? colorByCoverage : colorByConfidence;
      if (g) return (s, e) => f(pos.subarray(s * 3, e * 3), e - s, g, up);
      break;
    }
  }
  const full = colorForMode(mode, cloud, opts);
  return (s, e) => full.subarray(s * 3, e * 3);
}

/** Density counts in slices, then paints; every other mode just paints. */
export function slicePlanFor(mode: ColorMode, cloud: PointCloud, opts: ColorForModeOptions): SlicePlan {
  if (mode !== 'density' || cloud.pointCount === 0) return { paint: () => sliceKernelFor(mode, cloud, opts) };
  // Same bins, cell size and scale as colorForMode's densityForChunk call.
  const pos = cloud.positions;
  const up = opts.upAxis ?? 2;
  const bins = densityBins(densityCellSizeFor(pos, up), up);
  return {
    count: (s, e) => countDensityCells(bins, pos, s, e),
    paint: () => {
      const scale = densityScale(bins, {});
      return (s, e) => { const out = new Uint8Array((e - s) * 3); paintDensity(bins, scale, pos, s, e, out); return out; };
    },
  };
}

/**
 * Recolour `entry` to `mode` in budgeted batches. Resolves `true` when every
 * point was written, `false` when a newer write replaced the job first or a
 * kernel threw (logged).
 */
export function runSlicedRecolour(
  entry: SliceableEntry,
  job: object,
  mode: ColorMode,
  opts: ColorForModeOptions,
  changed: () => void,
  sched: SliceScheduler = frameScheduler,
  budgetMs = SLICE_BUDGET_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const n = entry.cloud.pointCount;
    let plan: SlicePlan | null = null;
    let kernel: SliceKernel | null = null;
    let at = 0;
    let counted = 0;
    const batch = (): void => {
      if (entry.recolourJob !== job) { resolve(false); return; }
      try {
        const t0 = sched.now();
        const spent = (): boolean => sched.now() - t0 >= budgetMs;
        plan ??= slicePlanFor(mode, entry.cloud, opts);
        if (plan.count) {
          while (counted < n) {
            const end = Math.min(n, counted + SLICE_CHUNK_POINTS);
            plan.count(counted, end);
            counted = end;
            if (spent()) break;
          }
          if (counted < n) { sched.next(batch); return; }
        }
        kernel ??= plan.paint();
        const dst = entry.colorAttr.array as Float32Array;
        const from = at;
        while (at < n) {
          const end = Math.min(n, at + SLICE_CHUNK_POINTS);
          writeFloatColorsInto(dst.subarray(at * 3, end * 3), kernel(at, end));
          at = end;
          if (spent()) break;
        }
        if (at > from) {
          entry.colorAttr.addUpdateRange?.(from * 3, (at - from) * 3);
          entry.colorAttr.needsUpdate = true;
          changed();
        }
      } catch (err) {
        // No caller to throw to once the switch has returned: report and stop.
        entry.recolourJob = undefined;
        console.error('Sliced recolour failed', err);
        resolve(false);
        return;
      }
      if (at >= n) { entry.recolourJob = undefined; resolve(true); return; }
      sched.next(batch);
    };
    batch();
  });
}
