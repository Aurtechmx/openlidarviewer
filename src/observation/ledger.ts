/**
 * ledger.ts — voxel evidence ledger storage and traversal (docs/observatory/SPEC.md
 * §5.2, OB-LED-01..05). Phase O4.
 *
 * Implements the 3D DDA traversal (Amanatides & Woo, 1987), the domain/voxel
 * key packing, the declared work-budget checks (OB-LED-03/04) and the
 * chunk-partition/merge contract (OB-LED-05) that accumulate a source's built
 * rays (`rays.ts`, phase O3) into `ObservationLedgerRow` values.
 *
 * Worker count (F9's second axis) is read as IN-PROCESS PARTITION count, per
 * the maintainer's 2026-09-23 decision recorded in
 * `docs/observatory/methods.md`: 1, 2 or 5 partitions of the same
 * deterministic ray-chunk list, merged by {@link mergePartialLedgers}, an
 * order-independent integer merge. No Web Worker and no `WORKER_REGISTRY`
 * entry exist yet; `RayPartitionInput`/`PartialLedger` are shaped so a real
 * worker later wraps {@link traverseRayChunks} in `postMessage`/`onmessage`,
 * not rewrites it (OB-RT-03 gates the worker itself on profiling, at O11).
 *
 * Storage: `ObservationLedgerRow`'s open-addressing table is accumulated here
 * by `LedgerBuilder`, a typed-array-column table in the same style
 * `voxelDownsample.ts`'s `VoxelAccumulator` uses (OB-LED-03's cited
 * precedent) — linear probing over a packed-key hash table handing out slots
 * in first-touched order, with row and per-source counters held in flat
 * `Uint16Array`/`Uint8Array` columns indexed by slot (and, for per-source
 * columns, by `slot*sourceCount + sourceIndex`). Growing the table doubles
 * every column and rehashes the keys into a fresh probe table; a slot's own
 * number never changes once handed out, so `finish()`'s slot-order iteration
 * is deterministic regardless of how many times the table grew during
 * accumulation — the same first-touch order the earlier `Map`-keyed builder
 * produced. `presence` doubles as the per-(slot, sourceIndex) "has an entry"
 * flag: `perSource` is materialized in `finish()` by scanning `0..sourceCount`
 * and keeping only the indices the presence bits mark touched, so no separate
 * touched/tombstone column is needed.
 *
 * `checkVoxelDomainBudget`'s `estimatedBytes` figure is grounded in THIS
 * table's own WORST-CASE cost, not a favourable sample of it. An early
 * version measured `measureLedgerBuilderBytesPerVoxel` (below; exact
 * `byteLength` sums, no `--expose-gc`) only at 1.5 million occupied voxels —
 * a point deep into a doubling cycle, where the probe table and every column
 * are amortized over a near-full capacity. Sweeping occupancy across
 * doubling boundaries instead (`ledgerBuilderWorstCaseBytesPerVoxel`'s own
 * test) shows the true worst case sits right AFTER a capacity doubling, when
 * only `capacity/2 + 1` of the new, twice-as-large `capacity`-sized columns
 * are occupied: every column then costs roughly DOUBLE its amortized rate.
 * `ledgerBuilderWorstCaseBytesPerVoxel(sourceCount)` computes this
 * analytically from the column byte widths and that ~50% just-after-growth
 * load factor, not from a single sample at one lucky occupancy:
 *
 *   worstCase(sourceCount) = 2 x (
 *     17                                  // row: 4x Uint16 (8B) + 1x Uint8 (rowSaturated) + 1x Float64 (keyBySlot, 8B)
 *     + 4 x presenceWords(sourceCount)    // row: Uint32 presence words
 *     + 10 x sourceCount                  // per-source: 4x Uint16 (8B) + 2x Uint8 (srcSaturated, srcNotDecoded)
 *     + 24                                // probe table: (Float64 key 8B + Int32 slotIndex 4B) x 2 (table size = 2x capacity)
 *   )
 *
 * which gives 110 B/voxel at one source per occupied voxel and 170 B/voxel
 * at four — both confirmed against `measureLedgerBuilderBytesPerVoxel` swept
 * across several doubling boundaries and source counts (this module's own
 * bytes/voxel test) — still an order of magnitude below the retired
 * `Map`-keyed builder's measured 650-990 B/voxel, because a flat column has
 * no per-entry object header, no hash-map bucket array and no boxed number.
 * Per-source columns scale linearly with `sourceCount`, so a domain with
 * more participating stations costs proportionally more per voxel; the
 * formula accounts for this directly rather than assuming a fixed multiplier.
 *
 * `checkVoxelDomainBudget` uses this formula with the CALLER's own
 * `sourceCount` (an explicit `bytesPerVoxel` override still wins when given),
 * defaulting to 1 when omitted so the check stays "a pure function of domain
 * and voxelEdge alone" for a caller with no station count to hand (its own
 * doc comment's claim). `SOFT_MAX_BUDGET_BYTES`/`HARD_MAX_BUDGET_BYTES` fix
 * OB-LED-03's real-memory envelope in BYTES (183 MiB soft, ~2.86 GiB hard —
 * the same envelope the original 48-byte-assumed 4,000,000 / 64,000,000 cell
 * pair intended), and the cell ceilings are DERIVED per call from
 * `envelopeBytes / worstCase(sourceCount)` — so the memory ceiling can never
 * be exceeded at any occupancy or source count, rather than holding for one
 * source count a fixed cell number was tuned against. `docs/observatory/
 * methods.md` tabulates the resulting cell ceilings for a few source counts.
 *
 * Pure and DOM-free (OB-INT-01). No traversal step, no packing function and
 * no budget check existed anywhere in the tree before this phase.
 */

import type { AcquisitionStation } from '../model/AcquisitionStations';
import type { ObservationRayChunk, ObservationReturnTable } from './rays';
import { canonicalHash } from '../canonicalHash';
import { COUNTER_SATURATION_MAX, PRESENCE_BITS_PER_WORD, presenceMaskWordCount } from './types';
import type { ObservationCounters, SourceObservationRecord, SourcePresenceMask } from './types';

// ---------------------------------------------------------------------------
// §1 — domain, grid and voxel-key packing (OB-LED-03)
// ---------------------------------------------------------------------------

/**
 * The declared voxelisation domain (SPEC §2.1's "ROI box, or the cloud's data
 * bounds"), in the same Float64 world frame as
 * `AcquisitionStation.pose.worldTranslation` (`docs/coordinate-precision.md`).
 * Tuple-shaped to match `ObservationOrigin.position`'s existing convention
 * (`types.ts`), not `src/geo/CoordinateTypes.ts`'s `Bounds3` — this keeps
 * `src/observation` self-contained rather than depending on a cross-module
 * type this phase has not verified is safe to import from a pure layer.
 */
export interface ObservationDomain {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** `{nx, ny, nz}`, the voxel grid a domain and edge length imply. Fail-closed (F17-style) on a degenerate input. */
export function domainGrid(domain: ObservationDomain, voxelEdge: number): { readonly nx: number; readonly ny: number; readonly nz: number } {
  if (!(voxelEdge > 0) || !Number.isFinite(voxelEdge)) {
    throw new Error(`domainGrid: voxelEdge must be a finite number > 0, got ${voxelEdge}`);
  }
  for (let a = 0; a < 3; a++) {
    const lo = domain.min[a];
    const hi = domain.max[a];
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) {
      throw new Error(`domainGrid: domain.max must exceed domain.min on every finite axis (axis ${a}: min=${lo}, max=${hi})`);
    }
  }
  return {
    nx: Math.ceil((domain.max[0] - domain.min[0]) / voxelEdge),
    ny: Math.ceil((domain.max[1] - domain.min[1]) / voxelEdge),
    nz: Math.ceil((domain.max[2] - domain.min[2]) / voxelEdge),
  };
}

/**
 * Row-major flat index of voxel `(ix, iy, iz)` relative to the domain's own
 * grid, `ix + nx*(iy + ny*iz)`. Safe as a JS number as long as
 * `nx*ny*nz <= Number.MAX_SAFE_INTEGER`, which {@link checkVoxelDomainBudget}
 * keeps far smaller in practice (OB-LED-03: every occupied row is one
 * specific in-domain cell, so the table's row count can never exceed the
 * domain's own total cell count).
 */
export function packVoxelKey(ix: number, iy: number, iz: number, nx: number, ny: number): number {
  return ix + nx * (iy + ny * iz);
}

/**
 * Inverse of {@link packVoxelKey}: recovers `(ix, iy, iz)` from a packed key
 * and the same `nx`/`ny` the key was packed with. Added for O5's frontier
 * adjacency walk (`shadowFrontier.ts`), which needs a frontier voxel's
 * grid coordinates to test its 6 neighbours, not just its packed key.
 */
export function unpackVoxelKey(key: number, nx: number, ny: number): { readonly ix: number; readonly iy: number; readonly iz: number } {
  const ix = key % nx;
  const rest = (key - ix) / nx;
  const iy = rest % ny;
  const iz = (rest - iy) / ny;
  return { ix, iy, iz };
}

// ---------------------------------------------------------------------------
// §2 — the ledger row (OB-LED-03), extending O2's placeholder
// ---------------------------------------------------------------------------

/**
 * One source's contribution to a voxel, in the ledger's own sparse row —
 * narrower than {@link SourceObservationRecord}: it omits `addressed`, which
 * needs a geometric test against a source's fitted angular/range domain
 * (`acquisitionCoverage`), a state-derivation fact O5 computes, not a
 * traversal one. O4 computes `notDecoded` and the four counters only; O5
 * assembles the full `SourceObservationRecord[]` `deriveObservationState`
 * needs by combining this shape with its own addressed-domain test.
 *
 * `types.ts`'s doc comment attributing `addressed` to "O3, the ray builder"
 * is imprecise: O3 (`rays.ts`) produces no per-voxel output at all, only
 * per-ray chunks. This module's reading — O4 computes `notDecoded` and the
 * counters, O5 computes `addressed` — is the corrected one.
 */
export type ObservationLedgerSourceCounters = Pick<
  SourceObservationRecord,
  'sourceIndex' | 'hit' | 'pass' | 'behind' | 'noReturn' | 'saturated' | 'notDecoded'
>;

/**
 * One packed voxel row's counters, sparse-table shape (OB-LED-03): typed-array
 * columns keyed by a packed integer voxel key, an open-addressing table in the
 * style the 0.6.9 voxel accumulator held to byte identity. `key` addresses the
 * row; `counters` is the aggregate across sources, per {@link ObservationCounters}.
 *
 * `presence` and `perSource` are new in O4 (this module's header explains the
 * builder that produces them). `counters` and `key` keep the meaning O2
 * declared them with; a `{key, counters}` object still satisfies this type
 * when the two new fields are also supplied.
 */
export interface ObservationLedgerRow {
  readonly key: number;
  readonly counters: ObservationCounters;
  /** Which sources touched this voxel at all (hit, pass, behind, noReturn or notDecoded), per {@link types.ts}'s Uint32-word packing. */
  readonly presence: SourcePresenceMask;
  /** Sparse: one entry per source that touched this voxel, not padded to the full source count. */
  readonly perSource: readonly ObservationLedgerSourceCounters[];
}

// ---------------------------------------------------------------------------
// §3 — voxel memory budget (OB-LED-03)
// ---------------------------------------------------------------------------

export type VoxelDomainBudgetVerdict = 'ready' | 'coarsen' | 'blocked';

export interface VoxelDomainBudgetResult {
  readonly verdict: VoxelDomainBudgetVerdict;
  /** `nx*ny*nz`: the domain's total cell count, an exact upper bound on the ledger's occupied row count. */
  readonly cellCount: number;
  readonly estimatedBytes: number;
  readonly reason: string;
}

export interface VoxelDomainBudgetOptions {
  /** Upper-bound bytes per OCCUPIED voxel, for the worst case where every domain cell is occupied. Default is {@link ledgerBuilderWorstCaseBytesPerVoxel} at `sourceCount` (this module's header derives the formula); a domain whose occupied voxels average well over `sourceCount` sources needs a caller-supplied value. */
  readonly bytesPerVoxel?: number;
  /** Participating station count, feeding the default `bytesPerVoxel` (ignored when `bytesPerVoxel` is given explicitly). Defaults to 1 so this check stays "a pure function of domain and voxelEdge alone" for a caller with no station count in hand; `runObservationLedger` passes its own `input.stations.length`. */
  readonly sourceCount?: number;
  readonly softMaxCells?: number;
  readonly hardMaxCells?: number;
}

/** Byte widths behind {@link ledgerBuilderWorstCaseBytesPerVoxel}'s formula (this module's header derives it in full) — kept in sync with `LedgerBuilder`'s own column declarations by the bytes/voxel sweep test below, not by any structural link to them. */
const LEDGER_ROW_FIXED_BYTES = 4 * 2 /* hit, pass, behind, noReturn: Uint16 */ + 1 /* rowSaturated: Uint8 */ + 8; /* keyBySlot: Float64 */
const LEDGER_PRESENCE_BYTES_PER_WORD = 4; // presence: Uint32
const LEDGER_SOURCE_BYTES_PER_SOURCE = 4 * 2 /* srcHit, srcPass, srcBehind, srcNoReturn: Uint16 */ + 2; /* srcSaturated, srcNotDecoded: Uint8 */
const LEDGER_PROBE_BYTES_PER_CAPACITY_UNIT = (8 /* keys: Float64 */ + 4) /* slotIndex: Int32 */ * 2; // probe table size is always 2x capacity

/**
 * `LedgerBuilder`'s worst-case bytes per OCCUPIED voxel, analytic from the
 * column byte widths above and the ~50% load factor right after a capacity
 * doubling (this module's header derives the formula in full): that is where
 * every column, sized for the new, twice-as-large capacity, is amortized
 * over only `capacity/2 + 1` occupied slots, roughly double its steady-state
 * rate. Not sampled at one favourable occupancy — a bytes/voxel sweep test,
 * across several doubling boundaries and source counts, confirms the
 * measured cost never exceeds this bound.
 */
export function ledgerBuilderWorstCaseBytesPerVoxel(sourceCount: number): number {
  const presenceWords = presenceMaskWordCount(sourceCount);
  const perSlotBytes =
    LEDGER_ROW_FIXED_BYTES + LEDGER_PRESENCE_BYTES_PER_WORD * presenceWords + LEDGER_SOURCE_BYTES_PER_SOURCE * sourceCount + LEDGER_PROBE_BYTES_PER_CAPACITY_UNIT;
  return 2 * perSlotBytes;
}

/** OB-LED-03's own real-memory soft ceiling, fixed in BYTES: ~183 MiB. The cell ceiling is derived per call from `SOFT_MAX_BUDGET_BYTES / ledgerBuilderWorstCaseBytesPerVoxel(sourceCount)`, so it holds at any source count, not just the one a fixed cell number was tuned against. */
const SOFT_MAX_BUDGET_BYTES = 183 * 1024 * 1024;
/** OB-LED-03's own real-memory hard ceiling, fixed in BYTES: ~2.86 GiB, derived the same way. */
const HARD_MAX_BUDGET_BYTES = Math.round(2.86 * 1024 * 1024 * 1024);

/**
 * OB-LED-03's declared voxel-memory budget, checkable BEFORE any ray is built
 * or traversed: it is a pure function of `domain`, `voxelEdge` and (for an
 * accurate multi-source estimate) `sourceCount`, since the table's
 * occupied-row count can never exceed the domain's own total cell count.
 * Fail-closed on a degenerate domain or edge, mirroring
 * `terrain/quality/gridBudget.ts`'s own `ready | coarsen | blocked` verdict
 * shape as a 3D variant, not a reinvention of it. Production soft/hard
 * ceilings are an O9 panel-declared-budget decision (SPEC calls the budget
 * itself "declared"); the byte envelope here exists for O4's own
 * refusal-path tests, not as a tuned production constant.
 */
export function checkVoxelDomainBudget(
  domain: ObservationDomain,
  voxelEdge: number,
  opts?: VoxelDomainBudgetOptions,
): VoxelDomainBudgetResult {
  const sourceCount = opts?.sourceCount ?? 1;
  const bytesPerVoxel = opts?.bytesPerVoxel ?? ledgerBuilderWorstCaseBytesPerVoxel(sourceCount);
  const softMaxCells = opts?.softMaxCells ?? Math.floor(SOFT_MAX_BUDGET_BYTES / bytesPerVoxel);
  const hardMaxCells = opts?.hardMaxCells ?? Math.floor(HARD_MAX_BUDGET_BYTES / bytesPerVoxel);

  let grid: { readonly nx: number; readonly ny: number; readonly nz: number };
  try {
    grid = domainGrid(domain, voxelEdge);
  } catch (err) {
    return { verdict: 'blocked', cellCount: 0, estimatedBytes: 0, reason: (err as Error).message };
  }

  const cellCount = grid.nx * grid.ny * grid.nz;
  if (!Number.isSafeInteger(cellCount) || cellCount <= 0) {
    return {
      verdict: 'blocked',
      cellCount: Number.isFinite(cellCount) ? cellCount : 0,
      estimatedBytes: 0,
      reason: `Domain ${grid.nx}x${grid.ny}x${grid.nz} at voxel edge ${voxelEdge} is not a safe cell count; refine the domain or coarsen the edge.`,
    };
  }

  const estimatedBytes = cellCount * bytesPerVoxel;

  if (cellCount >= hardMaxCells) {
    return {
      verdict: 'blocked',
      cellCount,
      estimatedBytes,
      reason: `Domain ${grid.nx}x${grid.ny}x${grid.nz} = ${cellCount.toLocaleString()} cells is at or over the hard ceiling of ${hardMaxCells.toLocaleString()}; no reasonable grid is this large.`,
    };
  }

  if (cellCount > softMaxCells) {
    return {
      verdict: 'coarsen',
      cellCount,
      estimatedBytes,
      reason: `Domain ${grid.nx}x${grid.ny}x${grid.nz} = ${cellCount.toLocaleString()} cells (${(estimatedBytes / (1024 * 1024)).toFixed(0)} MiB worst case) is over the working budget; a coarser voxel edge, a smaller ROI or subsampling is recommended.`,
    };
  }

  return {
    verdict: 'ready',
    cellCount,
    estimatedBytes,
    reason: `Domain ${grid.nx}x${grid.ny}x${grid.nz} = ${cellCount.toLocaleString()} cells (${(estimatedBytes / (1024 * 1024)).toFixed(1)} MiB worst case) is within budget.`,
  };
}

// ---------------------------------------------------------------------------
// §4 — work-budget estimate (OB-LED-04), unchanged shape from O2
// ---------------------------------------------------------------------------

/**
 * OB-LED-04's declared work-budget estimate: total traversal steps, before a
 * run, is Σ (clipped ray length) / `voxelEdge`. Named here as a type-level
 * placeholder for the check itself — an estimate over budget requires an
 * explicit user choice before traversal starts, and no run may truncate
 * silently once it has begun. The estimator function is written in O4,
 * alongside the traversal it gates.
 */
export interface TraversalBudgetEstimate {
  readonly estimatedSteps: number;
  readonly voxelEdge: number;
  readonly declaredBudget: number;
  readonly withinBudget: boolean;
}

// ---------------------------------------------------------------------------
// §5 — ray-AABB clip (OB-LED-02) and 3D DDA traversal (OB-LED-01)
// ---------------------------------------------------------------------------

type Vec3 = readonly [number, number, number];

export interface ClippedRayInterval {
  readonly tEntry: number;
  readonly tExit: number;
}

/**
 * OB-LED-02's cheap rejection, step 1: the slab method, the same algorithm
 * `validation/observatory/oracle/ray_aabb_traversal.py` uses. `null` means
 * the ray's `[tMin, tMax]` extent never meets the domain box at all (step 3's
 * empty-clip skip is then trivial: the caller traverses nothing).
 *
 * OB-LED-02's step 2 (skip a station whose range sphere misses the domain
 * entirely, before even clipping its rays) is NOT implemented here: a
 * station whose sphere misses the domain can only ever produce an empty clip
 * for every one of its own rays, which this function's own `null` return
 * already catches at step 3, so step 2 would save clip-computation time
 * only, never change a counter. `docs/observatory/methods.md`'s
 * `olv.observation.ledger` Assumptions paragraph records this in full.
 */
export function clipRayToDomain(origin: Vec3, direction: Vec3, tMin: number, tMax: number, domain: ObservationDomain): ClippedRayInterval | null {
  let entry = tMin;
  let exit = tMax;
  for (let a = 0; a < 3; a++) {
    const o = origin[a];
    const d = direction[a];
    const lo = domain.min[a];
    const hi = domain.max[a];
    if (d === 0) {
      if (o < lo || o > hi) return null;
      continue;
    }
    let t1 = (lo - o) / d;
    let t2 = (hi - o) / d;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    entry = Math.max(entry, t1);
    exit = Math.min(exit, t2);
    if (entry > exit) return null;
  }
  return { tEntry: entry, tExit: exit };
}

/** One voxel of a traversal, with the parametric span `[tEnter, tLeave)` the ray dwells inside it. */
export interface VoxelTraversalStep {
  readonly ix: number;
  readonly iy: number;
  readonly iz: number;
  readonly tEnter: number;
  readonly tLeave: number;
}

/**
 * OB-LED-01: 3D DDA in Float64 (Amanatides & Woo, 1987), over `[tEntry,
 * tExit]` already clipped to the domain (`direction` must be a unit vector,
 * so `t` is a true distance along the ray, matching how a hit-window
 * comparison uses it in {@link accumulateReturnedRay}). Tie rule: a
 * coordinate exactly on a voxel boundary belongs to the voxel on the
 * POSITIVE side of that boundary along that axis alone — voxel `i` owns
 * `[i*h, (i+1)*h)`, matching `validation/observatory/fixtures/f8-dda-cases.json`'s
 * own `tieRule` field verbatim. A ray grazing a shared corner or edge is not
 * a special case: every axis whose distance to its next boundary equals the
 * current step's minimum advances together, in the same step.
 */
export function traverseVoxelSteps(
  origin: Vec3,
  direction: Vec3,
  tEntry: number,
  tExit: number,
  domain: ObservationDomain,
  voxelEdge: number,
): VoxelTraversalStep[] {
  const h = voxelEdge;
  const entryPoint: [number, number, number] = [
    origin[0] + tEntry * direction[0],
    origin[1] + tEntry * direction[1],
    origin[2] + tEntry * direction[2],
  ];
  const voxel: [number, number, number] = [
    Math.floor((entryPoint[0] - domain.min[0]) / h),
    Math.floor((entryPoint[1] - domain.min[1]) / h),
    Math.floor((entryPoint[2] - domain.min[2]) / h),
  ];
  const stepDir: [number, number, number] = [0, 0, 0];
  const tNext: [number, number, number] = [Infinity, Infinity, Infinity];
  const tDelta: [number, number, number] = [Infinity, Infinity, Infinity];
  const active: [boolean, boolean, boolean] = [false, false, false];
  for (let a = 0; a < 3; a++) {
    const d = direction[a];
    if (d === 0) continue;
    active[a] = true;
    stepDir[a] = d > 0 ? 1 : -1;
    const boundaryIndex = d > 0 ? voxel[a] + 1 : voxel[a];
    const boundary = domain.min[a] + boundaryIndex * h;
    tNext[a] = (boundary - origin[a]) / d;
    tDelta[a] = Math.abs(h / d);
  }

  const steps: VoxelTraversalStep[] = [];
  let tCursor = tEntry;
  for (;;) {
    let axisMin = Infinity;
    for (let a = 0; a < 3; a++) {
      if (active[a] && tNext[a] < axisMin) axisMin = tNext[a];
    }
    const isLast = !Number.isFinite(axisMin) || axisMin >= tExit;
    const tLeave = isLast ? tExit : axisMin;
    steps.push({ ix: voxel[0], iy: voxel[1], iz: voxel[2], tEnter: tCursor, tLeave });
    if (isLast) break;
    for (let a = 0; a < 3; a++) {
      if (active[a] && tNext[a] === axisMin) {
        voxel[a] += stepDir[a];
        tNext[a] += tDelta[a];
      }
    }
    tCursor = axisMin;
  }
  return steps;
}

/** One traversed voxel's index, with no parametric span — the shape F8 compares against the oracle. */
export interface VoxelIndex {
  readonly ix: number;
  readonly iy: number;
  readonly iz: number;
}

/** {@link traverseVoxelSteps}, stripped to the voxel index list F8's oracle records. */
export function traverseVoxels(origin: Vec3, direction: Vec3, tEntry: number, tExit: number, domain: ObservationDomain, voxelEdge: number): VoxelIndex[] {
  return traverseVoxelSteps(origin, direction, tEntry, tExit, domain, voxelEdge).map((s) => ({ ix: s.ix, iy: s.iy, iz: s.iz }));
}

// ---------------------------------------------------------------------------
// §6 — hit-window accumulation (SPEC §2.1, OB-RAY-03 continuity)
// ---------------------------------------------------------------------------

type CounterField = 'hit' | 'pass' | 'behind' | 'noReturn';
const COUNTER_FIELDS: readonly CounterField[] = ['hit', 'pass', 'behind', 'noReturn'];

interface MutableCounters {
  hit: number;
  pass: number;
  behind: number;
  noReturn: number;
  saturated: boolean;
}

function freshCounters(): MutableCounters {
  return { hit: 0, pass: 0, behind: 0, noReturn: 0, saturated: false };
}

/** {@link mergePartialLedgers}'s own accumulation shape — unrelated to {@link LedgerBuilder}'s typed-array columns: this merge step runs once per finished-row set, well after any table has already been materialized, so its cost is not part of the per-run memory budget {@link checkVoxelDomainBudget} bounds. */
interface MutableSourceEntry extends MutableCounters {
  sourceIndex: number;
  notDecoded: boolean;
}

interface MutableRow extends MutableCounters {
  key: number;
  presence: SourcePresenceMask;
  perSource: Map<number, MutableSourceEntry>;
}

/**
 * Splits `key` (a non-negative safe integer, possibly over 2^32 for a very
 * large domain) into two 32-bit halves and mixes them — the same Murmur-style
 * finisher `voxelDownsample.ts`'s `hashKey` uses over its own packed key, so
 * the two open-addressing tables this module and that one keep share one
 * proven mixing function rather than two independently-tuned ones.
 */
function hashVoxelKey(key: number): number {
  const lo = key >>> 0;
  const hi = Math.floor(key / 0x100000000) >>> 0;
  let h = Math.imul(lo, 0x9e3779b1) ^ Math.imul(hi, 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  return h ^ (h >>> 13);
}

/**
 * The accumulation table behind one {@link traverseRayChunks} call: an
 * open-addressing table (linear probing, capacity doubling on demand) over
 * the packed voxel `key`, in the style `voxelDownsample.ts`'s
 * `VoxelAccumulator` holds to byte identity (OB-LED-03's cited precedent) —
 * see this module's header for the column layout and the slot-order
 * determinism argument.
 *
 * A slot is handed out, in first-touched order, the first time ANY source
 * touches a voxel; `presence` is the single source of truth for whether a
 * given `(slot, sourceIndex)` pair has a per-source entry at all, so
 * `finish()` needs no separate touched/tombstone column to materialize the
 * sparse `perSource` list.
 */
class LedgerBuilder {
  private readonly sourceCount: number;
  private readonly presenceWords: number;
  private capacity = 0;
  private slotCount = 0;

  // Hash table: `keys`/`slotIndex` are indexed by PROBE POSITION, not slot —
  // `keyBySlot` is the inverse, indexed by slot, for `finish()`'s slot-order walk.
  private keys!: Float64Array;
  private slotIndex!: Int32Array;
  private mask = 0;
  private keyBySlot!: Float64Array;

  // Row-level columns, indexed by slot.
  private hit!: Uint16Array;
  private pass!: Uint16Array;
  private behind!: Uint16Array;
  private noReturn!: Uint16Array;
  private rowSaturated!: Uint8Array;
  private presence!: Uint32Array; // slot*presenceWords + word

  // Per-source columns, indexed by slot*sourceCount + sourceIndex.
  private srcHit!: Uint16Array;
  private srcPass!: Uint16Array;
  private srcBehind!: Uint16Array;
  private srcNoReturn!: Uint16Array;
  private srcSaturated!: Uint8Array;
  private srcNotDecoded!: Uint8Array;

  constructor(sourceCount: number, initialCapacity = 1024) {
    this.sourceCount = sourceCount;
    this.presenceWords = presenceMaskWordCount(sourceCount);
    this.allocate(Math.max(1, initialCapacity));
  }

  private allocate(capacity: number): void {
    this.capacity = capacity;
    this.hit = new Uint16Array(capacity);
    this.pass = new Uint16Array(capacity);
    this.behind = new Uint16Array(capacity);
    this.noReturn = new Uint16Array(capacity);
    this.rowSaturated = new Uint8Array(capacity);
    this.keyBySlot = new Float64Array(capacity);
    this.presence = new Uint32Array(capacity * this.presenceWords);
    this.srcHit = new Uint16Array(capacity * this.sourceCount);
    this.srcPass = new Uint16Array(capacity * this.sourceCount);
    this.srcBehind = new Uint16Array(capacity * this.sourceCount);
    this.srcNoReturn = new Uint16Array(capacity * this.sourceCount);
    this.srcSaturated = new Uint8Array(capacity * this.sourceCount);
    this.srcNotDecoded = new Uint8Array(capacity * this.sourceCount);

    let tableSize = 1;
    while (tableSize < capacity * 2) tableSize *= 2;
    this.keys = new Float64Array(tableSize);
    this.slotIndex = new Int32Array(tableSize).fill(-1);
    this.mask = tableSize - 1;
  }

  private rowArray(field: CounterField): Uint16Array {
    return field === 'hit' ? this.hit : field === 'pass' ? this.pass : field === 'behind' ? this.behind : this.noReturn;
  }

  private srcArray(field: CounterField): Uint16Array {
    return field === 'hit' ? this.srcHit : field === 'pass' ? this.srcPass : field === 'behind' ? this.srcBehind : this.srcNoReturn;
  }

  /** The slot of voxel `key`, allotted (capacity grown first, if needed) on first sight. */
  private slotFor(key: number): number {
    if (this.slotCount === this.capacity) this.grow();
    let i = hashVoxelKey(key) & this.mask;
    for (;;) {
      const slot = this.slotIndex[i];
      if (slot === -1) {
        const fresh = this.slotCount++;
        this.keys[i] = key;
        this.slotIndex[i] = fresh;
        this.keyBySlot[fresh] = key;
        return fresh;
      }
      if (this.keys[i] === key) return slot;
      i = (i + 1) & this.mask;
    }
  }

  /** Marks `sourceIndex` present at voxel `key` and returns the slot to bump, creating it on first touch. */
  touch(key: number, sourceIndex: number): { readonly slot: number; readonly sourceIndex: number } {
    const slot = this.slotFor(key);
    const word = Math.floor(sourceIndex / PRESENCE_BITS_PER_WORD);
    const bit = sourceIndex % PRESENCE_BITS_PER_WORD;
    const idx = slot * this.presenceWords + word;
    this.presence[idx] = (this.presence[idx] | (1 << bit)) >>> 0; // i32-ok: 32-bit presence mask word, >>> 0 keeps it unsigned for the Uint32Array
    return { slot, sourceIndex };
  }

  /** {@link bump}'s saturating single-unit increment, over this table's own row-level column for `field`. */
  bumpRow(slot: number, field: CounterField): void {
    const arr = this.rowArray(field);
    if (arr[slot] >= COUNTER_SATURATION_MAX) {
      this.rowSaturated[slot] = 1;
      return;
    }
    arr[slot]++;
  }

  /** {@link bump}'s saturating single-unit increment, over this table's own per-source column for `field`. */
  bumpSource(slot: number, sourceIndex: number, field: CounterField): void {
    const idx = slot * this.sourceCount + sourceIndex;
    const arr = this.srcArray(field);
    if (arr[idx] >= COUNTER_SATURATION_MAX) {
      this.srcSaturated[idx] = 1;
      return;
    }
    arr[idx]++;
  }

  setNotDecoded(slot: number, sourceIndex: number): void {
    this.srcNotDecoded[slot * this.sourceCount + sourceIndex] = 1;
  }

  /** Doubles every column and rebuilds the key/slot probe table; slots keep their numbers (never renumbered). */
  private grow(): void {
    const next = this.capacity * 2;
    const widen = <T extends Uint16Array | Uint8Array | Float64Array | Uint32Array>(a: T, newLength: number): T => {
      const b = new (a.constructor as new (n: number) => T)(newLength);
      b.set(a);
      return b;
    };

    this.hit = widen(this.hit, next);
    this.pass = widen(this.pass, next);
    this.behind = widen(this.behind, next);
    this.noReturn = widen(this.noReturn, next);
    this.rowSaturated = widen(this.rowSaturated, next);
    this.keyBySlot = widen(this.keyBySlot, next);
    this.presence = widen(this.presence, next * this.presenceWords);
    this.srcHit = widen(this.srcHit, next * this.sourceCount);
    this.srcPass = widen(this.srcPass, next * this.sourceCount);
    this.srcBehind = widen(this.srcBehind, next * this.sourceCount);
    this.srcNoReturn = widen(this.srcNoReturn, next * this.sourceCount);
    this.srcSaturated = widen(this.srcSaturated, next * this.sourceCount);
    this.srcNotDecoded = widen(this.srcNotDecoded, next * this.sourceCount);
    this.capacity = next;

    const oldKeys = this.keys;
    const oldSlotIndex = this.slotIndex;
    let tableSize = 1;
    while (tableSize < next * 2) tableSize *= 2;
    this.keys = new Float64Array(tableSize);
    this.slotIndex = new Int32Array(tableSize).fill(-1);
    this.mask = tableSize - 1;
    for (let j = 0; j < oldSlotIndex.length; j++) {
      const slot = oldSlotIndex[j];
      if (slot === -1) continue;
      const key = oldKeys[j];
      let i = hashVoxelKey(key) & this.mask;
      while (this.slotIndex[i] !== -1) i = (i + 1) & this.mask;
      this.keys[i] = key;
      this.slotIndex[i] = slot;
    }
  }

  finish(): ObservationLedgerRow[] {
    const out: ObservationLedgerRow[] = [];
    for (let slot = 0; slot < this.slotCount; slot++) {
      const presence = this.presence.slice(slot * this.presenceWords, (slot + 1) * this.presenceWords);
      const perSource: ObservationLedgerSourceCounters[] = [];
      for (let sourceIndex = 0; sourceIndex < this.sourceCount; sourceIndex++) {
        const word = Math.floor(sourceIndex / PRESENCE_BITS_PER_WORD);
        const bit = sourceIndex % PRESENCE_BITS_PER_WORD;
        if (((presence[word] >>> bit) & 1) === 0) continue;
        const idx = slot * this.sourceCount + sourceIndex;
        perSource.push({
          sourceIndex,
          hit: this.srcHit[idx],
          pass: this.srcPass[idx],
          behind: this.srcBehind[idx],
          noReturn: this.srcNoReturn[idx],
          saturated: this.srcSaturated[idx] === 1,
          notDecoded: this.srcNotDecoded[idx] === 1,
        });
      }
      out.push({
        key: this.keyBySlot[slot],
        counters: { hit: this.hit[slot], pass: this.pass[slot], behind: this.behind[slot], noReturn: this.noReturn[slot], saturated: this.rowSaturated[slot] === 1 },
        presence,
        perSource,
      });
    }
    return out;
  }

  /**
   * Exact byte size of every column array this table currently holds — the
   * row-level counters/flag/key-by-slot/presence columns, the per-source
   * counter/flag columns, and the open-addressing probe table's own
   * `keys`/`slotIndex` arrays. Summed from each `TypedArray.byteLength`
   * directly, not sampled from `process.memoryUsage()`: a bytes/voxel test
   * built on this is exact and needs no `--expose-gc`, so it never flakes on
   * GC timing.
   */
  byteFootprint(): number {
    const arrays: readonly (Uint16Array | Uint8Array | Float64Array | Uint32Array | Int32Array)[] = [
      this.hit,
      this.pass,
      this.behind,
      this.noReturn,
      this.rowSaturated,
      this.keyBySlot,
      this.presence,
      this.srcHit,
      this.srcPass,
      this.srcBehind,
      this.srcNoReturn,
      this.srcSaturated,
      this.srcNotDecoded,
      this.keys,
      this.slotIndex,
    ];
    let total = 0;
    for (const a of arrays) total += a.byteLength;
    return total;
  }
}

/**
 * Test-only measurement API (`observatoryLedgerBytesPerVoxel.test.ts`):
 * builds a `LedgerBuilder` for `sourcesPerVoxel` stations, touches
 * `occupiedVoxels` distinct keys with every one of those sources at each
 * (the worst case this module's header quotes — every station's evidence
 * lands on every occupied voxel), and returns the table's exact
 * `byteFootprint()` divided by `occupiedVoxels`. Exported so the measurement
 * a bytes/voxel ceiling test asserts against is the SAME code path
 * `traverseRayChunks` runs, not a hand-reimplemented estimate of it.
 */
export function measureLedgerBuilderBytesPerVoxel(occupiedVoxels: number, sourcesPerVoxel: number): number {
  const builder = new LedgerBuilder(sourcesPerVoxel);
  for (let v = 0; v < occupiedVoxels; v++) {
    for (let s = 0; s < sourcesPerVoxel; s++) {
      builder.touch(v, s);
    }
  }
  return builder.byteFootprint() / occupiedVoxels;
}

interface AccumulationContext {
  readonly domain: ObservationDomain;
  readonly voxelEdge: number;
  readonly grid: { readonly nx: number; readonly ny: number; readonly nz: number };
  readonly builder: LedgerBuilder;
}

/** A finite, positive, normalizable direction; `null` for a degenerate one (F17-style: skipped, not thrown). */
function normalizeDirection(dx: number, dy: number, dz: number): Vec3 | null {
  const len = Math.hypot(dx, dy, dz);
  if (!(len > 0) || !Number.isFinite(len)) return null;
  return [dx / len, dy / len, dz / len];
}

/** One return's hit window, `[lo, hi] = [r - tau, r + tau]` for `tau = tauAbs + tauRel*r` (SPEC §2.1). */
export interface HitWindow {
  readonly lo: number;
  readonly hi: number;
}

/**
 * SPEC §2.1's hit window(s) for a ray's declared return range(s): one window
 * per return, in ascending `returnIndex` order (matching `ranges`' own
 * order). Extracted so a second consumer of the exact same windowing rule
 * (`strength.ts`'s hit-sample accumulator, phase O6) shares this function
 * rather than re-deriving τ(r) independently.
 */
export function computeHitWindows(ranges: readonly number[], tauAbs: number, tauRel: number): readonly HitWindow[] {
  return ranges.map((r) => {
    const tau = tauAbs + tauRel * r;
    return { lo: r - tau, hi: r + tau };
  });
}

/** True when a traversed voxel step's own `[tEnter, tLeave)` span overlaps ANY of `windows` (the same test {@link accumulateReturnedRay}'s `hit` branch uses). */
export function stepOverlapsAnyWindow(step: Pick<VoxelTraversalStep, 'tEnter' | 'tLeave'>, windows: readonly HitWindow[]): boolean {
  return windows.some((w) => step.tEnter < w.hi && step.tLeave > w.lo);
}

/**
 * One returned ray's hit-window accumulation (SPEC §2.1, OB-RAY-03). Returns
 * `false` when cheap rejection (a degenerate direction, or an empty domain
 * clip) discarded the ray before any voxel step ran, `true` otherwise — the
 * caller tallies this for OB-LED-02's rejection-ratio telemetry.
 *
 * `ranges` is one value for a single-return ray (`NaN` for no-return) or
 * every return's own declared range, in ascending `returnIndex` order, for a
 * multi-return ray. `pass` runs up to the FIRST return's window start,
 * `behind` from the LAST return's window end; `hit` increments once per
 * voxel whose traversed span overlaps ANY individual return's own window.
 * A voxel whose span lies strictly between two returns' windows (after the
 * first window closes but before it overlaps a later one, and before the
 * last window opens) gets no counter AND no row at all: `ctx.builder.touch`
 * is never called for it, so it carries neither a counter nor a presence
 * bit for this source. This is a deliberate reading, not a side effect of
 * the loop's `continue` below: `ObservationLedgerRow.presence`'s own doc
 * comment (`types.ts`) defines "touched" as hit, pass, behind, noReturn or
 * notDecoded, and a strictly-between-windows gap voxel is none of those —
 * unlike a not-read ray (`accumulateNotReadRay`), which always gets a
 * presence-only row because `notDecoded` IS one of the five. SPEC names
 * only `pass` up to the first return and `behind` from the last, and does
 * not name a third region between them.
 */
function accumulateReturnedRay(
  ctx: AccumulationContext,
  sourceIndex: number,
  origin: Vec3,
  rawDirection: readonly [number, number, number],
  ranges: readonly number[],
  tauAbs: number,
  tauRel: number,
  maxRange?: number,
): boolean {
  const direction = normalizeDirection(rawDirection[0], rawDirection[1], rawDirection[2]);
  if (direction === null) return false;

  const clip = clipRayToDomain(origin, direction, 0, Infinity, ctx.domain);
  if (clip === null) return false; // OB-LED-02 step 3: empty-clipped-ray skip.

  const isNoReturn = ranges.length === 1 && Number.isNaN(ranges[0]);
  // SPEC §2.1: "a no-return ray traverses the voxel up to the declared
  // maximum range" — when the caller supplies one (via a source's own
  // RayPartitionChunkEntry.maxRange), a no-return ray's OWN traversal stops
  // there rather than at the domain bound, matching a real instrument that
  // never listens past its own declared range. A returned ray's own finite
  // range already bounds its hit/behind windows and needs no such clip.
  const traversalExit = isNoReturn && maxRange !== undefined ? Math.min(clip.tExit, maxRange) : clip.tExit;
  if (traversalExit <= clip.tEntry) return true; // the declared maxRange closes before the ray even enters the domain: no evidence, and not a rejected ray (the ray itself was valid).
  const steps = traverseVoxelSteps(origin, direction, clip.tEntry, traversalExit, ctx.domain, ctx.voxelEdge);

  if (isNoReturn) {
    for (const step of steps) {
      const key = packVoxelKey(step.ix, step.iy, step.iz, ctx.grid.nx, ctx.grid.ny);
      const { slot } = ctx.builder.touch(key, sourceIndex);
      ctx.builder.bumpRow(slot, 'noReturn');
      ctx.builder.bumpSource(slot, sourceIndex, 'noReturn');
    }
    return true;
  }

  const windows = computeHitWindows(ranges, tauAbs, tauRel);
  const firstStart = Math.min(...windows.map((w) => w.lo));
  const lastEnd = Math.max(...windows.map((w) => w.hi));

  for (const step of steps) {
    const overlapsAnyWindow = stepOverlapsAnyWindow(step, windows);
    let field: CounterField | null = null;
    if (overlapsAnyWindow) field = 'hit';
    else if (step.tLeave <= firstStart) field = 'pass';
    else if (step.tEnter >= lastEnd) field = 'behind';
    if (field === null) continue; // Deliberate gap: no touch() call, so no row at all for this source here (see this function's doc comment).
    const key = packVoxelKey(step.ix, step.iy, step.iz, ctx.grid.nx, ctx.grid.ny);
    const { slot } = ctx.builder.touch(key, sourceIndex);
    ctx.builder.bumpRow(slot, field);
    ctx.builder.bumpSource(slot, sourceIndex, field);
  }
  return true;
}

/**
 * A not-decoded ray: traverses the same clip+DDA, sets `notDecoded` and the
 * presence bit, increments no counter (SPEC §2.4 rule 1's source fact).
 * Returns `false` when cheap rejection discarded the ray before any voxel
 * step ran, `true` otherwise (rejection-ratio telemetry, as in
 * {@link accumulateReturnedRay}).
 */
function accumulateNotReadRay(ctx: AccumulationContext, sourceIndex: number, origin: Vec3, rawDirection: readonly [number, number, number]): boolean {
  const direction = normalizeDirection(rawDirection[0], rawDirection[1], rawDirection[2]);
  if (direction === null) return false;
  const clip = clipRayToDomain(origin, direction, 0, Infinity, ctx.domain);
  if (clip === null) return false;
  const steps = traverseVoxelSteps(origin, direction, clip.tEntry, clip.tExit, ctx.domain, ctx.voxelEdge);
  for (const step of steps) {
    const key = packVoxelKey(step.ix, step.iy, step.iz, ctx.grid.nx, ctx.grid.ny);
    const { slot } = ctx.builder.touch(key, sourceIndex);
    ctx.builder.setNotDecoded(slot, sourceIndex);
  }
  return true;
}

// ---------------------------------------------------------------------------
// §7 — the worker-shaped partition contract (F9, the maintainer's 2026-09-23 reading)
// ---------------------------------------------------------------------------

/**
 * One chunk's traversal inputs, worker-transfer-shaped: everything here is
 * either a primitive or a typed array `rays.ts` already produces.
 *
 * `returnCounts`, when `returnTable` is given, is one entry per ray in
 * `chunk` — the number of returns that ray owns in `returnTable.range`,
 * starting at `chunk.returnOffset[k]`. This is a deliberate addition over
 * `ObservationRayChunk`'s own columns: `returnTable.countByRay` is a running
 * index across a SOURCE's entire ray-push order, not per chunk, so a ray at
 * the end of one chunk cannot recover its own count from `countByRay` alone
 * once partitioning has split its neighbour into a different chunk (or
 * partition). `returnCounts` is computed once, before partitioning, directly
 * from `countByRay`'s same running order, and is itself a plain typed array,
 * so the partition contract stays worker-transfer-shaped throughout.
 */
export interface RayPartitionChunkEntry {
  readonly sourceIndex: number;
  readonly chunk: ObservationRayChunk;
  /** τ(r) = tauAbs + tauRel·r for this chunk's source (SPEC §2.1); tauRel varies per source, so this is per-chunk-entry, not global. */
  readonly tauAbs: number;
  readonly tauRel: number;
  readonly returnTable?: ObservationReturnTable;
  readonly returnCounts?: Uint16Array;
  /**
   * The source's own declared maximum range (metres), bounding ONLY a
   * no-return ray's own traversal (SPEC §2.1: "up to the declared maximum
   * range"), never a returned ray's, whose finite range already bounds its
   * own hit/behind windows. Optional and additive: omitted (as every entry
   * before phase O5's F7 did) keeps the pre-existing domain-bound reading
   * `ledger.ts`'s own header records as O4's original interpretation.
   */
  readonly maxRange?: number;
}

export interface RayPartitionInput {
  readonly domain: ObservationDomain;
  readonly voxelEdge: number;
  readonly stations: readonly AcquisitionStation[];
  readonly returnedChunks: readonly RayPartitionChunkEntry[];
  readonly notReadChunks: readonly { readonly sourceIndex: number; readonly chunk: ObservationRayChunk }[];
}

/**
 * OB-LED-02's "rejection ratio... reported as telemetry": how much of one
 * partition's ray traffic never reached a single voxel step because cheap
 * rejection discarded it first. `rejectedRays` counts both OB-LED-02's own
 * empty-domain-clip skip (step 3; step 2, the station-sphere skip, is not
 * implemented — see {@link clipRayToDomain}'s doc comment) and this module's
 * separate degenerate-direction guard, since neither ever reaches traversal.
 * Plain integer counts, summed across partitions by
 * {@link mergeRejectionTelemetry} — commutative, so merge order never
 * matters. Deliberately excluded from {@link computeFieldDigest}: this is
 * telemetry about the run, not part of the per-voxel evidence OB-INV-07
 * fixes.
 */
export interface ObservationRejectionTelemetry {
  readonly totalRays: number;
  readonly rejectedRays: number;
}

/** One partition's traversal output, in the insertion (first-touch) order its own accumulation produced — unsorted, and never assumed sorted by a caller. */
export interface PartialLedger {
  readonly rows: readonly ObservationLedgerRow[];
  readonly telemetry: ObservationRejectionTelemetry;
}

function stationOriginOf(stations: readonly AcquisitionStation[], sourceIndex: number): Vec3 {
  const station = stations[sourceIndex];
  if (station === undefined) {
    throw new Error(`traverseRayChunks: no station at sourceIndex ${sourceIndex} (stations.length=${stations.length})`);
  }
  return station.pose.worldTranslation;
}

/**
 * One ray's own return range(s) (SPEC §2.1/OB-RAY-03): `[NaN]` for a
 * no-return ray, every CSR-table return in ascending `returnIndex` order for
 * a multi-return ray with a `returnTable`, or the chunk's own single
 * `range[k]` otherwise. Extracted out of {@link traverseRayChunks}'s own ray
 * loop so a second per-ray consumer of the exact same resolution
 * (`strength.ts`'s `accumulateStrengthHitSamples`, phase O6) shares it
 * rather than re-deriving the CSR lookup independently — a voxel's strength
 * samples must correspond to exactly the same per-ray return set the ledger
 * itself counted a hit against.
 */
export function resolveRayReturnRanges(
  chunk: ObservationRayChunk,
  k: number,
  returnTable?: ObservationReturnTable,
  returnCounts?: Uint16Array,
): readonly number[] {
  const rangeK = chunk.range[k]!;
  if (Number.isNaN(rangeK)) return [Number.NaN];
  if (returnTable !== undefined) {
    const offset = chunk.returnOffset[k]!;
    const count = returnCounts![k]!;
    return count > 0 ? Array.from(returnTable.range.subarray(offset, offset + count)) : [rangeK];
  }
  return [rangeK];
}

/**
 * OB-LED-01/02/05: traverses one partition's chunks (any subset of the full,
 * deterministic ray-chunk list, at whole-chunk granularity) against a fresh
 * table, independently of every other partition. Called once per partition
 * (the maintainer's F9 design: 1, 2 or 5), with no shared mutable state
 * across calls — a real Web Worker later wraps this exact function in
 * `postMessage`/`onmessage`, per OB-RT-03.
 */
export function traverseRayChunks(input: RayPartitionInput): PartialLedger {
  const grid = domainGrid(input.domain, input.voxelEdge);
  const builder = new LedgerBuilder(input.stations.length);
  const ctx: AccumulationContext = { domain: input.domain, voxelEdge: input.voxelEdge, grid, builder };
  let totalRays = 0;
  let rejectedRays = 0;

  for (const entry of input.returnedChunks) {
    const origin = stationOriginOf(input.stations, entry.sourceIndex);
    const n = entry.chunk.originIndex.length;
    if (entry.returnTable !== undefined && (entry.returnCounts === undefined || entry.returnCounts.length !== n)) {
      throw new Error('traverseRayChunks: a chunk with a returnTable needs a matching returnCounts array (one entry per ray)');
    }
    for (let k = 0; k < n; k++) {
      const direction: [number, number, number] = [entry.chunk.direction[k * 3], entry.chunk.direction[k * 3 + 1], entry.chunk.direction[k * 3 + 2]];
      const ranges = resolveRayReturnRanges(entry.chunk, k, entry.returnTable, entry.returnCounts);
      totalRays++;
      if (!accumulateReturnedRay(ctx, entry.sourceIndex, origin, direction, ranges, entry.tauAbs, entry.tauRel, entry.maxRange)) rejectedRays++;
    }
  }

  for (const entry of input.notReadChunks) {
    const origin = stationOriginOf(input.stations, entry.sourceIndex);
    const n = entry.chunk.originIndex.length;
    for (let k = 0; k < n; k++) {
      const direction: [number, number, number] = [entry.chunk.direction[k * 3], entry.chunk.direction[k * 3 + 1], entry.chunk.direction[k * 3 + 2]];
      totalRays++;
      if (!accumulateNotReadRay(ctx, entry.sourceIndex, origin, direction)) rejectedRays++;
    }
  }

  return { rows: builder.finish(), telemetry: { totalRays, rejectedRays } };
}

/** Sums {@link ObservationRejectionTelemetry} across partitions: plain integer addition, so merge order never matters (OB-LED-05's determinism extends to telemetry too). */
export function mergeRejectionTelemetry(partials: readonly PartialLedger[]): ObservationRejectionTelemetry {
  let totalRays = 0;
  let rejectedRays = 0;
  for (const partial of partials) {
    totalRays += partial.telemetry.totalRays;
    rejectedRays += partial.telemetry.rejectedRays;
  }
  return { totalRays, rejectedRays };
}

function mergeCountersInto(target: MutableCounters, from: ObservationCounters): void {
  let saturated = target.saturated || from.saturated;
  for (const field of COUNTER_FIELDS) {
    const sum = target[field] + from[field];
    if (sum > COUNTER_SATURATION_MAX) {
      target[field] = COUNTER_SATURATION_MAX;
      saturated = true;
    } else {
      target[field] = sum;
    }
  }
  target.saturated = saturated;
}

/**
 * OB-LED-05: folds each partial's rows, in the given array order, into one
 * table. For a `key` seen in more than one partial: `counters` merges by the
 * saturating-sum-and-flag rule; `presence` merges by word-wise bitwise OR;
 * `perSource` merges entries sharing the same `sourceIndex` by the same
 * saturating-sum rule per counter, and ORs `notDecoded`. All three
 * combinators are commutative and associative, so the final per-key values
 * are independent of fold order — only the returned array's own slot order
 * differs by fold order, which {@link computeFieldDigest}'s canonical row
 * sort removes before hashing. Called once per run, including at partition
 * count 1 (`mergePartialLedgers([onePartial])` is then a no-op merge), so
 * every partition count exercises the same merge code path.
 */
export function mergePartialLedgers(partials: readonly PartialLedger[]): readonly ObservationLedgerRow[] {
  const merged = new Map<number, MutableRow>();

  for (const partial of partials) {
    for (const row of partial.rows) {
      let target = merged.get(row.key);
      if (target === undefined) {
        target = { key: row.key, ...freshCounters(), presence: new Uint32Array(row.presence.length), perSource: new Map() };
        merged.set(row.key, target);
      }
      if (row.presence.length > target.presence.length) {
        const widened = new Uint32Array(row.presence.length);
        widened.set(target.presence);
        target.presence = widened;
      }
      for (let i = 0; i < row.presence.length; i++) target.presence[i] = (target.presence[i] | row.presence[i]) >>> 0; // i32-ok: OR of two Uint32 presence mask words
      mergeCountersInto(target, row.counters);

      for (const source of row.perSource) {
        let targetSource = target.perSource.get(source.sourceIndex);
        if (targetSource === undefined) {
          targetSource = { sourceIndex: source.sourceIndex, ...freshCounters(), notDecoded: false };
          target.perSource.set(source.sourceIndex, targetSource);
        }
        mergeCountersInto(targetSource, source);
        targetSource.notDecoded = targetSource.notDecoded || source.notDecoded;
      }
    }
  }

  const out: ObservationLedgerRow[] = [];
  for (const row of merged.values()) {
    out.push({
      key: row.key,
      counters: { hit: row.hit, pass: row.pass, behind: row.behind, noReturn: row.noReturn, saturated: row.saturated },
      presence: row.presence,
      perSource: Array.from(row.perSource.values(), (s) => ({
        sourceIndex: s.sourceIndex,
        hit: s.hit,
        pass: s.pass,
        behind: s.behind,
        noReturn: s.noReturn,
        saturated: s.saturated,
        notDecoded: s.notDecoded,
      })),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// §8 — work-budget estimate and canonical fieldDigest
// ---------------------------------------------------------------------------

/** OB-LED-04: `estimatedSteps = Σ (clipped ray length) / voxelEdge`, over every ray that survives cheap rejection (a degenerate direction, or an empty clip, contributes zero). */
export function estimateTraversalBudget(
  input: Pick<RayPartitionInput, 'domain' | 'voxelEdge' | 'stations' | 'returnedChunks' | 'notReadChunks'>,
  declaredBudget: number,
): TraversalBudgetEstimate {
  let totalSpan = 0;

  const consider = (sourceIndex: number, chunk: ObservationRayChunk): void => {
    const origin = stationOriginOf(input.stations, sourceIndex);
    const n = chunk.originIndex.length;
    for (let k = 0; k < n; k++) {
      const direction = normalizeDirection(chunk.direction[k * 3], chunk.direction[k * 3 + 1], chunk.direction[k * 3 + 2]);
      if (direction === null) continue;
      const clip = clipRayToDomain(origin, direction, 0, Infinity, input.domain);
      if (clip === null) continue;
      totalSpan += clip.tExit - clip.tEntry;
    }
  };

  for (const entry of input.returnedChunks) consider(entry.sourceIndex, entry.chunk);
  for (const entry of input.notReadChunks) consider(entry.sourceIndex, entry.chunk);

  const estimatedSteps = totalSpan / input.voxelEdge;
  return { estimatedSteps, voxelEdge: input.voxelEdge, declaredBudget, withinBudget: estimatedSteps <= declaredBudget };
}

/**
 * OB-INV-07's canonical digest, over exactly what O4 owns: the domain, the
 * voxel edge, the per-source τ parameters actually used, the participating
 * stations, and the merged rows. Deliberately excludes `p_solid`/`p_empty`/
 * `n_min`: those govern O5's state derivation, not this ledger's own
 * counters, so OB-INV-06 ("no presentation parameter shall change a
 * canonical byte") is trivially true of them at O4's boundary. O5/O7 may fold
 * this digest into a larger exported one later.
 *
 * Uses `canonicalHash` (`src/canonicalHash.ts`) exclusively — zero
 * dependencies, layer-neutral, already imported by other pure science
 * modules — never `src/render/measure/auditLog.ts`. Two implementation traps
 * `canonicalJson` sets are closed explicitly, both load-bearing for F9:
 *
 *   1. `canonicalJson` sorts object keys but does not reorder array
 *      elements, so `rows` is sorted by `key` ascending before hashing —
 *      different partition/merge orders populate this function's own input
 *      array in different orders even though the per-key VALUES are
 *      identical (that is exactly what F9 stresses).
 *   2. A `Uint32Array` (`presence`) is `typeof === 'object'` and
 *      `!Array.isArray`, so `canonicalJson` would otherwise serialize it via
 *      `Object.keys().sort()`, which sorts numeric-string indices
 *      lexicographically ("10" before "2") past nine elements. Converting
 *      with `Array.from` first takes the array branch instead.
 *
 * Each row's `perSource` is likewise copied and sorted by `sourceIndex`
 * ascending, for the same reason as the row sort.
 */
export function computeFieldDigest(
  input: Pick<RayPartitionInput, 'domain' | 'voxelEdge' | 'stations' | 'returnedChunks'>,
  rows: readonly ObservationLedgerRow[],
): string {
  const tauBySource = new Map<number, { readonly tauAbs: number; readonly tauRel: number }>();
  for (const entry of input.returnedChunks) {
    if (!tauBySource.has(entry.sourceIndex)) tauBySource.set(entry.sourceIndex, { tauAbs: entry.tauAbs, tauRel: entry.tauRel });
  }
  const tauList = Array.from(tauBySource.entries(), ([sourceIndex, tau]) => ({ sourceIndex, ...tau })).sort((a, b) => a.sourceIndex - b.sourceIndex);

  const stationList = input.stations
    .map((s) => ({ id: s.id, source: s.source, originStatus: s.originStatus, worldTranslation: Array.from(s.pose.worldTranslation) }))
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const sortedRows = rows
    .map((row) => ({
      key: row.key,
      counters: { hit: row.counters.hit, pass: row.counters.pass, behind: row.counters.behind, noReturn: row.counters.noReturn, saturated: row.counters.saturated },
      presence: Array.from(row.presence),
      perSource: row.perSource
        .map((s) => ({ sourceIndex: s.sourceIndex, hit: s.hit, pass: s.pass, behind: s.behind, noReturn: s.noReturn, saturated: s.saturated, notDecoded: s.notDecoded }))
        .slice()
        .sort((a, b) => a.sourceIndex - b.sourceIndex),
    }))
    .slice()
    .sort((a, b) => a.key - b.key);

  return canonicalHash({
    domain: { min: Array.from(input.domain.min), max: Array.from(input.domain.max) },
    voxelEdge: input.voxelEdge,
    tauBySource: tauList,
    stations: stationList,
    rows: sortedRows,
  });
}

// ---------------------------------------------------------------------------
// §9 — explicit-choice refusal, before any allocation (OB-LED-03/04)
// ---------------------------------------------------------------------------

export type ObservationLedgerRefusalReason = 'voxel-budget' | 'step-budget';
export type ObservationLedgerSuggestion = 'coarsen-h' | 'smaller-roi' | 'subsample';

export type ObservationLedgerRunResult =
  | {
      readonly status: 'ok';
      readonly rows: readonly ObservationLedgerRow[];
      readonly fieldDigest: string;
      /** OB-LED-02's rejection ratio: `rejectedRays / totalRays` over this run's own rays, 0 when there were none. Excluded from `fieldDigest`. */
      readonly rejectionRatio: number;
    }
  | {
      readonly status: 'refused';
      readonly reason: ObservationLedgerRefusalReason;
      readonly voxelBudget?: VoxelDomainBudgetResult;
      readonly stepBudget?: TraversalBudgetEstimate;
      readonly suggestions: readonly ObservationLedgerSuggestion[];
    };

export interface RunObservationLedgerOptions {
  readonly declaredStepBudget: number;
  readonly voxelBudget?: VoxelDomainBudgetOptions;
  /** Explicit user choice to proceed past a 'coarsen' voxel verdict or an over-budget step estimate (SPEC §5.2 OB-LED-04). Never defaults true. A 'blocked' voxel verdict is never overridable. */
  readonly allowOverBudget?: boolean;
}

/**
 * The single entry point OB-LED-03/04 describe: checks the voxel-memory
 * budget FIRST (pure `domain`+`voxelEdge`, no ray cost to even build), then —
 * only if that check does not refuse — the work-step estimate. Either
 * refusal returns before any traversal or table allocation runs ("the run
 * stops before allocation", SPEC §5.2). `allowOverBudget` is the one lever
 * that proceeds past a soft ('coarsen') voxel verdict or an over-estimate
 * step budget; it is never silently defaulted, satisfying OB-INV-08 by
 * making every refusal an inspectable value rather than a thrown exception,
 * mirroring `gridBudget.ts`'s own house convention.
 */
export function runObservationLedger(input: RayPartitionInput, options: RunObservationLedgerOptions): ObservationLedgerRunResult {
  // `sourceCount` defaults to the run's own station count, for an accurate
  // multi-source memory estimate; an explicit `voxelBudget.sourceCount` (or
  // `bytesPerVoxel`) still overrides it.
  const voxelBudget = checkVoxelDomainBudget(input.domain, input.voxelEdge, { sourceCount: input.stations.length, ...options.voxelBudget });
  if (voxelBudget.verdict === 'blocked') {
    return { status: 'refused', reason: 'voxel-budget', voxelBudget, suggestions: ['coarsen-h', 'smaller-roi'] };
  }
  if (voxelBudget.verdict === 'coarsen' && !options.allowOverBudget) {
    return { status: 'refused', reason: 'voxel-budget', voxelBudget, suggestions: ['coarsen-h', 'smaller-roi', 'subsample'] };
  }

  const stepBudget = estimateTraversalBudget(input, options.declaredStepBudget);
  if (!stepBudget.withinBudget && !options.allowOverBudget) {
    return { status: 'refused', reason: 'step-budget', stepBudget, suggestions: ['coarsen-h', 'smaller-roi', 'subsample'] };
  }

  const partial = traverseRayChunks(input);
  const rows = mergePartialLedgers([partial]);
  const telemetry = mergeRejectionTelemetry([partial]);
  const rejectionRatio = telemetry.totalRays > 0 ? telemetry.rejectedRays / telemetry.totalRays : 0;
  return { status: 'ok', rows, fieldDigest: computeFieldDigest(input, rows), rejectionRatio };
}
