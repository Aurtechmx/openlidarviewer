/**
 * scientificArtifactPassport.ts
 *
 * A self-verifying record that binds, in one canonical document, the whole
 * chain behind a single exported scientific product:
 *
 *     SOURCE bytes → methods + parameters → scientific result
 *                  → evidence decision → EXPORTED artifact bytes.
 *
 * The passport lets a later reader confirm that a file on disk is the exact
 * artifact this pipeline produced, from the source it names, by the methods it
 * lists, under the evidence grade it records — or find out precisely WHERE that
 * chain was broken.
 *
 * TAMPER-EVIDENT, NOT AUTHENTICATED. This is provenance, not a signature. There
 * is no private key, no certificate, and no authority: anyone can rebuild a
 * passport, so the passport proves nobody's identity and vouches for no one. It
 * proves only internal CONSISTENCY — that the recorded digests still recompute
 * over the bytes and records they claim to cover. It makes no claim of
 * authorship, and none of accuracy beyond the evidence level it records. A
 * reader who wants authenticity must obtain the passport over a trusted channel;
 * this module only tells them whether it, and the artifact it points at, still
 * hang together.
 *
 * Reuse, not reinvention. Every digest here is the repository's existing
 * synchronous SHA-256 (FIPS 180-4) — `sha256` over strings (render/measure) and
 * `sha256Hex` over bytes (terrain/export) — folded with the same `canonicalize`
 * the processing manifest and audit log already use. No second crypto is
 * introduced and no numerical result changes. The analysis record's own
 * `contentHash` is left exactly as it is (an FNV-1a fingerprint that IDENTIFIES
 * an analysis and is NOT tamper-proof); it rides along as `legacyContentHash`,
 * and the passport adds its OWN separate cryptographic fields beside it.
 *
 * Pure and worker-safe: no DOM, no three.js, no clock read of its own.
 */

import { canonicalize, sha256 } from '../render/measure/auditLog';
import { sha256Hex } from '../terrain/export/sha256';
import { methodRef, methodTag, type MethodRef } from './methodRegistry';
import type { ScientificAnalysisRecord } from './scientificAnalysisRecord';
import { verifyProcessingManifest, type ProcessingManifest } from './processingManifest';
import type { BuildIdentity } from '../build/buildIdentity';

export const SCIENTIFIC_ARTIFACT_PASSPORT_SCHEMA = 1;

/** Whether the whole-source digest was available when the passport was built. */
export type SourceDigestStatus = 'verified' | 'unavailable';

/** The source scan the artifact derives from. */
export interface PassportSource {
  /** Source basename, or null when not supplied. */
  readonly name: string | null;
  /**
   * The authoritative whole-source SHA-256 (the value produced by
   * `sourceContentDigestFromRange`), or null when it was not computed. NEVER
   * re-hashed here — a multi-gigabyte cloud is hashed once, upstream, and the
   * digest is passed in.
   */
  readonly sha256: string | null;
  readonly digestStatus: SourceDigestStatus;
}

/** The scientific analysis behind the artifact. */
export interface PassportAnalysis {
  readonly kind: string;
  /** SHA-256 over the analysis SCIENTIFIC content (kind, CRS, methods, evidence flag, summary). */
  readonly sha256: string;
  /** The record's own FNV-1a fingerprint, carried unchanged. Identifies; not tamper-proof. */
  readonly legacyContentHash?: string;
  /** A human-facing echo of the CRS for the reproducibility line (display only; not the identity). */
  readonly crs?: {
    readonly horizontal: string;
    readonly verticalDatum: string;
    readonly geoid: string | null;
  };
}

/** The processing chain that produced the analysis. */
export interface PassportProcessing {
  /** The manifest chain head (last op hash / envelope genesis). */
  readonly manifestHead: string;
  /** Whether the manifest verified intact at build time. */
  readonly verified: boolean;
}

/** The registered methods and their optional method digest. */
export interface PassportMethod {
  readonly ids: readonly string[];
  /** Optional method-code digest (e.g. dtmMethodDigest); null/absent when not available. */
  readonly methodDigest?: string | null;
}

/** The evidence resolution, recorded as-resolved by the caller (not re-resolved here). */
export interface PassportEvidence {
  readonly baseline: string | null;
  readonly effective: string | null;
  readonly resolutionState: string;
  readonly matchedStudy: string | null;
  readonly applicabilityVerdict: string;
}

/** The exported artifact bytes this passport certifies the provenance of. */
export interface PassportArtifact {
  readonly filename: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** The build identity that produced the artifact. */
export interface PassportBuild {
  readonly version: string;
  readonly commit: string;
  readonly dirty: boolean;
}

/** The complete, self-verifying provenance record. */
export interface ScientificArtifactPassport {
  readonly schemaVersion: number;
  /**
   * SHA-256 over the SCIENTIFIC IDENTITY only — source digest, analysis content
   * digest, registered method ids, method digest, and processing manifest head.
   * It EXCLUDES the filename, export format, generation clock, and artifact
   * bytes: the same DTM exported as GeoTIFF and as ASC shares one `scienceId`
   * but differs in `artifact.sha256`.
   */
  readonly scienceId: string;
  readonly source: PassportSource;
  readonly analysis: PassportAnalysis;
  readonly processing: PassportProcessing;
  readonly method: PassportMethod;
  readonly evidence: PassportEvidence;
  readonly artifact: PassportArtifact;
  readonly build: PassportBuild;
  /** SHA-256 over the canonical passport serialization WITHOUT this field. */
  readonly passportSha256: string;
}

/** Inputs for {@link buildScientificArtifactPassport}. */
export interface ScientificArtifactPassportInput {
  readonly source: { readonly name: string | null; readonly sha256: string | null };
  readonly analysis: ScientificAnalysisRecord;
  readonly processing: ProcessingManifest;
  /** Method ids; default the analysis record's own registered methods. */
  readonly methodIds?: readonly string[];
  /** Optional method-code digest; null when absent. */
  readonly methodDigest?: string | null;
  readonly evidence: PassportEvidence;
  readonly artifact: {
    readonly filename: string;
    readonly mediaType: string;
    readonly bytes: Uint8Array;
  };
  /** Geoid model name for the reproducibility line, when known. */
  readonly geoid?: string | null;
  /** Build identity; default the analysis record's build. */
  readonly build?: BuildIdentity;
}

/**
 * The canonical scientific-content object for a record — the SAME shape the
 * record fingerprints with FNV-1a, hashed here with SHA-256 so the passport
 * carries a cryptographic-strength analysis digest beside the legacy one.
 */
function analysisScientificContent(record: ScientificAnalysisRecord): Record<string, unknown> {
  return {
    schemaVersion: record.schemaVersion,
    kind: record.kind,
    crs: record.crs,
    methods: record.methods.map(methodTag),
    evidenceExploratory: record.evidenceExploratory,
    summary: record.summary,
  };
}

/** The canonical identity payload whose SHA-256 is the `scienceId`. */
function scienceIdentityPayload(fields: {
  readonly sourceSha256: string | null;
  readonly analysisSha256: string;
  readonly methodIds: readonly string[];
  readonly methodDigest: string | null;
  readonly manifestHead: string;
}): Record<string, unknown> {
  return {
    sourceSha256: fields.sourceSha256,
    analysisSha256: fields.analysisSha256,
    methodIds: [...fields.methodIds],
    methodDigest: fields.methodDigest,
    manifestHead: fields.manifestHead,
  };
}

/** The passport serialization the `passportSha256` covers (every field except itself). */
function passportBody(p: Omit<ScientificArtifactPassport, 'passportSha256'>): Record<string, unknown> {
  return {
    schemaVersion: p.schemaVersion,
    scienceId: p.scienceId,
    source: p.source,
    analysis: p.analysis,
    processing: p.processing,
    method: p.method,
    evidence: p.evidence,
    artifact: p.artifact,
    build: p.build,
  };
}

/**
 * Build the passport. Pure: every digest is recomputed from the inputs and no
 * clock is read. `scienceId` excludes filename, export format, generation time
 * and artifact bytes; `artifact.sha256` is over the exact exported bytes; and
 * `passportSha256` seals the whole document.
 */
export function buildScientificArtifactPassport(
  input: ScientificArtifactPassportInput,
): ScientificArtifactPassport {
  const record = input.analysis;
  const methodIds = input.methodIds ?? record.methods.map((m: MethodRef) => m.id);
  const methodDigest = input.methodDigest ?? null;
  const sourceSha = input.source.sha256;

  const analysisSha256 = sha256(canonicalize(analysisScientificContent(record)));
  const artifactSha256 = sha256Hex(input.artifact.bytes);
  const manifestHead = input.processing.head;

  const scienceId = sha256(
    canonicalize(
      scienceIdentityPayload({
        sourceSha256: sourceSha,
        analysisSha256,
        methodIds,
        methodDigest,
        manifestHead,
      }),
    ),
  );

  const build = input.build ?? record.build;

  const body: Omit<ScientificArtifactPassport, 'passportSha256'> = {
    schemaVersion: SCIENTIFIC_ARTIFACT_PASSPORT_SCHEMA,
    scienceId,
    source: {
      name: input.source.name,
      sha256: sourceSha,
      digestStatus: sourceSha != null ? 'verified' : 'unavailable',
    },
    analysis: {
      kind: record.kind,
      sha256: analysisSha256,
      legacyContentHash: record.contentHash,
      crs: {
        horizontal: record.crs.horizontal,
        verticalDatum: record.crs.verticalDatum,
        geoid: input.geoid ?? null,
      },
    },
    processing: {
      manifestHead,
      verified: verifyProcessingManifest(input.processing).ok,
    },
    method: { ids: [...methodIds], ...(methodDigest != null ? { methodDigest } : {}) },
    evidence: input.evidence,
    artifact: {
      filename: input.artifact.filename,
      mediaType: input.artifact.mediaType,
      bytes: input.artifact.bytes.length,
      sha256: artifactSha256,
    },
    build: { version: build.version, commit: build.commit, dirty: build.dirty },
  };

  return { ...body, passportSha256: sha256(canonicalize(passportBody(body))) };
}

/** The structured outcome of a passport verification. */
export type PassportVerificationState =
  | 'VERIFIED'
  | 'ARTIFACT_CHANGED'
  | 'SOURCE_CHANGED'
  | 'PROCESSING_MANIFEST_CHANGED'
  | 'ANALYSIS_CHANGED'
  | 'METHOD_MISMATCH'
  | 'EVIDENCE_MISMATCH'
  | 'PASSPORT_CORRUPT'
  | 'INCOMPLETE';

/**
 * Optional reference material for verification. Each field, when supplied, is
 * re-derived from the current source/methods/processing and compared against
 * what the passport recorded — which is what localizes a break to a precise
 * state. Omit them all to run the internal-consistency checks only.
 */
export interface PassportVerifyOptions {
  /** The exact artifact bytes on disk, to confirm `artifact.sha256`. */
  readonly artifactBytes?: Uint8Array;
  /** The source bytes, to confirm `source.sha256` (only when small enough to hash). */
  readonly sourceBytes?: Uint8Array;
  /** The current analysis record, to confirm `analysis.sha256`. */
  readonly analysis?: ScientificAnalysisRecord;
  /** The current registered method ids, to confirm method identity. */
  readonly methodIds?: readonly string[];
  /** The current method digest, to confirm method identity. */
  readonly methodDigest?: string | null;
  /** The current processing manifest, to confirm the chain head and integrity. */
  readonly processing?: ProcessingManifest;
  /** The current evidence resolution, to confirm the recorded decision. */
  readonly evidence?: PassportEvidence;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function structurallyComplete(p: ScientificArtifactPassport): boolean {
  return (
    p != null &&
    p.schemaVersion === SCIENTIFIC_ARTIFACT_PASSPORT_SCHEMA &&
    isNonEmptyString(p.scienceId) &&
    isNonEmptyString(p.passportSha256) &&
    p.source != null &&
    p.analysis != null &&
    isNonEmptyString(p.analysis.sha256) &&
    p.processing != null &&
    isNonEmptyString(p.processing.manifestHead) &&
    p.method != null &&
    Array.isArray(p.method.ids) &&
    p.evidence != null &&
    p.artifact != null &&
    isNonEmptyString(p.artifact.sha256) &&
    p.build != null
  );
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Recompute every digest the passport carries and report where — if anywhere —
 * the chain no longer holds. Returns a STRUCTURED state, not a boolean.
 *
 * The specific, reference-backed checks run first so a real break surfaces as
 * its precise cause; the internal `passportSha256` and `scienceId` recomputes
 * run last and catch any remaining edit (e.g. a mutated build field) as
 * `PASSPORT_CORRUPT`.
 */
export function verifyScientificArtifactPassport(
  passport: ScientificArtifactPassport,
  opts: PassportVerifyOptions = {},
): PassportVerificationState {
  if (!structurallyComplete(passport)) return 'INCOMPLETE';

  // Processing: recompute the chain head and re-verify the op chain.
  if (opts.processing) {
    const chain = verifyProcessingManifest(opts.processing);
    if (!chain.ok || opts.processing.head !== passport.processing.manifestHead) {
      return 'PROCESSING_MANIFEST_CHANGED';
    }
  }

  // Method identity: ids and digest must match what the passport registered.
  if (opts.methodIds !== undefined || opts.methodDigest !== undefined) {
    if (opts.methodIds !== undefined && !sameStringArray(opts.methodIds, passport.method.ids)) {
      return 'METHOD_MISMATCH';
    }
    if (
      opts.methodDigest !== undefined &&
      (opts.methodDigest ?? null) !== (passport.method.methodDigest ?? null)
    ) {
      return 'METHOD_MISMATCH';
    }
  }

  // Analysis content (covers CRS, methods, evidence flag, summary).
  if (opts.analysis) {
    const recomputed = sha256(canonicalize(analysisScientificContent(opts.analysis)));
    if (recomputed !== passport.analysis.sha256) return 'ANALYSIS_CHANGED';
  }

  // Evidence decision.
  if (opts.evidence) {
    const e = opts.evidence;
    const r = passport.evidence;
    if (
      e.baseline !== r.baseline ||
      e.effective !== r.effective ||
      e.resolutionState !== r.resolutionState ||
      e.matchedStudy !== r.matchedStudy ||
      e.applicabilityVerdict !== r.applicabilityVerdict
    ) {
      return 'EVIDENCE_MISMATCH';
    }
  }

  // Exported artifact bytes.
  if (opts.artifactBytes) {
    if (sha256Hex(opts.artifactBytes) !== passport.artifact.sha256) return 'ARTIFACT_CHANGED';
  }

  // Source bytes (only meaningful when a digest was recorded).
  if (opts.sourceBytes && passport.source.sha256 != null) {
    if (sha256Hex(opts.sourceBytes) !== passport.source.sha256) return 'SOURCE_CHANGED';
  }

  // Internal seal: any edited field the references above did not cover.
  const { passportSha256, ...rest } = passport;
  const recomputedSeal = sha256(canonicalize(passportBody(rest)));
  if (recomputedSeal !== passportSha256) return 'PASSPORT_CORRUPT';

  // Internal identity redundancy: the scienceId must recompute from the
  // passport's own recorded identity components.
  const recomputedId = sha256(
    canonicalize(
      scienceIdentityPayload({
        sourceSha256: passport.source.sha256,
        analysisSha256: passport.analysis.sha256,
        methodIds: passport.method.ids,
        methodDigest: passport.method.methodDigest ?? null,
        manifestHead: passport.processing.manifestHead,
      }),
    ),
  );
  if (recomputedId !== passport.scienceId) return 'PASSPORT_CORRUPT';

  return 'VERIFIED';
}

/**
 * One line a reader can copy to reproduce, or to cite, the artifact: build,
 * commit, the first 12 hex of the Science ID, registered method tags, the
 * effective evidence, CRS/datum and geoid — with the source digest appended
 * when one was recorded. The data half of the "copy reproducibility line"
 * action; wording is display-only and changes no digest.
 */
export function reproducibilityLine(passport: ScientificArtifactPassport): string {
  const methods = passport.method.ids
    .map((id) => {
      const ref = methodRef(id);
      return methodTag(ref);
    })
    .join(', ');
  const crs = passport.analysis.crs;
  const parts: string[] = [
    `${passport.build.version} (${passport.build.commit}${passport.build.dirty ? '+dirty' : ''})`,
    `Science ID ${passport.scienceId.slice(0, 12)}`,
    `methods ${methods || 'none'}`,
    `evidence ${passport.evidence.effective ?? 'unregistered'}`,
    `CRS ${crs?.horizontal ?? 'not georeferenced'} / ${crs?.verticalDatum ?? 'unknown'}`,
    `geoid ${crs?.geoid ?? 'none'}`,
  ];
  if (passport.source.sha256 != null) {
    parts.push(`source ${passport.source.sha256.slice(0, 12)}`);
  }
  return parts.join(' · ');
}
