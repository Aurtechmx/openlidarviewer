/**
 * geojsonContours.ts
 *
 * the cheapest real downstream path. Emits the contour feature
 * model as GeoJSON that QGIS / Civil 3D (via QGIS) ingest directly. Each
 * single-grade run becomes a LineString Feature carrying its elevation,
 * evidence grade, index flag, and confidence, so the recipient can style
 * or filter the uncertain spans rather than trusting one flat line.
 *
 * Elevation is written into the coordinate Z (3D positions, RFC 7946's
 * optional third element) AS WELL AS the `elevation` property — a 2D
 * LineString with attribute-only elevation imports flat (every contour at
 * Z=0) in 3D-aware GIS/CAD, which reads as "contours have no elevation".
 *
 * CRS note (honest, documented): RFC 7946 assumes WGS84 lon/lat, but
 * LiDAR contours are in a projected CRS (UTM etc.). We emit the
 * coordinates in their native projected CRS and include the legacy
 * top-level `crs` member (the pre-RFC GeoJSON convention QGIS still
 * reads) so the file is georeferenced in practice. When the CRS is
 * unknown we omit the member and the model warning explains the file is
 * not georeferenced.
 *
 * Pure data: no DOM, no three.js, no I/O. Returns a string / object.
 */

import { contourEvidence, type ContourFeatureModel } from './contourFeatureModel';
import { contourShapeStyleLabel } from './contourShapeStyle';
import { provenanceJson, type ExportProvenance } from '../export/exportProvenance';
import { crsUrn as sharedCrsUrn } from '../../export/crsIdentifier';



/**
 * Build the GeoJSON object (foreign members included for provenance). When the
 * unified {@link ExportProvenance} is supplied, its structured fields are merged
 * into the top-level `metadata` member (the superset) WITHOUT clobbering the
 * model-derived keys already there — so the existing `contourStyle`, `warnings`,
 * `verticalDatum` etc. are preserved and the file gains the same provenance every
 * other export carries (CRS, datum, export readiness, software + metric version,
 * accuracy, generation date).
 */
export function toGeoJSON(
  model: ContourFeatureModel,
  provenance?: ExportProvenance,
): Record<string, unknown> {
  const features = model.features.map((f) => ({
    type: 'Feature',
    properties: {
      interval: model.intervalM,
      elevation: f.value,
      grade: f.grade,
      evidenceGrade: contourEvidence(f.grade),
      index: f.isIndex,
      meanConfidence: Math.round(f.meanConfidence),
      coverageMode: model.coverageMode,
    },
    geometry: {
      type: 'LineString',
      // 3D positions: elevation rides in the coordinate Z (RFC 7946's optional
      // third element), NOT only in the `elevation` property. A 2D LineString
      // with attribute-only elevation imports flat (every contour at Z=0) in
      // 3D-aware GIS/CAD — "contours have no elevation". The property is kept
      // for attribute-driven styling/labelling; the Z carries the real height.
      coordinates: f.coordinates.map(([x, y]) => [x, y, f.value]),
    },
  }));

  // Foreign members carry honest provenance into the file itself.
  const metadata: Record<string, unknown> = {
      intervalM: model.intervalM,
      verticalDatum: model.verticalDatum,
      coverageMode: model.coverageMode,
      // Honest record of the shape transform applied to the geometry. When the
      // style is not 'crisp' the lines have been smoothed/generalized (within
      // the confidence gate — gaps are never bridged), so a downstream GIS knows
      // these are not the raw marching-squares vertices.
      contourStyle: model.contourStyle,
      contourStyleLabel: contourShapeStyleLabel(model.contourStyle),
      geometryNote:
        model.contourStyle === 'crisp'
          ? 'Geometry is the raw marching-squares vertices (no smoothing or simplification).'
          : `Geometry is smoothed/generalized (style: ${contourShapeStyleLabel(model.contourStyle)}); low-confidence and gap vertices are preserved exactly.`,
      interpolatedFraction: Number.isFinite(model.interpolatedFraction)
        ? Math.round(model.interpolatedFraction * 1000) / 1000
        : null,
      warnings: model.warnings,
      notSurveyGrade: 'Not survey-grade unless validated against ground-truth control.',
  };

  // Merge the unified provenance as the metadata superset. Existing model-derived
  // keys win (so nothing regresses — contourStyle, warnings, verticalDatum stay
  // exactly as before); the provenance only ADDS the fields the file lacked
  // (software + version, CRS, export readiness, accuracy, generation date …).
  if (provenance) {
    const pj = provenanceJson(provenance);
    for (const [k, v] of Object.entries(pj)) {
      if (!(k in metadata)) metadata[k] = v;
    }
  }

  const obj: Record<string, unknown> = {
    type: 'FeatureCollection',
    name: 'contours',
    metadata,
    features,
  };
  // FRAME CONTRACT: the CRS stamp asserts the coordinates are IN that CRS
  // frame. The caller (serializeContours) is responsible for shifting a
  // local-frame model into the world frame first — or for nulling `crs`
  // when no world origin is known — so this writer never georeferences
  // recentred local coordinates.
  // The name must be a resolvable IDENTIFIER. `model.crs` is the parser's
  // DISPLAY label, and a reader that cannot resolve it falls back to the RFC
  // default of WGS84 — placing projected contours in the ocean rather than
  // failing. When no code can be recovered the member is omitted, which makes a
  // reader ask instead of quietly assuming. The measurement exporter already
  // works this way; this writer kept a pass-through that defeated it.
  const urn = model.crs ? sharedCrsUrn(model.crs) : null;
  if (urn) {
    obj.crs = { type: 'name', properties: { name: urn } };
  }
  return obj;
}

/** Serialise the model to a GeoJSON string. */
export function geojsonString(
  model: ContourFeatureModel,
  pretty = true,
  provenance?: ExportProvenance,
): string {
  return JSON.stringify(toGeoJSON(model, provenance), null, pretty ? 2 : 0);
}

/** Thrown when a standards-compliant GeoJSON cannot be produced honestly. */
export class GeoJsonFrameError extends Error {}

/**
 * A point in the source frame → WGS 84 `[lon, lat, elevation]`.
 * Throws (rather than approximating) for a point it cannot convert.
 */
export type ToLonLat = (p: readonly [number, number, number]) => [number, number, number];

/**
 * Build an RFC 7946 GeoJSON: WGS 84 longitude/latitude, and NO `crs` member.
 *
 * The native writer above emits projected coordinates and declares them with
 * the pre-RFC top-level `crs` member. RFC 7946 requires WGS 84 lon/lat and
 * REMOVED that member, so a compliant reader discards the only thing naming
 * the frame and then reads an easting of 517,047 as a longitude — it does not
 * error, it just puts the data somewhere impossible. Since the member cannot
 * carry the source frame any more, the source CRS is recorded in `metadata`
 * instead, where it is provenance rather than a positioning instruction.
 */
export function toGeoJSONWgs84(
  model: ContourFeatureModel,
  toLonLat: ToLonLat,
  provenance?: ExportProvenance,
): Record<string, unknown> {
  const obj = toGeoJSON(model, provenance);
  // The frame is degrees now, so the projected stamp would be a lie.
  delete obj.crs;
  const metadata = { ...(obj.metadata as Record<string, unknown>) };
  metadata.sourceCrs = model.crs ?? null;
  metadata.coordinateFrame =
    'WGS 84 longitude/latitude (RFC 7946). Reprojected from the source CRS named in sourceCrs; '
    + 'the native projected coordinates ship in the companion -native file.';
  obj.metadata = metadata;

  obj.features = (obj.features as Array<Record<string, unknown>>).map((f) => {
    const geom = f.geometry as { type: string; coordinates: number[][] };
    return {
      ...f,
      geometry: {
        ...geom,
        coordinates: geom.coordinates.map((c) =>
          toLonLat([c[0], c[1], c[2] ?? 0]),
        ),
      },
    };
  });
  return obj;
}

/** Serialise the model as RFC 7946 GeoJSON (WGS 84 degrees). */
export function geojsonStringWgs84(
  model: ContourFeatureModel,
  toLonLat: ToLonLat,
  pretty = true,
  provenance?: ExportProvenance,
): string {
  return JSON.stringify(toGeoJSONWgs84(model, toLonLat, provenance), null, pretty ? 2 : 0);
}
