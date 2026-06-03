/**
 * sparkline.ts
 *
 * Pure SVG path builder for tiny inline-line / bar charts. No DOM, no
 * external libraries — just numeric inputs in, SVG `d` string + viewport
 * dimensions out. The Inspector card and PDF report card both render
 * sparklines from the same builder so a future tweak to the visual
 * idiom lands everywhere.
 *
 * Design choices:
 *   - We accept raw samples (no pre-binning required). NaN / Infinity
 *     samples break the path into separate runs so a "no-coverage" gap
 *     reads as a discontinuity, not an interpolated lie.
 *   - The y-axis is auto-ranged from the finite samples. Callers that
 *     want a fixed range (e.g. "0% to 100% density") pass `yMin` /
 *     `yMax` explicitly.
 *   - Output is unit-less SVG geometry. The caller chooses the
 *     viewBox and the stroke / fill from CSS.
 */

/** A sparkline build result. */
export interface SparklineResult {
  /**
   * One SVG `d` path string per contiguous run of finite samples.
   * Empty when no finite samples were provided.
   */
  readonly paths: readonly string[];
  /** Viewport width in SVG units (same as the input). */
  readonly width: number;
  /** Viewport height in SVG units (same as the input). */
  readonly height: number;
  /** Resolved y-axis minimum (after auto-range or explicit input). */
  readonly yMin: number;
  /** Resolved y-axis maximum (after auto-range or explicit input). */
  readonly yMax: number;
  /** Count of finite samples actually plotted. */
  readonly plotted: number;
}

/** Inputs to `buildSparkline`. */
export interface SparklineInput {
  readonly samples: ReadonlyArray<number>;
  /** Viewport width in SVG units. */
  readonly width: number;
  /** Viewport height in SVG units. */
  readonly height: number;
  /** Padding inside the viewport. Defaults to 1 unit. */
  readonly padding?: number;
  /** Explicit y-axis min. Defaults to the min of the finite samples. */
  readonly yMin?: number;
  /** Explicit y-axis max. Defaults to the max of the finite samples. */
  readonly yMax?: number;
  /**
   * When true, NaN / Infinity samples ARE counted as zero rather than
   * breaking the run. Default false (the "honest" path). Useful for a
   * histogram-style chart where missing bins really mean zero.
   */
  readonly treatGapsAsZero?: boolean;
}

/**
 * Build a sparkline path. Pure: deterministic given the same input.
 */
export function buildSparkline(input: SparklineInput): SparklineResult {
  const W = input.width;
  const H = input.height;
  const PAD = input.padding ?? 1;
  const n = input.samples.length;

  if (n === 0) {
    return {
      paths: [],
      width: W,
      height: H,
      yMin: 0,
      yMax: 0,
      plotted: 0,
    };
  }

  // Auto-range from finite values.
  let yMin = input.yMin;
  let yMax = input.yMax;
  if (yMin === undefined || yMax === undefined) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of input.samples) {
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (yMin === undefined) yMin = lo === Infinity ? 0 : lo;
    if (yMax === undefined) yMax = hi === -Infinity ? 0 : hi;
  }
  const ySpan = Math.max(yMax - yMin, 1e-9);
  const innerW = Math.max(W - PAD * 2, 0);
  const innerH = Math.max(H - PAD * 2, 0);
  const xStep = n > 1 ? innerW / (n - 1) : 0;

  const paths: string[] = [];
  let cur = '';
  let plotted = 0;
  for (let i = 0; i < n; i++) {
    const v = input.samples[i];
    const finite = Number.isFinite(v);
    if (!finite && !input.treatGapsAsZero) {
      if (cur) {
        paths.push(cur);
        cur = '';
      }
      continue;
    }
    const y = finite ? v : 0;
    const x = PAD + i * xStep;
    // SVG y grows downward; invert so larger sample values plot higher.
    const py = H - PAD - ((y - yMin) / ySpan) * innerH;
    cur += cur === '' ? `M${x.toFixed(2)} ${py.toFixed(2)}` : ` L${x.toFixed(2)} ${py.toFixed(2)}`;
    plotted += 1;
  }
  if (cur) paths.push(cur);

  return {
    paths,
    width: W,
    height: H,
    yMin,
    yMax,
    plotted,
  };
}

/**
 * Build a bar-style sparkline (one rectangle per sample) returning the
 * rectangle geometry the caller can map into `<rect>` elements.
 * Useful for classification distributions and density histograms.
 */
export interface SparkBarsResult {
  readonly bars: ReadonlyArray<{
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }>;
  readonly width: number;
  readonly height: number;
  readonly yMin: number;
  readonly yMax: number;
}

export function buildSparkBars(input: SparklineInput): SparkBarsResult {
  const W = input.width;
  const H = input.height;
  const PAD = input.padding ?? 1;
  const n = input.samples.length;
  if (n === 0) {
    return { bars: [], width: W, height: H, yMin: 0, yMax: 0 };
  }
  let yMin = input.yMin ?? 0;
  let yMax = input.yMax;
  if (yMax === undefined) {
    let hi = -Infinity;
    for (const v of input.samples) {
      if (Number.isFinite(v) && v > hi) hi = v;
    }
    yMax = hi === -Infinity ? 0 : hi;
  }
  const ySpan = Math.max(yMax - yMin, 1e-9);
  const innerW = Math.max(W - PAD * 2, 0);
  const innerH = Math.max(H - PAD * 2, 0);
  const barWidth = innerW / n;
  const gap = Math.min(barWidth * 0.2, 1);
  const rectWidth = Math.max(barWidth - gap, 0);

  const bars: SparkBarsResult['bars'] = input.samples.map((v, i) => {
    const finite = Number.isFinite(v);
    const value = finite ? v : 0;
    const clamped = Math.max(yMin as number, Math.min(yMax as number, value));
    const h = ((clamped - (yMin as number)) / ySpan) * innerH;
    return {
      x: PAD + i * barWidth + gap / 2,
      y: H - PAD - h,
      width: rectWidth,
      height: h,
    };
  });
  return { bars, width: W, height: H, yMin: yMin as number, yMax: yMax as number };
}
