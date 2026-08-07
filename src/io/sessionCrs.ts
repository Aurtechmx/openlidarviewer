/**
 * sessionCrs.ts: the serialized form of a resolved CRS, and its parser.
 *
 * Lifted out of `session.ts` unchanged so the session document and the v8
 * project-frame records can read the SAME CRS shape through the same parser.
 * Two copies of this validation would be two definitions of what a persisted
 * CRS is, and the one that drifted would be the one deciding what a restored
 * measurement's units mean.
 *
 * Pure: no DOM, no proj4.
 */

import type { ResolvedCrs } from '../geo/CoordinateTypes';

/**
 * A resolved CRS as it is written into a session file. Structurally identical
 * to the in-memory {@link ResolvedCrs}: the encoder has always written the
 * whole record and the parser reads the whole record back, so naming the
 * serialized form is a clarification of the existing contract, not a new shape.
 */
export type SerializedResolvedCrs = ResolvedCrs;

const CRS_KINDS = ['local', 'projected', 'geographic', 'unknown'] as const;
const CRS_SOURCES = [
  'las-vlr',
  'copc-meta',
  'ept-srs',
  'catalog-tile',
  'user-override',
  'default-assumption',
] as const;
const CRS_CONFIDENCES = ['high', 'medium', 'low', 'none'] as const;
const CRS_LINEAR_UNITS = ['metre', 'foot', 'us-survey-foot', 'unknown'] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Tolerantly parse a serialized resolved CRS. Returns null when the object is
 * missing, not a record, or fails the required-field set. Optional fields
 * (`epsg`, `wkt`) are dropped individually on bad shape; the rest of the
 * resolved CRS still imports. This matches the "v3 optional fields" discipline:
 * a partly-broken record never blocks the rest of the session.
 */
export function parseResolvedCrs(v: unknown): SerializedResolvedCrs | null {
  if (!isRecord(v)) return null;
  // Required fields.
  if (typeof v.name !== 'string' || v.name.length === 0) return null;
  if (typeof v.kind !== 'string' || !CRS_KINDS.includes(v.kind as never)) return null;
  if (typeof v.source !== 'string' || !CRS_SOURCES.includes(v.source as never)) return null;
  if (typeof v.confidence !== 'string' || !CRS_CONFIDENCES.includes(v.confidence as never)) return null;
  if (typeof v.linearUnit !== 'string' || !CRS_LINEAR_UNITS.includes(v.linearUnit as never)) {
    return null;
  }
  if (!isFiniteNumber(v.linearUnitToMetres)) return null;
  if (typeof v.userConfirmed !== 'boolean') return null;
  const out: ResolvedCrs = {
    kind: v.kind as ResolvedCrs['kind'],
    name: v.name,
    linearUnit: v.linearUnit as ResolvedCrs['linearUnit'],
    linearUnitToMetres: v.linearUnitToMetres,
    source: v.source as ResolvedCrs['source'],
    confidence: v.confidence as ResolvedCrs['confidence'],
    userConfirmed: v.userConfirmed,
    ...(isFiniteNumber(v.epsg) ? { epsg: v.epsg } : {}),
    ...(typeof v.wkt === 'string' && v.wkt.length > 0 ? { wkt: v.wkt } : {}),
    // The vertical + datum fields. The serializer has always written the whole
    // ResolvedCrs; only these were dropped on the way back in, so a
    // compound-CRS session reopened with its geometry intact and the metadata
    // needed to interpret its heights silently gone.
    ...(isFiniteNumber(v.verticalEpsg) ? { verticalEpsg: v.verticalEpsg } : {}),
    ...(typeof v.verticalDatum === 'string' && v.verticalDatum.length > 0
      ? { verticalDatum: v.verticalDatum }
      : {}),
    ...(isFiniteNumber(v.verticalUnitToMetres) && v.verticalUnitToMetres > 0
      ? { verticalUnitToMetres: v.verticalUnitToMetres }
      : {}),
    ...(typeof v.horizontalDatum === 'string' && v.horizontalDatum.length > 0
      ? { horizontalDatum: v.horizontalDatum }
      : {}),
  };
  return out;
}
