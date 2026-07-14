/**
 * exportManifest.ts
 *
 * The evidence-gated export manifest (v0.5.9 spec §19). Every scientific Contour
 * Studio exporter is REGISTERED here with the claim it exports; the intended
 * contract is that every functional export path resolves its decision through
 * {@link resolveExportDecision}. That decision can only ever downgrade — a
 * product the registry marks validated is still capped to exploratory when the
 * launch context isn't fully supported, and never the reverse.
 *
 * STATUS: the resolver is ENFORCED for every Contour Studio export product.
 * Every GeoJSON, DXF, SVG, contour map-PDF, DEM raster package, complete
 * deliverable ZIP and terrain intelligence report export is minted through
 * `resolveContourExportPermit` → {@link resolveExportDecision}; the caller
 * refuses when the permit is blocked (writer-level for the vectors, map PDF and
 * deliverable ZIP; adapter-level for the DEM package and report, whose writers
 * keep a stampless direct-button path) and stamps the decision (validated /
 * exploratory + watermark) into the exported file's provenance. The separate,
 * older `evidenceStatus` gate remains wired for the live measurement exports.
 *
 * This builds on the existing evidence registry (`evidenceStatus` / `exportGate`)
 * rather than inventing a parallel gate. The decision type is named
 * `ScientificExportDecision` to avoid colliding with the registry's own
 * `ExportDecision`.
 */

import {
  evidenceStatus as registryEvidenceStatus,
  type EvidenceStatus,
} from '../validation/exportEvidenceNote';
// Import the note from its dependency-free leaf module, NOT from exportProvenance:
// the gate is reached eagerly (Contour Studio mints permits synchronously), so
// pulling in exportProvenance here would collapse its deliberately-lazy chunk.
import { NOT_SURVEY_GRADE_NOTE } from '../terrain/export/exportNotes';

export type ScientificProduct =
  | 'contour-map-pdf'
  | 'contours-geojson-analytical'
  | 'contours-geojson-cartographic'
  | 'contours-dxf-cartographic'
  | 'contours-svg-cartographic'
  | 'dtm-raster'
  | 'deliverable-package'
  | 'terrain-intelligence-report';

export interface ScientificExporterRegistration {
  readonly exporterId: string;
  readonly product: ScientificProduct;
  /** The claim-register id this product's evidence is governed by. */
  readonly claimId: string;
  /** Structural marker: a registered scientific exporter always gates. */
  readonly requiresEvidenceDecision: true;
}

/** The registered scientific exporters. A product not here cannot be exported. */
export const SCIENTIFIC_EXPORTERS: readonly ScientificExporterRegistration[] = [
  { exporterId: 'contour.pdf', product: 'contour-map-pdf', claimId: 'CONTOURS', requiresEvidenceDecision: true },
  { exporterId: 'contour.geojson.analytical', product: 'contours-geojson-analytical', claimId: 'CONTOURS', requiresEvidenceDecision: true },
  { exporterId: 'contour.geojson.cartographic', product: 'contours-geojson-cartographic', claimId: 'CONTOURS', requiresEvidenceDecision: true },
  { exporterId: 'contour.dxf.cartographic', product: 'contours-dxf-cartographic', claimId: 'CONTOURS', requiresEvidenceDecision: true },
  // SVG is a cartographic vector sheet (never analytical): a smoothed/rounded
  // print line is stamped as such, so it shares the CONTOURS claim but is
  // registered distinctly so it can never be minted as exact analytical geometry.
  { exporterId: 'contour.svg.cartographic', product: 'contours-svg-cartographic', claimId: 'CONTOURS', requiresEvidenceDecision: true },
  { exporterId: 'contour.dem', product: 'dtm-raster', claimId: 'DTM', requiresEvidenceDecision: true },
  { exporterId: 'contour.package', product: 'deliverable-package', claimId: 'CONTOURS', requiresEvidenceDecision: true },
  // The terrain intelligence report presents the DTM-derived analysis (verdicts,
  // coverage, accuracy), so its evidence is governed by the same DTM claim as
  // the raster — the report can never claim more than the surface it summarises.
  { exporterId: 'contour.report', product: 'terrain-intelligence-report', claimId: 'DTM', requiresEvidenceDecision: true },
] as const;

export function exporterRegistration(exporterId: string): ScientificExporterRegistration | undefined {
  return SCIENTIFIC_EXPORTERS.find((e) => e.exporterId === exporterId);
}

export type ScientificExportDecision =
  | { readonly status: 'validated'; readonly badge: string; readonly caveats: readonly string[] }
  | { readonly status: 'exploratory'; readonly badge: string; readonly watermark: string; readonly caveats: readonly string[] }
  | { readonly status: 'blocked'; readonly reasons: readonly string[] };

export interface ExportDecisionContext {
  /** The Contour Studio launch state for this scan. */
  readonly launchStatus: 'available' | 'exploratory' | 'unavailable' | 'not-analyzed';
  /** Whether metric contour support may be claimed (PR3 contourUnitClaim). */
  readonly unitClaim: 'metric-supported' | 'cartographic-only';
  /** Reasons to attach when blocked (from the launch state). */
  readonly blockedReasons?: readonly string[];
  /** Injectable evidence lookup (defaults to the claim registry) — for tests. */
  readonly evidenceStatusOf?: (claimId: string) => EvidenceStatus;
}

const EXPLORATORY_WATERMARK = 'EXPLORATORY';

/**
 * Resolve the export decision for a registered exporter. Throws for an
 * unregistered exporter (§19: no scientific download bypasses the gate). The
 * decision is the MINIMUM of the registry evidence and the launch/unit context —
 * it never promotes.
 */
export function resolveExportDecision(
  exporterId: string,
  ctx: ExportDecisionContext,
): ScientificExportDecision {
  const reg = exporterRegistration(exporterId);
  if (!reg) {
    throw new Error(
      `exportManifest: "${exporterId}" is not a registered scientific exporter; it must be registered before it can export.`,
    );
  }

  // Hard block: nothing to export, or the launch prerequisites failed.
  if (ctx.launchStatus === 'not-analyzed' || ctx.launchStatus === 'unavailable') {
    return {
      status: 'blocked',
      reasons: ctx.blockedReasons && ctx.blockedReasons.length > 0
        ? ctx.blockedReasons
        : ['No usable terrain deliverable is available for this scan.'],
    };
  }

  const status = (ctx.evidenceStatusOf ?? registryEvidenceStatus)(reg.claimId);
  if (status === 'refused') {
    return { status: 'blocked', reasons: [`The ${reg.product} product is not exportable at its current evidence level.`] };
  }

  const caveats = [NOT_SURVEY_GRADE_NOTE];

  // Validated requires BOTH the registry validated AND a fully-supported launch
  // AND a metric-supported unit claim. Any shortfall caps to exploratory.
  const fullySupported =
    status === 'validated' && ctx.launchStatus === 'available' && ctx.unitClaim === 'metric-supported';

  if (fullySupported) {
    return { status: 'validated', badge: 'Internal validation', caveats };
  }

  const reasons: string[] = [];
  if (ctx.launchStatus === 'exploratory') reasons.push('One or more scientific prerequisites are incomplete.');
  if (ctx.unitClaim !== 'metric-supported') reasons.push('Metric contour support is not claimed (unknown vertical unit or geographic CRS).');
  if (status === 'exploratory') reasons.push('The product has not reached its required evidence level.');

  return {
    status: 'exploratory',
    badge: 'Exploratory',
    watermark: EXPLORATORY_WATERMARK,
    caveats: [...caveats, ...reasons],
  };
}
