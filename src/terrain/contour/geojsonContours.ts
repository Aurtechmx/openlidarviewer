/**
 * geojsonContours.ts
 *
 * the cheapest real downstream path. Emits the contour feature
 * model as GeoJSON that QGIS / Civil 3D (via QGIS) ingest directly. Each
 * single-grade run becomes a LineString Feature carrying its elevation,
 * evidence grade, index flag, and confidence, so the recipient can style
 * or filter the uncertain spans rather than trusting one flat line.
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

/** Convert "EPSG:32610" → an OGC URN; pass through anything else. */
function crsUrn(crs: string): string {
  const m = /^EPSG:(\d+)$/i.exec(crs.trim());
  return m ? `urn:ogc:def:crs:EPSG::${m[1]}` : crs;
}

/** Build the GeoJSON object (foreign members included for provenance). */
export function toGeoJSON(model: ContourFeatureModel): Record<string, unknown> {
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
      coordinates: f.coordinates,
    },
  }));

  const obj: Record<string, unknown> = {
    type: 'FeatureCollection',
    name: 'contours',
    // Foreign members carry honest provenance into the file itself.
    metadata: {
      intervalM: model.intervalM,
      verticalDatum: model.verticalDatum,
      coverageMode: model.coverageMode,
      interpolatedFraction: Number.isFinite(model.interpolatedFraction)
        ? Math.round(model.interpolatedFraction * 1000) / 1000
        : null,
      warnings: model.warnings,
      notSurveyGrade: 'Not survey-grade unless validated against ground-truth control.',
    },
    features,
  };
  if (model.crs) {
    obj.crs = { type: 'name', properties: { name: crsUrn(model.crs) } };
  }
  return obj;
}

/** Serialise the model to a GeoJSON string. */
export function geojsonString(model: ContourFeatureModel, pretty = true): string {
  return JSON.stringify(toGeoJSON(model), null, pretty ? 2 : 0);
}
