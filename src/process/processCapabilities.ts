/**
 * processCapabilities.ts — the single eligibility evaluator (v0.6.5 Phase 1).
 *
 * {@link evaluateCapabilities} turns a plain-data {@link ProcessInputs} into a
 * {@link ProcessPlan}. It is the ONE place product eligibility is decided; the
 * Process Studio UI and every exporter read its verdicts rather than re-deriving
 * their own, so a product can never be offered in one surface and refused in
 * another.
 *
 * Fail-closed is the rule. A metric product (contours, footprint area, volume)
 * needs a confirmed linear unit and, for cross-epoch work, a shared vertical
 * reference. When those are missing the product is `blocked` or `review`, never
 * `ready`. Coverage honesty carries through too: a resident-only streaming scan
 * cannot back a full-dataset product, so those degrade to `review`.
 *
 * Pure — no DOM, no I/O, no three.js. Reuses the v0.6.4 unit guard
 * ({@link isLinearUnitKnown}) so "unit known" means exactly what it means
 * everywhere else.
 */

import type {
  ProcessInputs,
  ProcessPlan,
  ProductCapability,
  ProductId,
  ScanFacts,
} from './ProcessPlan';
import { isLinearUnitKnown } from '../geo/CoordinateTypes';

/** Build one capability verdict. */
function cap(
  product: ProductId,
  readiness: ProductCapability['readiness'],
  reasonCode: string,
  reason: string,
): ProductCapability {
  return { product, readiness, reasonCode, reason };
}

/** True when the scan can back a full-dataset product (not resident-only). */
function isFullCoverage(scan: ScanFacts): boolean {
  return scan.coverage === 'full';
}

/**
 * Two scans share a usable vertical reference when both declare a vertical
 * datum and the two agree. A missing or mismatched vertical reference fails
 * closed — cross-epoch height math on incompatible references is exactly the
 * silent wrong number the model exists to prevent.
 */
function sharedVerticalReference(a: ScanFacts, b: ScanFacts): boolean {
  const va = a.crs?.verticalDatum;
  const vb = b.crs?.verticalDatum;
  return va != null && vb != null && va === vb;
}

/** Classification of unclassified points — geometry-driven, no CRS needed. */
function classifyGaps(scan: ScanFacts): ProductCapability {
  const p: ProductId = 'classify-gaps';
  if (scan.pointCount <= 0) {
    return cap(p, 'blocked', 'NO_POINTS', 'The scan has no points to classify.');
  }
  if (scan.classification === 'full') {
    return cap(p, 'review', 'ALREADY_CLASSIFIED', 'Every point already carries a class; reclassifying would overwrite producer values, so it is an explicit action rather than a default.');
  }
  if (!isFullCoverage(scan)) {
    return cap(p, 'review', 'PARTIAL_COVERAGE', 'Only resident or sampled points are available, so classification would cover part of the scan; it is labelled as such.');
  }
  return cap(p, 'ready', 'GAPS_CLASSIFIABLE', 'Unclassified points can be classified from geometry while producer classes are preserved.');
}

/** Bare-earth DTM — needs ground and full coverage; unit gates georeferenced use. */
function dtm(scan: ScanFacts): ProductCapability {
  const p: ProductId = 'dtm';
  if (scan.pointCount <= 0) {
    return cap(p, 'blocked', 'NO_POINTS', 'The scan has no points to grid.');
  }
  if (!isFullCoverage(scan)) {
    return cap(p, 'blocked', 'RESIDENT_ONLY', 'A surface needs the whole dataset; a resident-only streaming view cannot back a DTM.');
  }
  if (!isLinearUnitKnown(scan.crs)) {
    return cap(p, 'review', 'UNIT_UNKNOWN', 'The linear unit is unconfirmed, so the surface can be built for inspection but its georeferenced export is withheld.');
  }
  if (!scan.groundClassified) {
    return cap(p, 'review', 'GROUND_DERIVED', 'No trusted ground class is present, so ground is derived by the filter; the surface carries lower confidence than one built from classified ground.');
  }
  return cap(p, 'ready', 'GROUND_TRUSTED', 'Trusted ground points and a known unit support a bare-earth DTM.');
}

/** Upper-surface DSM — needs full coverage; no ground requirement. */
function dsm(scan: ScanFacts): ProductCapability {
  const p: ProductId = 'dsm';
  if (scan.pointCount <= 0) {
    return cap(p, 'blocked', 'NO_POINTS', 'The scan has no points to grid.');
  }
  if (!isFullCoverage(scan)) {
    return cap(p, 'blocked', 'RESIDENT_ONLY', 'A surface needs the whole dataset; a resident-only streaming view cannot back a DSM.');
  }
  if (!isLinearUnitKnown(scan.crs)) {
    return cap(p, 'review', 'UNIT_UNKNOWN', 'The linear unit is unconfirmed, so the surface can be built for inspection but its georeferenced export is withheld.');
  }
  return cap(p, 'ready', 'SURFACE_READY', 'The upper surface can be gridded from all returns.');
}

/** Contours — a metric product; a confirmed unit is required, not optional. */
function contours(scan: ScanFacts, dtmVerdict: ProductCapability): ProductCapability {
  const p: ProductId = 'contours';
  if (dtmVerdict.readiness === 'blocked') {
    return cap(p, 'blocked', 'NO_DTM', 'Contours derive from a DTM, which is not available for this scan.');
  }
  if (!isLinearUnitKnown(scan.crs)) {
    return cap(p, 'blocked', 'UNIT_UNKNOWN', 'A contour interval is a metric distance, so an unconfirmed linear unit blocks contours rather than guessing metres.');
  }
  if (dtmVerdict.readiness === 'review') {
    return cap(p, 'review', 'DTM_REVIEW', 'The underlying DTM is for review, so its contours carry the same caveat.');
  }
  return cap(p, 'ready', 'DTM_READY', 'A trusted DTM and a known unit support evidence-graded contours.');
}

/** Building footprints — need building points and a known unit (area is metric). */
function buildingFootprints(scan: ScanFacts): ProductCapability {
  const p: ProductId = 'building-footprints';
  if (!isLinearUnitKnown(scan.crs)) {
    return cap(p, 'blocked', 'UNIT_UNKNOWN', 'Footprint area is a metric quantity, so an unconfirmed linear unit blocks extraction.');
  }
  if (!isFullCoverage(scan)) {
    return cap(p, 'blocked', 'RESIDENT_ONLY', 'Footprints need every building return; a resident-only streaming view cannot back them.');
  }
  if (scan.hasBuildingClass) {
    return cap(p, 'ready', 'BUILDING_CLASS_PRESENT', 'Building-class points support footprint extraction.');
  }
  if (scan.classification === 'none') {
    return cap(p, 'review', 'NEEDS_CLASSIFICATION', 'No building class is present; classifying first would supply the candidates, so extraction is offered for review.');
  }
  return cap(p, 'review', 'NO_BUILDING_CLASS', 'The scan is classified but carries no building class, so any footprints come from derived candidates and need review.');
}

/**
 * A two-scan product (change raster or volume) — needs exactly two scans, a
 * compatible frame, and a shared vertical reference. Reused by both cross-epoch
 * change and cut/fill volume, which share the same eligibility.
 */
function twoScanProduct(product: ProductId, inputs: ProcessInputs, noun: string): ProductCapability {
  const [a, b] = inputs.scans;
  if (inputs.scans.length !== 2 || a == null || b == null) {
    return cap(product, 'blocked', 'NEED_TWO_SCANS', `${noun} needs exactly two loaded scans.`);
  }
  if (!isLinearUnitKnown(a.crs) || !isLinearUnitKnown(b.crs)) {
    return cap(product, 'blocked', 'UNIT_UNKNOWN', `${noun} is a metric product, so an unconfirmed linear unit on either scan blocks it.`);
  }
  if (!sharedVerticalReference(a, b)) {
    return cap(product, 'blocked', 'VERTICAL_REF_DIFFERS', `${noun} compares heights, so a missing or differing vertical reference between the two scans blocks it.`);
  }
  if (inputs.projectFrameCompatible !== true) {
    return cap(product, 'review', 'FRAME_UNPROVEN', `The two scans' spatial frames are not yet proven compatible, so ${noun.toLowerCase()} is offered for review pending alignment.`);
  }
  return cap(product, 'ready', 'COMPATIBLE', `Two scans in a compatible frame with a shared vertical reference support ${noun.toLowerCase()}.`);
}

/**
 * Evaluate what the loaded dataset(s) can safely produce. The single source of
 * product eligibility for Process Studio and every exporter.
 */
export function evaluateCapabilities(inputs: ProcessInputs): ProcessPlan {
  const products: ProductCapability[] = [];
  const primary = inputs.scans[0];

  if (primary != null) {
    const dtmVerdict = dtm(primary);
    products.push(classifyGaps(primary));
    products.push(dtmVerdict);
    products.push(dsm(primary));
    products.push(contours(primary, dtmVerdict));
    products.push(buildingFootprints(primary));
  }

  products.push(twoScanProduct('cross-epoch-change', inputs, 'Cross-epoch change'));
  products.push(twoScanProduct('volume-cut-fill', inputs, 'Cut/fill volume'));

  return { products };
}

/** Convenience: look up one product's verdict in a plan. */
export function capabilityFor(plan: ProcessPlan, product: ProductId): ProductCapability | undefined {
  return plan.products.find((c) => c.product === product);
}
