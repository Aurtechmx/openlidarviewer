/**
 * measurementExportActions.ts
 *
 * The two measurement-deliverable exports the Export panel drives — the open
 * GeoJSON/CSV file and the signed integrity report — lifted out of the
 * composition root so `main.ts` wires them in one line each. Both read the live
 * measure state and the resolved export frame at one instant, build the shared
 * export context (unit / up-axis / verified-scale aware), and hand off to the
 * pure serializers. Kept as free functions over an explicit deps object so the
 * orchestration is testable without the whole app.
 */

import type { Measurement, Vec3 } from '../render/measure/types';
import type { GeoJsonLonLat, MeasurementExportContext } from '../export/measurementExport';
import type { SpatialUpAxis } from '../geo/SpatialContext';
import type { ReportFinding } from '../render/measure/reportManifest';
import type { GeoExportContext } from './reportExport';
import { framesOfApp, resolveOwnerFrame, type AppFrameSource, type ExportFrame, type OwnerRef } from './measurementExportFrame';
import { measurementsOwnedByActive, ownershipOf, partitionSessionWork, type OwnershipView } from './measurementOwnership';

import { activeScanBasisOf, type ActiveScanBasis } from './measurementScanHooks';
import { appToast } from '../ui/panelChrome';
import { resolveLocalToLonLat, LonLatConversionError } from '../export/lonLatMapper';
import { lonLatUpAxisRefusal } from '../export/scanFootprint';
import { resolveVerticalEpsg } from '../geo/height';
import { UNIT_FACTORS } from '../units/units';
import type { ResolvedCrs } from '../geo/CoordinateTypes';
import { SigningError } from '../export/reportSignature';
import { reportSignerLabel, reportSigningRequested } from '../export/reportSigningState';

export type { ActiveScanBasis } from './measurementScanHooks';

/** The slice of the measure controller these exports read. */
export interface MeasureExportView {
  getMeasurements(): readonly Measurement[];
  readonly worldUp: Vec3;
  /**
   * The up vector a measurement's figures are read along: its own layer's
   * (Z for a survey, Y for a mesh scan), not the scene's. Absent: `worldUp`.
   */
  upFor?(m: Measurement): Vec3;
  readonly unitToMetres: number;
  readonly verticalUnitToMetres: number;
  /** True when the scan's linear scale is known — drives the M1 units caveat. */
  readonly crsKnown: boolean;
  /**
   * True when the horizontal frame is ANGULAR (lon/lat degrees).
   *
   * The controller has always tracked this and grades measurements on it, but
   * the export view did not expose it, so the export hardcoded `false`. Two
   * things went wrong from that: the GeoJSON kept a named CRS member it should
   * have suppressed, and a degree difference was carried into the metre-named
   * columns by a scalar factor that cannot exist for an angular frame.
   */
  readonly geographicCrs: boolean;
  /**
   * True when the frame has no valid local vertical (geocentric, depth-down):
   * `SpatialContext.verticalMetricRefused`, as the live controller holds it.
   * Absent reads false.
   */
  readonly verticalRefused?: boolean;
}

export interface MeasurementExportActionDeps {
  readonly measure: MeasureExportView;
  /** Resolved export frame (origin + resolved CRS label + name), read once. */
  readonly geo: () => GeoExportContext;
  readonly baseName: (name: string) => string;
  readonly downloadText: (filename: string, text: string) => void;
  readonly loadMeasurementExport: () => Promise<
    Pick<typeof import('../export/measurementExport'), 'measurementsToGeoJSON' | 'measurementsToCsv' | 'measurementCsvProvenance' | 'provenanceSidecarName' | 'resolveExportDigests'>
  >;
  readonly loadMeasurementReport: () => Promise<
    Pick<
      typeof import('../export/measurementReport'),
      'integrityReportFile' | 'measurementsToFindings' | 'findingsReportFile' | 'resolveExportDigests'
    > &
      Partial<Pick<typeof import('../export/measurementReport'), 'signReportText'>>
  >;
  /**
   * Every open layer, for placing each measurement through the layer it was
   * taken on. Omitted or a single layer: the active frame from `geo()`.
   */
  readonly layers?: { readonly view: ExportLayerView; readonly stableIdFor: (viewerId: string) => string | null };
  /**
   * The complete export frame of any open scan (origin, resolved CRS, unit
   * scales, up-axis, labels). With several scans open, a measurement is exported
   * through the frame of the scan it was taken on, never the active scan's.
   * Omitted: the active frame from `geo()` and the measure view, as before.
   */
  readonly frameSource?: AppFrameSource;
  /**
   * The resolved up-axis of the active scan. The GeoJSON places X/Y as the
   * ground plane, so it refuses a frame that is not Z-up, as the KML does.
   */
  readonly upAxis?: () => SpatialUpAxis;
  /** Shown when the export is refused rather than written. */
  readonly refuse?: (message: string) => void;
  /** Shown after a write. Defaults to the app's toast line. */
  readonly notify?: (message: string) => void;
  /** Active scan's classification epoch (0 when none), for the report manifest. */
  readonly activeClassificationEpoch: () => number;
  /**
   * The active scan's point basis line and class-edit state, for the CSV's
   * provenance sidecar; null when no scan is active. Defaults to reading the
   * export frame's source and the active classification epoch.
   */
  readonly activeScanBasis?: () => ActiveScanBasis | null;
  readonly appVersion: string;
  /** ISO timestamp source — injected so the report build stays deterministic. */
  readonly now: () => string;
}

/** One open layer, as the measurement export places points through it. */
export interface ExportLayer {
  /** The viewer's id for the layer. */
  readonly viewerId: string;
  /** Stable layer id (`model/layerIdentity`), or null when none was bound. */
  readonly stableId: string | null;
  /** Display name: the file name. */
  readonly name: string;
  readonly sourceOrigin: readonly [number, number, number];
  /** source-local to project-local offset, or null when the layer is unplaced. */
  readonly projectOffset: readonly [number, number, number] | null;
  /** The CRS the layer's file declares, or null. */
  readonly crsName: string | null;
}

/** The slice of the viewer the layer read needs. */
export interface ExportLayerView {
  clouds(): readonly string[];
  getCloud(id: string): { readonly name: string; readonly sourceOrigin: readonly [number, number, number]; readonly metadata?: { readonly crs?: { readonly name?: string } | null } | null } | undefined;
  layerProjectOffset(id: string): readonly [number, number, number] | null;
}

/** The open layers of a viewer, read once for an export. */
export function exportLayersOf(v: ExportLayerView, stableIdFor: (viewerId: string) => string | null): ExportLayer[] {
  const out: ExportLayer[] = [];
  for (const id of v.clouds()) {
    const c = v.getCloud(id);
    if (!c) continue;
    out.push({ viewerId: id, stableId: stableIdFor(id), name: c.name, sourceOrigin: c.sourceOrigin, projectOffset: v.layerProjectOffset(id), crsName: c.metadata?.crs?.name ?? null });
  }
  return out;
}

/** Where one measurement's points leave: the world offset to add, and its scans. */
interface Placed {
  readonly base: readonly [number, number, number];
  readonly names: readonly string[];
  readonly owners: readonly OwnerRef[];
}

/**
 * With several layers open, each measurement is placed through the layers its
 * points were picked on, or through its owner when no pick was recorded (a
 * restored or programmatic measurement). A point leaves as the point less its
 * layer's placement offset plus its file origin; a `source-local` owner's
 * points are already in that layer's frame. A measurement whose layer is
 * unknown, one whose points sit on layers that place it differently (heights
 * not in one frame, or an unmounted layer), or a set across different declared
 * CRSs has no single honest position, so the export is refused.
 */
function ownLayers(
  measurements: readonly Measurement[],
  layers: readonly ExportLayer[],
  /** False when the per-scan frame check runs instead, so it can name the scans. */
  declaredCrsCheck: boolean,
  /** The layer a measurement recording no scan was taken on, when that is known. */
  fallbackLayerId: string | null = null,
): { byId: Map<string, Placed> } | { refused: string } {
  const byId = new Map<string, Placed>();
  let unknown = 0;
  const split: string[] = [];
  const crs = new Set<string | null>();
  // A measurement with no recorded pick (restored, or placed without one) is
  // placed through its owner only when every open layer places a point the same
  // way; otherwise its layer would be a guess.
  const baseOf = (l: ExportLayer): number[] => l.sourceOrigin.map((o, i) => o - (l.projectOffset?.[i] ?? 0));
  const oneFrame = layers.every((l) => baseOf(l).every((c, i) => Math.abs(c - baseOf(layers[0]!)[i]!) <= 1e-6));
  for (const m of measurements) {
    const picked = m.pickLayers && m.pickLayers.length > 0;
    if (!picked && !oneFrame) {
      unknown++;
      continue;
    }
    const ids = picked ? m.pickLayers! : m.owner?.layerId ? [m.owner.layerId] : fallbackLayerId ? [fallbackLayerId] : [];
    const ls = ids.map((id) => layers.find((x) => x.stableId === id));
    if (ls.length === 0 || ls.some((l) => !l)) {
      unknown++;
      continue;
    }
    const local = !picked && m.owner?.frame === 'source-local';
    const bases = (ls as ExportLayer[]).map((l): [number, number, number] => {
      const d = local ? [0, 0, 0] : l.projectOffset ?? [0, 0, 0];
      return [l.sourceOrigin[0] - d[0], l.sourceOrigin[1] - d[1], l.sourceOrigin[2] - d[2]];
    });
    if (bases.some((v) => v.some((c, i) => Math.abs(c - bases[0]![i]!) > 1e-6))) split.push(m.name);
    for (const l of ls) crs.add(l!.crsName);
    byId.set(m.id, { base: bases[0]!, names: [...new Set(ls.map((l) => l!.name))].sort((a, b) => a.localeCompare(b)), owners: (ls as ExportLayer[]).map((l) => ({ viewerId: l.viewerId, name: l.name })) });
  }
  if (unknown > 0) {
    return { refused: `Not exported: ${unknown} of ${measurements.length} measurements have no record of the scan their points were picked on, so their coordinates cannot be placed. Close every scan but the one the measurements were taken on, then export again.` };
  }
  if (split.length > 0) {
    return { refused: `Not exported: ${split.join(', ')} has points on scans whose heights are not in one frame. Delete it or measure on one scan, then export again.` };
  }
  if (declaredCrsCheck && crs.size > 1) {
    return { refused: 'Not exported: the measurements come from scans with different coordinate systems. Export them one scan at a time.' };
  }
  return { byId };
}

/**
 * The one open layer, when it is the active scan and still placed in the
 * project frame (its anchor closed, the frame kept). Its scene coordinates are
 * then local to the project origin, not its file origin, so its points leave
 * through {@link ownLayers} like any multi-layer export. Null otherwise.
 */
function solePlacedLayer(layers: readonly ExportLayer[], deps: MeasurementExportActionDeps): ExportLayer | null {
  const l = layers.length === 1 ? layers[0]! : null;
  if (!l?.projectOffset || l.projectOffset.every((c) => c === 0)) return null;
  return !deps.frameSource || deps.frameSource.activeId() === l.viewerId ? l : null;
}

/**
 * The measure state an export reads, copied at one instant. Taken before the
 * first await, so a scan swap or unit change while the serializer chunk loads
 * cannot pair one scan's geometry with another scan's scale or up axis.
 */
interface MeasureSnapshot {
  readonly measurements: readonly Measurement[];
  readonly worldUp: Vec3;
  /** Each measurement's own layer up, by id, read with the rest. */
  readonly upOf: ReadonlyMap<string, Vec3>;
  readonly unitToMetres: number;
  readonly verticalUnitToMetres: number;
  readonly geographicCrs: boolean;
  readonly verticalRefused: boolean;
  /** Linear scale known and the frame not angular: the metre columns are real metres. */
  readonly unitsVerified: boolean;
}

function snapshotMeasure(measure: MeasureExportView): MeasureSnapshot {
  const measurements = measure.getMeasurements().map((m) => structuredClone(m));
  const w = measure.worldUp;
  const upOf = new Map(measure.getMeasurements().map((m): [string, Vec3] => {
    const u = measure.upFor ? measure.upFor(m) : w;
    return [m.id, [u[0], u[1], u[2]]];
  }));
  return {
    measurements,
    worldUp: [w[0], w[1], w[2]],
    upOf,
    unitToMetres: measure.unitToMetres,
    verticalUnitToMetres: measure.verticalUnitToMetres,
    geographicCrs: measure.geographicCrs,
    verticalRefused: measure.verticalRefused === true,
    unitsVerified: measure.crsKnown && !measure.geographicCrs,
  };
}

/**
 * The one up axis a set of measurements is written along: each one's own
 * layer up. A file has one up; measurements on layers with different up axes
 * (a Z-up survey and a Y-up scan) are refused rather than written along one.
 */
function sharedUp(measurements: readonly Measurement[], snap: MeasureSnapshot): Vec3 | { refused: string } {
  const ups = measurements.map((m) => snap.upOf.get(m.id) ?? snap.worldUp);
  const first = ups[0] ?? snap.worldUp;
  if (ups.every((u) => u[0] === first[0] && u[1] === first[1] && u[2] === first[2])) return first;
  return { refused: 'Not exported: the measurements sit on layers with different up axes, so their heights do not share one vertical. Export one scan\'s measurements at a time.' };
}

/**
 * The open layers and the active scan, for deciding which measurements a
 * scan-specific output (the findings ledger) may hold. With no frame source,
 * the one open layer is the active scan.
 */
function ownershipViewFor(deps: MeasurementExportActionDeps): OwnershipView {
  const layers = deps.layers ? exportLayersOf(deps.layers.view, deps.layers.stableIdFor) : [];
  const activeViewerId = deps.frameSource ? deps.frameSource.activeId() : layers.length === 1 ? layers[0]!.viewerId : null;
  return { layers: layers.map((l) => ({ viewerId: l.viewerId, stableId: l.stableId, name: l.name })), activeViewerId };
}

/**
 * The measurements a file export may hold, by the rule the session uses
 * ({@link partitionSessionWork}): work that names a scan that is no longer
 * open, or a scan more than one open layer matches, has no frame to be written
 * in. It holds no layer of the scene, so it is never placed through the active
 * scan's origin or named after it. This holds with no static layer open too: a
 * streamed scan's own work records no scan, and work left from a replaced scan
 * names one that is gone.
 *
 * The rest is kept and the left-out work is counted in `withheld`. When nothing
 * is left, the export is refused with the sentence that says what to do, and
 * `kept` is null.
 */
function exportableMeasurements(
  measurements: readonly Measurement[],
  deps: MeasurementExportActionDeps,
): { kept: Measurement[]; withheld: string | null } | { kept: null } {
  const view = ownershipViewFor(deps);
  const { keep } = partitionSessionWork(measurements, view);
  if (keep.length === measurements.length) return { kept: keep, withheld: null };
  const left = measurements.filter((m) => !keep.includes(m));
  if (keep.length > 0) return { kept: keep, withheld: measurementsOwnedByActive(left, view).withheld };
  const shared = left.filter((m) => ownershipOf(m, view).kind === 'ambiguous').length;
  if (shared > 0) {
    deps.refuse?.(`Not exported: ${shared} ${shared === 1 ? 'measurement names' : 'measurements name'} a scan that more than one open scan matches. Close all but one of those scans, then export again.`);
  } else {
    const closed = left.length;
    deps.refuse?.(`Not exported: ${closed} ${closed === 1 ? 'measurement was' : 'measurements were'} taken on a scan that is no longer open. Reopen it or delete them, then export again.`);
  }
  return { kept: null };
}

/**
 * The frame of the scan(s) the measurements were taken on, for the report
 * exports: null (keep the active frame) with one scan open, no frame source, or
 * no measurement naming a scan; the refusal sentence when the owners do not
 * share a frame. Unowned measurements keep meaning the active scan.
 */
function ownerFrameFor(
  measurements: readonly Measurement[],
  deps: MeasurementExportActionDeps,
): { frame: ExportFrame | null; owners: readonly OwnerRef[] } | { refused: string } {
  const layers = deps.layers ? exportLayersOf(deps.layers.view, deps.layers.stableIdFor) : [];
  if (!deps.frameSource || layers.length < 2) return { frame: null, owners: [] };
  const entries = measurements.map((m): OwnerRef[] => {
    const ids = m.pickLayers && m.pickLayers.length > 0 ? m.pickLayers : m.owner?.layerId ? [m.owner.layerId] : [];
    return ids.flatMap((id) => layers.filter((l) => l.stableId === id).map((l) => ({ viewerId: l.viewerId, name: l.name })));
  });
  return resolveOwnerFrame(entries, framesOfApp(deps.frameSource));
}

/** Export the placed measurements as an open GeoJSON or CSV file. */
export async function exportMeasurementsFile(
  format: 'geojson' | 'csv',
  deps: MeasurementExportActionDeps,
): Promise<void> {
  // Everything the file is built from is read here, before the first await.
  const snap = snapshotMeasure(deps.measure);
  if (snap.measurements.length === 0) return;
  const layers = deps.layers ? exportLayersOf(deps.layers.view, deps.layers.stableIdFor) : [];
  const exportable = exportableMeasurements(snap.measurements, deps);
  if (!exportable.kept) return;
  const measurements = exportable.kept;
  const withheld = exportable.withheld;
  const up = sharedUp(measurements, snap);
  if ('refused' in up) {
    deps.refuse?.(up.refused);
    return;
  }
  const sole = solePlacedLayer(layers, deps);
  const own = layers.length > 1 || sole ? ownLayers(measurements, layers, !deps.frameSource, sole?.stableId ?? null) : null;
  if (own && 'refused' in own) {
    deps.refuse?.(own.refused);
    return;
  }
  // Several scans: the file is described by the frame of the scan(s) the
  // measurements were taken on, and refused when they do not share one.
  let owned: ExportFrame | null = null;
  let ownerCount = 0;
  if (own && deps.frameSource) {
    const r = resolveOwnerFrame(measurements.map((m) => own.byId.get(m.id)!.owners), framesOfApp(deps.frameSource));
    if ('refused' in r) {
      deps.refuse?.(r.refused);
      return;
    }
    owned = r.frame;
    ownerCount = r.owners.length;
  }
  // Measurement points are LOCAL (recentered); add the origin back to land them
  // in the source projected/local frame. `geo()` resolves the origin for
  // streaming scans too (renderOrigin) — a static-only read would export at
  // render-frame coordinates.
  const activeGeo = deps.geo();
  const geo = owned ? owned.geo : activeGeo;
  const origin: [number, number, number] = [geo.origin[0], geo.origin[1], geo.origin[2]];
  const generatedAt = deps.now();
  let lonLat: GeoJsonLonLat | undefined;
  if (format === 'geojson') {
    const placed = geoJsonLonLat(geo, owned ? owned.upAxis : deps.upAxis?.() ?? 'unknown');
    if ('refused' in placed) {
      deps.refuse?.(placed.refused);
      return;
    }
    lonLat = placed.lonLat;
  }
  // Several layers: each point leaves through its own layer, undoing that
  // layer's placement and adding its file origin. The file names the sources
  // it holds; the digest and data basis describe the active scan, so they are
  // stated only when it is the one source.
  const sources = own ? [...new Set([...own.byId.values()].flatMap((p) => p.names))].sort((a, b) => a.localeCompare(b)) : null;
  // The digest and data basis describe one source: with owner frames that is
  // the single owning scan, otherwise the active scan when it is the only source.
  const activeOnly = !sources || (owned ? ownerCount === 1 : sources.length === 1 && sources[0] === geo.name);

  const stems = sources ? sources.map(deps.baseName) : geo.name ? [deps.baseName(geo.name)] : [];
  const singleSource = geo.name ? deps.baseName(geo.name) : null;
  const sourceOfId = own ? new Map([...own.byId].map(([id, p]) => [id, p.names.map(deps.baseName).join('+')])) : null;
  // Read with the rest of the scan state, before the lazy import yields.
  // An owning scan states its own point basis and class-edit state, from its own
  // source and edit epoch; only the active scan reads the injected readers.
  const scanBasis = owned
    ? activeScanBasisOf(geo.source, owned.classificationEpoch)
    : deps.activeScanBasis
      ? deps.activeScanBasis()
      : activeScanBasisOf(geo.source, deps.activeClassificationEpoch());
  const exporter = await deps.loadMeasurementExport();
  const { measurementsToGeoJSON, measurementsToCsv, resolveExportDigests } = exporter;
  const digests = await resolveExportDigests(activeOnly ? geo.source : undefined, geo.crs);
  // From here on only the snapshot is read.
  const ctx: MeasurementExportContext = {
    toOutput: own
      ? (p, m) => {
          const b = own.byId.get(m!.id)!.base;
          return [p[0] + b[0], p[1] + b[1], p[2] + b[2]];
        }
      : (p) => [p[0] + origin[0], p[1] + origin[1], p[2] + origin[2]],
    sourceOf: sourceOfId ? (m) => sourceOfId.get(m.id)! : () => singleSource,
    // The measurements' own layer up, never the scene's: a Y-up scan made
    // active must not zero a Z-up survey's heights.
    up,
    unitToMetres: owned ? owned.unitToMetres : snap.unitToMetres,
    verticalUnitToMetres: owned ? owned.verticalUnitToMetres : snap.verticalUnitToMetres,
    crsName: geo.crsName,
    // The RESOLVED frame's own answer, not a literal. A geographic frame has no
    // scalar metres-per-unit at all, so it is neither verified nor convertible.
    geographic: owned ? owned.geographic : snap.geographicCrs,
    verticalRefused: owned ? owned.verticalRefused : snap.verticalRefused,
    // A local / unknown-unit scan has an inert factor of 1, so the `_m` columns
    // are nominal, not metres — the evidence note then says so (M1). An angular
    // frame is unverified for a stronger reason: no scalar could make it metres.
    unitsVerified: owned ? owned.unitsVerified : snap.unitsVerified,
    lonLat,
    provenance: {
      generatedAt,
      source: stems.length > 0 ? stems.join('+') : null,
      crsName: geo.crsName,
      interpretation: activeOnly ? geo.interpretation : undefined,
      crs: geo.crs,
      digests,
    },
  };
  let text: string;
  try {
    text = format === 'geojson' ? measurementsToGeoJSON(measurements, ctx) : measurementsToCsv(measurements, ctx);
  } catch (err) {
    // One point that has no place in lon/lat makes the whole GeoJSON wrong.
    if (format === 'geojson' && (err instanceof LonLatConversionError || (err instanceof Error && err.name === 'GeoJsonLonLatError'))) {
      deps.refuse?.(`GeoJSON export stopped: a point could not be placed in longitude/latitude. ${err.message} Export CSV instead for the measured values.`);
      return;
    }
    throw err;
  }
  const stem = stems.length > 0 ? stems.join('+') : 'measurements';
  const filename = `${stem}-measurements.${format === 'geojson' ? 'geojson' : 'csv'}`;
  deps.downloadText(filename, text);
  if (format === 'geojson' || !ctx.provenance) {
    if (withheld) (deps.notify ?? appToast().show)(withheld);
    return;
  }
  // A CSV has no comment slot every parser skips, so its provenance rides in a sidecar.
  const basis = csvBasis(scanBasis, activeOnly, sources?.length ?? 1, geo.name);
  const sidecar = exporter.provenanceSidecarName(filename);
  deps.downloadText(sidecar, exporter.measurementCsvProvenance(ctx.provenance, basis));
  const saved = csvSavedMessage(filename, sidecar);
  (deps.notify ?? appToast().show)(withheld ? `${saved} ${withheld}` : saved);
}

/**
 * The WGS 84 placement for a GeoJSON export, or the sentence that refuses it.
 *
 * The same resolver, datum refusals and NAD83-style caveat the site KML uses,
 * but its own height rule ({@link geoJsonHeightPolicy}): RFC 7946 heights are
 * ellipsoidal, so KML's sea-level rule does not carry over. Output-frame
 * points (origin restored) are moved back to the active scan's local frame
 * before the mapper, which is built on that origin.
 */
export function geoJsonLonLat(
  geo: GeoExportContext,
  upAxis: SpatialUpAxis,
): { lonLat: GeoJsonLonLat } | { refused: string } {
  const crs = geo.crs ?? null;
  const mapper = resolveLocalToLonLat(crs, geo.origin);
  if (!mapper.ok) return { refused: `GeoJSON export refused. ${mapper.reason} ${GEOJSON_CSV_HINT}` };
  const axis = lonLatUpAxisRefusal(upAxis);
  if (axis) return { refused: `GeoJSON export refused. ${axis} ${GEOJSON_CSV_HINT}` };
  const policy = geoJsonHeightPolicy(crs, mapper.datumCaveat);
  const [ox, oy, oz] = geo.origin;
  return {
    lonLat: {
      map: (p) => mapper.map([p[0] - ox, p[1] - oy, p[2] - oz]),
      withAltitude: policy.withAltitude,
      altitudeNote: policy.note,
      datumCaveat: mapper.datumCaveat,
      sourceHeights: policy.sourceHeights,
    },
  };
}

/** A label for the source vertical unit, from its factor to metres. */
function verticalUnitLabel(toMetres: number | undefined): string {
  if (toMetres === undefined || !Number.isFinite(toMetres) || toMetres <= 0) return 'unknown unit';
  if (Math.abs(toMetres - 1) < 1e-9) return 'metre';
  if (Math.abs(toMetres - UNIT_FACTORS.M_PER_FT) < 1e-9) return 'foot';
  if (Math.abs(toMetres - UNIT_FACTORS.M_PER_US_FT) < 1e-9) return 'US survey foot';
  return `source unit (1 unit = ${toMetres} m)`;
}

/**
 * The GeoJSON height rule, separate from KML's.
 *
 * RFC 7946 section 4 defines a third position element as height in metres
 * above the WGS 84 ellipsoid. An orthometric elevation (NAVD88, EGM96, MSL…)
 * differs from that by the local geoid undulation — tens of metres — and OLV
 * carries no geoid model to convert it. So a height is written only when the
 * source heights already ARE WGS 84 ellipsoidal heights in metres (EPSG:4979)
 * and the horizontal datum was not substituted (no datum caveat): then the
 * value passes through unchanged and means exactly what RFC 7946 says. Every
 * other case writes 2D positions and keeps the source elevations, their unit
 * and their datum in the feature properties, unconverted.
 */
export function geoJsonHeightPolicy(
  crs: ResolvedCrs | null,
  datumCaveat: string | null,
): { withAltitude: boolean; note: string; sourceHeights: { verticalDatum: string | null; unit: string } } {
  const datum = crs?.verticalDatum?.trim() || null;
  const code = resolveVerticalEpsg({ verticalEpsg: crs?.verticalEpsg, verticalDatum: datum ?? undefined });
  const metric = crs?.verticalUnitToMetres !== undefined && Math.abs(crs.verticalUnitToMetres - 1) < 1e-9;
  const sourceHeights = { verticalDatum: datum ?? (code !== undefined ? `EPSG:${code}` : null), unit: verticalUnitLabel(crs?.verticalUnitToMetres) };
  if (code === 4979 && metric && !datumCaveat) {
    return {
      withAltitude: true,
      note: 'The third coordinate is the source height, already metres above the WGS 84 ellipsoid (EPSG:4979), as RFC 7946 defines it; it is passed through unconverted.',
      sourceHeights,
    };
  }
  const why = datum
    ? `the source heights are on ${datum}, not metres above the WGS 84 ellipsoid, and no geoid conversion is applied`
    : 'the source declares no vertical datum';
  return {
    withAltitude: false,
    note:
      `Positions are 2D (no height written): RFC 7946 defines a third coordinate as metres above the WGS 84 ellipsoid, and ${why}. `
      + 'The source elevations are kept unconverted in each feature\'s elevations_source property; see vertical_reference.',
    sourceHeights,
  };
}

const GEOJSON_CSV_HINT =
  'GeoJSON is WGS 84 longitude/latitude by definition (RFC 7946); export CSV instead for the measured values.';

/**
 * The toast after a CSV export. It names both files, because a browser can
 * block the second download until the user allows multiple downloads.
 */
export function csvSavedMessage(csv: string, sidecar: string): string {
  return `Requested downloads for ${csv} and ${sidecar}. Keep both files together. If your browser asked to allow multiple downloads, allow it.`;
}

/** The sidecar's scan facts: the active scan's own, or a statement that several scans are mixed. */
function csvBasis(
  scan: ActiveScanBasis | null,
  activeOnly: boolean,
  sourceCount: number,
  sourceName: string | null,
): { pointBasis: string; classesEdited: boolean | null; sourceName: string | null } {
  if (!activeOnly) {
    return { pointBasis: `Point basis: not recorded (measurements span ${sourceCount} scans)`, classesEdited: null, sourceName: null };
  }
  if (!scan) return { pointBasis: 'Point basis: not recorded (no active scan)', classesEdited: null, sourceName };
  return { pointBasis: scan.pointBasis, classesEdited: scan.classesEdited, sourceName };
}

/**
 * The report text to write: signed when the user turned signing on, otherwise
 * as built. Returns null, after saying why, when signing was requested and
 * cannot be done, so a report the user meant to sign is never written unsigned.
 */
async function textToWrite(
  text: string,
  deps: MeasurementExportActionDeps,
  signReportText: ((t: string, o: { signedAt: string; software?: string; signerLabel?: string }) => Promise<string>) | undefined,
): Promise<string | null> {
  if (!reportSigningRequested()) return text;
  try {
    if (!signReportText) throw new SigningError('Signing is not available in this build. Turn off "Sign this report".');
    return await signReportText(text, { signedAt: deps.now(), software: deps.appVersion, signerLabel: reportSignerLabel() });
  } catch (e) {
    const cause = e instanceof SigningError ? e.message : 'Signing is not available. Turn off "Sign this report" to export an unsigned report.';
    (deps.refuse ?? deps.notify ?? appToast().show)(`Report not written. ${cause}`);
    return null;
  }
}

/** Export the measurement integrity report (JSON) with its content digest. */
export async function exportMeasurementIntegrityReport(
  deps: MeasurementExportActionDeps,
): Promise<void> {
  const snap = snapshotMeasure(deps.measure);
  if (snap.measurements.length === 0) return;
  const exportable = exportableMeasurements(snap.measurements, deps);
  if (!exportable.kept) return;
  // A signed report that silently left records out would misstate what was
  // measured: refuse instead, and say which measurements cannot be placed.
  if (exportable.withheld) {
    deps.refuse?.(`Not exported: ${exportable.withheld} An integrity report must account for every measurement; delete or reopen those, then export again.`);
    return;
  }
  const ms = exportable.kept;
  const owned = ownerFrameFor(ms, deps);
  if ('refused' in owned) {
    deps.refuse?.(owned.refused);
    return;
  }
  // The report records ONE dataset identity, digest and classification epoch,
  // so it cannot carry several scans' provenance: measurements taken on more
  // than one scan are refused rather than stamped with one scan's state.
  if (owned.owners.length > 1) {
    deps.refuse?.(`Not exported: the measurements were taken on ${[...new Set(owned.owners.map((o) => o.name))].sort((a, b) => a.localeCompare(b)).join(' and ')}. An integrity report records one scan's identity and classification epoch; export one scan's measurements at a time.`);
    return;
  }
  const geo = owned.frame ? owned.frame.geo : deps.geo();
  // Every scan-bound fact is read BEFORE the lazy import, so the report is one
  // scan's account of itself. The frame, unit scales, class epoch and
  // unit-known flag were read AFTER the await, so a scan swap while the chunk
  // loaded signed A's geometry and name with B's up vector, unit scale and
  // classification epoch — inside a file called an integrity report.
  const worldUp = sharedUp(ms, snap);
  if ('refused' in worldUp) {
    deps.refuse?.(worldUp.refused);
    return;
  }
  const unitToMetres = owned.frame ? owned.frame.unitToMetres : snap.unitToMetres;
  const verticalUnitToMetres = owned.frame ? owned.frame.verticalUnitToMetres : snap.verticalUnitToMetres;
  // The OWNING scan's epoch: a report naming scan A must not record the class
  // edits of whichever scan is active.
  const classificationEpoch = owned.frame ? owned.frame.classificationEpoch : deps.activeClassificationEpoch();
  // Local / unknown-unit scan → the findings' metre labels are nominal (M1).
  // A GEOGRAPHIC frame is unverified for a stronger reason than an unknown
  // one: no scalar metres-per-degree exists, so there is nothing to convert
  // by. The CSV/GeoJSON action next door has always read it this way; this
  // path read the bare `crsKnown` and so called a lon/lat scan unit-verified.
  const crsKnown = owned.frame ? owned.frame.unitsVerified : snap.unitsVerified;
  const geographic = owned.frame ? owned.frame.geographic : snap.geographicCrs;
  const verticalRefused = owned.frame ? owned.frame.verticalRefused : snap.verticalRefused;
  const generatedAt = deps.now();
  const { integrityReportFile, resolveExportDigests, signReportText } = await deps.loadMeasurementReport();
  // The digest describes one source file; with several owning scans in one frame it is omitted.
  const digests = await resolveExportDigests(geo.source, geo.crs);
  const scanName = geo.name ? deps.baseName(geo.name) : 'scan';
  const f = integrityReportFile(
    ms,
    worldUp,
    unitToMetres,
    verticalUnitToMetres,
    scanName,
    geo.crsName,
    generatedAt,
    classificationEpoch,
    deps.appVersion,
    crsKnown,
    undefined,
    digests,
    // The flag the live grade refuses on: every kind but a height is
    // recorded as a null finding with the reason.
    geographic,
    verticalRefused,
  );
  const out = await textToWrite(f.text, deps, signReportText);
  if (out === null) return;
  deps.downloadText(f.filename, out);
}

/**
 * Convert the placed measurements into report findings for the findings ledger.
 * The panel's "Add current measurements" button drives this; the conversion
 * lives in the lazy report chunk, so the call is async. Returns an empty array
 * when nothing is placed.
 *
 * The ledger belongs to the ACTIVE scan and its report carries that scan's
 * dataset identity, so only measurements the active scan owns become findings,
 * in that scan's own units and permissions. A measurement taken on another
 * scan, on a scan that is no longer open, or with no resolvable owner is
 * withheld and the refusal says why; its numbers are never relabelled with
 * the active scan's units or identity.
 */
export async function collectMeasurementFindings(
  deps: MeasurementExportActionDeps,
): Promise<readonly ReportFinding[]> {
  // Read at one instant, before the lazy import.
  const snap = snapshotMeasure(deps.measure);
  if (snap.measurements.length === 0) return [];
  const { own, withheld } = measurementsOwnedByActive(snap.measurements, ownershipViewFor(deps));
  if (withheld) deps.refuse?.(`Not added as findings: ${withheld}`);
  if (own.length === 0) return [];
  // The active scan's frame, from the canonical context when the app supplies
  // it, else the live measure view (fed from the same context).
  const frame = deps.frameSource ? framesOfApp(deps.frameSource).active() : null;
  const unitToMetres = frame ? frame.unitToMetres : snap.unitToMetres;
  const verticalUnitToMetres = frame ? frame.verticalUnitToMetres : snap.verticalUnitToMetres;
  const geographic = frame ? frame.geographic : snap.geographicCrs;
  const verticalRefused = frame ? frame.verticalRefused : snap.verticalRefused;
  const unitsVerified = frame ? frame.unitsVerified : snap.unitsVerified;
  const up = sharedUp(own, snap);
  if ('refused' in up) {
    deps.refuse?.(`Not added as findings: ${up.refused.replace(/^Not exported: /, '')}`);
    return [];
  }
  const { measurementsToFindings } = await deps.loadMeasurementReport();
  return measurementsToFindings(own, up, unitToMetres, verticalUnitToMetres, { geographic, unitsVerified, verticalRefused });
}

/**
 * Export the curated findings ledger as the signed integrity report (JSON).
 * The ledger holds only the active scan's findings (see
 * {@link collectMeasurementFindings}), and the caller checks that scan is still
 * active, so the dataset identity, CRS, digest and epoch are that scan's own.
 */
export async function exportFindingsReport(
  deps: MeasurementExportActionDeps,
  findings: readonly ReportFinding[],
): Promise<void> {
  if (findings.length === 0) return;
  const geo = deps.geo();
  const classificationEpoch = deps.activeClassificationEpoch();
  // Geographic reads as unverified here too — see `exportIntegrityReport`.
  const geographic = deps.measure.geographicCrs;
  const verticalRefused = deps.measure.verticalRefused === true;
  const crsKnown = deps.measure.crsKnown && !geographic;
  const { findingsReportFile, resolveExportDigests, signReportText } = await deps.loadMeasurementReport();
  const digests = await resolveExportDigests(geo.source, geo.crs);
  const generatedAt = deps.now();
  const f = findingsReportFile(
    findings,
    geo.name ? deps.baseName(geo.name) : 'scan',
    geo.crsName,
    generatedAt,
    classificationEpoch,
    deps.appVersion,
    crsKnown,
    undefined,
    digests,
    geographic,
    verticalRefused,
  );
  const out = await textToWrite(f.text, deps, signReportText);
  if (out !== null) deps.downloadText(f.filename, out);
}
