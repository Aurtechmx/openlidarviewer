/**
 * loadPlan.ts
 *
 * The pure decision logic behind v0.2.7 budget-aware fast loading: given what
 * a file header reveals — its point count, its byte size, the attributes it
 * carries — decide *how* to load it before a single point is decoded.
 *
 * This module has NO three.js, DOM, or I/O dependency, so it is unit-tested in
 * Node and runs identically on the main thread (driving the preflight UI) and
 * inside the parse worker (driving the decode).
 */

import type { SourceFormat } from './sniffFormat';

/** How a cloud is turned into the on-screen point set. */
export type LoadMode = 'all' | 'voxel' | 'stride';

/** Which per-point attributes a cloud carries — drives the memory estimate. */
export interface PointAttributes {
  hasColor: boolean;
  hasIntensity: boolean;
  hasClassification: boolean;
  hasNormals: boolean;
}

/** Everything `planLoad` needs to choose a strategy. */
export interface LoadPlanInput {
  /** Point count read from the file header. */
  sourceCount: number;
  /** Size of the file, in bytes. */
  fileBytes: number;
  /** Point budget for the target device (the desktop or mobile default). */
  budget: number;
  /** True on phones — tightens every threshold. */
  isMobile: boolean;
  /** `navigator.deviceMemory` in GB when the browser reports it, else undefined. */
  deviceMemoryGB?: number;
  /** Attributes the cloud carries. */
  attributes: PointAttributes;
  /** Source format — only `'laz'` changes the memory estimate (WASM heap). */
  format: SourceFormat;
}

/** The chosen strategy plus everything the UI and worker need to act on it. */
export interface LoadPlan {
  mode: LoadMode;
  /** Point count read from the file header — the source the plan started from. */
  sourceCount: number;
  /** Decode every `stride`-th record. Always 1 unless `mode === 'stride'`. */
  stride: number;
  /** Expected on-screen point count once the plan has run. */
  targetCount: number;
  /** Effective budget after the mobile and memory-guard adjustments. */
  budget: number;
  /** Conservative peak-memory estimate, in bytes. */
  memoryEstimateBytes: number;
  /** True when the memory guard downgraded the plan. */
  memoryGuardTriggered: boolean;
  /** Human-readable lines for the preload UI. */
  preloadSummary: string[];
}

/** A point count plus the attributes and file context the estimate needs. */
export interface MemoryEstimateInput {
  pointCount: number;
  attributes: PointAttributes;
  fileBytes: number;
  format: SourceFormat;
}

// --- tuning constants ------------------------------------------------------

/**
 * Desktop: a cloud up to 3x the budget is decoded in full and then
 * voxel-reduced; beyond that it is stride-decoded. These multipliers are first
 * estimates — see the v0.2.7 design doc, §9 — and are expected to be tuned
 * from real telemetry.
 */
export const DESKTOP_MEDIUM_MULTIPLIER = 3;
/** Mobile: a tighter band, so phones reach stride decode sooner. */
export const MOBILE_MEDIUM_MULTIPLIER = 1.5;

/** Fraction of reported device memory a single load may plan to occupy. */
const DESKTOP_MEMORY_FRACTION = 0.6;
const MOBILE_MEMORY_FRACTION = 0.4;

/** Memory ceiling used when the browser does not report `deviceMemory`. */
const DESKTOP_FALLBACK_CEILING = 1_500_000_000;
const MOBILE_FALLBACK_CEILING = 600_000_000;

/** A load is never planned below this many points, even under the guard. */
const MIN_BUDGET_FLOOR = 250_000;

/** Per-point byte costs of each typed array the renderer holds. */
const BYTES_POSITION = 12; // Float32 x3
const BYTES_COLOR = 3; // Uint8 x3
const BYTES_INTENSITY = 2; // Uint16
const BYTES_CLASS = 1; // Uint8
const BYTES_NORMAL = 12; // Float32 x3

/** Fixed laz-perf WASM scratch allowance, on top of the heap's file copy. */
const LAZ_SCRATCH_BYTES = 16_000_000;

// --- mode selection --------------------------------------------------------

/**
 * Choose a decode mode from the source point count.
 *
 * `all` when the cloud is within budget; `voxel` when it is over budget but
 * within `budget * mediumMultiplier` (decode fully, then voxel-downsample);
 * `stride` beyond that (decode only every Nth record, never materialising the
 * whole cloud).
 */
export function chooseLoadMode(
  sourceCount: number,
  budget: number,
  mediumMultiplier: number,
): LoadMode {
  if (sourceCount <= budget) return 'all';
  if (sourceCount <= budget * mediumMultiplier) return 'voxel';
  return 'stride';
}

/**
 * Stride for a stride-decode: keep roughly `budget` points out of
 * `sourceCount`. Always >= 1, so the decode can never loop forever; a
 * non-positive budget degrades safely to a stride of 1.
 */
export function strideFor(sourceCount: number, budget: number): number {
  if (!(budget > 0)) return 1;
  return Math.max(1, Math.ceil(sourceCount / budget));
}

// --- memory estimation -----------------------------------------------------

/** Bytes one decoded point occupies, given which attributes it carries. */
function perPointBytes(a: PointAttributes): number {
  return (
    BYTES_POSITION +
    (a.hasColor ? BYTES_COLOR : 0) +
    (a.hasIntensity ? BYTES_INTENSITY : 0) +
    (a.hasClassification ? BYTES_CLASS : 0) +
    (a.hasNormals ? BYTES_NORMAL : 0)
  );
}

/**
 * Conservative peak-memory estimate for a load, in bytes: the decoded typed
 * arrays plus the source file buffer (held throughout decoding). A `.laz` load
 * also holds the compressed file a second time inside the laz-perf WASM heap,
 * plus a fixed scratch allowance.
 *
 * This is deliberately an over-estimate — the memory guard errs toward a
 * smaller, safer load rather than risking an out-of-memory crash.
 */
export function estimateMemoryBytes(input: MemoryEstimateInput): number {
  const points = Math.max(0, input.pointCount) * perPointBytes(input.attributes);
  const fileBytes = Math.max(0, input.fileBytes);
  let total = points + fileBytes;
  if (input.format === 'laz') total += fileBytes + LAZ_SCRATCH_BYTES;
  return total;
}

/** Memory ceiling a single load may plan to occupy, in bytes. */
function memoryCeilingBytes(deviceMemoryGB: number | undefined, isMobile: boolean): number {
  if (deviceMemoryGB !== undefined && deviceMemoryGB > 0) {
    const fraction = isMobile ? MOBILE_MEMORY_FRACTION : DESKTOP_MEMORY_FRACTION;
    return deviceMemoryGB * 1_000_000_000 * fraction;
  }
  return isMobile ? MOBILE_FALLBACK_CEILING : DESKTOP_FALLBACK_CEILING;
}

/**
 * Point count the decoder produces before any voxel pass. `all` and `voxel`
 * decode every record; `stride` decodes one record per bucket.
 */
function decodedCount(mode: LoadMode, sourceCount: number, stride: number): number {
  if (mode === 'stride') return Math.ceil(sourceCount / Math.max(1, stride));
  return sourceCount;
}

/**
 * Peak concurrent point count for a mode — the memory-estimate input. `all`
 * holds only the decoded cloud; `voxel` and `stride` also hold the voxel
 * output briefly alongside the cloud being reduced.
 */
function peakPointCount(mode: LoadMode, decoded: number, budget: number): number {
  return mode === 'all' ? decoded : decoded + budget;
}

/** Expected on-screen point count once a mode has fully run. */
function finalCount(mode: LoadMode, sourceCount: number, budget: number): number {
  // 'all' shows every decoded point; 'voxel' and 'stride' both end at the
  // voxel budget.
  return mode === 'all' ? sourceCount : Math.min(sourceCount, budget);
}

// --- human-readable formatting ---------------------------------------------

/** One decimal place, with a trailing `.0` dropped. */
function trimDecimal(v: number): string {
  const s = v.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/**
 * Format a point count for the preload UI: `18_200_000` -> `"18.2M"`,
 * `4_000_000` -> `"4M"`, `950_000` -> `"950K"`, small values verbatim.
 */
export function formatPointCount(n: number): string {
  const v = Math.max(0, n);
  if (v >= 1_000_000) return `${trimDecimal(v / 1_000_000)}M`;
  if (v >= 1_000) return `${trimDecimal(v / 1_000)}K`;
  return String(Math.round(v));
}

/** The preload-UI lines for a finished plan. */
function buildPreloadSummary(
  format: SourceFormat,
  sourceCount: number,
  mode: LoadMode,
  budget: number,
  memoryGuardTriggered: boolean,
): string[] {
  const lines: string[] = [
    `${format.toUpperCase()} file detected`,
    `${formatPointCount(sourceCount)} source points`,
  ];
  if (mode === 'all') {
    lines.push('Loading at full resolution');
  } else if (mode === 'voxel') {
    lines.push('Optimizing to the render budget');
    lines.push(`Target render budget: ${formatPointCount(budget)} points`);
  } else {
    lines.push('Fast load mode enabled');
    lines.push(`Target render budget: ${formatPointCount(budget)} points`);
  }
  if (memoryGuardTriggered) {
    lines.push('Large file — loading at reduced density to fit available memory');
  }
  return lines;
}

// --- the plan --------------------------------------------------------------

/**
 * Build a complete `LoadPlan` from a file's header facts.
 *
 * `all` decodes every point; `voxel` decodes the whole cloud and voxel-reduces
 * it to the budget; `stride` stratified-samples a far-over-budget cloud down to
 * a memory-safe intermediate (~budget x the medium multiplier) and then
 * voxel-reduces *that* to the budget. Every over-budget path ends in the same
 * voxel pass, so a fast-loaded cloud has uniform density — no scan-line
 * aliasing and no flight-strip density blocks.
 *
 * The plan is built once at the requested budget, then a memory guard checks
 * the estimated peak: if it exceeds what the device can safely give, the plan
 * is forced to `stride` (which caps the decoded set) and its budget shrunk
 * until the estimate fits — never below `MIN_BUDGET_FLOOR`. A guard adjustment
 * is always surfaced through `preloadSummary`, never applied silently.
 */
export function planLoad(input: LoadPlanInput): LoadPlan {
  const sourceCount = Math.max(0, Math.floor(input.sourceCount));
  const fileBytes = Math.max(0, input.fileBytes);
  const { isMobile, attributes, format } = input;
  const mediumMultiplier = isMobile ? MOBILE_MEDIUM_MULTIPLIER : DESKTOP_MEDIUM_MULTIPLIER;
  const ceiling = memoryCeilingBytes(input.deviceMemoryGB, isMobile);

  /**
   * Resolve the mode, stride, target, and memory estimate for a budget.
   * `stride` mode samples down to `budget x mediumMultiplier` — the same band
   * `voxel` mode tops out at — so a huge cloud is never fully materialised.
   */
  const build = (
    budget: number,
    forceMode?: LoadMode,
  ): { mode: LoadMode; stride: number; targetCount: number; estimate: number } => {
    const mode = forceMode ?? chooseLoadMode(sourceCount, budget, mediumMultiplier);
    const stride =
      mode === 'stride' ? strideFor(sourceCount, Math.floor(budget * mediumMultiplier)) : 1;
    const decoded = decodedCount(mode, sourceCount, stride);
    const estimate = estimateMemoryBytes({
      pointCount: peakPointCount(mode, decoded, budget),
      attributes,
      fileBytes,
      format,
    });
    return { mode, stride, targetCount: finalCount(mode, sourceCount, budget), estimate };
  };

  let budget = Math.max(MIN_BUDGET_FLOOR, Math.floor(input.budget));
  let plan = build(budget);

  // Memory guard — if the estimate exceeds the ceiling, force `stride` (which
  // caps the decoded set) and shrink the budget until it fits. The stride peak
  // is budget x (mediumMultiplier + 1) x perPoint plus the fixed file/scratch
  // terms; invert that for a budget that fits the remaining room.
  let memoryGuardTriggered = false;
  if (plan.estimate > ceiling) {
    memoryGuardTriggered = true;
    const perPoint = perPointBytes(attributes);
    const fixed = fileBytes + (format === 'laz' ? fileBytes + LAZ_SCRATCH_BYTES : 0);
    const room = ceiling - fixed;
    const denom = (mediumMultiplier + 1) * perPoint;
    const fittingBudget = room > 0 ? Math.floor(room / denom) : MIN_BUDGET_FLOOR;
    budget = Math.max(MIN_BUDGET_FLOOR, Math.min(budget, fittingBudget));
    plan = build(budget, 'stride');
  }

  return {
    mode: plan.mode,
    sourceCount,
    stride: plan.stride,
    targetCount: plan.targetCount,
    budget,
    memoryEstimateBytes: plan.estimate,
    memoryGuardTriggered,
    preloadSummary: buildPreloadSummary(format, sourceCount, plan.mode, budget, memoryGuardTriggered),
  };
}
