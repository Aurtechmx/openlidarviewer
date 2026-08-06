/**
 * kmlActions.ts: the Products lane's two Google Earth exports, lifted out of
 * `main.ts`.
 *
 * Both write KML, both place local render-space coordinates through the same
 * resolved-CRS transform, and both must REFUSE rather than approximate when
 * that transform does not exist. Keeping them together (and out of the shell)
 * means the readiness rule and the export path for each product sit next to each
 * other, so a button cannot say "ready" for a reason the exporter does not
 * actually honour.
 *
 * They differ in what they claim, which is why they gate differently:
 *
 *   - The SITE file publishes annotations, measurements and saved views, so it
 *     needs at least one of those to carry.
 *   - The SCAN AREA file publishes only the outline of the capture, so it needs
 *     nothing placed. It does need a coordinate system the user has confirmed,
 *     because a polygon in lon/lat is a claim about where on Earth the scan is;
 *     `footprintCrsRefusal` owns that judgement and supplies the wording.
 *
 * The shell's running state arrives through {@link KmlActionDeps}, accessors
 * rather than snapshots, the same seam `reportExport.ts` uses. The heavy KML
 * serialiser is a lazy loader so this module stays off the boot graph.
 */

import { makeLocalToLonLat, LonLatConversionError } from '../export/lonLatMapper';
import {
  footprintCrsRefusal,
  footprintLonLatRing,
  footprintRectangleRing,
  ScanFootprintError,
  type FootprintExtent,
  type FootprintExtentBasis,
} from '../export/scanFootprint';
import type { KmlExportInput, KmlViewpoint } from '../export/kmlExport';
import type { GeoExportContext } from './reportExport';
import type { ResolvedCrs } from '../geo/CoordinateTypes';
import type { Annotation } from '../render/annotate/types';
import type { Measurement, Vec3 } from '../render/measure/types';
import type { loadKmlExport } from '../lazyChunks';

/** Whether a product can be exported right now, and why not when it cannot. */
export interface KmlActionStatus {
  readonly ready: boolean;
  readonly reason: string;
}

/**
 * The scan's horizontal extent plus a plain-language note on where it came
 * from. The note travels into the file: for a streaming scan the extent is the
 * DECLARED header extent, which can be wider than the points downloaded so far,
 * and a reader deserves to know which of the two they are holding.
 */
export interface ScanExtentReading {
  readonly extent: FootprintExtent;
  readonly basis: FootprintExtentBasis;
}

/** The shell state both exports read, as accessors evaluated at call time. */
export interface KmlActionDeps {
  /** False until the lazily-loaded Viewer chunk is in place. */
  readonly hasViewer: () => boolean;
  /** Origin + CRS label + name for the active scan, static or streaming. */
  readonly geo: () => GeoExportContext;
  /** The resolved CRS for the active scan, or null. */
  readonly crsCurrent: () => ResolvedCrs | null;
  /** Placed annotations, in LOCAL render space. */
  readonly annotations: () => readonly Annotation[];
  /** Placed measurements, in LOCAL render space. */
  readonly measurements: () => readonly Measurement[];
  /** Saved camera views, in LOCAL render space. */
  readonly viewpoints: () => readonly KmlViewpoint[];
  /** World up vector for the measurement metrics. */
  readonly worldUp: () => Vec3;
  /** Render-units to metres for the measurement metrics. */
  readonly unitToMetres: () => number;
  /** The active scan's horizontal extent in LOCAL space, or null when none. */
  readonly scanExtent: () => ScanExtentReading | null;
  /** A file name without its extension (the shell's `baseName`). */
  readonly baseName: (name: string) => string;
  /** Write a text file to the user's downloads. */
  readonly downloadText: (filename: string, text: string) => void;
  /** Surface a refusal to the user. */
  readonly setError: (message: string) => void;
  /** Lazily import the KML serialiser. */
  readonly loadKmlExport: typeof loadKmlExport;
}

/** The caveat every published product carries, verbatim across the exports. */
const NOT_SURVEY_GRADE =
  'Estimates only — not survey-grade. Validate against ground control where survey-grade accuracy is required.';

/** True when the resolved CRS is a real-world frame (projected / geographic). */
export function crsIsKnown(resolved: ResolvedCrs | null): boolean {
  return resolved != null && (resolved.kind === 'projected' || resolved.kind === 'geographic');
}

/**
 * Whether the SITE KML can be written, with the reason when it cannot.
 * Resolves origin/CRS for static AND streaming, because a georeferenced streaming scan
 * can place KML too.
 */
export function siteKmlStatus(deps: KmlActionDeps): KmlActionStatus {
  if (!deps.hasViewer()) return { ready: false, reason: 'Open a scan first.' };
  const geo = deps.geo();
  if (geo.name === null) return { ready: false, reason: 'KML needs a loaded, georeferenced scan.' };
  const features = deps.measurements().length + deps.annotations().length;
  if (features === 0) {
    return { ready: false, reason: 'Add a measurement or annotation to place on the map.' };
  }
  const resolved = deps.crsCurrent();
  if (!crsIsKnown(resolved)) {
    return {
      ready: false,
      reason: 'KML needs a georeferenced scan (it places features on a lat/lon map).',
    };
  }
  if (!makeLocalToLonLat(resolved, geo.origin)) {
    return {
      ready: false,
      reason: "This scan's CRS isn't supported for lat/lon export yet (UTM and geographic are).",
    };
  }
  return { ready: true, reason: '' };
}

/** Write the site KML: annotations, measurements and saved views. */
export async function exportSiteKml(deps: KmlActionDeps): Promise<void> {
  if (!deps.hasViewer()) return;
  const geo = deps.geo();
  const crs = deps.crsCurrent();
  const toLonLat = makeLocalToLonLat(crs, geo.origin);
  if (!toLonLat) return; // gated by siteKmlStatus; defensive no-op if reached
  const { buildKml, KmlCoordinateError } = await deps.loadKmlExport();
  const input: KmlExportInput = {
    annotations: deps.annotations(),
    measurements: deps.measurements(),
    // Saved views become <LookAt> placemarks in the same LOCAL render frame as
    // the measurements, so the injected transform places them correctly.
    viewpoints: deps.viewpoints(),
    crsName: geo.crsName ?? crs?.name ?? null,
    // The exporter reports metres (keys end in _m); unitToMetres scales render
    // units, so the label is always metres.
    unitLabel: 'm',
    up: deps.worldUp(),
    unitToMetres: deps.unitToMetres(),
    // The RESOLVED vertical unit, not the measurement controller's. That one
    // falls back to the horizontal factor when the CRS declares no vertical
    // unit of its own: harmless for on-screen measurement, wrong for a
    // published file, where it would let a foot-based scan look metric and be
    // stamped as absolute metres above sea level.
    verticalUnitToMetres: crs?.verticalUnitToMetres,
    // Drives the geometry's altitudeMode: absolute only for a declared metric
    // vertical datum, otherwise clamped with the reason stated.
    verticalDatum: crs?.verticalDatum ?? null,
    toLonLat,
    notSurveyGradeNote: NOT_SURVEY_GRADE,
  };
  const stem = geo.name ? deps.baseName(geo.name) : 'site';
  let text: string;
  try {
    text = buildKml(input);
  } catch (err) {
    // Every KML coordinate is geographic by specification, so one unconvertible
    // point makes the whole file wrong. Decline it. Both refusals mean the same
    // thing to the user: something in this scan has no honest place on a map.
    // The mapper raises the first when a point leaves the projection's domain;
    // the exporter raises the second when a value reaches it that is not a real
    // geographic position.
    if (err instanceof LonLatConversionError || err instanceof KmlCoordinateError) {
      deps.setError(
        `KML export stopped: a point could not be placed in longitude/latitude. ${err.message}`,
      );
      return;
    }
    throw err;
  }
  deps.downloadText(`${stem}.kml`, text);
}

/**
 * Whether the SCAN AREA polygon can be written, with the reason when it cannot.
 *
 * The CRS gate is the strict one and it speaks for itself: `footprintCrsRefusal`
 * returns the sentence the user reads, so the button's disabled reason and the
 * export's refusal message are the same words from the same rule.
 */
export function scanFootprintStatus(deps: KmlActionDeps): KmlActionStatus {
  if (!deps.hasViewer()) return { ready: false, reason: 'Open a scan first.' };
  const geo = deps.geo();
  if (geo.name === null) return { ready: false, reason: 'Open a scan first.' };
  const refusal = footprintCrsRefusal(deps.crsCurrent());
  if (refusal) return { ready: false, reason: refusal };
  if (!makeLocalToLonLat(deps.crsCurrent(), geo.origin)) {
    return {
      ready: false,
      reason: "This scan's CRS isn't supported for lat/lon export yet (UTM and geographic are).",
    };
  }
  if (!deps.scanExtent()) {
    return { ready: false, reason: 'The scan has no measured extent to outline yet.' };
  }
  return { ready: true, reason: '' };
}

/** Write the scanned area as a KML polygon (bounding rectangle, WGS84). */
export async function exportScanFootprintKml(deps: KmlActionDeps): Promise<void> {
  if (!deps.hasViewer()) return;
  const geo = deps.geo();
  const crs = deps.crsCurrent();
  const stem = geo.name ? deps.baseName(geo.name) : 'scan';
  // Re-checked here, not just at the button: the CRS can be overridden between
  // the render that enabled the control and the click that uses it.
  const refusal = footprintCrsRefusal(crs);
  if (refusal) {
    deps.setError(`Scan area export stopped. ${refusal}`);
    return;
  }
  const reading = deps.scanExtent();
  if (!reading) {
    deps.setError('Scan area export stopped. The scan has no measured extent to outline yet.');
    return;
  }
  const { buildFootprintKml, KmlCoordinateError } = await deps.loadKmlExport();
  let text: string;
  try {
    text = buildFootprintKml({
      name: stem,
      ring: footprintLonLatRing(
        footprintRectangleRing(reading.extent),
        makeLocalToLonLat(crs, geo.origin),
      ),
      crsName: geo.crsName ?? crs?.name ?? null,
      extentBasis: reading.basis,
      notSurveyGradeNote: NOT_SURVEY_GRADE,
    });
  } catch (err) {
    // Same contract as the site file: a corner that cannot be placed makes the
    // polygon wrong rather than incomplete, so nothing is written.
    if (
      err instanceof ScanFootprintError
      || err instanceof LonLatConversionError
      || err instanceof KmlCoordinateError
    ) {
      deps.setError(`Scan area export stopped. ${err.message}`);
      return;
    }
    throw err;
  }
  deps.downloadText(`${stem}-scan-area.kml`, text);
}
