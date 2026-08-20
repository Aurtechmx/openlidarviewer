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

/** A datum label that carries no real identity — never a match, even to itself. */
const VERTICAL_DATUM_PLACEHOLDERS = new Set(['', 'unknown', 'unspecified', 'n/a', 'none']);

/**
 * The vertical identity a scan declares, normalised, or `null` when it declares
 * none. Trimming and lower-casing so 'NAVD88' and 'navd88' are one identity, and
 * rejecting placeholder labels so two undeclared scans both stamped 'unknown' do
 * NOT read as a shared reference (the fail-OPEN a raw `===` would allow).
 */
function verticalIdentityOf(scan: ScanFacts): string | null {
  const raw = scan.crs?.verticalDatum;
  if (raw == null) return null;
  const norm = raw.trim().toLowerCase();
  return norm.length > 0 && !VERTICAL_DATUM_PLACEHOLDERS.has(norm) ? norm : null;
}

/** The structured outcome of comparing two scans' vertical references. */
type VerticalReferenceVerdict =
  | { readonly ok: true }
  /** A missing/placeholder datum on either side, or two proven-different datums. */
  | { readonly ok: false; readonly code: 'VERTICAL_REF_DIFFERS' }
  /** Same datum, but a proven-different vertical UNIT (e.g. NAVD88 ft vs NAVD88 m). */
  | { readonly ok: false; readonly code: 'VERTICAL_UNIT_CONFLICT' };

/**
 * Compare two scans' vertical references, structured and fail-closed. Two scans
 * share a usable reference only when both declare the SAME real vertical datum
 * AND no proven vertical-unit conflict exists between them. A missing or
 * mismatched datum, or a same-datum pair whose vertical units are both known and
 * differ, each fails closed — cross-epoch height math across either mismatch is
 * exactly the silent wrong number the model exists to prevent. A same-datum pair
 * whose units are not both known is left to pass on the datum evidence (an
 * unproven unit is unverified, not a proven conflict).
 */
function compareVerticalReference(a: ScanFacts, b: ScanFacts): VerticalReferenceVerdict {
  const va = verticalIdentityOf(a);
  const vb = verticalIdentityOf(b);
  if (va == null || vb == null || va !== vb) return { ok: false, code: 'VERTICAL_REF_DIFFERS' };

  // Same datum: reject only a PROVEN unit conflict (both known, positive, unequal).
  const ua = a.crs?.verticalUnitToMetres;
  const ub = b.crs?.verticalUnitToMetres;
  const uaKnown = typeof ua === 'number' && Number.isFinite(ua) && ua > 0;
  const ubKnown = typeof ub === 'number' && Number.isFinite(ub) && ub > 0;
  if (uaKnown && ubKnown) {
    const differ = Math.abs(ua - ub) > Math.max(Math.abs(ua), Math.abs(ub)) * 1e-12;
    if (differ) return { ok: false, code: 'VERTICAL_UNIT_CONFLICT' };
  }
  return { ok: true };
}

/**
 * Classification of unclassified points. The classifier is geometry-driven but
 * its thresholds are PHYSICAL (a 20 m object size, a 1 m structural
 * neighbourhood, 0.5/2/5 m height bands), so a known source unit is needed to
 * normalize them. With the unit unconfirmed the classifier falls back to a
 * factor of 1, treating one source unit as one metre, and the same physical
 * geometry expressed in feet or metres can classify differently. Classification
 * for inspection is still allowed; the confirmed-unit result is what a graded
 * product needs.
 */
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
  if (!isLinearUnitKnown(scan.crs)) {
    return cap(p, 'review', 'UNIT_UNKNOWN', 'Classification can be derived for inspection, but its physical neighbourhood and height thresholds cannot be normalized until the source unit is confirmed, so the same geometry in another unit may classify differently.');
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
    return cap(p, 'review', 'RESIDENT_ONLY', 'Only the resident streaming set is loaded, so a surface can be built for inspection but a whole-dataset product is withheld until the full cloud is graded.');
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
    return cap(p, 'review', 'RESIDENT_ONLY', 'Only the resident streaming set is loaded, so a surface can be built for inspection but a whole-dataset product is withheld until the full cloud is graded.');
  }
  if (!isLinearUnitKnown(scan.crs)) {
    return cap(p, 'review', 'UNIT_UNKNOWN', 'The linear unit is unconfirmed, so the surface can be built for inspection but its georeferenced export is withheld.');
  }
  return cap(p, 'ready', 'SURFACE_READY', 'The upper surface can be gridded from all returns.');
}

/** Contours — a confirmed unit is required for a VALIDATED contour, but an exploratory one can be produced for inspection. */
function contours(scan: ScanFacts, dtmVerdict: ProductCapability): ProductCapability {
  const p: ProductId = 'contours';
  if (dtmVerdict.readiness === 'blocked') {
    return cap(p, 'blocked', 'NO_DTM', 'Contours derive from a DTM, which is not available for this scan.');
  }
  if (!isLinearUnitKnown(scan.crs)) {
    return cap(p, 'review', 'UNIT_UNKNOWN', 'The linear unit is unconfirmed, so a validated metric interval cannot be claimed; exploratory contours can still be produced for inspection with the deliverable withheld — the same output the Contour Studio launcher offers.');
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
  const vref = compareVerticalReference(a, b);
  if (!vref.ok) {
    return vref.code === 'VERTICAL_UNIT_CONFLICT'
      ? cap(product, 'blocked', 'VERTICAL_UNIT_CONFLICT', `${noun} compares heights, and the two scans share a vertical datum but declare different vertical units — one factor cannot convert both, so it is blocked.`)
      : cap(product, 'blocked', 'VERTICAL_REF_DIFFERS', `${noun} compares heights, so a missing or differing vertical reference between the two scans blocks it.`);
  }
  if (inputs.projectFrameCompatible !== true) {
    return cap(product, 'review', 'FRAME_UNPROVEN', `The two scans' spatial frames are not yet proven compatible, so ${noun.toLowerCase()} is offered for review pending alignment.`);
  }
  // Coverage honesty, symmetric with the single-scan surface products: a full-
  // dataset change/volume product needs the WHOLE of both scans. If either is
  // resident-only or sampled, the result would cover only the resident overlap,
  // so it is offered for review scoped to that overlap, never as a full product.
  if (a.coverage !== 'full' || b.coverage !== 'full') {
    return cap(product, 'review', 'RESIDENT_OVERLAP_ONLY', `${noun} needs the whole of both scans; one is resident-only or sampled, so the result would cover only the resident overlap and is offered for review scoped to that overlap.`);
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
