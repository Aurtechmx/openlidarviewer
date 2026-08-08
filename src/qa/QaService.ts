/**
 * QaService.ts — product-specific QA gating (Phase 2).
 *
 * Wraps the independent `runQaChecks` diagnostics and answers, per product,
 * whether QA permits it — reading only the checks that actually bear on that
 * product. The point is independence: a failed terrain-readiness check must NOT
 * block an unrelated classification export, and vice versa. There is still no
 * global score; `gateFor` names the specific checks that block a given product.
 * Pure and side-effect-free.
 */

import type { ScanFacts, ProductId } from '../process/ProcessPlan';
import { runQaChecks, worstStatus, type QaCheck, type QaStatus } from './qaChecks';

/** Which QA check ids bear on each product. Absent products depend on the base set. */
const BASE_CHECKS = ['FILE_INTEGRITY', 'SPATIAL_REFERENCE'] as const;
const PRODUCT_CHECKS: Partial<Record<ProductId, readonly string[]>> = {
  'classify-gaps': ['FILE_INTEGRITY', 'CLOUD_QUALITY'], // classification does not need a CRS or ground
  dtm: ['FILE_INTEGRITY', 'SPATIAL_REFERENCE', 'COVERAGE', 'TERRAIN_READINESS'],
  dsm: ['FILE_INTEGRITY', 'SPATIAL_REFERENCE', 'COVERAGE'],
  contours: ['FILE_INTEGRITY', 'SPATIAL_REFERENCE', 'COVERAGE', 'TERRAIN_READINESS'],
  'building-footprints': ['FILE_INTEGRITY', 'SPATIAL_REFERENCE', 'CLASSIFICATION'],
  'cross-epoch-change': ['FILE_INTEGRITY', 'SPATIAL_REFERENCE', 'COVERAGE'],
  'volume-cut-fill': ['FILE_INTEGRITY', 'SPATIAL_REFERENCE', 'COVERAGE'],
};

export interface ProductQaGate {
  readonly product: ProductId;
  /** True when no relevant check BLOCKS the product (review is allowed). */
  readonly allowed: boolean;
  /** The relevant checks, and specifically those blocking it. */
  readonly relevant: readonly QaCheck[];
  readonly blocking: readonly QaCheck[];
}

export class QaService {
  private readonly _checks: QaCheck[];

  private constructor(checks: QaCheck[]) {
    this._checks = checks;
  }

  static forFacts(facts: ScanFacts): QaService {
    return new QaService(runQaChecks(facts));
  }

  /** All independent checks, in stable order. */
  checks(): readonly QaCheck[] {
    return this._checks;
  }

  /** Severity headline across all checks — a banner signal, not a score. */
  worst(): QaStatus {
    return worstStatus(this._checks);
  }

  /**
   * QA's verdict for one product, over ONLY the checks that bear on it. A block
   * on an unrelated axis (e.g. terrain readiness for a classification export)
   * never appears here, so products fail independently.
   */
  gateFor(product: ProductId): ProductQaGate {
    const ids = PRODUCT_CHECKS[product] ?? BASE_CHECKS;
    const relevant = this._checks.filter((c) => ids.includes(c.id));
    const blocking = relevant.filter((c) => c.status === 'block');
    return { product, allowed: blocking.length === 0, relevant, blocking };
  }
}
