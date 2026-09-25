/**
 * runRecord.ts — the record one Observatory evidence run leaves behind
 * (docs/observatory/SPEC.md §4 OB-INT-05, phase O7).
 *
 * Follows `src/simulation/simulationRunRecord.ts`'s own pattern (source,
 * basis, model id and version, input digest, SHA-256 over canonical JSON)
 * rather than paralleling it: `FieldSimulationKind` is a closed union for
 * `terrain-flow` / `terrain-access` / `scan-rescue` and does not name
 * Observatory's own kind of run, so this module is a sibling record type
 * built from the same primitives (`canonicalize`/`sha256` from
 * `render/measure/auditLog.ts`), not a cast into that union.
 *
 * ── WHAT THE DIGEST COVERS, AND WHY IT LEAVES THINGS OUT ────────────────────
 * Same reasoning as `simulationRunRecord.ts`: `id` and `generatedAt` are
 * excluded so re-running one saved configuration reproduces one digest
 * regardless of when it ran. The ledger's own `fieldDigest`
 * (`ledger.ts#computeFieldDigest`) already covers the domain, voxel edge,
 * per-source tau and the merged rows (OB-INV-07); this record's digest folds
 * that value in as one field among the classification parameters
 * (`p_solid`/`p_empty`/`n_min`), the state counts and the frontier summary,
 * so two records agree exactly when every canonical fact they cover agrees —
 * never when only the ledger's own sub-digest happens to match.
 *
 * OB-INV-06 ("no presentation parameter shall change a canonical byte") is
 * true of this record by construction: it has no field for pixel ratio,
 * colour range, overlay sampling or panel state, so no such value can enter
 * `digestibleObservationFields` in the first place.
 *
 * Pure: no DOM, no three.js, no I/O (OB-INT-01).
 */

import { canonicalize, sha256 } from '../render/measure/auditLog';
import type { ObservationDomain } from './ledger';
import type { ObservationParameters } from './types';
import type { ObservationStateCounts } from './observationField';

/** One participating station, as the record names it — never a second copy of the point data. */
export interface ObservationRunStation {
  readonly id: string;
  readonly source: string;
  readonly originStatus: string;
  /** Float64 world position, exactly as declared (`docs/coordinate-precision.md`); never recentred or narrowed to Float32. */
  readonly worldTranslation: readonly [number, number, number];
  readonly sourceIndex: number;
  /** tau(r) = tauAbs + tauRel*r actually used for this station's rays (SPEC §2.1). */
  readonly tauAbs: number;
  readonly tauRel: number;
}

/** What the run read (SPEC §1.1's basis vocabulary, reused per the module header). */
export interface ObservationRunSource {
  readonly filename: string | null;
  readonly sourceDigest: string | null;
  /** `TerrainCoverageMode`-shaped ('full' | 'resident-only' | 'sampled'), carried as a plain string so this module stays import-free of `TerrainContracts`. */
  readonly basis: string;
  /** Metres per source linear unit, or `null` when unknown (OB-INV-10: every metric figure downstream is withheld when this is null). */
  readonly metresPerUnit: number | null;
}

/** The shadow-frontier summary folded into the record, without the full voxel-key list (kept in the export's own `frontier.csv`). */
export interface ObservationRunFrontierSummary {
  readonly frontierVoxelCount: number;
  readonly areaSquareMetres: number | null;
  readonly adjacentToShadowed: number;
  readonly adjacentToUnaddressed: number;
  readonly adjacentToNoReturnPath: number;
}

/** One completed Observatory evidence run. */
export interface ObservationRunRecord {
  readonly schemaVersion: 1;
  /** Unique per run. Not part of the digest. */
  readonly id: string;
  /** ISO 8601. Not part of the digest. */
  readonly generatedAt: string;
  readonly build: string;
  readonly source: ObservationRunSource;
  readonly domain: ObservationDomain;
  readonly voxelEdge: number;
  readonly stations: readonly ObservationRunStation[];
  readonly parameters: ObservationParameters;
  /** Registered method tags this run's stages ran under, in the order they ran (OB-INT-04). */
  readonly methods: readonly string[];
  /** `ledger.ts#computeFieldDigest`'s own digest over domain/voxelEdge/tau/stations/rows. */
  readonly fieldDigest: string;
  readonly stateCounts: ObservationStateCounts;
  readonly frontier: ObservationRunFrontierSummary | null;
  /** OB-LED-02 telemetry: rays discarded before a single voxel step. Not part of the digest (it is telemetry about the run, not evidence). */
  readonly rejectionRatio: number;
  readonly limitations: readonly string[];
  readonly processingManifestHead: string | null;
  readonly digest: string;
}

/** The fields the digest covers. Exported so a reader can see the omissions. */
export function digestibleObservationFields(
  record: Omit<ObservationRunRecord, 'digest' | 'id' | 'generatedAt' | 'rejectionRatio'>,
): Record<string, unknown> {
  return {
    schemaVersion: record.schemaVersion,
    build: record.build,
    source: record.source,
    domain: record.domain,
    voxelEdge: record.voxelEdge,
    stations: record.stations
      .map((s) => ({ ...s, worldTranslation: Array.from(s.worldTranslation) }))
      .slice()
      .sort((a, b) => a.sourceIndex - b.sourceIndex),
    parameters: record.parameters,
    methods: record.methods,
    fieldDigest: record.fieldDigest,
    stateCounts: record.stateCounts,
    frontier: record.frontier,
    limitations: record.limitations,
    processingManifestHead: record.processingManifestHead,
  };
}

/** SHA-256 over the reproducible fields, as lowercase hex. */
export function observationRunRecordDigest(
  record: Omit<ObservationRunRecord, 'digest' | 'id' | 'generatedAt' | 'rejectionRatio'> & { readonly rejectionRatio?: number },
): string {
  return sha256(canonicalize(digestibleObservationFields(record)));
}

/**
 * Seal a run into a record, computing its digest.
 *
 * Takes the record without its digest so the digest cannot be passed in and
 * quietly disagree with the content it claims to cover.
 */
export function sealObservationRunRecord(
  record: Omit<ObservationRunRecord, 'digest'>,
): ObservationRunRecord {
  return { ...record, digest: observationRunRecordDigest(record) };
}

/**
 * Whether two records describe the same computation. Compares digests, not
 * fields, so the answer follows exactly what re-running a saved
 * `.olv-observation.json` config would produce: two runs with different
 * `id`/`generatedAt` agree here whenever every canonical fact matches.
 */
export function sameObservationComputation(
  a: ObservationRunRecord,
  b: ObservationRunRecord,
): boolean {
  return a.digest === b.digest;
}

/** The parameter digest alone, matching `ObservationFreshnessStamp.parameterDigest` (`analysisFreshness.ts`). */
export function observationParameterDigest(parameters: ObservationParameters): string {
  return sha256(canonicalize(parameters));
}

/** The declared ROI digest, matching `ObservationFreshnessStamp.roiDigest`. */
export function observationRoiDigest(domain: ObservationDomain): string {
  return sha256(canonicalize({ min: Array.from(domain.min), max: Array.from(domain.max) }));
}

/** The station-set digest, matching `ObservationFreshnessStamp.stationSetDigest`. */
export function observationStationSetDigest(stations: readonly ObservationRunStation[]): string {
  const sorted = stations
    .map((s) => ({ id: s.id, source: s.source, originStatus: s.originStatus, worldTranslation: Array.from(s.worldTranslation) }))
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sha256(canonicalize(sorted));
}

/** Reproducible `.olv-observation.json` config: re-running it over the same source reproduces `fieldDigest` and this record's own `digest`. */
export function buildObservationConfig(record: ObservationRunRecord): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'observation',
    domain: { min: Array.from(record.domain.min), max: Array.from(record.domain.max) },
    voxelEdge: record.voxelEdge,
    parameters: record.parameters,
    stations: record.stations.map((s) => ({ id: s.id, sourceIndex: s.sourceIndex, tauAbs: s.tauAbs, tauRel: s.tauRel })),
  };
}
