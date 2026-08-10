/**
 * dualCompleteness.ts — a small DERIVED view over existing authoritative facts.
 *
 * OLV already decides subject (coverage) and support (evidence) completeness
 * inside `processCapabilities`; this does not replace or recompute either. It
 * only NAMES the two dimensions so the "strongest claim needs both" rule is
 * explicit and testable:
 *
 *   subjectComplete — the product's subject dataset is fully present
 *                     (full coverage, not resident-only / sampled).
 *   supportComplete — the support/evidence for a VALIDATED product is present
 *                     (trusted producer ground AND a confirmed linear unit).
 *
 * Derived, not authoritative: both fields are read straight off {@link ScanFacts},
 * the same facts the capability evaluator reads. Pure — no I/O, no point data.
 */

import type { ScanFacts } from './ProcessPlan';
import { isLinearUnitKnown } from '../geo/CoordinateTypes';

export interface DualCompleteness {
  readonly subjectComplete: boolean;
  readonly supportComplete: boolean;
}

/** Derive the two completeness dimensions from a scan's existing facts. */
export function dualCompletenessOf(scan: ScanFacts): DualCompleteness {
  return {
    subjectComplete: scan.coverage === 'full',
    supportComplete: scan.groundClassified && isLinearUnitKnown(scan.crs),
  };
}

/**
 * The strongest (validated, full-scope) claim requires BOTH completeness
 * dimensions. A partial subject stays exploratory; incomplete support withholds
 * the strongest validation claim. Neither is forced to BLOCKED here — that
 * REVIEW/BLOCKED decision remains the capability evaluator's.
 */
export function permitsStrongestClaim(dc: DualCompleteness): boolean {
  return dc.subjectComplete && dc.supportComplete;
}
