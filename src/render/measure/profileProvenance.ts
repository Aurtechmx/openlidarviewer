/**
 * profileProvenance.ts
 *
 * What shaped a profile sample, in a record small enough to keep.
 *
 * A saved profile carries a compact chart, a corridor half-width and a
 * percentile. Those describe the OUTPUT. They do not say which layers were
 * read, whether the classification those layers were filtered by came from the
 * producer or from this app, whether the read saw the whole source or only the
 * nodes that happened to be resident, or what unit and vertical reference the
 * heights are in. A number without those is a number, not a measurement.
 *
 * The record here answers exactly that, and nothing else:
 *
 *   - the method and the corridor-definition version the sample was taken with;
 *   - the normalised `up` the heights were measured along;
 *   - every source that was read, by STABLE layer id, with its classification
 *     kind, whether it was streaming, and how much it contributed;
 *   - the class-exclusion policy, and whether classification was actually
 *     available on every contributing source;
 *   - whether the read was resident-only, and whether it can claim completeness;
 *   - the linear unit and vertical reference the heights sit in.
 *
 * Three properties this module exists to hold:
 *
 * COUNTS, NEVER POINTS. A section can hold millions of returns. The builder
 * reads the accepted set to COUNT it and keeps no reference to it, so the
 * record's serialised size is a function of the number of sources and never of
 * the number of points. Persisting the returns beside every measurement would
 * turn a session file into a second copy of the cloud.
 *
 * IDENTITY IS THE STABLE LAYER ID. A display name is user-editable, so it is
 * human context and never identity. Both are recorded; only the id is keyed on,
 * and {@link profileProvenanceIdentity} is built from ids alone, so a rename
 * leaves it untouched.
 *
 * NO CLOCK. The timestamp is supplied by the caller, exactly as
 * `reportManifest.ts` does it, so {@link serializeProfileProvenance} is
 * byte-identical for the same input and two parties can compare records.
 *
 * Pure. No viewer, no scheduler, no DOM.
 *
 * The record is BUILT here and READ back in `io/session.ts`, alongside that
 * file's own readers for the profile chart, the volume record and the scan
 * summary. The io layer owns the tolerance rules for its own file format, and
 * the shape is not free to drift apart from this one: the reader is typed to
 * return a {@link ProfileProvenance}, so a field added or renamed here fails to
 * compile there.
 */

import { canonicalize } from './auditLog';
import { resolveSectionScope, streamingIsComplete } from './profileSectionSnapshot';
import type { ProfileSectionScope, StreamingCoverage } from './profileSectionSnapshot';
import type { CrsLinearUnit } from '../../io/crs';
import type { VerticalReference } from '../../geo/height';
import type { Truncation } from '../../io/truncation';
import type { SourceReduction, WithheldReadCounts } from '../../science/withheldCounts';

/**
 * Schema version of the provenance record itself.
 *
 * Independent of the session-file version: the record is an additive optional
 * field on a profile measurement, so it versions on its own terms and a reader
 * that meets a higher number than it knows drops the record rather than the
 * measurement.
 */
export const PROFILE_PROVENANCE_VERSION = 1;

/** The sampling method this record describes. */
export const PROFILE_METHOD_CORRIDOR_PERCENTILE = 'corridor-percentile';

/**
 * Version of the corridor membership definition in `profileCorridor.ts`.
 *
 * Recorded because the corridor decides which returns exist at all. If that
 * definition ever changes, a stored sample taken under the old one is not
 * reproducible under the new one, and the record has to be able to say so.
 */
export const PROFILE_CORRIDOR_VERSION = 1;

/**
 * Where a source's classification came from.
 *
 * `producer` — the class codes shipped with the file.
 * `derived`  — this app assigned them (see `classification/`).
 * `absent`   — the source carries no classification, so no class-based
 *              exclusion could be applied to it, whatever the policy says.
 *
 * The distinction matters because the exclusion policy reads as a filter that
 * was applied everywhere. On a source with no class channel nothing was
 * filtered, and the percentile saw vegetation and buildings along with ground.
 */
export type ProfileClassificationKind = 'producer' | 'derived' | 'absent';

/** One source as the record keeps it. */
export interface ProfileProvenanceSource {
  /**
   * The source's STABLE layer id. Identity, and the only field keyed on.
   */
  readonly layerId: string;
  /**
   * The layer's display name at capture time. Human context. User-editable,
   * so never identity and never part of {@link profileProvenanceIdentity}.
   */
  readonly displayName: string;
  readonly classification: ProfileClassificationKind;
  /** True when the source was streaming (COPC/EPT) rather than fully resident. */
  readonly streaming: boolean;
  /** Returns from this source that the corridor accepted. */
  readonly acceptedCount: number;
  /**
   * Whether this source reached the accepted set at all. A source that was
   * read and contributed nothing is still worth recording: it says the layer
   * was considered, which "not listed" does not.
   */
  readonly contributed: boolean;
  /**
   * For a streaming source, whether every node it is known to contain was
   * resident. `null` means unknown, which is not `false` — see
   * `streamingIsComplete`. Always `null` for a static source, which has no
   * node set to be complete over.
   */
  readonly residency: boolean | null;
  /**
   * For a static source read from a truncated file, the records read and the
   * count the header declares. Absent for a complete read, so a record for a
   * complete source serialises as it did before.
   */
  readonly truncation?: Truncation;
}

/** The class-exclusion policy the sample was taken under. */
export interface ProfileClassPolicy {
  /** ASPRS class codes dropped before the percentile. Sorted, deduplicated. */
  readonly excludedClasses: readonly number[];
  /**
   * True only when EVERY contributing source carried classification, from the
   * producer or derived here. False when any of them carried none, and false
   * when nothing contributed, because no availability can be asserted over an
   * empty read.
   */
  readonly availableOnEverySource: boolean;
}

/** The unit and vertical-reference context the heights sit in. */
export interface ProfileUnitContext {
  /** Horizontal linear unit of the project frame. */
  readonly linearUnit: CrsLinearUnit;
  /** The surface heights are measured from, or `unknown` when undeclared. */
  readonly verticalReference: VerticalReference;
  /**
   * Metres per vertical unit, or `null` when the source declared no vertical
   * unit. Null is NOT one: a file that carried no vertical unit must not be
   * read as metres.
   */
  readonly verticalMetresPerUnit: number | null;
}

/** The provenance of one profile sample. */
export interface ProfileProvenance {
  readonly recordVersion: number;
  /** The sampling method, e.g. {@link PROFILE_METHOD_CORRIDOR_PERCENTILE}. */
  readonly method: string;
  /** {@link PROFILE_CORRIDOR_VERSION} at capture time. */
  readonly corridorVersion: number;
  /** Caller-supplied ISO timestamp. Never read from the clock here. */
  readonly capturedAt: string;
  /**
   * The normalised scene up axis the heights were measured along.
   * `[0, 0, 0]` when the supplied up was degenerate, matching `ProfileFrame`.
   */
  readonly up: readonly [number, number, number];
  /** True when the supplied up was zero-length or non-finite. */
  readonly upDegenerate: boolean;
  /** Every source that was read, ordered by layer id. */
  readonly sources: readonly ProfileProvenanceSource[];
  /** Total returns the corridor accepted, across all sources. */
  readonly acceptedCount: number;
  /** What the read is entitled to claim, from `resolveSectionScope`. */
  readonly scope: ProfileSectionScope;
  /** True when every contributing source was streaming. */
  readonly residentOnly: boolean;
  /**
   * Whether the read saw everything it was reading from. `true` only when no
   * streaming source contributed, or every one that did was provably fully
   * resident. `false` when one provably was not. `null` when unknown, and
   * `null` when nothing was read at all. A resident-only read is never
   * `true` by default: residency has to be established, not assumed.
   */
  readonly complete: boolean | null;
  readonly classPolicy: ProfileClassPolicy;
  readonly units: ProfileUnitContext;
  /**
   * How the sources were reduced before the read, when they were: the
   * resident and declared point counts and whether the reduction kept
   * records or replaced them with voxel centroids. Absent for a whole
   * cloud, and for a record saved before this field existed.
   */
  readonly reduction?: SourceReduction;
}

/** One source as the caller describes it to the builder. */
export interface ProfileProvenanceSourceInput {
  /** The slot the section's `sourceSlot` array records for this source. */
  readonly slot: number;
  /** Stable layer id. Blank ids are refused: a record keyed on "" is not one. */
  readonly layerId: string;
  readonly displayName: string;
  readonly classification: ProfileClassificationKind;
  readonly streaming: boolean;
  /**
   * Node coverage for a streaming source, when the host knows it. Absent or
   * null leaves residency unknown, which is what `streamingIsComplete` already
   * refuses to turn into a claim.
   */
  readonly coverage?: StreamingCoverage | null;
  /** A static source's truncation, or null / absent for a complete read. */
  readonly truncation?: Truncation | null;
}

/**
 * The accepted set, read for its counts only.
 *
 * Structural rather than `ProfileSectionPoints` so a caller can hand over just
 * the two fields that are counted, and so this module never gains a reason to
 * hold the positions, heights or channels.
 */
export interface ProfileAcceptedCounts {
  readonly count: number;
  /** Per-return source slot, `count` entries. */
  readonly sourceSlot: ArrayLike<number>;
}

export interface ProfileProvenanceInput {
  /** ISO timestamp. Required, and never defaulted from the clock. */
  readonly capturedAt: string;
  /** Defaults to {@link PROFILE_METHOD_CORRIDOR_PERCENTILE}. */
  readonly method?: string;
  /** Defaults to {@link PROFILE_CORRIDOR_VERSION}. */
  readonly corridorVersion?: number;
  /** The scene up axis, normalised here. */
  readonly up: readonly [number, number, number];
  readonly sources: readonly ProfileProvenanceSourceInput[];
  readonly accepted: ProfileAcceptedCounts;
  /** ASPRS codes dropped before the percentile. */
  readonly excludedClasses: readonly number[];
  readonly units: ProfileUnitContext;
  /** The sources' reduction, when the loader handed over fewer points than declared. */
  readonly reduction?: SourceReduction | null;
}

/**
 * Build the provenance record for one profile sample.
 *
 * Deterministic: sources are emitted in stable-id order rather than in the
 * host's iteration order, class codes are sorted, and the timestamp comes from
 * `input.capturedAt`. The same input therefore serialises to the same bytes.
 *
 * `input.accepted` is walked once to count returns per source and is not
 * retained. Nothing in the returned record grows with the accepted count.
 *
 * Throws when `capturedAt` is not a string, or when a source carries a blank
 * layer id — both are caller mistakes that would otherwise persist as a record
 * that cannot be compared or keyed.
 */
export function buildProfileProvenance(input: ProfileProvenanceInput): ProfileProvenance {
  if (typeof input.capturedAt !== 'string') {
    throw new Error(
      'buildProfileProvenance: capturedAt must be a caller-supplied ISO string. ' +
        'The builder never reads the clock, because a record that stamps itself ' +
        'cannot be compared byte for byte against another copy of the same sample.',
    );
  }
  for (const s of input.sources) {
    if (typeof s.layerId !== 'string' || s.layerId === '') {
      throw new Error(
        `buildProfileProvenance: source in slot ${String(s.slot)} has no stable layer id. ` +
          'A display name is not identity; recording one under a blank id would lose ' +
          'the layer the moment it is renamed.',
      );
    }
  }

  // Count per slot in one pass. The array is read, never referenced.
  const perSlot = new Map<number, number>();
  const total = countBySlot(input.accepted, perSlot);

  const sources: ProfileProvenanceSource[] = input.sources.map((s) => {
    const acceptedCount = perSlot.get(s.slot) ?? 0;
    return {
      layerId: s.layerId,
      displayName: typeof s.displayName === 'string' ? s.displayName : '',
      classification: s.classification,
      streaming: s.streaming === true,
      acceptedCount,
      contributed: acceptedCount > 0,
      residency:
        s.streaming === true && s.coverage != null ? streamingIsComplete(s.coverage) : null,
      ...(s.streaming !== true && s.truncation && s.truncation.read < s.truncation.declared
        ? { truncation: { read: s.truncation.read, declared: s.truncation.declared } }
        : {}),
    };
  });
  // Stable order: by layer id, then by accepted count, so the bytes do not
  // depend on which order the host happened to list its layers in.
  sources.sort((a, b) => compareIds(a.layerId, b.layerId) || a.acceptedCount - b.acceptedCount);

  const contributing = sources.filter((s) => s.contributed);
  const staticSourceCount = contributing.filter((s) => !s.streaming).length;
  const streamingSourceCount = contributing.length - staticSourceCount;
  const scope = resolveSectionScope({ staticSourceCount, streamingSourceCount });

  return {
    recordVersion: PROFILE_PROVENANCE_VERSION,
    method: typeof input.method === 'string' && input.method !== ''
      ? input.method
      : PROFILE_METHOD_CORRIDOR_PERCENTILE,
    corridorVersion: Number.isFinite(input.corridorVersion as number)
      ? (input.corridorVersion as number)
      : PROFILE_CORRIDOR_VERSION,
    capturedAt: input.capturedAt,
    up: normaliseUp(input.up),
    upDegenerate: isDegenerateUp(input.up),
    sources,
    acceptedCount: total,
    scope,
    residentOnly: scope === 'resident-snapshot',
    complete: resolveCompleteness(scope, contributing),
    classPolicy: {
      excludedClasses: sortedClassCodes(input.excludedClasses),
      // Over the CONTRIBUTING sources: a source that reached nothing filtered
      // nothing. Vacuously true over an empty read would be a claim about a
      // read that did not happen.
      availableOnEverySource:
        contributing.length > 0 && contributing.every((s) => s.classification !== 'absent'),
    },
    units: {
      linearUnit: input.units.linearUnit,
      verticalReference: input.units.verticalReference,
      verticalMetresPerUnit:
        typeof input.units.verticalMetresPerUnit === 'number' &&
        Number.isFinite(input.units.verticalMetresPerUnit)
          ? input.units.verticalMetresPerUnit
          : null,
    },
    ...(input.reduction
      ? {
          reduction: {
            mode: input.reduction.mode,
            resident: input.reduction.resident,
            declared: input.reduction.declared,
          },
        }
      : {}),
  };
}

/**
 * Canonical, key-sorted serialisation. Byte-identical for the same record.
 *
 * Shares `canonicalize` with the report manifest so the two cannot disagree
 * about what "the same document" means.
 */
export function serializeProfileProvenance(record: ProfileProvenance): string {
  return canonicalize(record);
}

/**
 * The record's source identity: the contributing layers, by stable id, in
 * order, with nothing user-editable in it.
 *
 * Renaming a layer does not change this. Reading a different layer does.
 */
export function profileProvenanceIdentity(record: ProfileProvenance): string {
  return JSON.stringify(record.sources.filter((s) => s.contributed).map((s) => s.layerId));
}

/**
 * The sentence a panel can show for a record's coverage.
 *
 * A resident-only read whose residency is unknown says so, rather than
 * implying either answer.
 */
export function describeProfileProvenance(
  record: ProfileProvenance,
  reduction: SourceReduction | undefined = record.reduction,
): string {
  if (record.scope === 'empty') return 'No source read';
  // A reduced static source is not "the full source": the sample basis takes
  // the place of that phrase, and "complete read" is dropped because the read
  // was complete only over the sample.
  if (reduction && record.scope === 'full-static-source') {
    return `${describeSampleBasis(reduction)}, ${describeClassBasis(record.classPolicy.availableOnEverySource)}`;
  }
  const base = record.residentOnly
    ? 'Resident snapshot'
    : record.scope === 'mixed-full-and-resident'
      ? 'Mixed static and resident sources'
      : record.sources.some((s) => s.contributed && s.truncation != null)
        ? 'Truncated static source'
        : 'Full static source';
  const coverage =
    record.complete === true
      ? 'complete read'
      : record.complete === false
        ? 'incomplete read'
        : 'coverage unknown';
  return `${base}, ${coverage}, ${describeClassBasis(record.classPolicy.availableOnEverySource)}`;
}

/** An integer with thousands separators, the form every count on a profile surface prints in. */
export function formatCount(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : String(n);
}

/**
 * What the loaded cloud is, when it is a reduction of the file rather than
 * the file: "Display sample of 1,912,920 points (voxel centroids), 10,789,680
 * declared". The wording the volume caveat uses for the same facts.
 */
export function describeSampleBasis(r: SourceReduction): string {
  if (r.reducedSources !== undefined && r.totalSources !== undefined) {
    const n = r.reducedSources;
    return (
      `Includes ${formatCount(n)} reduced ${n === 1 ? 'source' : 'sources'} of ${formatCount(r.totalSources)} ` +
      `(${formatCount(r.resident)} of ${formatCount(r.declared)} declared points held in ${n === 1 ? 'it' : 'them'}, ` +
      `${r.mode === 'voxel-centroids' ? 'voxel centroids' : 'strided'})`
    );
  }
  return r.mode === 'voxel-centroids'
    ? `Display sample of ${formatCount(r.resident)} points (voxel centroids), ${formatCount(r.declared)} declared`
    : `Strided sample of ${formatCount(r.resident)} of ${formatCount(r.declared)} declared points`;
}

/**
 * What a reduced sample means for the heights read off it. A centroid carries
 * no flags and the class of its first member only, so a voxel sample cannot
 * exclude Withheld or noise points; a stride keeps whole records.
 */
export function describeSampleCaveat(r: SourceReduction): string {
  return r.mode === 'voxel-centroids'
    ? 'Percentiles are over the sample, not the file\'s returns; Withheld and noise points cannot be excluded.'
    : 'Percentiles are over the sample, not every return in the file.';
}

/** {@link describeWithheldRead} with separators, and the sample basis when the cloud was reduced. */
export function describeProfilePointsRead(c: WithheldReadCounts, includeBasis = true): string {
  const excluded =
    c.withheldExcluded === 'unknown'
      ? 'unknown (no flags on a source)'
      : formatCount(c.withheldExcluded);
  const read = `${formatCount(c.analysedPoints)} of ${formatCount(c.sourcePoints)} analysed; Withheld excluded: ${excluded}`;
  return c.reduction && includeBasis ? `${describeSampleBasis(c.reduction)}; ${read}` : read;
}

/**
 * The sheet's points note. The points-read statement is always there, with
 * its method tag; a reduced cloud adds the sample basis beside it. For voxel
 * centroids the read statement says Withheld excluded is unknown, because a
 * centroid has no flags; a stride keeps flags and reports the count.
 */
export function describeSampleNote(
  withheld: WithheldReadCounts | null,
  reduction: SourceReduction | undefined,
  method: string | null,
): string {
  const points = withheld
    ? `Points: ${describeProfilePointsRead(withheld, false)} (${method ?? 'method not recorded'}).`
    : 'Points: Withheld handling not recorded; sampled before Withheld points were excluded.';
  return reduction
    ? `${points} Sample basis: ${describeSampleBasis(reduction)}. ${describeSampleCaveat(reduction)}`
    : points;
}

/**
 * The clause naming what the class-exclusion policy could actually act on.
 *
 * Both the exported sheet and the on-screen workbench state this, from here,
 * because a reader who is told the basis on paper and not on screen has to
 * export a PDF to learn how the heights in front of them were chosen.
 */
export function describeClassBasis(availableOnEverySource: boolean): string {
  return availableOnEverySource
    ? 'classification on every source'
    : 'classification missing on a source';
}

/**
 * What a missing classification means for the figures read off the surface.
 *
 * Vegetation and buildings are dropped before the percentile only where a
 * source classifies them. Without that, the percentile still runs, over every
 * return: on open ground it lands near the surface, and under canopy it lands
 * in the canopy. Grade is a difference between two such heights, so it
 * inherits whatever the surface followed.
 */
export const GROUND_BASIS_UNVERIFIED_NOTE =
  'Heights here are a percentile of every return, because a source carries no ' +
  'classification. Where vegetation hides the ground the surface follows the ' +
  'canopy, and the grades follow it too.';

// --- internals ---------------------------------------------------------------

/**
 * Tally accepted returns per source slot, returning the total.
 *
 * `count` bounds the walk rather than the array's own length, so an
 * over-allocated buffer cannot inflate the tally. Nothing is retained.
 */
function countBySlot(accepted: ProfileAcceptedCounts, out: Map<number, number>): number {
  const slots = accepted.sourceSlot;
  const declared = Number.isFinite(accepted.count) ? Math.max(0, Math.floor(accepted.count)) : 0;
  const n = Math.min(declared, slots.length);
  for (let i = 0; i < n; i++) {
    const slot = slots[i]!;
    out.set(slot, (out.get(slot) ?? 0) + 1);
  }
  return n;
}

/**
 * Whether the read can claim to have seen everything.
 *
 * A provable gap outranks an unknown: "incomplete" is the stronger and safer
 * statement, and neither ever resolves to `true` on its own.
 */
function resolveCompleteness(
  scope: ProfileSectionScope,
  contributing: readonly ProfileProvenanceSource[],
): boolean | null {
  if (scope === 'empty') return null;
  // A truncated static source is a partial read, whatever the stream did.
  if (contributing.some((s) => s.truncation != null)) return false;
  const streaming = contributing.filter((s) => s.streaming);
  if (streaming.length === 0) return true;
  if (streaming.some((s) => s.residency === false)) return false;
  if (streaming.some((s) => s.residency === null)) return null;
  return true;
}

/**
 * Normalise `up` the way `buildProfileFrame` does — `Math.hypot`, and the zero
 * vector for a zero length — with one deliberate addition: a non-finite input
 * records as the degenerate zero instead of NaN. JSON has no NaN, and a
 * component that serialises as `null` would read back as a different vector.
 * `upDegenerate` carries the fact either way.
 */
function normaliseUp(v: readonly [number, number, number]): readonly [number, number, number] {
  const x = v[0];
  const y = v[1];
  const z = v[2];
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return [0, 0, 0];
  const len = Math.hypot(x, y, z);
  if (len === 0) return [0, 0, 0];
  return [x / len, y / len, z / len];
}

function isDegenerateUp(v: readonly [number, number, number]): boolean {
  const u = normaliseUp(v);
  return u[0] === 0 && u[1] === 0 && u[2] === 0;
}

/** Sorted, deduplicated, integral ASPRS codes in 0..255. Anything else drops. */
function sortedClassCodes(codes: readonly unknown[]): readonly number[] {
  const seen = new Set<number>();
  for (const c of codes) {
    if (typeof c !== 'number' || !Number.isInteger(c) || c < 0 || c > 255) continue;
    seen.add(c);
  }
  return Array.from(seen).sort((a, b) => a - b);
}

/** Code-unit compare, so the order does not vary with locale. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
