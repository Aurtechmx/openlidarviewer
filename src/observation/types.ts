/**
 * types.ts — Observation model vocabulary (docs/observatory/SPEC.md §2, §4 OB-INT-06).
 *
 * Pure data and pure helpers only: no DOM, `three` or `ui/` imports (OB-INT-01).
 * Nothing here reads a `PointCloud` or a raw `.positions` array. The ray builder
 * and traversal that populate these shapes from a real scan are later phases
 * (O2-O4); this module only names the vocabulary they and the state-table
 * function (`stateTable.ts`) share.
 */

// ---------------------------------------------------------------------------
// SPEC §2.2 — state vocabulary
// ---------------------------------------------------------------------------

/**
 * The nine observation states a voxel can carry, per source or in aggregate
 * (SPEC §2.2). Each is a derived label; the counters below remain the record.
 */
export type ObservationState =
  | 'SURFACE'
  | 'PARTIAL'
  | 'OBSERVED_EMPTY'
  | 'CONFLICT'
  | 'SHADOWED'
  | 'NO_RETURN_PATH'
  | 'UNADDRESSED'
  | 'NOT_READ'
  | 'OUTSIDE_DOMAIN';

/** Every {@link ObservationState}, in the order SPEC §2.2 declares them. */
export const OBSERVATION_STATES: readonly ObservationState[] = [
  'SURFACE',
  'PARTIAL',
  'OBSERVED_EMPTY',
  'CONFLICT',
  'SHADOWED',
  'NO_RETURN_PATH',
  'UNADDRESSED',
  'NOT_READ',
  'OUTSIDE_DOMAIN',
];

// ---------------------------------------------------------------------------
// SPEC §2.1 — the evidence ledger's counters
// ---------------------------------------------------------------------------

/**
 * Counters saturate at the Uint16 ceiling (SPEC §2.1). A counter that would
 * exceed this stops accumulating and the voxel's `saturated` flag is set,
 * rather than wrapping or growing the column's storage width.
 */
export const COUNTER_SATURATION_MAX = 0xffff;

/**
 * The four ray-outcome counts a voxel accumulates, for one source or for the
 * aggregate across sources (SPEC §2.1). Each of `hit`, `pass`, `behind` and
 * `noReturn` is conceptually a saturating Uint16; `saturated` is one flag per
 * record, true when any of the four hit {@link COUNTER_SATURATION_MAX}.
 */
export interface ObservationCounters {
  /** Rays whose return landed in this voxel's hit window. */
  readonly hit: number;
  /** Rays that traversed this voxel before their hit window began. */
  readonly pass: number;
  /** Rays whose extension beyond their hit traverses this voxel. */
  readonly behind: number;
  /** No-return rays that traverse this voxel up to the declared maximum range. */
  readonly noReturn: number;
  /** True when any counter above saturated at {@link COUNTER_SATURATION_MAX}. */
  readonly saturated: boolean;
}

/** All-zero counters, unsaturated. The value an untouched voxel starts from. */
export const EMPTY_OBSERVATION_COUNTERS: ObservationCounters = Object.freeze({
  hit: 0,
  pass: 0,
  behind: 0,
  noReturn: 0,
  saturated: false,
});

/**
 * One source's contribution to a voxel: its counters, plus the two facts the
 * state table needs beyond raw counts (SPEC §2.2-§2.4).
 *
 * `addressed` and the counters are independent facts, not one derived from
 * the other: a voxel can sit inside a source's declared angular/range domain
 * (`addressed` true) while every counter reads zero, because no individual ray
 * happened to intersect that exact voxel (an angular-discretisation gap). A
 * later phase (O3, the ray builder) computes `addressed` from the source's
 * fitted domain (`acquisitionCoverage`); O1 only declares the field.
 */
export interface SourceObservationRecord extends ObservationCounters {
  /** 0-based index into the source list for this voxel/run; see the presence mask below. */
  readonly sourceIndex: number;
  /** Whether this voxel lies within this source's declared/addressed ray domain. */
  readonly addressed: boolean;
  /**
   * True when at least one of this source's rays that would traverse this
   * voxel was `NOT_DECODED` rather than read (drives `NOT_READ`, SPEC §2.4
   * rule 1). Independent of the four counters, which count only READ rays.
   */
  readonly notDecoded: boolean;
}

// ---------------------------------------------------------------------------
// SPEC §2.1 — per-source presence bitmask (Uint32 words, 32 sources/word)
// ---------------------------------------------------------------------------

/** Sources packed per presence-mask word (SPEC §2.1). */
export const PRESENCE_BITS_PER_WORD = 32;

/**
 * Which sources have any recorded evidence at a voxel, packed 32 sources per
 * `Uint32` word: bit `sourceIndex % 32` of word `Math.floor(sourceIndex / 32)`.
 * F17 (33+ sources) exercises the boundary where a source index crosses into
 * a second word; that fixture is scored from O5 onward, this module only
 * supplies the packing so later phases share one bit layout.
 */
export type SourcePresenceMask = Uint32Array;

/** Word count needed to hold `sourceCount` sources' presence bits. */
export function presenceMaskWordCount(sourceCount: number): number {
  if (!Number.isInteger(sourceCount) || sourceCount < 0) {
    throw new Error(`presenceMaskWordCount: sourceCount must be a non-negative integer, got ${sourceCount}`);
  }
  return sourceCount === 0 ? 0 : Math.ceil(sourceCount / PRESENCE_BITS_PER_WORD);
}

/** A zeroed presence mask sized for `sourceCount` sources. */
export function createPresenceMask(sourceCount: number): SourcePresenceMask {
  return new Uint32Array(presenceMaskWordCount(sourceCount));
}

function assertValidSourceIndex(mask: SourcePresenceMask, sourceIndex: number): { word: number; bit: number } {
  if (!Number.isInteger(sourceIndex) || sourceIndex < 0) {
    throw new Error(`sourceIndex must be a non-negative integer, got ${sourceIndex}`);
  }
  const word = Math.floor(sourceIndex / PRESENCE_BITS_PER_WORD);
  if (word >= mask.length) {
    throw new Error(
      `sourceIndex ${sourceIndex} needs word ${word}, but the mask holds only ${mask.length} word(s)`,
    );
  }
  return { word, bit: sourceIndex % PRESENCE_BITS_PER_WORD };
}

/** Sets `sourceIndex` present in `mask`, in place. */
export function setSourcePresent(mask: SourcePresenceMask, sourceIndex: number): void {
  const { word, bit } = assertValidSourceIndex(mask, sourceIndex);
  mask[word] = (mask[word] | (1 << bit)) >>> 0;
}

/** True when `sourceIndex` is marked present in `mask`. */
export function isSourcePresent(mask: SourcePresenceMask, sourceIndex: number): boolean {
  const { word, bit } = assertValidSourceIndex(mask, sourceIndex);
  return ((mask[word] >>> bit) & 1) === 1;
}

// ---------------------------------------------------------------------------
// SPEC §4 OB-INT-06 — observation origin
// ---------------------------------------------------------------------------

/**
 * An origin's provenance status. `DECLARED` and `ASSUMED` are Observatory's
 * own vocabulary (OB-INV-04): `DECLARED` comes from the file (scanner
 * metadata), `ASSUMED` is user-placed. The three `RECONSTRUCTED_*` grades are
 * the statuses the sibling SensorPrint spec's origin handoff declares for a
 * computed origin (strong / moderate / weak); Observatory accepts
 * `RECONSTRUCTED_STRONG` under a visible label and refuses the two weaker
 * grades with a reason (OB-INT-06). No SensorPrint handoff type exists in
 * this tree yet, so this type is Observatory's own until one does.
 */
export type ObservationOriginStatus =
  | 'DECLARED'
  | 'ASSUMED'
  | 'RECONSTRUCTED_STRONG'
  | 'RECONSTRUCTED_MODERATE'
  | 'RECONSTRUCTED_WEAK';

/** Statuses OB-INT-06's default policy accepts into the evidence ledger. */
export const ACCEPTED_ORIGIN_STATUSES: readonly ObservationOriginStatus[] = [
  'DECLARED',
  'RECONSTRUCTED_STRONG',
];

/**
 * A scanner origin, with the provenance OB-INV-04 requires: no origin is ever
 * invented, so every one carries where it came from and how sure that source
 * is (SPEC §4 OB-INT-06). `ASSUMED` origins additionally carry `preview`
 * authority and a badge on every surface that shows them (OB-INV-04); that
 * wiring belongs to the phase that builds the panel (O9), not to this type.
 */
export interface ObservationOrigin {
  /** World position, Float64, before any origin shift (`docs/coordinate-precision.md`). */
  readonly position: readonly [number, number, number];
  readonly status: ObservationOriginStatus;
  /**
   * The tag of the method that produced this origin, in `methodTag()`'s
   * `id@version` form. The seven `olv.observation.*` ids are registered early
   * (OB-INT-04, phase O2) to reserve their names and versions, but none has a
   * working origin-producing implementation yet (that lands per-method across
   * O3-O10, see docs/observatory/methods.md), so this field is still an
   * undeclared string in practice, not validated against `METHOD_REGISTRY`.
   */
  readonly methodTag: string;
  /** Position uncertainty in metres, or `null` when none has been estimated. */
  readonly uncertainty: number | null;
}

/** True when `status` is one OB-INT-06's default policy accepts today. */
export function isAcceptedOriginStatus(status: ObservationOriginStatus): boolean {
  return (ACCEPTED_ORIGIN_STATUSES as readonly string[]).includes(status);
}

// ---------------------------------------------------------------------------
// SPEC §2.1 / §5.1 — declared parameters
// ---------------------------------------------------------------------------

/**
 * The five declared parameters SPEC §2.1 and §5.1 name, with units. Values
 * are preregistered in `validation/protocols/observatory/` before any fixture
 * is scored (OB-ST-02) and change only by editing that record with a reason.
 */
export interface ObservationParameters {
  /** Hit-fraction floor for `SURFACE`, and the "solid" side of `CONFLICT` (dimensionless, hit / (hit + pass), in [0, 1]). */
  readonly p_solid: number;
  /** Hit-fraction ceiling for the "empty" side of `CONFLICT` (dimensionless, in [0, 1]). */
  readonly p_empty: number;
  /** Minimum ray count (`hit + pass`) before a hit fraction is trusted (count, integer ≥ 1). */
  readonly n_min: number;
  /** Hit-window absolute half-width term in the τ(r) = tau_abs + tau_rel·r formula (metres). */
  readonly tau_abs: number;
  /** Hit-window range-proportional half-width term in the same formula (dimensionless, metres per metre of range). */
  readonly tau_rel: number;
}
