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

/**
 * An unforgeable "you may produce this product" token. Issued ONLY by
 * {@link ProcessService.authorize} and only when the product is `ready`, and it
 * carries the reason code it was granted from. A run seam that demands this
 * token cannot be reached with a blocked or review-only product, so a caller
 * cannot skip the eligibility check the way a bare `isReady()` boolean allows.
 * There is no public constructor — the type name is exported, its values are
 * not.
 */
export interface ProductAuthorization {
  readonly product: ProductId;
  /** The `ready`-verdict reason code this authorization was granted from. */
  readonly grantedFrom: string;
  /** Brand so an authorization cannot be structurally forged by a plain object. */
  readonly __brand: 'process-authorization';
}

/** The result of a guarded run: the executor's value, or the refusal verdict. */
export type AuthorizedRun<T> =
  | { readonly authorized: true; readonly value: T }
  | {
      readonly authorized: false;
      readonly product: ProductId;
      readonly readiness: Readiness;
      readonly reasonCode: string;
      readonly reason: string;
    };

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

  /**
   * Issue an authorization token for a product, or `null` when it is not
   * `ready`. The token is the capability an execution path requires (see
   * {@link runIfAuthorized}); withholding it on a blocked/review product is the
   * fail-closed default. The token freezes the reason code the grant rested on,
   * so an audit trail can show WHY production was permitted.
   */
  authorize(product: ProductId): ProductAuthorization | null {
    const cap = this.capability(product);
    if (cap == null || cap.readiness !== 'ready') return null;
    return { product, grantedFrom: cap.reasonCode, __brand: 'process-authorization' };
  }

  /**
   * Run `executor` ONLY when the product is authorized (`ready`), handing it the
   * authorization token as proof. When the product is not ready the executor is
   * never invoked and the plan's refusal verdict is returned instead — so a
   * blocked or review-only product cannot be produced by routing through this
   * seam, no matter what the caller intended. This is the unforgeable version of
   * "check isReady, then export": the check and the action are one call.
   */
  runIfAuthorized<T>(product: ProductId, executor: (auth: ProductAuthorization) => T): AuthorizedRun<T> {
    const auth = this.authorize(product);
    if (auth == null) {
      const cap = this.capability(product);
      return {
        authorized: false,
        product,
        readiness: cap?.readiness ?? 'blocked',
        reasonCode: cap?.reasonCode ?? 'UNKNOWN_PRODUCT',
        reason: cap?.reason ?? `No capability verdict exists for ${product}.`,
      };
    }
    return { authorized: true, value: executor(auth) };
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
