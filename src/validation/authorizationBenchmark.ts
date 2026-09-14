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
import {
  permitContextFor,
  resolveContourExportPermit,
  type ContourExportFrameFacts,
  type ContourExportPermit,
  type ContourPermitContext,
  type ContourPermitProduct,
} from '../export/contourExportPermit';
import { resolveWorkspaceClaim } from '../export/workspaceClaim';
import { governingClaim } from './evidenceComposition';
import type { AnalyseContoursResult } from '../terrain/contour/analyseContours';
import { contourArtifactClaims, dtmArtifactClaims } from '../terrain/export/exportProvenance';

function crs(o: Partial<CrsInfo> = {}): CrsInfo {
  return { source: 'epsg', linearUnit: 'metre', linearUnitToMetres: 1, verticalDatum: 'NAVD88', verticalUnitToMetres: 1, ...o } as CrsInfo;
}

/** BASE's stated point total, named so a case can vary it without re-reading a
 *  field that is nullable for sources which state no total. */
const BASE_POINT_COUNT = 1_000_000;

/** A fully-supported single scan: full coverage, known unit, trusted ground. */
const BASE: ScanFacts = {
  kind: 'static', coverage: 'full', crs: crs(), pointCount: BASE_POINT_COUNT,
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
  /** True when the case reuses an authentic token across a state change (SAAR denominator). */
  readonly staleCase?: boolean;
  /** True when the case mints a production permit on non-full coverage (CPAR denominator). */
  readonly coverageBlindCase?: boolean;
  /** Runs the case against the real authorization machinery. */
  readonly run: () => CaseOutcome;
}

/** Issue a genuine token for `product` on `before`, then verify it against `after`. */
function reuseAcross(before: ScanFacts[], after: ScanFacts[], product: ProductId, frame?: boolean): CaseOutcome {
  const token = ProcessService.fromFacts(before, frame).authorize(product);
  const check = ProcessService.fromFacts(after, frame).verifyAuthorization(token, product);
  // For a reuse case "authorized" == the stale/changed-state token was ACCEPTED (which must not happen).
  return { authorized: check.ok, authentic: check.ok, provenanceResolvable: check.ok };
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


// ── Production-permit cases (A21–A28) ─────────────────────────────────────────
// These run the export permit the adapter mints at click time, not the
// capability token alone. "authorized" here means the permit resolved
// `validated`; a review-grade or blocked permit is a refusal. Provenance is
// resolvable when the permit returned the claim set it governed over.

const VALIDATED: NonNullable<ContourPermitContext['evidenceStatusOf']> = () => 'validated';

/** The frame the runner builds for Contour Studio from these facts. */
function frameOf(facts: ScanFacts, over: Partial<ContourExportFrameFacts> = {}, authorizeOn: ScanFacts = facts): ContourExportFrameFacts {
  const svc = svcOf(facts);
  const issuer = svcOf(authorizeOn);
  const verdict = (product: 'contours' | 'dtm') => {
    const c = svc.capability(product);
    return c ? { readiness: c.readiness, reasonCode: c.reasonCode, reason: c.reason } : undefined;
  };
  return {
    launchStatus: 'available', verticalUnitsKnown: true, crsProjected: true, precision: null,
    capabilities: { contours: verdict('contours'), dtm: verdict('dtm') },
    artifactClaimIds: { contours: ['CONTOURS', 'DTM'], dtm: ['DTM'] },
    authorizeFor: (product) => ({ product, token: issuer.authorize(product), verify: (t, p) => svc.verifyAuthorization(t, p) }),
    ...over,
  };
}

function permitOn(product: ContourPermitProduct, frame: ContourExportFrameFacts, evidenceStatusOf?: ContourPermitContext['evidenceStatusOf']): ContourExportPermit {
  return resolveContourExportPermit(product, { ...permitContextFor(product, frame, product === 'geojson-native'), evidenceStatusOf });
}

function permitOutcome(permit: ContourExportPermit): CaseOutcome {
  const authorized = permit.ok && permit.decision.status === 'validated';
  return { authorized, authentic: authorized, provenanceResolvable: authorized && permit.claimIds.length > 0 };
}

const CLAIM_LABEL = { validated: 'Supported (internal validation only)', exploratory: 'Exploratory' } as const;

/** The interface claim and the permit the package exports under agree on words and rationale. */
function claimAgrees(frame: ContourExportFrameFacts, evidenceStatusOf?: ContourPermitContext['evidenceStatusOf']): boolean {
  const claim = resolveWorkspaceClaim(frame, evidenceStatusOf);
  const permit = permitOn('complete-package', frame, evidenceStatusOf);
  if (!permit.ok) return claim.label === 'Blocked' && claim.rationale.join('\n') === permit.reasons.join('\n');
  return claim.label === CLAIM_LABEL[permit.decision.status]
    && claim.rationale.join('\n') === permit.decision.caveats.join('\n');
}

const SAMPLED: ScanFacts = { ...BASE, coverage: 'sampled' };
const RESIDENT: ScanFacts = { ...BASE, kind: 'streaming', coverage: 'resident-only' };
const DERIVED_GROUND: ScanFacts = { ...BASE, groundClassified: false, classificationProvenance: 'derived' };
/** Same capability verdicts as BASE, different scientific state. */
const REVISED: ScanFacts = { ...BASE, hasBuildingClass: false };
const CRISP_WITH_RMSE = { generationParams: { contourStyle: 'crisp' }, accuracyStandards: { rmseZM: 0.08 } } as unknown as AnalyseContoursResult;
const PRECISION_REFUSED = { ok: false, precision: {}, reasons: ['Float32 cannot hold this extent at the product precision.'] } as unknown as ContourExportFrameFacts['precision'];

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
  // A13–A20: state-bound freshness + dual completeness (build on A01–A12, which stay frozen).
  {
    id: 'A13', title: 'authentic token reused after a relevant state revision (classification)', kind: 'adversarial', product: 'dtm', staleCase: true,
    run: () => reuseAcross([BASE], [{ ...BASE, classification: 'partial' }], 'dtm'),
  },
  {
    id: 'A14', title: 'authentic token reused for another dataset', kind: 'adversarial', product: 'dtm', staleCase: true,
    run: () => reuseAcross([BASE], [{ ...BASE, pointCount: BASE_POINT_COUNT - 1 }], 'dtm'),
  },
  {
    id: 'A15', title: 'subject completeness full → partial (coverage)', kind: 'adversarial', product: 'dtm', staleCase: true,
    run: () => reuseAcross([BASE], [{ ...BASE, kind: 'streaming', coverage: 'resident-only' }], 'dtm'),
  },
  {
    id: 'A16', title: 'support completeness complete → incomplete (unit / vertical reference)', kind: 'adversarial', product: 'dtm', staleCase: true,
    run: () => reuseAcross([BASE], [{ ...BASE, crs: crs({ verticalDatum: undefined }) }], 'dtm'),
  },
  // A17–A19: scope non-broadening under evidence change (build on A01–A16, which stay frozen).
  {
    id: 'A17', title: 'evidence scope narrowed after authorization (building class removed) — broader dependent claim withdrawn', kind: 'adversarial', product: 'building-footprints', staleCase: true,
    // Footprints were authorized while the building class was present. Removing it
    // narrows the sensor evidence scope (the after-state only reaches review); an
    // authentic token from the wider state must not survive that narrowing.
    run: () => reuseAcross([BASE], [{ ...BASE, hasBuildingClass: false }], 'building-footprints'),
  },
  {
    id: 'A18', title: 'requested claim widened beyond evidence scope (sampled coverage, full-dataset DTM requested) — refused', kind: 'adversarial', product: 'dtm',
    // The evidence backs only a partial (sampled) surface; requesting a full-dataset
    // DTM widens the subject scope past what the evidence supports, so no authorization
    // is issued at all (distinct from A05's resident-only path).
    run: () => obtain(svcOf({ ...BASE, kind: 'streaming', coverage: 'sampled' }), 'dtm'),
  },
  {
    id: 'A19', title: 'supporting evidence removed (one epoch collapses to resident-only) — stronger dependent claim withdrawn', kind: 'adversarial', product: 'cross-epoch-change', staleCase: true,
    // The change claim depends on BOTH epochs covering the whole scene. Collapsing one
    // epoch to resident-only removes the supporting evidence for the wider claim; the
    // token issued while both epochs were complete must not be re-accepted.
    run: () => reuseAcross([BASE, BASE], [BASE, { ...BASE, kind: 'streaming', coverage: 'resident-only' }], 'cross-epoch-change', true),
  },
  {
    id: 'A20', title: 'valid state-bound control — token verified against its own unchanged state', kind: 'control', product: 'dtm',
    run: () => {
      const svc = svcOf(BASE);
      const token = svc.authorize('dtm');
      const check = svc.verifyAuthorization(token, 'dtm');
      const auth = check.ok && isAuthenticAuthorization(token, 'dtm');
      return { authorized: auth, authentic: auth, provenanceResolvable: auth && typeof (token as ProductAuthorization).grantedFrom === 'string' };
    },
  },
  {
    id: 'A21', title: 'production permit on a sampled read, fully supported frame, registry stubbed validated — exploratory', kind: 'adversarial', product: 'dtm', coverageBlindCase: true,
    run: () => permitOutcome(permitOn('dem', frameOf(SAMPLED), VALIDATED)),
  },
  {
    id: 'A22', title: 'production permit on a resident-only streaming read, registry stubbed validated — exploratory', kind: 'adversarial', product: 'dtm', coverageBlindCase: true,
    run: () => permitOutcome(permitOn('dem', frameOf(RESIDENT), VALIDATED)),
  },
  {
    id: 'A23', title: 'production permit on derived ground, registry stubbed validated — exploratory (GROUND_DERIVED)', kind: 'adversarial', product: 'dtm',
    run: () => permitOutcome(permitOn('dem', frameOf(DERIVED_GROUND), VALIDATED)),
  },
  {
    id: 'A24', title: 'registry patched to validated on every claim, sampled load — still exploratory', kind: 'adversarial', product: 'contours', coverageBlindCase: true,
    run: () => permitOutcome(permitOn('complete-package', frameOf(SAMPLED), VALIDATED)),
  },
  {
    id: 'A25', title: 'permit vs provenance: crisp map PDF with RMSEz — one governing claim, refused above it', kind: 'adversarial', product: 'contours',
    run: () => {
      const frame = frameOf(BASE, { artifactClaimIds: { contours: contourArtifactClaims(CRISP_WITH_RMSE), dtm: dtmArtifactClaims(CRISP_WITH_RMSE) } });
      const permit = permitOn('pdf', frame);
      const o = permitOutcome(permit);
      // A permit whose governing claim differs from the artifact's counts as
      // authorized above its evidence: the stamp would describe another product.
      const agrees = permit.ok && governingClaim(permit.claimIds) === governingClaim([...contourArtifactClaims(CRISP_WITH_RMSE), 'CONTOURS-CARTOGRAPHIC']);
      return { ...o, authorized: o.authorized || !agrees };
    },
  },
  {
    id: 'A26', title: 'validated branch with a token minted on state S₁, export attempted on S₂ — capped to exploratory', kind: 'adversarial', product: 'contours', staleCase: true,
    run: () => permitOutcome(permitOn('geojson-native', frameOf(REVISED, {}, BASE), VALIDATED)),
  },
  {
    id: 'A27', title: 'control — interface Claim equals the permit stamp across six frames (supported, sampled, unit unknown, no CRS, derived ground, precision refused)', kind: 'control', product: 'contours',
    run: () => {
      const frames: Array<[ContourExportFrameFacts, ContourPermitContext['evidenceStatusOf']]> = [
        [frameOf(BASE), VALIDATED],
        [frameOf(SAMPLED), undefined],
        [frameOf(BASE, { verticalUnitsKnown: false, launchStatus: 'exploratory' }), undefined],
        [frameOf(BASE, { crsProjected: false, launchStatus: 'exploratory' }), undefined],
        [frameOf(DERIVED_GROUND), undefined],
        [frameOf(BASE, { precision: PRECISION_REFUSED }), undefined],
      ];
      const agree = frames.every(([f, e]) => claimAgrees(f, e));
      return { authorized: agree, authentic: agree, provenanceResolvable: agree };
    },
  },
  {
    id: 'A28', title: 'control — full coverage, producer ground, fresh token, registry stubbed validated — validated', kind: 'control', product: 'contours',
    run: () => permitOutcome(permitOn('geojson-native', frameOf(BASE), VALIDATED)),
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
  /** Stale Authorization Acceptance Rate — reused-across-state tokens wrongly accepted. Target 0. */
  readonly saar: number;
  /** Coverage-blind Production Authorization Rate — production permits on non-full coverage that resolve validated. Target 0. */
  readonly cpar: number;
}

/** Run every case and score the integrity metrics. Deterministic. */
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
  const staleCases = cases.filter((c) => c.staleCase);
  const staleResults = results.filter((r) => staleCases.some((c) => c.id === r.id));
  const uoar = adversarial.length === 0 ? 0 : adversarial.filter((r) => r.authorized).length / adversarial.length;
  const orr = controls.length === 0 ? 0 : controls.filter((r) => !r.authorized).length / controls.length;
  const atr = authorized.length === 0 ? 1 : authorized.filter((r) => r.provenanceResolvable).length / authorized.length;
  const saar = staleResults.length === 0 ? 0 : staleResults.filter((r) => r.authorized).length / staleResults.length;
  const coverageBlind = results.filter((r) => cases.some((c) => c.coverageBlindCase && c.id === r.id));
  const cpar = coverageBlind.length === 0 ? 0 : coverageBlind.filter((r) => r.authorized).length / coverageBlind.length;
  return {
    results,
    totals: { adversarial: adversarial.length, control: controls.length, authorized: authorized.length },
    uoar, orr, atr, saar, cpar,
  };
}
