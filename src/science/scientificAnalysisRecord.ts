/**
 * scientificAnalysisRecord.ts — the canonical, schema-versioned record of one
 * scientific analysis run.
 *
 * Today each output path (contour GeoJSON, DEM README, terrain PDF, the panel)
 * reconstructs provenance in its own shape. That lets the same run describe
 * itself slightly differently in different places and makes it impossible to say
 * "these two artifacts came from the identical analysis". This record is the one
 * structure they can all derive from: it composes the build identity (which
 * build), the CRS honesty (what units, known or not), the registered methods
 * (which algorithms at which version), the evidence-gate verdict, and a flat
 * result summary — plus a content fingerprint that is stable across builds so
 * the same analysis of the same data hashes identically.
 *
 * This is the FOUNDATION plus its first consumer (export provenance). Making
 * every output path derive strictly from this record is a later, separate step;
 * this module does not yet replace those paths, it gives them one thing to agree
 * on.
 *
 * Pure data: no DOM, no three.js, no I/O.
 */

import type { BuildIdentity } from '../build/buildIdentity';
import { BUILD_IDENTITY } from '../build/buildIdentity';
import { methodRef, methodTag, type MethodRef } from './methodRegistry';
import { canonicalJson, fnv1a } from '../canonicalHash';

/** The schema version of {@link ScientificAnalysisRecord}. Bump on shape change. */
export const SCIENTIFIC_RECORD_SCHEMA = 1;

/** CRS honesty, carried verbatim so a record can never imply a unit it lacks. */
export interface ScientificRecordCrs {
  /** Horizontal CRS name, or the literal 'not georeferenced'. */
  readonly horizontal: string;
  readonly horizontalKnown: boolean;
  /** Vertical datum, or the literal 'unknown'. */
  readonly verticalDatum: string;
  readonly verticalDatumKnown: boolean;
  /**
   * Linear unit token ('metre' | 'foot' | 'us-survey-foot' | 'unknown') when the
   * producing layer resolved one. OMITTED (not 'unknown') when the layer did not
   * carry the token — omission means "not resolved here", which is distinct from
   * a CRS that genuinely declares an unknown unit. A record never fabricates a
   * unit it did not receive.
   */
  readonly linearUnit?: string;
}

/** A flat, JSON-safe summary of the run's headline results. */
export type ScientificRecordSummary = Readonly<
  Record<string, string | number | boolean | null>
>;

/** The canonical record of one analysis run. */
export interface ScientificAnalysisRecord {
  readonly schemaVersion: number;
  /** What was analysed, e.g. 'terrain-dtm'. */
  readonly kind: string;
  /** The build that produced it (PR1 build identity). */
  readonly build: BuildIdentity;
  /** ISO 8601 generation timestamp. */
  readonly generatedAt: string;
  /** Source scan basename, or null. */
  readonly source: string | null;
  readonly crs: ScientificRecordCrs;
  /** The registered methods that produced this analysis, at their versions. */
  readonly methods: ReadonlyArray<MethodRef>;
  /** True when the evidence gate marks every product of this run exploratory. */
  readonly evidenceExploratory: boolean;
  readonly summary: ScientificRecordSummary;
  /**
   * A non-cryptographic content fingerprint (FNV-1a) over the SCIENTIFIC
   * content — kind, CRS, method tags, evidence flag, summary — and NOT the build
   * time or generation timestamp. So the same analysis of the same data
   * fingerprints identically across builds and runs. It identifies an analysis;
   * it is not a tamper-proof digest.
   */
  readonly contentHash: string;
}

/** Inputs for {@link buildScientificAnalysisRecord}. */
export interface ScientificAnalysisRecordInput {
  readonly kind: string;
  readonly source?: string | null;
  readonly crs: ScientificRecordCrs;
  /** Method ids (validated against the registry; unknown ids throw). */
  readonly methodIds: ReadonlyArray<string>;
  readonly evidenceExploratory: boolean;
  readonly summary: ScientificRecordSummary;
  /** Generation timestamp — Date or ISO string. Default now. */
  readonly generatedAt?: Date | string | null;
  /** Build identity. Default the stamped {@link BUILD_IDENTITY}. */
  readonly build?: BuildIdentity;
}

function toIso(at: Date | string | null | undefined): string {
  if (at instanceof Date) return at.toISOString();
  if (typeof at === 'string' && at.length > 0) return at;
  return new Date().toISOString();
}

/**
 * Build the canonical record. Every method id is resolved against the registry
 * (an unknown id throws — a record must not reference a method the registry does
 * not define), and the content fingerprint excludes the build time / generation
 * timestamp so it is stable across builds.
 */
export function buildScientificAnalysisRecord(
  input: ScientificAnalysisRecordInput,
): ScientificAnalysisRecord {
  const methods = input.methodIds.map(methodRef);
  // The fingerprint covers the scientific content only — not build/time.
  const fingerprintInput = {
    schemaVersion: SCIENTIFIC_RECORD_SCHEMA,
    kind: input.kind,
    crs: input.crs,
    methods: methods.map(methodTag),
    evidenceExploratory: input.evidenceExploratory,
    summary: input.summary,
  };
  return {
    schemaVersion: SCIENTIFIC_RECORD_SCHEMA,
    kind: input.kind,
    build: input.build ?? BUILD_IDENTITY,
    generatedAt: toIso(input.generatedAt),
    source: input.source ?? null,
    crs: input.crs,
    methods,
    evidenceExploratory: input.evidenceExploratory,
    summary: input.summary,
    contentHash: fnv1a(canonicalJson(fingerprintInput)),
  };
}

/** JSON-friendly form for embedding in an export's metadata. */
export function scientificRecordJson(
  record: ScientificAnalysisRecord,
): Record<string, unknown> {
  return {
    schemaVersion: record.schemaVersion,
    kind: record.kind,
    generatedAt: record.generatedAt,
    source: record.source,
    build: `${record.build.version} (${record.build.commit}${record.build.dirty ? '+dirty' : ''})`,
    crs: { ...record.crs },
    methods: record.methods.map(methodTag),
    evidenceExploratory: record.evidenceExploratory,
    summary: { ...record.summary },
    contentHash: record.contentHash,
  };
}
