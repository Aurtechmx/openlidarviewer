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

/** Convert a CRS label to an OGC URN; pass through anything with no code. */
function crsUrn(crs: string): string {
  return sharedCrsUrn(crs) ?? crs;
}

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
  if (model.crs) {
    obj.crs = { type: 'name', properties: { name: crsUrn(model.crs) } };
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
