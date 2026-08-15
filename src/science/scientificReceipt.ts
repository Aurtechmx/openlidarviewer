/**
 * scientificReceipt.ts — a portable, human-readable receipt for one analysis.
 *
 * A `ScientificAnalysisRecord` already holds what a run was: kind, build, CRS
 * honesty, registered methods, the evidence-gate verdict, a flat result summary,
 * and a content fingerprint. A receipt is that record rendered for a reader and
 * for embedding — the output alongside why the software believed it was allowed
 * to produce it: the evidence grade and, when a product was run through the
 * process gate, the authorization reason it was granted from.
 *
 * Pure: derives from the record, adds no state, reads no clock (the timestamp is
 * the record's own `generatedAt`). It can be shown, embedded in a PDF, written
 * to JSON, or carried in a project file.
 */

import type { ScientificAnalysisRecord } from './scientificAnalysisRecord';
import { methodTag } from './methodRegistry';
import { canonicalJson } from '../canonicalHash';

export interface ScientificReceipt {
  readonly kind: string;
  readonly source: string | null;
  readonly build: { readonly commit: string; readonly dirty: boolean };
  readonly crs: {
    readonly horizontal: string;
    readonly horizontalKnown: boolean;
    readonly verticalDatum: string;
    readonly verticalDatumKnown: boolean;
    readonly linearUnit: string | null;
  };
  /** Registered method tags, e.g. `terrain-core@3`. */
  readonly methods: readonly string[];
  /** 'exploratory' when the evidence gate marked the run exploratory, else 'validated'. */
  readonly evidenceGrade: 'exploratory' | 'validated';
  /** The process-gate reason a run was authorised from, when supplied. */
  readonly authorization: string | null;
  readonly summary: ScientificAnalysisRecord['summary'];
  /** The record's content fingerprint (FNV-1a; identifies, not tamper-proof). */
  readonly digest: string;
  readonly generatedAt: string;
}

export interface ReceiptOptions {
  /** The `ProductAuthorization.grantedFrom` reason code, when the run was gated. */
  readonly authorizationGrantedFrom?: string | null;
}

/** Build a receipt from a record (and optionally the authorization it ran under). */
export function buildScientificReceipt(
  record: ScientificAnalysisRecord,
  opts: ReceiptOptions = {},
): ScientificReceipt {
  return {
    kind: record.kind,
    source: record.source,
    build: { commit: record.build.commit, dirty: record.build.dirty },
    crs: {
      horizontal: record.crs.horizontal,
      horizontalKnown: record.crs.horizontalKnown,
      verticalDatum: record.crs.verticalDatum,
      verticalDatumKnown: record.crs.verticalDatumKnown,
      linearUnit: record.crs.linearUnit ?? null,
    },
    methods: record.methods.map(methodTag),
    evidenceGrade: record.evidenceExploratory ? 'exploratory' : 'validated',
    authorization: opts.authorizationGrantedFrom ?? null,
    summary: record.summary,
    digest: record.contentHash,
    generatedAt: record.generatedAt,
  };
}

/** Stable JSON serialisation (canonical key order, so equal receipts match byte for byte). */
export function receiptToJson(receipt: ScientificReceipt): string {
  return canonicalJson(receipt);
}

/** A fixed-order plain-text rendering for display or PDF embedding. */
export function renderReceiptText(receipt: ScientificReceipt): string {
  const lines: string[] = [];
  lines.push(receipt.kind);
  lines.push('─'.repeat(Math.max(12, receipt.kind.length)));
  lines.push(`Input        ${receipt.source ?? '(none)'}`);
  const unit = receipt.crs.linearUnit ? ` (${receipt.crs.linearUnit})` : '';
  lines.push(`CRS          ${receipt.crs.horizontal}${unit}${receipt.crs.horizontalKnown ? '' : ' [unconfirmed]'}`);
  lines.push(
    `Vertical     ${receipt.crs.verticalDatum}${receipt.crs.verticalDatumKnown ? '' : ' [unresolved]'}`,
  );
  lines.push(`Method       ${receipt.methods.join(', ') || '(none)'}`);
  for (const [k, v] of Object.entries(receipt.summary)) lines.push(`${k.padEnd(12)} ${String(v)}`);
  lines.push(`Evidence     ${receipt.evidenceGrade}`);
  if (receipt.authorization) lines.push(`Authorization ${receipt.authorization}`);
  lines.push(`Digest       ${receipt.digest}`);
  lines.push(`Build        ${receipt.build.commit}${receipt.build.dirty ? ' (dirty)' : ''}`);
  lines.push(`Generated    ${receipt.generatedAt}`);
  return lines.join('\n');
}
