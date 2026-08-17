/**
 * ProcessService.ts — the single source of product eligibility (Phase 1).
 *
 * The capability maths already live in `processCapabilities.evaluateCapabilities`
 * (pure). This is the thin, stateless surface the shell and the Process Studio
 * panel read for a product's coarse readiness (ready / review / blocked). It
 * composes the fail-closed scan-facts normaliser with the evaluator and exposes
 * per-product lookups plus a readiness roll-up. No live objects, no side effects.
 *
 * SCOPE. This is the readiness MODEL, not the export enforcement point. The file
 * exporters enforce `src/export/contourExportPermit.ts` — a finer, independent
 * decision that also reads launch state, evidence grade, and the precision
 * permit, and that intentionally allows a `cartographic-only` exploratory export
 * where this service reports `review`. The unforgeable {@link ProcessService.authorize}
 * / {@link ProcessService.runIfAuthorized} seam models a strict "produce only
 * when ready" policy; no product uses it in production yet, because every OLV
 * product supports a legitimate exploratory / review path that a hard ready-only
 * gate would wrongly block. Making one authorization backbone for both the
 * readiness model and the export permit is deferred design work.
 */

import type { ProcessPlan, ProductCapability, ProductId, Readiness, ScanFacts } from './ProcessPlan';
import { evaluateCapabilities, capabilityFor } from './processCapabilities';
import { deriveScanFacts, type RawScanSignals } from './scanFacts';
import { scientificStateSignature } from './scientificState';

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
  /**
   * The scientific-state signature this token was issued against (see
   * {@link scientificStateSignature}). A token whose signature no longer matches
   * the current service's is STALE: an authentic token issued for one state must
   * not be honoured after a scientifically-relevant change.
   */
  readonly stateSignature: string;
  /** Brand so an authorization cannot be structurally forged by a plain object. */
  readonly __brand: 'process-authorization';
}

/** Why an authorization was refused at the consumption boundary. */
export type AuthorizationRejection = 'NOT_AUTHENTIC' | 'WRONG_PRODUCT' | 'STALE_AUTHORIZATION';

/** The result of verifying a token against a live service. */
export type AuthorizationCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: AuthorizationRejection };

/**
 * Module-private registry of the tokens this service ACTUALLY issued. The
 * branded interface is compile-time only — structural typing lets any plain
 * object with a matching `__brand` string satisfy `ProductAuthorization` at
 * runtime, and a spread/clone of a real token is a new object that also
 * satisfies it. Runtime identity closes that: a WeakSet holds each issued token
 * BY REFERENCE, so a forged look-alike (never added) and a clone (a different
 * object) are both non-members. Local-only — no hashing, no crypto, no
 * point-data traversal; the WeakSet also lets a token be GC'd with its scope.
 */
const _issuedAuthorizations = new WeakSet<ProductAuthorization>();

/**
 * Whether `token` is an authorization this service genuinely issued — not a
 * structurally-forged or cloned look-alike — and, when `product` is given, that
 * it was issued for THAT product. A path that consumes an authorization as proof
 * of eligibility calls this instead of trusting the object's shape.
 */
export function isAuthenticAuthorization(
  token: unknown,
  product?: ProductId,
): token is ProductAuthorization {
  if (typeof token !== 'object' || token === null) return false;
  if (!_issuedAuthorizations.has(token as ProductAuthorization)) return false;
  return product === undefined || (token as ProductAuthorization).product === product;
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
  private readonly _stateSignature: string;

  private constructor(plan: ProcessPlan, stateSignature: string) {
    this._plan = plan;
    this._stateSignature = stateSignature;
  }

  /** Build from already-normalised scan facts (e.g. tests, worker payloads). */
  static fromFacts(scans: readonly ScanFacts[], projectFrameCompatible?: boolean): ProcessService {
    return new ProcessService(
      evaluateCapabilities({ scans, projectFrameCompatible }),
      scientificStateSignature(scans),
    );
  }

  /** The scientific-state signature every token this service issues is bound to. */
  get stateSignature(): string {
    return this._stateSignature;
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
    // Freeze so the returned token cannot be mutated in place, and register it
    // in the module-private WeakSet so {@link isAuthenticAuthorization} can tell
    // this genuine token from a structural forgery or a clone.
    const token: ProductAuthorization = Object.freeze({
      product,
      grantedFrom: cap.reasonCode,
      stateSignature: this._stateSignature,
      __brand: 'process-authorization' as const,
    });
    _issuedAuthorizations.add(token);
    return token;
  }

  /**
   * Verify a token at the consumption boundary against THIS live service:
   * authentic (genuinely issued, not forged/cloned) AND for the right product
   * AND bound to the current scientific state. A token that was authentic for an
   * earlier state fails `STALE_AUTHORIZATION` — an authentic token must not
   * survive a scientifically-relevant change. O(1): three field comparisons, no
   * point data. Order matters — authenticity is checked first so a forged object
   * can never reach the state comparison.
   */
  verifyAuthorization(token: unknown, product: ProductId): AuthorizationCheck {
    if (!isAuthenticAuthorization(token)) return { ok: false, reason: 'NOT_AUTHENTIC' };
    if (token.product !== product) return { ok: false, reason: 'WRONG_PRODUCT' };
    if (token.stateSignature !== this._stateSignature) return { ok: false, reason: 'STALE_AUTHORIZATION' };
    return { ok: true };
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
