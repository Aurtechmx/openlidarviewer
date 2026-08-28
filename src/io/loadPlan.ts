/**
 * loadPlan.ts
 *
 * The pure decision logic behind budget-aware fast loading: given what
 * a file header reveals — its point count, its byte size, the attributes it
 * carries — decide *how* to load it before a single point is decoded.
 *
 * This module has NO three.js, DOM, or I/O dependency, so it is unit-tested in
 * Node and runs identically on the main thread (driving the preflight UI) and
 * inside the parse worker (driving the decode).
 */

import { clamp } from '../numeric';
import { formatByteSize } from './formatByteSize';
import type { SourceFormat } from './sniffFormat';

/** How a cloud is turned into the on-screen point set. */
export type LoadMode = 'all' | 'voxel' | 'stride';

/** Which per-point attributes a cloud carries — drives the memory estimate. */
export interface PointAttributes {
  hasColor: boolean;
  hasIntensity: boolean;
  hasClassification: boolean;
  hasNormals: boolean;
  /**
   * The LAS-specific inspection attributes — return number/count, point
   * source ID and GPS time. Optional because only LAS/LAZ clouds carry them.
   */
  hasLasExtras?: boolean;
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
  /**
   * True when the post-shrink estimate is STILL above the memory
   * ceiling. The guard shrinks the budget toward `MIN_BUDGET_FLOOR`,
   * but when the FIXED cost (file bytes + LAZ scratch + WASM heap)
   * alone exceeds the ceiling, no point budget reshape can bring
   * the estimate down. The loader warns rather than implying the
   * file fits: `buildSourceMetadata` in `src/io/loadFile.ts` reads
   * this first and, when set, replaces the ordinary "large file"
   * size note with a stronger "the open may fail" caution.
   *
   * Optional for backward-compat with sites that synthesise a
   * `LoadPlan` in tests; `planLoad` always populates it. Read sites
   * should treat `undefined` as `false`.
   */
  mayExceedCeiling?: boolean;
  /**
   * True when the file is a large non-LAS/LAZ format (E57, PCD, PTS,
   * PTX, PLY, OBJ, GLB, XYZ, CSV) that will be decoded fully in
   * memory before the downsample step. LAS/LAZ has streaming-friendly
   * record decode + WASM-managed scratch, but other format loaders
   * currently allocate the full point set at parse time, so a 4 GB
   * E57 can spike RAM dramatically before the budget guard runs.
   *
   * The UI surfaces this as a pre-decode warning ("this is a large
   * non-LAS file — decode will spike memory") so the user knows
   * what to expect rather than facing a silent OOM.
   *
   * Optional for backward-compat — treat `undefined` as `false`.
   */
  largeNonLasFormat?: boolean;
  /**
   * True when the file is a large uncompressed LAS or chunked LAZ whose whole-file load would
   * exceed the memory ceiling, so it should be built into an out-of-core tile
   * store and streamed rather than materialised (see `src/io/heavy/`). The
   * sliced reader never holds the whole file, so the out-of-core path removes
   * exactly the fixed whole-file cost that trips the ceiling here.
   *
   * Uncompressed LAS and chunked LAZ both route here: the tile builder reads
   * sliced LAS (`openSlicedLasSource`) or decodes the LAZ chunk table one bounded
   * window at a time. A heavy LAZ without a usable chunk table is refused rather
   * than read whole. Optional for backward-compat, treat `undefined` as `false`.
   */
  buildThenStream?: boolean;
  /**
   * True when the file is an over-ceiling non-streaming format with NO bounded
   * decode (PLY, PCD, PTX, PTS, XYZ, OBJ, GLB/GLTF, PNTS). Unlike LAS/LAZ
   * (`buildThenStream`) and E57 (its own preflight plan), these have no way to
   * decode within the ceiling, so the load must be REFUSED before the whole
   * file is materialised — a warning that still proceeds crashes the tab. The
   * loader turns this into a `memory-constraint` refusal with guidance to
   * stream as COPC/EPT or convert. Optional — treat `undefined` as `false`.
   */
  refuseOverCeiling?: boolean;
}

/**
 * Per-format threshold above which the non-LAS warning fires.
 * 300 MB is the empirical knee where browser decode peaks crosses
 * 1 GB resident — small enough to skip for the common case, large
 * enough to actually mean "this will hurt".
 */
export const LARGE_NON_LAS_THRESHOLD_BYTES = 300 * 1024 * 1024;

/**
 * Threshold above which a NON-COPC static LAS/LAZ triggers a "read fully into
 * memory" caution. LAS/LAZ strides at decode so the DISPLAY stays bounded, but
 * the whole file is still materialised as one ArrayBuffer first — so a multi-GB
 * file is a real RAM risk the user should know about before the read. COPC is
 * routed to the streaming range-reader and never reaches this path. 1 GiB is
 * high enough to skip routine survey tiles, low enough to catch the genuinely
 * huge files that belong in COPC/EPT.
 */
export const LARGE_STATIC_LAS_THRESHOLD_BYTES = 1024 * 1024 * 1024;

/**
 * Formats with a bounded decode for an over-ceiling file: LAS/LAZ route to the
 * out-of-core tile build, and E57 has its own preflight verdict plus stride
 * plan. Any other format materialises the whole point set at parse time, so an
 * over-ceiling estimate for it is a hard refusal (see `refuseOverCeiling`).
 */
export const BOUNDED_DECODE_FORMATS: ReadonlySet<SourceFormat> = new Set<SourceFormat>([
  'las',
  'laz',
  'e57',
]);

/** Non-LAS/LAZ formats that decode the whole point set up front. */
export const NON_STREAMING_FORMATS: ReadonlySet<SourceFormat> = new Set<SourceFormat>([
  'e57',
  'pcd',
  'pts',
  'ptx',
  'ply',
  'obj',
  'glb',
  'gltf',
  'xyz',
  'pnts',
]);

/** A point count plus the attributes and file context the estimate needs. */
export interface MemoryEstimateInput {
  pointCount: number;
  attributes: PointAttributes;
  fileBytes: number;
  format: SourceFormat;
  /**
   * E57 only: BYTES of decode column the parse materialises per record, from
   * the E57 preflight (`summariseE57Scans`). Omitted, the estimate still counts
   * the file copies and the merged arrays but not the columns, which is the
   * largest term — so an E57 estimate without it is a floor, not a peak.
   *
   * Bytes rather than a column count because the columns are no longer one
   * width. A structured scan keeps its `rowIndex` as a `Uint16Array` while its
   * `cartesianX` stays a `Float64Array`, and a scan-count multiplied by a flat
   * eight bytes cannot express that — nor "scan 2 keeps two index columns and
   * scan 5 keeps none", which per-scan eligibility makes an ordinary case.
   */
  decodeBytesPerPoint?: number;
  /**
   * E57 only: bytes the acquisition grids of the structured scans allocate.
   *
   * Its own term because it scales with GRID CELLS, not with records. The flat
   * resident allowance below was fitted to temporaries that scale with neither,
   * so folding a cells-sized array into it would leave the allowance describing
   * something it was never measured against.
   */
  structuredGridBytes?: number;
}

// --- tuning constants ------------------------------------------------------

/**
 * Desktop: a cloud up to 3x the budget is decoded in full and then
 * voxel-reduced; beyond that it is stride-decoded. These multipliers are first
 * estimates — see the design doc, §9 — and are expected to be tuned
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
// LAS inspection extras: return number + count (Uint8 x2), point source ID
// (Uint16) and GPS time (Float64) — 1 + 1 + 2 + 8 bytes per point.
const BYTES_LAS_EXTRAS = 12;

/** Fixed laz-perf WASM scratch allowance, on top of the heap's file copy. */
const LAZ_SCRATCH_BYTES = 16_000_000;

// --- E57 decode cost -------------------------------------------------------
//
// The E57 reader's peak is nothing like the LAS reader's, and the generic
// `pointCount * perPointBytes + fileBytes` model under-reports it by about 3x.
// The constants below were fitted to measured peaks, not assumed; the fit is
// recorded in `tests/loadPlanE57Memory.test.ts`, which re-derives each measured
// figure from the model.
//
// WHAT THE DECODE ACTUALLY HOLDS, CONCURRENTLY:
//
//   1. the source ArrayBuffer, alive for the whole parse;
//   2. the de-paged logical buffer — a second, near-identical copy of the file,
//      because `depage` strips the per-page CRC trailers into a fresh buffer;
//   3. one Float64Array per CONSUMED prototype field per scan, and every scan's
//      columns are alive at once because the parse returns them all before the
//      merge starts. This is the largest term and the one the generic model has
//      no expression for at all;
//   4. the merged Float64 xyz buffer plus the merged attribute arrays;
//   5. the Float32 positions the recentre produces, alive beside (4);
//   6. for a structured scan, the acquisition grid: per-cell state and record
//      arrays plus the copy the identity remap holds beside them. This one
//      scales with grid cells rather than records, so it is a separate term.
//
// Terms 1 and 2 give the two file-byte costs. Terms 3-5 give the per-record
// cost below.

/**
 * Bytes one decoded E57 point-column value occupies (`Float64Array`, one per
 * consumed prototype field). Exported so the preflight, which counts the
 * columns, states their cost in the same number the estimate spends.
 */
export const E57_COLUMN_BYTES = 8;

/** Bytes the merged global-coordinate buffer holds per point (Float64 x3). */
const E57_MERGE_XYZ_BYTES = 24;

/**
 * Copies of the file the E57 decode holds at once: the source ArrayBuffer and
 * the de-paged logical buffer (`pageSize - 4` of every `pageSize` bytes, so
 * within 0.4 % of the source at the 1024-byte page size every E57 in
 * circulation uses).
 */
const E57_FILE_COPIES = 2;

/**
 * Headroom over the itemised array total above.
 *
 * The five terms account for every array the decode KEEPS. What they do not
 * itemise is the per-field bytestream concatenation it allocates and drops one
 * field at a time, bounded by a single scan's widest field (22 MB on the
 * 616 MB, 26.9 M-record file measured), plus allocator slack.
 *
 * Measured peak committed bytes exceeded the itemised total by at most 28 MB
 * across six real files spanning 0.4 MB to 616 MB, and the excess did not track
 * file size. So this is a flat allowance sized well above every observation
 * rather than a fraction that would have to be wrong at one end of the range —
 * and it is deliberately generous, because the failure it guards against is a
 * dead tab, not a slow load.
 */
const E57_RESIDENT_SLACK_BYTES = 200_000_000;

/**
 * Ceiling the E57 whole-file decode may plan to occupy, on top of the shared
 * device-memory ceiling.
 *
 * `memoryCeilingBytes` is a fraction of what the DEVICE reports, and a browser
 * caps `navigator.deviceMemory` at 8, so on any well-provisioned desktop it
 * resolves to 4.8 GB. A tab does not get 4.8 GB: opening a 616 MB, 26.9 M-point
 * E57 committed 3.57 GB of typed arrays and killed the tab outright. LAS/LAZ can
 * answer an over-ceiling estimate by building an out-of-core tile store
 * (`buildThenStream`); a whole-file decode has no such fallback, so it is held
 * to the low end of a tab's practical working set, leaving the render buffers
 * and the application itself their share of the same process.
 */
export const E57_DECODE_CEILING_BYTES = 2_000_000_000;

/**
 * Fewest points a strided E57 decode may leave. Below this a "sample of the
 * scan" stops being one: the same floor `planLoad`'s memory guard refuses to
 * plan under. Checked against the points the chosen stride actually keeps, not
 * against the room the ceiling leaves — a whole-number stride rounded up to fit
 * can keep far fewer points than the room would have held. A file that cannot
 * reach the floor is refused rather than decoded.
 */
const E57_MIN_SAMPLE_POINTS = MIN_BUDGET_FLOOR;

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
    (a.hasNormals ? BYTES_NORMAL : 0) +
    (a.hasLasExtras ? BYTES_LAS_EXTRAS : 0)
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
  const fileBytes = Math.max(0, input.fileBytes);
  const count = Math.max(0, input.pointCount);
  if (input.format === 'e57') {
    return (
      E57_FILE_COPIES * fileBytes +
      E57_RESIDENT_SLACK_BYTES +
      Math.max(0, input.structuredGridBytes ?? 0) +
      count * e57BytesPerRecord(input.decodeBytesPerPoint ?? 0, input.attributes)
    );
  }
  const points = count * perPointBytes(input.attributes);
  let total = points + fileBytes;
  if (input.format === 'laz') total += fileBytes + LAZ_SCRATCH_BYTES;
  return total;
}

/**
 * Bytes one E57 record costs at the decode's peak: its Float64 columns, its
 * slot in the merged Float64 xyz buffer and the merged attribute arrays, and
 * its slot in the Float32 cloud the recentre produces beside them. Every one of
 * those is alive at the same moment (see the E57 decode cost note above).
 */
export function e57BytesPerRecord(
  decodeBytesPerRecord: number,
  attributes: PointAttributes,
): number {
  const attributeBytes = perPointBytes(attributes) - BYTES_POSITION;
  return (
    Math.max(0, decodeBytesPerRecord) +
    E57_MERGE_XYZ_BYTES +
    attributeBytes +
    BYTES_POSITION
  );
}

/**
 * Memory ceiling a single load may plan to occupy, in bytes.
 *
 * Exported so a loader that plans its own decode can name the same number in a
 * refusal message rather than quoting a second, differently-derived figure.
 */
export function memoryCeilingBytes(deviceMemoryGB: number | undefined, isMobile: boolean): number {
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
 * is recorded in `memoryGuardTriggered`, never applied silently.
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
    budget = clamp(budget, MIN_BUDGET_FLOOR, fittingBudget);
    plan = build(budget, 'stride');
  }

  // Honest over-ceiling check — when fixed costs alone exceed the
  // ceiling, even shrinking the point budget to MIN_BUDGET_FLOOR
  // can't pull the estimate below it. The caller surfaces this as a
  // warning rather than implying the file fits.
  const mayExceedCeiling = plan.estimate > ceiling;

  // Pre-decode size warning for non-streaming formats. LAS/LAZ
  // streams record-by-record, so a large file is fine; everything
  // else loads the full point set in memory before downsampling, so
  // a large file means a real RAM spike during decode.
  const largeNonLasFormat =
    NON_STREAMING_FORMATS.has(format) &&
    fileBytes > LARGE_NON_LAS_THRESHOLD_BYTES;

  // Route an over-ceiling LAS or LAZ to the out-of-core build: for LAS the whole-
  // file buffer is the fixed cost that pushed the estimate past the ceiling, and
  // for LAZ the same buffer plus the decode scratch is (see the `fixed` term
  // above). The sliced LAS reader and the chunked-LAZ source that feed the tile
  // builder never hold the whole file. This flag decides HEAVINESS only, from the
  // same ceiling for both formats; whether a LAZ can actually be randomly decoded
  // (a usable chunk table, a supported point format) is a separate check the open
  // path makes before it builds. The strided plan above stays populated as the
  // fallback for a caller that does not act on this flag.
  const buildThenStream = (format === 'las' || format === 'laz') && mayExceedCeiling;

  // Fail closed for a non-streaming format with no bounded decode. LAS/LAZ has
  // the out-of-core build (`buildThenStream`) and E57 has its own preflight
  // verdict and stride plan; both can survive an over-ceiling file. Everything
  // else (PLY, PCD, PTX, PTS, XYZ, OBJ, GLB/GLTF, PNTS) materialises the whole
  // point set at parse time with no bounded fallback, so an over-ceiling
  // estimate means the decode cannot fit and must be refused, not merely warned
  // about — a warning that lets the read proceed still takes the tab with it.
  const refuseOverCeiling =
    mayExceedCeiling && !BOUNDED_DECODE_FORMATS.has(format);

  return {
    mode: plan.mode,
    sourceCount,
    stride: plan.stride,
    targetCount: plan.targetCount,
    budget,
    memoryEstimateBytes: plan.estimate,
    memoryGuardTriggered,
    mayExceedCeiling,
    largeNonLasFormat,
    buildThenStream,
    refuseOverCeiling,
  };
}

// --- the E57 decode plan ---------------------------------------------------

/** What `planE57Decode` needs, all of it from the E57 preflight plus the device. */
export interface E57DecodePlanInput {
  /** Declared record total across the scans that merge, from the E57 preflight. */
  sourceCount: number;
  /** Size of the file, in bytes. */
  fileBytes: number;
  /** Bytes of decode column the parse materialises per record. */
  decodeBytesPerRecord: number;
  /** Bytes the structured scans' acquisition grids allocate, from the preflight. */
  structuredGridBytes?: number;
  /** Attributes the merged cloud will carry. */
  attributes: PointAttributes;
  /** True on phones — tightens the ceiling. */
  isMobile: boolean;
  /** `navigator.deviceMemory` in GB when the browser reports it, else undefined. */
  deviceMemoryGB?: number;
}

/** How an E57 file will be decoded, decided before a point is read. */
export interface E57DecodePlan {
  /** `all` reads every record; `stride` reads one record per bucket. */
  mode: LoadMode;
  /** Read every `stride`-th record. Always 1 unless `mode === 'stride'`. */
  stride: number;
  /** Declared record total the plan started from. */
  sourceCount: number;
  /**
   * Records the decode will read: `ceil(sourceCount / stride)`. The stride is
   * applied per SCAN, so a multi-scan file rounds up once per scan and can read
   * up to `scanCount - 1` records more than this (2 more on the 10-scan,
   * 26.9 M-record file measured). The cloud reports what it actually read.
   */
  decodedCount: number;
  /** Estimated peak for the chosen mode, in bytes. */
  memoryEstimateBytes: number;
  /** Estimated peak for reading every record, in bytes — what a refusal reports. */
  fullDecodeEstimateBytes: number;
  /** The ceiling the estimate was judged against, in bytes. */
  ceilingBytes: number;
  /**
   * False when no stride down to the minimum sample brings the estimate under
   * the ceiling. The loader refuses BEFORE decoding rather than starting a read
   * it has already worked out cannot finish.
   */
  fits: boolean;
}

/**
 * Decide how to read an E57 file from what it declares about itself.
 *
 * Three outcomes, the same three the LAS path has: read every record when the
 * estimate fits; read one record per bucket at the smallest stride that fits;
 * refuse when even the minimum sample does not. The stride is stratified and
 * jittered at decode (see `strideSample.ts`), so the sample carries no
 * scan-line phase.
 *
 * The point budget plays no part here. The E57 decode's peak is reached and
 * released inside the loader, before the budget voxel-reduce runs on the
 * returned cloud, and that later step's peak — the returned cloud plus its
 * reduction — is an order of magnitude below the decode's. So this plan answers
 * one question only: what fits in memory.
 */
export function planE57Decode(input: E57DecodePlanInput): E57DecodePlan {
  const sourceCount = Math.max(0, Math.floor(input.sourceCount));
  const fileBytes = Math.max(0, input.fileBytes);
  const structuredGridBytes = Math.max(0, input.structuredGridBytes ?? 0);
  const perRecord = e57BytesPerRecord(input.decodeBytesPerRecord, input.attributes);
  const ceilingBytes = Math.min(
    memoryCeilingBytes(input.deviceMemoryGB, input.isMobile),
    E57_DECODE_CEILING_BYTES,
  );
  const estimate = (records: number): number =>
    estimateMemoryBytes({
      pointCount: records,
      attributes: input.attributes,
      fileBytes,
      format: 'e57',
      decodeBytesPerPoint: input.decodeBytesPerRecord,
      structuredGridBytes,
    });

  const fullDecodeEstimateBytes = estimate(sourceCount);
  const base = {
    sourceCount,
    fullDecodeEstimateBytes,
    ceilingBytes,
  };
  if (fullDecodeEstimateBytes <= ceilingBytes) {
    return {
      ...base,
      mode: 'all',
      stride: 1,
      decodedCount: sourceCount,
      memoryEstimateBytes: fullDecodeEstimateBytes,
      fits: true,
    };
  }

  // The file copies and the resident allowance are paid whatever the stride, so
  // what is left over is all a strided decode has to spend on records.
  const fixed = E57_FILE_COPIES * fileBytes + E57_RESIDENT_SLACK_BYTES + structuredGridBytes;
  const affordable = perRecord > 0 ? Math.floor((ceilingBytes - fixed) / perRecord) : 0;
  const stride = affordable > 0 ? strideFor(sourceCount, affordable) : 0;
  // Test the SURVIVING sample, not the room. A stride is a whole number, so
  // rounding it up to fit can land well under what the room could have held —
  // 900 k records with room for 260 k needs a stride of 4 and keeps 225 k, not
  // 260 k. Guarding the room instead would let exactly those cases through.
  const decodedCount = stride > 0 ? Math.ceil(sourceCount / stride) : 0;
  if (decodedCount < E57_MIN_SAMPLE_POINTS) {
    return {
      ...base,
      mode: 'all',
      stride: 1,
      decodedCount: sourceCount,
      memoryEstimateBytes: fullDecodeEstimateBytes,
      fits: false,
    };
  }

  return {
    ...base,
    mode: 'stride',
    stride,
    decodedCount,
    memoryEstimateBytes: estimate(decodedCount),
    fits: true,
  };
}

// --- E57 refusal wording ---------------------------------------------------
//
// Two places refuse an E57: `loadFile`, which holds the preflight plan before
// the whole-file read, and `loadE57`, which holds it before the decode. Both
// name the same numbers from the same functions here, so the message a user
// gets does not depend on which guard fired.

/** The refusal for a file no stride brings under the memory ceiling. */
export function e57TooLargeMessage(name: string, plan: E57DecodePlan): string {
  return (
    `${name} is too large for this device's memory. Reading it needs about ` +
    `${formatByteSize(plan.fullDecodeEstimateBytes)} — an E57 decode holds the file, a ` +
    `checksum-stripped copy of it, and one Float64 column per attribute per scan all at ` +
    `once — against a ${formatByteSize(plan.ceilingBytes)} budget for this device. ` +
    `Sampling it down far enough to fit would leave too few points to be worth showing. ` +
    `Convert it to COPC or EPT (PDAL or untwine) and open that instead: those stream ` +
    `rather than decoding the whole file.`
  );
}

/**
 * The refusal for a file identified as E57 whose declaration will not read.
 *
 * A file that reached this point carries the E57 signature, so the memory guard
 * applies to it. Without a plan there is no stride, no estimate and no ceiling
 * check, so the load is refused with the reason attached.
 */
export function e57NoPlanMessage(name: string, reason: string): string {
  return (
    `${name} could not be read: its E57 declaration (the file header and the XML ` +
    `section that states the scan record counts) did not parse, so the memory an open ` +
    `would need cannot be established and the open is refused. The file may be corrupt ` +
    `or truncated. Reported: ${reason}`
  );
}
