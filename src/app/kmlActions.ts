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
 *     `footprintCrsRefusal` owns that judgement and supplies the wording. It
 *     also needs the extent's own two axes to BE the horizontal plane, which
 *     only holds for a Z-up frame — `footprintUpAxisRefusal` owns that half.
 *
 * The shell's running state arrives through {@link KmlActionDeps}, accessors
 * rather than snapshots, the same seam `reportExport.ts` uses. The heavy KML
 * serialiser is a lazy loader so this module stays off the boot graph.
 */

import { makeLocalToLonLat, LonLatConversionError } from '../export/lonLatMapper';
import {
  footprintCrsRefusal,
  footprintConvexHullRing,
  footprintLonLatRing,
  footprintRectangleRing,
  footprintUpAxisRefusal,
  ScanFootprintError,
  type FootprintExtent,
  type FootprintExtentBasis,
} from '../export/scanFootprint';
import type { KmlExportInput, KmlViewpoint } from '../export/kmlExport';
import type { GeoExportContext } from './reportExport';
import type { ResolvedCrs } from '../geo/CoordinateTypes';
import type { SpatialUpAxis } from '../geo/SpatialContext';
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
 *
 * `upAxis` travels with it because the extent is read off local X/Y, and X/Y is
 * the horizontal plane only in a Z-up frame. A reading with no stated axis is a
 * reading nobody can check, so the field is required rather than optional and
 * `'unknown'` is a real answer the gate refuses — see `footprintUpAxisRefusal`.
 */
export interface ScanExtentReading {
  readonly extent: FootprintExtent;
  readonly basis: FootprintExtentBasis;
  readonly upAxis: SpatialUpAxis;
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
  /**
   * The active scan's resident points as an interleaved local `xyz` buffer, for
   * the tighter convex-hull outline — or null when it must fall back to the
   * bounding rectangle. Null for a streaming scan (its resident set is a subset
   * of the declared extent, so its hull would understate the area) and for any
   * non-Z-up frame (already refused upstream). Read at click time only, never
   * during the status check that renders the button.
   */
  readonly scanHullPositions: () => Float32Array | null;
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
  // Every input is read BEFORE the serialiser import. The origin and CRS above
  // were already captured pre-await while the features, up vector and unit scale
  // were read after it, so a placement made (or a scan opened) during the import
  // produced a file mixing one moment's frame with another's contents. One
  // reading of the session, then the load.
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
  const { buildKml, KmlCoordinateError } = await deps.loadKmlExport();
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
  const reading = deps.scanExtent();
  if (!reading) {
    return { ready: false, reason: 'The scan has no measured extent to outline yet.' };
  }
  // The frame the extent was measured in, checked at the button for the same
  // reason the CRS is: a disabled control that states the real obstacle is
  // better than an enabled one that fails at the click.
  const axisRefusal = footprintUpAxisRefusal(reading.upAxis);
  if (axisRefusal) return { ready: false, reason: axisRefusal };
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
  // Re-checked here for the same reason the CRS gate is: the active scan can
  // change between the render that enabled the control and the click that uses
  // it, and a Y-up scan's X/Y rectangle is exactly the kind of wrong answer
  // that still looks right in Google Earth.
  const axisRefusal = footprintUpAxisRefusal(reading.upAxis);
  if (axisRefusal) {
    deps.setError(`Scan area export stopped. ${axisRefusal}`);
    return;
  }
  // Prefer the true outline (convex hull of the resident points) when the scan
  // can back one; fall back to the extent's bounding rectangle otherwise. A
  // degenerate hull (too few points, collinear) throws ScanFootprintError, which
  // the shared catch below turns into a refusal — it does NOT silently drop to
  // the rectangle, because a scan whose points enclose no area has no honest
  // outline of either shape.
  //
  // Read BEFORE the loader await, with the CRS, origin and extent it belongs
  // to. It was read after, so a scan swap during the lazy import produced a
  // polygon from B's points labelled with A's CRS and extent — the sibling site
  // export already captures its whole input before loading the serializer.
  const hullPositions = deps.scanHullPositions();
  const { buildFootprintKml, KmlCoordinateError } = await deps.loadKmlExport();
  let text: string;
  try {
    const localRing = hullPositions
      ? footprintConvexHullRing(hullPositions)
      : footprintRectangleRing(reading.extent);
    text = buildFootprintKml({
      name: stem,
      ring: footprintLonLatRing(localRing, makeLocalToLonLat(crs, geo.origin)),
      crsName: geo.crsName ?? crs?.name ?? null,
      extentBasis: reading.basis,
      shape: hullPositions ? 'point-cloud outline' : 'bounding rectangle',
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
