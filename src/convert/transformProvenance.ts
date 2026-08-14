/**
 * transformProvenance.ts — provenance for one coordinate transform.
 *
 * A reprojection RESULT is not just coordinates: it should be able to say WHICH
 * operation produced it, the operation's accuracy, the source/target geodetic
 * datum, the realization-preserving datum name (NAD83(2011) ≠ NAD83), and the
 * coordinate epoch the source declared. {@link TransformProvenance} is that
 * disclosure record, and {@link buildTransformProvenance} derives it for the
 * primary reproject path (`reprojectGlobal`) from the source/target EPSG plus
 * whatever `CrsInfo` the caller carries.
 *
 * Honesty contract (mirrors the rest of the CRS stack): every field is derived
 * from a real signal or reported absent — a datum/realization we cannot resolve
 * is OMITTED, an accuracy/epoch we do not know is `null`. Nothing is fabricated,
 * and no reprojected coordinate depends on any of it — this is metadata about
 * the transform, computed alongside it.
 *
 * Builds ON the existing datum-shift honesty rather than duplicating it: the
 * operation label comes from {@link epsgLabel}, the datum family from
 * {@link epsgDatumFamily}, the accuracy from {@link datumShiftAccuracyMetres}
 * (the companion of the caveat `reprojectGlobal` already surfaces), the
 * realization from the single-source-of-truth {@link resolveHorizontalDatum},
 * and the epoch by reading the WKT AST the parser already produces.
 *
 * Pure data — no DOM, no proj4, no three.js.
 */

import type { CrsInfo } from '../io/crs';
import { collectWktNodes, parseWkt, wktFirstNumber } from '../io/wktParser';
import { epsgDatumFamily, epsgLabel, datumShiftAccuracyMetres } from './epsg';
import { resolveHorizontalDatum } from '../geo/CrsRegistry';

/**
 * The provenance of one coordinate transform. Attached to every reproject
 * result (see {@link reprojectGlobal}) and disclosable in an export's
 * provenance. Absent values are honest: a datum/realization we cannot resolve is
 * omitted; an accuracy/epoch we do not know is `null`. Never fabricated.
 */
export interface TransformProvenance {
  /**
   * Human-readable operation label — `"<source> → <target>"` from
   * {@link epsgLabel}, or a "no transform" note when the two CRSs are identical.
   * Always present.
   */
  readonly operation: string;
  /**
   * Estimated horizontal error of the DATUM leg in metres
   * ({@link datumShiftAccuracyMetres}). `null` when there is no cross-datum leg
   * to characterise (a projection-only change, a conventionally-coincident pair)
   * or the datums are unresolvable — never a fabricated zero.
   */
  readonly accuracyMetres?: number | null;
  /** Source geodetic datum FAMILY (e.g. 'NAD83', 'WGS84'); absent when unresolvable. */
  readonly sourceDatum?: string;
  /** Target geodetic datum FAMILY; absent when unresolvable. */
  readonly targetDatum?: string;
  /**
   * Realization-preserving source datum NAME (e.g. 'NAD83(2011)', distinct from
   * the 'NAD83' family). A WKT-declared datum wins over the registry generic;
   * absent when neither source knows it.
   */
  readonly sourceRealization?: string;
  /** Realization-preserving target datum NAME; absent when neither source knows it. */
  readonly targetRealization?: string;
  /**
   * Coordinate epoch the SOURCE CRS declared (e.g. 2010.0), read from an
   * `EPOCH[…]` / `COORDINATEEPOCH[…]` node in the source WKT. `null` when the
   * source declares none — the common case for static-datum captures.
   */
  readonly coordinateEpoch?: number | null;
}

/**
 * The minimal resolved-CRS facts a transform's PROVENANCE needs: WKT-declared
 * realization + coordinate epoch (from `wkt`) and the horizontal datum. A full
 * `CrsInfo` satisfies this, and so does the CRS authority's `ResolvedCrs`, so a
 * caller can hand over either. `epsg` rides along for callers (e.g. the
 * converter) that pick the source CRS from the same object.
 */
export interface ResolvedSourceCrs {
  readonly epsg?: number | null;
  readonly wkt?: string;
  readonly horizontalDatum?: string;
}

/** Source/target CRS facts, when the caller has them, for realization + epoch. */
export interface TransformCrsHints {
  /**
   * The source CRS — supplies its WKT-declared realization and coordinate epoch.
   * Widened to {@link ResolvedSourceCrs} so the resolved authority (which is not
   * a `CrsInfo`) can be passed directly; only `wkt` / `horizontalDatum` are read.
   */
  readonly sourceCrs?: ResolvedSourceCrs | null;
  /** The target CRS — supplies its WKT-declared realization when one is known. */
  readonly targetCrs?: CrsInfo | null;
}

/**
 * Read the coordinate epoch a WKT declares, or `null` when it declares none.
 *
 * The coordinate epoch (WKT2 `EPOCH[2010.0]`, older `COORDINATEEPOCH`) is the
 * epoch at which the coordinates are valid — distinct from a dynamic datum's
 * `FRAMEEPOCH` (a datum property) and from `ANCHOREPOCH`, neither of which is
 * matched here. Reads the AST the shared parser already produces; never throws.
 */
export function coordinateEpochFromWkt(wkt: string | undefined): number | null {
  if (!wkt) return null;
  const root = parseWkt(wkt);
  if (!root) return null;
  for (const node of collectWktNodes(root)) {
    if (node.keyword !== 'EPOCH' && node.keyword !== 'COORDINATEEPOCH') continue;
    const epoch = wktFirstNumber(node);
    if (typeof epoch === 'number' && Number.isFinite(epoch)) return epoch;
  }
  return null;
}

/**
 * Derive the {@link TransformProvenance} for a src→dst EPSG transform. Pure —
 * given the same inputs it returns the same record, and it reads no state beyond
 * its arguments.
 *
 *   - `operation`       ← {@link epsgLabel} of each code.
 *   - `sourceDatum` /
 *     `targetDatum`     ← {@link epsgDatumFamily} (omitted when unresolvable).
 *   - `sourceRealization` /
 *     `targetRealization` ← {@link resolveHorizontalDatum}: the WKT datum from the
 *                          hint's `CrsInfo` when present (realization-preserving),
 *                          else the curated registry generic by code, else omitted.
 *   - `accuracyMetres`  ← {@link datumShiftAccuracyMetres} (`null` when there is
 *                          no cross-datum leg or the datums are unknown).
 *   - `coordinateEpoch` ← the SOURCE WKT's declared epoch (`null` when none).
 */
export function buildTransformProvenance(
  srcEpsg: number,
  dstEpsg: number,
  hints: TransformCrsHints = {},
): TransformProvenance {
  const operation =
    srcEpsg === dstEpsg
      ? `no transform (identical CRS ${epsgLabel(srcEpsg)})`
      : `${epsgLabel(srcEpsg)} → ${epsgLabel(dstEpsg)}`;

  const sourceDatum = epsgDatumFamily(srcEpsg);
  const targetDatum = epsgDatumFamily(dstEpsg);
  const sourceRealization = resolveHorizontalDatum(hints.sourceCrs?.horizontalDatum, srcEpsg);
  const targetRealization = resolveHorizontalDatum(hints.targetCrs?.horizontalDatum, dstEpsg);

  return {
    operation,
    // number when the datum leg is a known degenerate case, else null (unknown
    // or no cross-datum leg) — never fabricated.
    accuracyMetres: datumShiftAccuracyMetres(srcEpsg, dstEpsg),
    // The coordinate epoch belongs to the coordinates being moved — the SOURCE.
    coordinateEpoch: coordinateEpochFromWkt(hints.sourceCrs?.wkt),
    // Datum family + realization are OMITTED (not null) when unresolvable, so a
    // consumer reads their absence as "not known" rather than a value.
    ...(sourceDatum ? { sourceDatum } : {}),
    ...(targetDatum ? { targetDatum } : {}),
    ...(sourceRealization ? { sourceRealization } : {}),
    ...(targetRealization ? { targetRealization } : {}),
  };
}
