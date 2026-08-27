/**
 * storagePreflight.ts — will the index this file needs actually fit on disk?
 *
 * Out-of-core indexing turns a scan the browser cannot hold into a tile store
 * the browser writes to the Origin Private File System and streams back. That
 * store is not small: it is a fixed-length record per point plus one file per
 * octree node, and nothing about the compressed input bounds it. A 5 GB LAZ can
 * carry four hundred million points, and four hundred million points at the
 * record layout in `tileRecord.ts` is over 11 GB of cache. Routing that file to
 * the indexer without asking first is how a viewer fills a user's disk and then
 * fails at ninety-two percent, leaving the bytes it already wrote behind with no
 * store to show for them.
 *
 * So the demand is computed from the POINT COUNT AND THE SCHEMA, which the LAS
 * public header states before a record is read, never from the file size. The
 * per-point figure comes from {@link tileRecordBytes}, so this module cannot
 * drift from the layout it is predicting, and the node count comes from
 * {@link depthForRatio} and {@link DEFAULT_POINTS_PER_LEAF} for the same reason.
 *
 * TWO HALVES, DELIBERATELY APART. {@link estimateIndexDiskDemand} and
 * {@link decideStoragePreflight} are pure: same input, same answer, no browser.
 * {@link readStorageEstimate} is the one impure seam, and it takes the navigator
 * as an argument so the policy is testable in Node — the same split
 * `io/workerPool/decodePoolSize.ts` uses for `navigator.hardwareConcurrency`.
 *
 * FAIL CLOSED. `navigator.storage.estimate()` is optional, approximate, and
 * absent or throwing in exactly the contexts where a large write is most likely
 * to be discarded. A missing estimate therefore REFUSES rather than proceeding:
 * a guard that reads "could not check" as "checked and fine" is the fail-open
 * null guard this repository already treats as a defect (compare `e57Refusal`,
 * which refuses an E57 whose declaration will not parse rather than reading it
 * unguarded). Refusing costs the user the out-of-core path, which is recoverable
 * — the file still opens by the existing whole-file route, and COPC or EPT
 * streams it without a cache at all. Proceeding wrongly costs them their disk.
 *
 * STILL RIGHT AFTER THE PARTIAL-STORE CHANGE. `opfsSpillStore.ts` builds into
 * `<name>.partial` and promotes that directory to `<name>` once the manifest is
 * written. The figures below do not move: the same tiles, hierarchy and
 * manifest are written once each, and promotion RENAMES files where the engine
 * offers `FileSystemFileHandle.move`. Where it does not, promotion copies one
 * file at a time and deletes each source immediately, so the transient excess
 * is the largest tile rather than a second store, which the reserve below
 * already covers many times over.
 *
 * Nothing in the application calls this yet. It is the check that has to exist
 * before any file is routed to local indexing, not the routing itself.
 */

import { formatByteSize } from '../formatByteSize';
import { LoadError } from '../loadErrors';
import { DEFAULT_POINTS_PER_LEAF } from './oocIndexer';
import { DEFAULT_MAX_DEPTH, depthForRatio } from './octreeGrid';
import { tileRecordBytes, type TileSchema } from './tileRecord';

// ── the margin ──────────────────────────────────────────────────────────────
//
// The guard requires the demand to fit inside the free space MINUS a reserve,
// never the free space itself. Three reasons the last byte is not usable:
//
//  1. `estimate()` is documented as an approximation, and browsers deliberately
//     blur it — Chromium pads reported usage to blunt storage-based
//     fingerprinting — so the number is a neighbourhood, not a measurement.
//  2. A quota is not a reservation. It moves with free disk on the host, and a
//     browser under storage pressure evicts a whole origin rather than failing
//     one write, so an index that lands with nothing to spare can take the rest
//     of the origin's data down with it later.
//  3. The demand is itself an estimate. The tile payload is exact given the
//     header, but the node count is bounded rather than known, and a build that
//     lands within a percent of its prediction has no room for the gap.
//
// A fraction alone leaves too little on a small quota; a flat floor alone
// scales badly on a large one. So the reserve is the LARGER of the two.
/** Share of the reported free space held back from any index. */
export const STORAGE_HEADROOM_FRACTION = 0.2;
/**
 * Smallest reserve, whatever the fraction works out to. Below roughly a quarter
 * of a gigabyte of slack an origin is inside the band where browsers evict, so
 * a build that would land there is not a build worth starting.
 */
export const STORAGE_HEADROOM_FLOOR_BYTES = 256 * 1024 * 1024;

// ── per-node costs ──────────────────────────────────────────────────────────

/**
 * Bytes charged for each tile file beyond its records. A tile is one OPFS file
 * backed by one host file, and a filesystem hands out whole blocks: a tile
 * holding a single record still occupies one. 4 KiB is the common block size on
 * the filesystems this runs over (APFS, ext4, NTFS).
 */
export const TILE_FILE_OVERHEAD_BYTES = 4096;

/**
 * Bytes charged per hierarchy line. `tileStore.ts` writes one `key count` line
 * per node: the key is at most `depth` octant digits, then a space, a decimal
 * count and a newline. Twenty digits covers any count a `Number` can state.
 */
const HIERARCHY_LINE_OVERHEAD_BYTES = 22;

/**
 * Bytes charged for `manifest.json`. It is a fixed set of fields — bounds, root
 * cube, schema, counts — pretty-printed at two-space indent, so its size does
 * not grow with the scan. 2 KiB is comfortably above what it prints.
 */
const MANIFEST_BYTES = 2048;

/** Every cell at every level of an octree `depth` deep: `(8 ** (depth + 1) - 1) / 7`. */
function cellsThroughDepth(depth: number): number {
  return (8 ** (depth + 1) - 1) / 7;
}

/**
 * How much a node is assumed to be under-filled. Pyramid placement settles each
 * point at the coarsest cell with room, so a perfectly packed build occupies
 * `pointCount / pointsPerLeaf` nodes; a spatially sparse one occupies more,
 * because a cell holding six points still costs a file. Two is the allowance,
 * and it is capped by {@link cellsThroughDepth}, which is the real ceiling.
 */
const NODE_FILL_ALLOWANCE = 2;

// ── the demand ──────────────────────────────────────────────────────────────

export interface IndexDiskDemandInput {
  /** Points the source declares. From the LAS public header, not from a decode. */
  readonly pointCount: number;
  /** Which optional fields the records carry; fixes the per-point record size. */
  readonly schema: TileSchema;
  /** Target points per leaf the build will use. Defaults to the indexer's own. */
  readonly pointsPerLeaf?: number;
}

/** What indexing a source would write, and how that figure was reached. */
export interface IndexDiskDemand {
  /** False when the input does not describe a countable index; then `bytes` means nothing. */
  readonly known: boolean;
  /** Why it is not known, when it is not. */
  readonly reason?: string;
  /**
   * False once `bytes` leaves exact-integer range. The figure is still the right
   * magnitude and still orders correctly, but it no longer counts bytes, so a
   * caller must not treat a near-miss comparison as meaningful.
   */
  readonly exact: boolean;
  readonly pointCount: number;
  /** Straight from {@link tileRecordBytes}: 19 bare, 30 with GPS time and RGB. */
  readonly recordBytes: number;
  /** `pointCount * recordBytes`. Every point is written to exactly one node. */
  readonly tileBytes: number;
  readonly depth: number;
  readonly nodeCount: number;
  readonly nodeOverheadBytes: number;
  readonly hierarchyBytes: number;
  readonly manifestBytes: number;
  /** The total the preflight compares against available storage. */
  readonly bytes: number;
}

function unknownDemand(pointCount: number, recordBytes: number, reason: string): IndexDiskDemand {
  return {
    known: false,
    reason,
    exact: false,
    pointCount,
    recordBytes,
    tileBytes: 0,
    depth: 0,
    nodeCount: 0,
    nodeOverheadBytes: 0,
    hierarchyBytes: 0,
    manifestBytes: 0,
    bytes: 0,
  };
}

/**
 * The disk an out-of-core index of this source would occupy.
 *
 * Sized from the declared point count and the record schema, never from the
 * input's byte size: a compressed file says nothing about how much uncompressed,
 * fixed-length cache it becomes, and the whole reason the guard exists is that
 * the cache is routinely several times the file.
 *
 * Fails closed on an input it cannot count. A point count that is negative,
 * fractional, infinite or NaN yields `known: false` rather than a number, so a
 * malformed header cannot produce a small demand that sails past the check.
 */
export function estimateIndexDiskDemand(input: IndexDiskDemandInput): IndexDiskDemand {
  const recordBytes = tileRecordBytes(input.schema);
  const pointCount = input.pointCount;
  if (typeof pointCount !== 'number' || !Number.isFinite(pointCount)) {
    return unknownDemand(pointCount, recordBytes, 'the source declares no finite point count');
  }
  if (pointCount < 0 || !Number.isInteger(pointCount)) {
    return unknownDemand(
      pointCount,
      recordBytes,
      `the declared point count ${pointCount} is not a whole number of points`,
    );
  }

  const pointsPerLeaf = Math.max(1, Math.floor(input.pointsPerLeaf ?? DEFAULT_POINTS_PER_LEAF));
  const depth = Math.max(0, Math.min(DEFAULT_MAX_DEPTH, depthForRatio(pointCount / pointsPerLeaf)));
  const nodeCount = Math.min(
    pointCount,
    cellsThroughDepth(depth),
    Math.ceil(pointCount / pointsPerLeaf) * NODE_FILL_ALLOWANCE,
  );

  const tileBytes = pointCount * recordBytes;
  const nodeOverheadBytes = nodeCount * TILE_FILE_OVERHEAD_BYTES;
  const hierarchyBytes = nodeCount * (depth + HIERARCHY_LINE_OVERHEAD_BYTES);
  const manifestBytes = MANIFEST_BYTES;
  const bytes = tileBytes + nodeOverheadBytes + hierarchyBytes + manifestBytes;

  return {
    known: true,
    exact: Number.isSafeInteger(bytes),
    pointCount,
    recordBytes,
    tileBytes,
    depth,
    nodeCount,
    nodeOverheadBytes,
    hierarchyBytes,
    manifestBytes,
    bytes,
  };
}

// ── the browser's side, as data ──────────────────────────────────────────────

/**
 * What the browser said about storage, or that it said nothing. Deliberately a
 * plain record rather than a `StorageEstimate`: the decision is given this, so
 * every branch — including the absent one — is reachable from a Node test.
 */
export interface StorageEstimateReading {
  readonly available: boolean;
  readonly quotaBytes?: number;
  readonly usageBytes?: number;
  /** Why nothing was read, when `available` is false. Quoted in the refusal. */
  readonly reason?: string;
}

/** The injected seam: anything that can answer "how much storage is there?". */
export type StorageEstimateReader = () => Promise<StorageEstimateReading>;

/** The slice of `StorageManager` this module calls. */
export interface StorageManagerLike {
  estimate(): Promise<{ quota?: number; usage?: number }>;
}
/** The slice of `Navigator` this module reads. */
export interface NavigatorLike {
  readonly storage?: StorageManagerLike;
}

/**
 * Read `navigator.storage.estimate()`. The only impure function here.
 *
 * Never throws and never guesses. `navigator.storage` is absent outside a secure
 * context and in some privacy modes, and `estimate()` itself rejects where
 * storage is blocked; both come back as `available: false` with the reason
 * attached, which {@link decideStoragePreflight} turns into a refusal.
 */
export async function readStorageEstimate(navigatorLike?: NavigatorLike): Promise<StorageEstimateReading> {
  const nav = navigatorLike ?? (globalThis as { navigator?: NavigatorLike }).navigator;
  const storage = nav?.storage;
  if (!storage || typeof storage.estimate !== 'function') {
    return { available: false, reason: 'this browser exposes no navigator.storage.estimate()' };
  }
  try {
    const estimate = await storage.estimate();
    return { available: true, quotaBytes: estimate.quota, usageBytes: estimate.usage };
  } catch (err) {
    return {
      available: false,
      reason: `navigator.storage.estimate() failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── the decision ────────────────────────────────────────────────────────────

export type StoragePreflightOutcome =
  | 'proceed'
  /** The demand is larger than what is available after the reserve. */
  | 'insufficient-storage'
  /** No estimate was readable at all. Refuses: unknown is not permission. */
  | 'estimate-unavailable'
  /** An estimate came back that does not describe a usable quota. */
  | 'quota-unknown'
  /** The estimate is readable and the origin is granted nothing. */
  | 'no-quota'
  /** The source does not state a countable point count. */
  | 'demand-unknown';

export interface StoragePreflightVerdict {
  readonly outcome: StoragePreflightOutcome;
  readonly proceed: boolean;
  /** What the index would need. Always stated, whatever the outcome. */
  readonly requiredBytes: number;
  /** What it may use: free space less the reserve. Zero when nothing is known. */
  readonly availableBytes: number;
  /** What the reserve held back. Zero when there was no figure to reserve from. */
  readonly reservedBytes: number;
  /** `quota - usage` as reported, before the reserve. Null when unknown. */
  readonly freeBytes: number | null;
  readonly quotaBytes: number | null;
  readonly usageBytes: number | null;
  /** The user-facing sentence. Names the required and available figures. */
  readonly message: string;
}

export interface StoragePreflightOptions {
  readonly headroomFraction?: number;
  readonly headroomFloorBytes?: number;
}

/** `1234567` becomes `1,234,567`, without depending on the host locale. */
function groupDigits(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const [whole, ...rest] = Math.abs(value).toFixed(0).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (value < 0 ? '-' : '') + grouped + (rest.length > 0 ? `.${rest.join('')}` : '');
}

/** The sentence every refusal ends on: the way out that needs no local cache. */
const CONVERT_ADVICE =
  'Convert it to COPC or EPT (PDAL or untwine) and open that instead: those stream from the ' +
  'file and write no local cache.';

/** How the demand figure was reached, so a user can check it against the header. */
function demandProvenance(demand: IndexDiskDemand): string {
  return (
    `The cache is sized by the points, not by the file: ${groupDigits(demand.pointCount)} points at ` +
    `${demand.recordBytes} bytes per point, plus ${groupDigits(demand.nodeCount)} tile files and the ` +
    `hierarchy. A compressed file gives no bound on that, which is why the file's own size is not ` +
    `the check.`
  );
}

function verdict(
  outcome: StoragePreflightOutcome,
  demand: IndexDiskDemand,
  message: string,
  space: {
    availableBytes?: number;
    reservedBytes?: number;
    freeBytes?: number | null;
    quotaBytes?: number | null;
    usageBytes?: number | null;
  } = {},
): StoragePreflightVerdict {
  return {
    outcome,
    proceed: outcome === 'proceed',
    requiredBytes: demand.bytes,
    availableBytes: space.availableBytes ?? 0,
    reservedBytes: space.reservedBytes ?? 0,
    freeBytes: space.freeBytes ?? null,
    quotaBytes: space.quotaBytes ?? null,
    usageBytes: space.usageBytes ?? null,
    message,
  };
}

/**
 * Proceed, or refuse by name.
 *
 * Pure. The browser's answer arrives as {@link StorageEstimateReading} rather
 * than being read here, so the branch that matters most — no estimate at all —
 * is an ordinary test case instead of an environment nobody can reproduce.
 *
 * Every path that is not `proceed` is a refusal, and every refusal states what
 * was needed. The four ways it can refuse are distinct on purpose: "you need
 * more than you have", "I could not ask", "the answer did not parse", and "you
 * were granted nothing" are different problems with different remedies, and
 * collapsing them into one boolean would lose the only thing a user could act on.
 */
export function decideStoragePreflight(
  demand: IndexDiskDemand,
  reading: StorageEstimateReading,
  options: StoragePreflightOptions = {},
): StoragePreflightVerdict {
  if (!demand.known) {
    return verdict(
      'demand-unknown',
      demand,
      `The storage an index would need cannot be established: ${demand.reason ?? 'no reason recorded'}. ` +
        `The file may be malformed or truncated. Indexing is refused rather than started blind. ${CONVERT_ADVICE}`,
    );
  }

  const required = formatByteSize(demand.bytes);

  if (!reading.available) {
    return verdict(
      'estimate-unavailable',
      demand,
      `Indexing this scan would need about ${required} of local cache, and this browser does not ` +
        `report a storage estimate (${reading.reason ?? 'no reason recorded'}), so the space available ` +
        `is unknown. Indexing is refused rather than started: a build that runs out part-way leaves ` +
        `the cache it already wrote behind with no store to show for it, and an unreadable estimate ` +
        `is not permission. ${demandProvenance(demand)} ${CONVERT_ADVICE}`,
    );
  }

  const quota = reading.quotaBytes;
  const usage = reading.usageBytes ?? 0;
  if (typeof quota !== 'number' || !Number.isFinite(quota) || quota < 0
    || typeof usage !== 'number' || !Number.isFinite(usage) || usage < 0) {
    return verdict(
      'quota-unknown',
      demand,
      `Indexing this scan would need about ${required} of local cache, and the storage estimate this ` +
        `browser returned does not describe a usable quota (quota ${String(quota)}, usage ` +
        `${String(reading.usageBytes)}), so the space available is unknown. Indexing is refused ` +
        `rather than started blind. ${CONVERT_ADVICE}`,
    );
  }

  if (quota === 0) {
    return verdict(
      'no-quota',
      demand,
      `Indexing this scan would need about ${required} of local cache and this browser grants this ` +
        `page no storage at all (a quota of ${formatByteSize(0)}), so there is nowhere to write it. ` +
        `Private browsing and blocked site data both do this. ${CONVERT_ADVICE}`,
      { freeBytes: 0, quotaBytes: 0, usageBytes: usage, availableBytes: 0 },
    );
  }

  const free = Math.max(0, quota - usage);
  const reserved = Math.max(
    free * (options.headroomFraction ?? STORAGE_HEADROOM_FRACTION),
    options.headroomFloorBytes ?? STORAGE_HEADROOM_FLOOR_BYTES,
  );
  const available = Math.max(0, free - reserved);
  const space = {
    availableBytes: available,
    reservedBytes: reserved,
    freeBytes: free,
    quotaBytes: quota,
    usageBytes: usage,
  };

  if (demand.bytes <= available) {
    return verdict(
      'proceed',
      demand,
      `Indexing this scan needs about ${required} of local cache and this browser has about ` +
        `${formatByteSize(available)} usable, after holding ${formatByteSize(reserved)} of the ` +
        `${formatByteSize(free)} it reports free in reserve.`,
      space,
    );
  }

  return verdict(
    'insufficient-storage',
    demand,
    `Indexing this scan needs about ${required} of local cache and only about ` +
      `${formatByteSize(available)} is usable, so it is refused before anything is written. ` +
      `${demandProvenance(demand)} This browser reports ${formatByteSize(free)} free of a ` +
      `${formatByteSize(quota)} quota, of which ${formatByteSize(reserved)} is held back so an index ` +
      `cannot consume the last of it. ${CONVERT_ADVICE}`,
    space,
  );
}

/**
 * The refusal a finished verdict already justifies, or `undefined` when the
 * index may be built. Shaped after `e57Refusal` in `io/loadFile.ts` so the two
 * pre-read guards hand the same kind of object to the same describing path.
 *
 * The category is `memory-constraint`, the nearest of the six
 * {@link LoadErrorCategory} values: this is a storage ceiling rather than a RAM
 * one, but both are "this device cannot hold what this file needs", and the
 * message carries the specifics the category cannot.
 */
export function storagePreflightRefusal(
  result: StoragePreflightVerdict,
  name: string,
): LoadError | undefined {
  if (result.proceed) return undefined;
  return new LoadError('memory-constraint', `${name}: ${result.message}`);
}

/**
 * Size the index, ask for the estimate, decide. The reader is a parameter with
 * the live one as its default, so production gets the browser and a test gets
 * whatever it wants without touching a global.
 *
 * A reader that throws is treated exactly as a reader that reports nothing:
 * refused, with what it threw quoted. Nothing about a thrown estimate makes the
 * disk more likely to be there.
 */
export async function storagePreflight(
  input: IndexDiskDemandInput,
  read: StorageEstimateReader = readStorageEstimate,
  options: StoragePreflightOptions = {},
): Promise<StoragePreflightVerdict> {
  let reading: StorageEstimateReading;
  try {
    reading = await read();
  } catch (err) {
    reading = {
      available: false,
      reason: `the storage estimate threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return decideStoragePreflight(estimateIndexDiskDemand(input), reading, options);
}
