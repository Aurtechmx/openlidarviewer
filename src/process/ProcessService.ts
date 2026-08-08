/**
 * ProcessService.ts — the single source of product eligibility (Phase 1).
 *
 * The capability maths already live in `processCapabilities.evaluateCapabilities`
 * (pure). This is the thin, stateless surface the shell and the exporters both
 * read, so eligibility is decided in exactly one place: no button re-derives
 * "can I export a DTM?" on its own. It composes the fail-closed scan-facts
 * normaliser with the evaluator and exposes per-product lookups plus a readiness
 * roll-up. No live objects, no side effects.
 */

import type { ProcessPlan, ProductCapability, ProductId, Readiness, ScanFacts } from './ProcessPlan';
import { evaluateCapabilities, capabilityFor } from './processCapabilities';
import { deriveScanFacts, type RawScanSignals } from './scanFacts';

export interface ProcessReadinessSummary {
  readonly ready: number;
  readonly review: number;
  readonly blocked: number;
  /** True when at least one product is ready to export as a validated artifact. */
  readonly anyReady: boolean;
}

export class ProcessService {
  private readonly _plan: ProcessPlan;

  private constructor(plan: ProcessPlan) {
    this._plan = plan;
  }

  /** Build from already-normalised scan facts (e.g. tests, worker payloads). */
  static fromFacts(scans: readonly ScanFacts[], projectFrameCompatible?: boolean): ProcessService {
    return new ProcessService(evaluateCapabilities({ scans, projectFrameCompatible }));
  }

  /** Build from loose shell signals; each is normalised fail-closed first. */
  static fromSignals(raw: readonly RawScanSignals[], projectFrameCompatible?: boolean): ProcessService {
    return ProcessService.fromFacts(raw.map(deriveScanFacts), projectFrameCompatible);
  }

  /** The full capability plan. */
  get plan(): ProcessPlan {
    return this._plan;
  }

  /** One product's capability, or undefined if the model does not carry it. */
  capability(product: ProductId): ProductCapability | undefined {
    return capabilityFor(this._plan, product);
  }

  /** A product's readiness, defaulting to `blocked` for an unknown product. */
  readiness(product: ProductId): Readiness {
    return this.capability(product)?.readiness ?? 'blocked';
  }

  /** True only when the product is `ready` — the gate an exporter should use. */
  isReady(product: ProductId): boolean {
    return this.readiness(product) === 'ready';
  }

  /** Count products by readiness. */
  summary(): ProcessReadinessSummary {
    let ready = 0, review = 0, blocked = 0;
    for (const p of this._plan.products) {
      if (p.readiness === 'ready') ready++;
      else if (p.readiness === 'review') review++;
      else blocked++;
    }
    return { ready, review, blocked, anyReady: ready > 0 };
  }
}
