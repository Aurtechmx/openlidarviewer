/**
 * simulationRunRecord.ts — the record a simulation run leaves behind.
 *
 * One schema for every field simulation, so a reader learns the shape once and
 * a later tool can compare a flow run against a terrain-access run without
 * special-casing either.
 *
 * ── WHAT THE DIGEST COVERS, AND WHY IT LEAVES THINGS OUT ────────────────────
 * The digest answers one question: would this run, on this input, with these
 * parameters, produce this result again. So it covers the kind, the model and
 * its version, the parameters, the input identity and basis, and the result.
 *
 * It deliberately excludes `id` and `generatedAt`. Both change on every run
 * while nothing about the science does, and a digest that changed with the
 * clock could never show that two runs agree. That is the whole use of it:
 * re-running a saved configuration and getting the same digest is what
 * reproducibility means here. Including the timestamp would turn the digest
 * into a serial number.
 *
 * ── SHA-256, NOT THE 32-BIT FINGERPRINT ─────────────────────────────────────
 * `canonicalHash` in `src/canonicalHash.ts` is FNV-1a over 32 bits, which is
 * the right tool for a cache key and the wrong one for a persisted scientific
 * identity: collisions become likely in the tens of thousands of values, and
 * this identity is meant to be quoted in an export and compared later. The
 * hash and the canonical serialisation here are the ones the processing
 * manifest and the DTM descriptor already use, so one record cannot disagree
 * with another about what canonical means.
 *
 * Pure: no DOM, no three.js, no I/O.
 */

import { canonicalize, sha256 } from '../render/measure/auditLog';
import type { SimulationInputBasis } from './simulationInputBasis';

/** Which simulation produced a record. */
export type FieldSimulationKind = 'terrain-flow' | 'terrain-access' | 'scan-rescue';

/** What the run read. */
export interface SimulationSource {
  /** The renderer's id for the layer, when one was involved. */
  readonly layerId: string | null;
  /** The source filename, for a reader who has the file. */
  readonly filename: string | null;
  /** Digest of the source as delivered, when one is known. */
  readonly sourceDigest: string | null;
  /** Digest of the exact input the model read, which is what reproduces. */
  readonly analysisInputDigest: string;
  /** How much of the source stood behind that input. */
  readonly basis: SimulationInputBasis;
}

/** The model that ran, at the version that ran. */
export interface SimulationModel {
  /** A registered method id, so the record hops to the registry. */
  readonly id: string;
  readonly version: number;
}

/** A completed run. */
export interface FieldSimulationRunRecord {
  readonly schemaVersion: 1;
  /** Unique per run. Not part of the digest. */
  readonly id: string;
  /** ISO 8601. Not part of the digest. */
  readonly generatedAt: string;
  /** The build that produced it. */
  readonly build: string;
  readonly kind: FieldSimulationKind;
  readonly source: SimulationSource;
  readonly model: SimulationModel;
  /** Every registered method the run used, in the order it used them. */
  readonly methods: readonly string[];
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly result: Readonly<Record<string, unknown>>;
  /** What the reader must be told, from the basis and from the model. */
  readonly limitations: readonly string[];
  /** Head of the processing manifest chain, when the run wrote one. */
  readonly processingManifestHead: string | null;
  /** SHA-256 over the reproducible fields. */
  readonly digest: string;
}

/** The fields the digest covers. Exported so a reader can see the omissions. */
export function digestibleFields(
  record: Omit<FieldSimulationRunRecord, 'digest'>,
): Record<string, unknown> {
  return {
    schemaVersion: record.schemaVersion,
    kind: record.kind,
    build: record.build,
    source: {
      layerId: record.source.layerId,
      filename: record.source.filename,
      sourceDigest: record.source.sourceDigest,
      analysisInputDigest: record.source.analysisInputDigest,
      basis: record.source.basis,
    },
    model: record.model,
    methods: record.methods,
    parameters: record.parameters,
    result: record.result,
    limitations: record.limitations,
    processingManifestHead: record.processingManifestHead,
  };
}

/** SHA-256 over the reproducible fields, as lowercase hex. */
export function runRecordDigest(record: Omit<FieldSimulationRunRecord, 'digest'>): string {
  return sha256(canonicalize(digestibleFields(record)));
}

/**
 * Seal a run into a record, computing its digest.
 *
 * Takes the record without its digest so the digest cannot be passed in and
 * quietly disagree with the content it claims to cover.
 */
export function sealRunRecord(
  record: Omit<FieldSimulationRunRecord, 'digest'>,
): FieldSimulationRunRecord {
  return { ...record, digest: runRecordDigest(record) };
}

/**
 * Whether two records describe the same computation.
 *
 * Compares digests rather than fields, so the answer follows the same rule
 * the exported figure does. Two runs of one saved configuration agree here
 * even though their ids and timestamps differ.
 */
export function sameComputation(
  a: FieldSimulationRunRecord,
  b: FieldSimulationRunRecord,
): boolean {
  return a.digest === b.digest;
}

/** The parameter digest alone, for a caller comparing configurations. */
export function parameterDigest(parameters: Readonly<Record<string, unknown>>): string {
  return sha256(canonicalize(parameters));
}
