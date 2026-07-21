/**
 * contourDownload.ts
 *
 * Integration helper — turn a contour feature model into a downloadable
 * file. The serialisation half is pure data (testable); the browser
 * trigger half is a thin, guarded DOM call kept separate so everything
 * worth testing stays testable.
 *
 * Formats: GeoJSON (cheapest real downstream path), SVG (print), DXF
 * (CAD). PDF is produced by the report subsystem, not here.
 */

import {
  shiftFeatureModelToWorld,
  type ContourFeatureModel,
  type ContourWorldOrigin,
} from './contourFeatureModel';
import type { ContourLabel } from './labelPlacement';
import { geojsonString, geojsonStringWgs84, GeoJsonFrameError, type ToLonLat } from './geojsonContours';
import { epsgFromCrsLabel } from '../../export/crsIdentifier';
import { svgContours } from './svgContours';
import { dxfContours, type DxfLinearUnit } from './dxfContours';
import type { ExportProvenance } from '../export/exportProvenance';
import { triggerDownload } from '../../io/download';

/** Supported pure-data export formats. */
/**
 * `geojson` is RFC 7946 — WGS 84 degrees, no `crs` member — because that is
 * what the extension promises a reader. `geojson-native` keeps the source
 * projected frame and the pre-RFC `crs` member for GIS that wants the survey
 * grid, under a filename that says so.
 */
export type ContourFormat = 'geojson' | 'geojson-native' | 'svg' | 'dxf';

/** A serialised file ready to download. */
export interface ContourFile {
  readonly filename: string;
  readonly mime: string;
  readonly content: string;
}

const EXT: Record<ContourFormat, string> = { geojson: 'geojson', 'geojson-native': 'geojson', svg: 'svg', dxf: 'dxf' };
const MIME: Record<ContourFormat, string> = {
  geojson: 'application/geo+json',
  'geojson-native': 'application/geo+json',
  svg: 'image/svg+xml',
  dxf: 'application/dxf',
};

/**
 * Warning stamped onto an export whose caller could not supply a world
 * origin. Exported so tests / callers can match it without duplicating
 * the wording.
 */
export const LOCAL_FRAME_WARNING =
  'World origin unknown — coordinates are in the local (recentred) scan frame; CRS stamp omitted (local frame).';

/** Serialise a model to a named file in the requested format. Pure data. */
export function serializeContours(
  model: ContourFeatureModel,
  format: ContourFormat,
  opts: {
    basename?: string;
    labels?: ReadonlyArray<ContourLabel>;
    /** Unified provenance, stamped identically into whichever format is chosen. */
    provenance?: ExportProvenance;
    /**
     * World-frame origin the loader subtracted on load. When supplied, every
     * coordinate (and elevation, when `z` is present) is shifted back into
     * the model's CRS frame before serialisation — the same registration the
     * DEM package applies. When absent/null the geometry is left in the
     * LOCAL frame and the CRS stamp is OMITTED: stamping a real EPSG code on
     * recentred coordinates made a GIS drop the contours at the CRS origin
     * (v0.4.3 bug).
     */
    worldOrigin?: ContourWorldOrigin | null;
    /**
     * Resolved linear unit of the horizontal CRS. Drives the DXF `$INSUNITS`
     * header and the SVG scale note. Default 'metre' (the stack's standing
     * assumption); pass the resolved unit for feet-based CRSs.
     */
    linearUnit?: DxfLinearUnit;
    /**
     * Source frame → WGS 84 lon/lat. REQUIRED by the RFC 7946 `geojson`
     * format, which cannot be written honestly without it. Absent means the
     * export refuses rather than emitting projected numbers as degrees.
     */
    toLonLat?: ToLonLat;
  } = {},
): ContourFile {
  const basename = opts.basename ?? 'contours';

  // ── Frame registration (world vs local) ───────────────────────────────
  let exportModel = model;
  let exportLabels = opts.labels;
  const origin = opts.worldOrigin;
  if (origin) {
    exportModel = shiftFeatureModelToWorld(model, origin);
    // Labels are placed in the same local frame as the geometry — shift
    // them identically so they stay on their lines (and state the world
    // elevation when a vertical origin is known).
    const oz = origin.z ?? 0;
    exportLabels = opts.labels?.map((l) => ({
      ...l,
      x: l.x + origin.x,
      y: l.y + origin.y,
      value: l.value + oz,
    }));
  } else if (model.crs != null) {
    // Honest fallback: never stamp an EPSG code on local coordinates.
    exportModel = {
      ...model,
      crs: null,
      warnings: [...model.warnings, LOCAL_FRAME_WARNING],
    };
  }

  // Unit stamp for the human-facing formats. 'metre' is the standing default;
  // the abbreviation feeds the SVG's visible scale note.
  const linearUnit = opts.linearUnit ?? 'metre';
  const unitLabel =
    linearUnit === 'foot' ? 'ft' : linearUnit === 'us-survey-foot' ? 'ftUS' : linearUnit === 'unknown' ? 'unit' : 'm';

  let content: string;
  switch (format) {
    case 'geojson':
      if (!opts.toLonLat) {
        throw new GeoJsonFrameError(
          'Cannot write RFC 7946 GeoJSON: no conversion to WGS 84 longitude/latitude is '
          + 'available for this CRS. Export the native-frame GeoJSON instead.',
        );
      }
      content = geojsonStringWgs84(exportModel, opts.toLonLat, true, opts.provenance);
      break;
    case 'geojson-native':
      content = geojsonString(exportModel, true, opts.provenance);
      break;
    case 'svg':
      content = svgContours(exportModel, {
        labels: exportLabels,
        provenance: opts.provenance,
        unitLabel,
      });
      break;
    case 'dxf':
      // Labels ride into the DXF too (their own TEXT layer), shifted into the
      // same frame as the geometry above.
      content = dxfContours(exportModel, {
        provenance: opts.provenance,
        labels: exportLabels,
        linearUnit,
      });
      break;
  }
  // The native file must be distinguishable at a glance from the RFC one —
  // two files with the same extension in one folder is how the wrong frame
  // gets loaded.
  const code = format === 'geojson-native' ? epsgFromCrsLabel(exportModel.crs ?? '') : null;
  const stem = format === 'geojson-native' ? `${basename}-native${code ? `-EPSG${code}` : ''}` : basename;
  return { filename: `${stem}.${EXT[format]}`, mime: MIME[format], content };
}

/**
 * Trigger a browser download for a serialised file. DOM-only; no-op
 * outside a browser (returns false so callers can detect it). Kept out
 * of the pure path on purpose.
 */
export function triggerBrowserDownload(file: ContourFile): boolean {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
    return false;
  }
  // Shared helper defers the object-URL revoke (Safari / iOS / large-blob safe).
  triggerDownload(new Blob([file.content], { type: file.mime }), file.filename);
  return true;
}
