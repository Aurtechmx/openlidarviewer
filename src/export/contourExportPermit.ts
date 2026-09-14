/**
 * contourExportPermit.ts
 *
 * The single authoritative permit for a Contour Studio FILE export (v0.5.9 §19).
 *
 * Before v0.5.9's enforcement pass, the evidence gate (`resolveExportDecision`)
 * was a tested model with no production caller: the contour vector/PDF exporters
 * wrote files based on an ad-hoc `exportReadiness !== 'blocked'` check that
 * bypassed the registry entirely. This module closes that gap. It is the ONLY
 * way a contour export is permitted:
 *
 *   1. It maps a Studio export product (+ the per-click analytical/cartographic
 *      geometry choice) to a REGISTERED exporter id. An unmapped product throws —
 *      a file type that isn't registered cannot be minted.
 *   2. It builds the {@link ExportDecisionContext} from the launch state and the
 *      unit facts (metric-supported requires BOTH a known vertical unit AND a
 *      projected CRS), then defers to {@link resolveExportDecision}, which can
 *      only ever downgrade.
 *   3. It returns a discriminated permit: `ok:false` (the caller MUST refuse and
 *      write nothing) or `ok:true` with the resolved decision to stamp into the
 *      file's provenance (badge / exploratory watermark / caveats).
 *
 * Pure and unit-testable: no DOM, no I/O. The evidence lookup is injectable so a
 * test can pin the registry status without touching the global claim registry.
 */

import {
  resolveExportDecision,
  type ScientificExportDecision,
  type ExportDecisionContext,
  unionClaimIds,
} from './exportManifest';
import type { PrecisionPermit } from '../geo/inMemoryPrecision';

/**
 * The products that produce a downloadable file gated by this permit. The four
 * contour vectors + map-PDF share the CONTOURS claim; `dem` is the bare-earth
 * raster package and `report` the terrain intelligence report, both governed by
 * the DTM claim, routed through the SAME resolver so every scientific
 * deliverable's evidence decision comes from one place.
 */
export type ContourPermitProduct =
  | 'pdf'
  | 'geojson'
  | 'geojson-native'
  | 'dxf'
  | 'svg'
  | 'dem'
  | 'complete-package'
  | 'report';

/** The frame + unit facts the permit needs, lifted from the launch state. */
export interface ContourPermitContext {
  /** The Contour Studio launch status for this scan (drives block/downgrade). */
  readonly launchStatus: ExportDecisionContext['launchStatus'];
  /** The source vertical unit (metre/foot) is known, not unknown/local. */
  readonly verticalUnitsKnown: boolean;
  /** The active CRS is a projected (linear) frame, not geographic degrees. */
  readonly crsProjected: boolean;
  /**
   * The geometry being exported is exact analytical isolines (Survey Review),
   * not cartographically generalized. Only meaningful for GeoJSON, which has a
   * distinct analytical vs cartographic registration; ignored for the others.
   */
  readonly analyticalGeometry: boolean;
  /** Reasons to attach when the launch state itself blocked. */
  readonly blockedReasons?: readonly string[];
  /**
   * The scan's in-memory Float32 precision permit (`app/scanPrecision.ts`), or
   * `null` when no scan frame was available to measure. Passed straight through
   * to {@link resolveExportDecision}, which refuses on it.
   */
  readonly precision: PrecisionPermit | null;
  /** Injectable evidence lookup (defaults to the claim registry) — for tests. */
  readonly evidenceStatusOf?: NonNullable<ExportDecisionContext['evidenceStatusOf']>;
  /**
   * The capability verdict for the product this export delivers: `contours`
   * for the vector and map products, `dtm` for the DEM and the report, the
   * weaker of the two for the complete package. Passed through to
   * {@link resolveExportDecision}, which caps or blocks on it and treats its
   * absence as a shortfall.
   */
  readonly capability?: ExportDecisionContext['capability'];
  /** The claim ids the artifact carries; see `ExportDecisionContext.claimIds`. */
  readonly claimIds?: readonly string[];
  /** The state-bound authorization; see `ExportDecisionContext.authorization`. */
  readonly authorization?: ExportDecisionContext['authorization'];
}

/**
 * The stable, per-frame subset of the permit context — everything except the
 * per-click geometry choice. Computed once when Contour Studio mounts (from the
 * launch state + CRS facts) and handed to the export host so it can mint a permit
 * at click time by adding only the analytical/cartographic flag from the intent.
 */
export type ContourExportFrameFacts = Pick<
  ContourPermitContext,
  'launchStatus' | 'verticalUnitsKnown' | 'crsProjected' | 'blockedReasons' | 'precision'
> & {
  /**
   * The capability verdicts the frame was mounted with, by governing product.
   * The permit picks the one its product exports from; a frame mounted with
   * none caps every export to exploratory.
   */
  readonly capabilities?: {
    readonly contours?: ExportDecisionContext['capability'];
    readonly dtm?: ExportDecisionContext['capability'];
  };
  /** The claim ids each artifact family carries, from the analysis result. */
  readonly artifactClaimIds?: {
    readonly contours?: readonly string[];
    readonly dtm?: readonly string[];
  };
  /**
   * Mint the state-bound authorization for a governing product at click
   * time: a token from the state the frame was mounted on, verified against
   * the state at export. Absent when the frame was mounted without facts.
   */
  readonly authorizeFor?: (product: 'contours' | 'dtm') => ExportDecisionContext['authorization'];
};

/** The governing product a permit exports under, resolved for the package by the weaker verdict. */
export function governingProductResolved(
  product: ContourPermitProduct,
  capabilities: ContourExportFrameFacts['capabilities'],
): 'contours' | 'dtm' {
  const which = governingProductFor(product);
  if (which !== 'both') return which;
  const c = capabilities?.contours;
  const d = capabilities?.dtm;
  if (!c || !d) return 'contours';
  return RANK[d.readiness] > RANK[c.readiness] ? 'dtm' : 'contours';
}

/** The permit context for a product from its frame facts and the click's geometry choice. */
export function permitContextFor(
  product: ContourPermitProduct,
  frame: ContourExportFrameFacts,
  analyticalGeometry: boolean,
): ContourPermitContext {
  const governing = governingProductResolved(product, frame.capabilities);
  const ids = frame.artifactClaimIds;
  const claimIds = governingProductFor(product) === 'both'
    ? unionClaimIds(ids?.contours ?? [], ids?.dtm)
    : ids?.[governing];
  return {
    launchStatus: frame.launchStatus,
    verticalUnitsKnown: frame.verticalUnitsKnown,
    crsProjected: frame.crsProjected,
    analyticalGeometry,
    blockedReasons: frame.blockedReasons,
    precision: frame.precision,
    capability: capabilityForProduct(product, frame.capabilities),
    claimIds,
    authorization: frame.authorizeFor?.(governing),
  };
}

/** The product whose capability verdict governs each export. */
export function governingProductFor(product: ContourPermitProduct): 'contours' | 'dtm' | 'both' {
  switch (product) {
    case 'dem':
    case 'report':
      return 'dtm';
    case 'complete-package':
      return 'both';
    default:
      return 'contours';
  }
}

const RANK = { ready: 0, review: 1, blocked: 2 } as const;

/**
 * The verdict a product exports under, from the frame's verdicts. The
 * complete package takes the weaker of contours and DTM; a product whose
 * verdict is missing gets none, which the decision treats as a shortfall.
 */
export function capabilityForProduct(
  product: ContourPermitProduct,
  capabilities: ContourExportFrameFacts['capabilities'],
): ExportDecisionContext['capability'] {
  if (!capabilities) return undefined;
  const which = governingProductFor(product);
  if (which === 'contours') return capabilities.contours;
  if (which === 'dtm') return capabilities.dtm;
  const c = capabilities.contours;
  const d = capabilities.dtm;
  if (!c || !d) return undefined;
  return RANK[c.readiness] >= RANK[d.readiness] ? c : d;
}

/** A granted permit — the file MAY be written, stamped with `decision`. */
export interface ContourExportGranted {
  readonly ok: true;
  /** The registered exporter id the permit was minted for. */
  readonly exporterId: string;
  /** The resolved decision (validated or exploratory) to stamp into provenance. */
  readonly decision: Extract<ScientificExportDecision, { status: 'validated' | 'exploratory' }>;
  /** The one claim set the decision governed over; the provenance stamp uses it verbatim. */
  readonly claimIds: readonly string[];
}

/** A refused permit — the caller MUST write nothing and surface `reasons`. */
export interface ContourExportRefused {
  readonly ok: false;
  readonly exporterId: string;
  readonly reasons: readonly string[];
}

export type ContourExportPermit = ContourExportGranted | ContourExportRefused;

/**
 * Resolve the registered exporter id for a product. GeoJSON splits on geometry:
 * exact analytical isolines mint the analytical exporter; anything generalized
 * mints the cartographic one, so a smoothed line can never be stamped "exact".
 */
export function exporterIdForContourProduct(
  product: ContourPermitProduct,
  analyticalGeometry: boolean,
): string {
  switch (product) {
    case 'pdf':
      return 'contour.pdf';
    case 'geojson':
    // The native-frame sibling carries the same geometry under the same
    // claim; only its coordinate frame and filename differ.
    case 'geojson-native':
      return analyticalGeometry ? 'contour.geojson.analytical' : 'contour.geojson.cartographic';
    case 'dxf':
      return 'contour.dxf.cartographic';
    case 'svg':
      return 'contour.svg.cartographic';
    case 'dem':
      return 'contour.dem';
    case 'complete-package':
      return 'contour.package';
    case 'report':
      return 'contour.report';
  }
}

/**
 * Mint the export permit for a contour product. This is the enforcement point:
 * a caller that does not consult it, or that writes a file after `ok:false`,
 * is a §19 violation. Returns the resolved decision to stamp on `ok:true`.
 */
export function resolveContourExportPermit(
  product: ContourPermitProduct,
  ctx: ContourPermitContext,
): ContourExportPermit {
  const exporterId = exporterIdForContourProduct(product, ctx.analyticalGeometry);

  // Metric-supported may be claimed only when the vertical unit is known AND the
  // CRS is a projected frame — the same conjunction the launch state uses for its
  // 'available' verdict. Any shortfall means cartographic-only, which caps the
  // decision to exploratory inside resolveExportDecision.
  const unitClaim: ExportDecisionContext['unitClaim'] =
    ctx.verticalUnitsKnown && ctx.crsProjected ? 'metric-supported' : 'cartographic-only';

  const decision = resolveExportDecision(exporterId, {
    launchStatus: ctx.launchStatus,
    unitClaim,
    blockedReasons: ctx.blockedReasons,
    precision: ctx.precision,
    evidenceStatusOf: ctx.evidenceStatusOf,
    capability: ctx.capability,
    claimIds: ctx.claimIds,
    authorization: ctx.authorization,
  });

  if (decision.status === 'blocked') {
    return { ok: false, exporterId, reasons: decision.reasons };
  }
  return { ok: true, exporterId, decision, claimIds: decision.claimIds };
}
