/**
 * authorizationBenchmark.ts — a deterministic, frozen adversarial benchmark for
 * scientific-OUTPUT authorization (not numerical-algorithm mutation).
 *
 * Each case perturbs a fully-supported baseline and asks whether the existing
 * authorization machinery — {@link ProcessService.authorize} /
 * {@link runIfAuthorized} / {@link isAuthenticAuthorization} — correctly refuses
 * an unsupported output or admits a genuinely supported one. It CONSUMES the
 * existing capability decision; it never re-derives eligibility, so it cannot
 * drift from production policy.
 *
 * Three integrity metrics fall out (see {@link scoreAuthorizationBenchmark}):
 *   UOAR — Unsupported Output Authorization Rate  (adversarial cases wrongly authorized) → target 0
 *   ORR  — Over-Refusal Rate                      (valid controls wrongly refused)       → target ~0
 *   ATR  — Authorization Traceability Rate        (authorized outputs with provenance)   → target 1
 *
 * Pure: no DOM, no I/O, no point traversal.
 */

import type { CrsInfo } from '../io/crs';
import type { ProductId, ScanFacts } from '../process/ProcessPlan';
import {
  ProcessService,
  isAuthenticAuthorization,
  type ProductAuthorization,
} from '../process/ProcessService';

function crs(o: Partial<CrsInfo> = {}): CrsInfo {
  return { source: 'epsg', linearUnit: 'metre', linearUnitToMetres: 1, verticalDatum: 'NAVD88', verticalUnitToMetres: 1, ...o } as CrsInfo;
}

/** A fully-supported single scan: full coverage, known unit, trusted ground. */
const BASE: ScanFacts = {
  kind: 'static', coverage: 'full', crs: crs(), pointCount: 1_000_000,
  hasRgb: true, hasIntensity: true, hasGpsTime: true, hasReturnNumber: true, hasPointSourceId: false,
  classification: 'full', groundClassified: true, hasBuildingClass: true,
  classificationProvenance: 'producer', medianSpacing: 0.2,
};

type CaseKind = 'adversarial' | 'control';

/** What actually happened when the case tried to obtain an authorized output. */
export interface CaseOutcome {
  /** A genuine, service-issued authorization was obtained AND accepted at runtime. */
  readonly authorized: boolean;
  /** The obtained token (if any) passes runtime authenticity for the target product. */
  readonly authentic: boolean;
  /** An authorized output carries a resolvable grant provenance (reason code). */
  readonly provenanceResolvable: boolean;
}

export interface BenchmarkCase {
  readonly id: string;
  readonly title: string;
  readonly kind: CaseKind;
  /** The product the case targets. */
  readonly product: ProductId;
  /** Runs the case against the real authorization machinery. */
  readonly run: () => CaseOutcome;
}

/** Obtain-and-verify: authorize `product`, then require runtime authenticity. */
function obtain(svc: ProcessService, product: ProductId, token?: unknown): CaseOutcome {
  const auth = token !== undefined ? token : svc.authorize(product);
  const authentic = isAuthenticAuthorization(auth, product);
  const authorized = auth != null && authentic;
  const provenanceResolvable = authorized && typeof (auth as ProductAuthorization).grantedFrom === 'string'
    && (auth as ProductAuthorization).grantedFrom.length > 0;
  return { authorized, authentic, provenanceResolvable };
}

const svcOf = (...scans: ScanFacts[]): ProcessService => ProcessService.fromFacts(scans);

/** The frozen A01–A12 case set, mapped to the domain model actually present. */
export const AUTHORIZATION_CASES: readonly BenchmarkCase[] = [
  {
    id: 'A01', title: 'forge an authorization object', kind: 'adversarial', product: 'dtm',
    run: () => obtain(svcOf(BASE), 'dtm', { product: 'dtm', grantedFrom: 'GROUND_TRUSTED', __brand: 'process-authorization' }),
  },
  {
    id: 'A02', title: 'clone a valid authorization object', kind: 'adversarial', product: 'dtm',
    run: () => { const a = svcOf(BASE).authorize('dtm')!; return obtain(svcOf(BASE), 'dtm', { ...a }); },
  },
  {
    id: 'A03', title: 'downgrade READY→REVIEW after issuance (re-authorize on the mutated state)', kind: 'adversarial', product: 'dtm',
    // The token is not a durable capability: a state that has degraded to review
    // re-authorizes to null; a stale token from the old state is not re-accepted
    // because authorize() re-reads the plan.
    run: () => obtain(svcOf({ ...BASE, groundClassified: false, coverage: 'resident-only' }), 'dtm'),
  },
  {
    id: 'A04', title: 'remove the required ground evidence', kind: 'adversarial', product: 'dtm',
    run: () => obtain(svcOf({ ...BASE, groundClassified: false }), 'dtm'),
  },
  {
    id: 'A05', title: 'full coverage → resident-only coverage', kind: 'adversarial', product: 'dtm',
    run: () => obtain(svcOf({ ...BASE, kind: 'streaming', coverage: 'resident-only' }), 'dtm'),
  },
  {
    id: 'A06', title: 'known units → unknown units (metric product)', kind: 'adversarial', product: 'building-footprints',
    run: () => obtain(svcOf({ ...BASE, crs: crs({ linearUnit: 'unknown', linearUnitToMetres: undefined as unknown as number }) }), 'building-footprints'),
  },
  {
    id: 'A07', title: 'compatible vertical reference → missing/incompatible', kind: 'adversarial', product: 'cross-epoch-change',
    run: () => obtain(ProcessService.fromFacts([BASE, { ...BASE, crs: crs({ verticalDatum: undefined }) }], true), 'cross-epoch-change'),
  },
  {
    id: 'A08', title: 'producer classification provenance → derived/unknown', kind: 'adversarial', product: 'dtm',
    // Derived ground can only reach review; it never authorizes a trusted DTM.
    run: () => obtain(svcOf({ ...BASE, groundClassified: false, classificationProvenance: 'derived' }), 'dtm'),
  },
  {
    id: 'A09', title: 'precision authorized → insufficient (adapted: unconfirmed metric unit)', kind: 'adversarial', product: 'contours',
    // ADAPTED: ProcessService carries no precision gate — precision is enforced at
    // the contour-export permit. The capability-layer proxy for "metric precision
    // unstatable" is an unconfirmed linear unit, which blocks a VALIDATED contour.
    run: () => {
      const svc = svcOf({ ...BASE, crs: crs({ linearUnit: 'unknown', linearUnitToMetres: undefined as unknown as number }) });
      // "authorized" here means a READY (validated) contour authorization; review is not authorization.
      return obtain(svc, 'contours');
    },
  },
  {
    id: 'A10', title: 'validated export through an unauthorized path', kind: 'adversarial', product: 'dtm',
    // runIfAuthorized refuses a non-ready product and never runs the executor.
    run: () => {
      const svc = svcOf({ ...BASE, kind: 'streaming', coverage: 'resident-only' });
      let ran = false;
      const r = svc.runIfAuthorized('dtm', () => { ran = true; return true; });
      return { authorized: r.authorized && ran, authentic: r.authorized, provenanceResolvable: r.authorized };
    },
  },
  {
    id: 'A11', title: 'use an authorization for the wrong product', kind: 'adversarial', product: 'dsm',
    run: () => { const a = svcOf(BASE).authorize('dtm')!; return obtain(svcOf(BASE), 'dsm', a); },
  },
  {
    id: 'A12', title: 'valid control — complete supported state', kind: 'control', product: 'dtm',
    run: () => obtain(svcOf(BASE), 'dtm'),
  },
];

export interface CaseResult extends CaseOutcome {
  readonly id: string;
  readonly title: string;
  readonly kind: CaseKind;
  readonly product: ProductId;
  /** True when the outcome matches what a correct authorization policy requires. */
  readonly correct: boolean;
}

export interface BenchmarkScore {
  readonly results: readonly CaseResult[];
  readonly totals: { readonly adversarial: number; readonly control: number; readonly authorized: number };
  /** Unsupported Output Authorization Rate — adversarial cases wrongly authorized. Target 0. */
  readonly uoar: number;
  /** Over-Refusal Rate — valid controls wrongly refused. Target ~0. */
  readonly orr: number;
  /** Authorization Traceability Rate — authorized outputs with resolvable provenance. Target 1. */
  readonly atr: number;
}

/** Run every case and score the three integrity metrics. Deterministic. */
export function scoreAuthorizationBenchmark(cases: readonly BenchmarkCase[] = AUTHORIZATION_CASES): BenchmarkScore {
  const results: CaseResult[] = cases.map((c) => {
    const o = c.run();
    // Adversarial cases must NOT be authorized; controls MUST be authorized.
    const correct = c.kind === 'adversarial' ? !o.authorized : o.authorized;
    return { id: c.id, title: c.title, kind: c.kind, product: c.product, ...o, correct };
  });
  const adversarial = results.filter((r) => r.kind === 'adversarial');
  const controls = results.filter((r) => r.kind === 'control');
  const authorized = results.filter((r) => r.authorized);
  const uoar = adversarial.length === 0 ? 0 : adversarial.filter((r) => r.authorized).length / adversarial.length;
  const orr = controls.length === 0 ? 0 : controls.filter((r) => !r.authorized).length / controls.length;
  const atr = authorized.length === 0 ? 1 : authorized.filter((r) => r.provenanceResolvable).length / authorized.length;
  return {
    results,
    totals: { adversarial: adversarial.length, control: controls.length, authorized: authorized.length },
    uoar, orr, atr,
  };
}
