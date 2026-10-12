/**
 * measurementExportFrame.ts
 *
 * The complete export frame of ONE scan, resolved from that scan itself: origin,
 * resolved CRS (user overrides included), horizontal and vertical unit scales,
 * the geographic flag, the unit-verified flag and the source up-axis.
 *
 * A measurement is placed through the scan it was taken on, so the file's
 * coordinates, units, CRS label, lon/lat mapper and source digests must all come
 * from that scan. Reading any of them from whichever scan happens to be active
 * labels one scan's points with another scan's frame (a UTM 12N measurement
 * exported as UTM 13N while the 13N scan is active), with no refusal.
 *
 * The decision of whether a set of measurements shares one frame, and the
 * sentence that refuses when it does not, are pure and live here.
 */

import type { GeoExportContext } from './reportExport';
import type { PointCloud } from '../model/PointCloud';
import type { ResolvedCrs } from '../geo/CoordinateTypes';
import type { CrsService } from '../geo/CrsService';
import { datasetIdentity } from '../geo/CrsService';
import { sourceUpAxis } from '../io/sniffFormat';
import { geoContextForCloud } from './reportExport';
import { spatialContextFrom, verticalMetresPerUnit, type SpatialContext, type SpatialUpAxis } from '../geo/SpatialContext';

/** One scan's complete export frame. */
export interface ExportFrame {
  /** Origin, resolved CRS label and name, source key and interpretation of the scan. */
  readonly geo: GeoExportContext;
  readonly unitToMetres: number;
  readonly verticalUnitToMetres: number;
  /** The horizontal frame is angular (lon/lat degrees). */
  readonly geographic: boolean;
  /** Linear scale known and the frame not angular: the metre columns are real metres. */
  readonly unitsVerified: boolean;
  readonly upAxis: SpatialUpAxis;
  /** The scan's own classification edit epoch (0 when none), for its class-edit state. */
  readonly classificationEpoch: number;
  /** Identity of the frame for equality: every field a coordinate, unit or label depends on. */
  readonly key: string;
  /** Short label for a refusal sentence: the EPSG code, else the CRS name. */
  readonly label: string;
}

/** The frame scalars of a resolved spatial context, the same rules the live measure tool applies. */
export function frameScalars(ctx: SpatialContext): Pick<ExportFrame, 'unitToMetres' | 'verticalUnitToMetres' | 'geographic' | 'unitsVerified'> {
  return {
    unitToMetres: ctx.linearUnitToMetres,
    verticalUnitToMetres: verticalMetresPerUnit(ctx, 'horizontal') ?? 1,
    geographic: ctx.isGeographic,
    unitsVerified: ctx.linearUnitKnown && !ctx.isGeographic,
  };
}

/** Build a frame from a scan's geo context, spatial context and resolved up-axis. */
export function exportFrameOf(geo: GeoExportContext, ctx: SpatialContext, upAxis: SpatialUpAxis, classificationEpoch = 0): ExportFrame {
  const scalars = frameScalars(ctx);
  const key = JSON.stringify([
    ctx.kind, ctx.epsg ?? null, geo.crsName ?? null, ctx.linearUnit,
    scalars.unitToMetres, scalars.verticalUnitToMetres, scalars.geographic, scalars.unitsVerified,
    ctx.verticalReference, ctx.verticalDatum ?? null, ctx.verticalEpsg ?? null, upAxis,
  ]);
  const label = ctx.epsg != null ? `EPSG:${ctx.epsg}` : geo.crsName ?? 'no CRS';
  return { geo, ...scalars, upAxis, classificationEpoch, key, label };
}

/** The slice of the app the per-scan frame reads. */
export interface FrameResolverDeps {
  /** Viewer id of the active scan, or null. */
  readonly activeId: () => string | null;
  /** The active scan's geo context (also covers a streaming scan). */
  readonly activeGeo: () => GeoExportContext;
  /** The active scan's spatial context. */
  readonly activeContext: () => SpatialContext;
  /** The active scan's resolved up-axis. */
  readonly activeUpAxis: () => SpatialUpAxis;
  readonly cloud: (viewerId: string) => PointCloud | undefined;
  /** Resolve a scan's own CRS, override included, without making it active. */
  readonly resolveCrs: (cloud: PointCloud) => ResolvedCrs;
  /** Resolved up-axis of a non-active scan from its own format. */
  readonly upAxisOf: (cloud: PointCloud, resolved: SpatialUpAxis) => SpatialUpAxis;
  /** The geo context of a static cloud under a resolved CRS. */
  readonly geoOf: (cloud: PointCloud, crs: ResolvedCrs | null) => GeoExportContext;
  /** A scan's classification edit epoch. */
  readonly epochOf: (viewerId: string) => number;
}

export interface ExportFrames {
  /** The frame of the scan with this viewer id, or null when it is not open. */
  readonly of: (viewerId: string) => ExportFrame | null;
  /** The active scan's frame. */
  readonly active: () => ExportFrame;
}

export function makeExportFrames(deps: FrameResolverDeps): ExportFrames {
  const activeFrame = (): ExportFrame => exportFrameOf(deps.activeGeo(), deps.activeContext(), deps.activeUpAxis(), deps.activeId() ? deps.epochOf(deps.activeId()!) : 0);
  return {
    active: activeFrame,
    of: (viewerId) => {
      if (deps.activeId() === viewerId) return activeFrame();
      const cloud = deps.cloud(viewerId);
      if (!cloud) return null;
      const crs = deps.resolveCrs(cloud);
      const ctx = spatialContextFrom(crs);
      return exportFrameOf(deps.geoOf(cloud, crs), ctx, deps.upAxisOf(cloud, ctx.upAxis), deps.epochOf(viewerId));
    },
  };
}

/** One scan a set of measurements was taken on. */
export interface OwnerRef {
  readonly viewerId: string;
  readonly name: string;
}

/** `EPSG:32612`, or the label plus the unit/axis detail when two frames share a label. */
function describeFrames(groups: readonly { frame: ExportFrame; names: readonly string[] }[]): string[] {
  const seen = new Map<string, number>();
  for (const g of groups) seen.set(g.frame.label, (seen.get(g.frame.label) ?? 0) + 1);
  return groups.map((g) => {
    const f = g.frame;
    const detail = (seen.get(f.label) ?? 0) > 1
      ? `, ${f.unitToMetres} m/unit, vertical ${f.verticalUnitToMetres} m/unit, ${f.upAxis}-up`
      : '';
    return `${g.names.join(', ')} (${f.label}${detail})`;
  });
}

/** The sentence refusing an export that spans different coordinate frames. */
export function mixedFrameRefusal(groups: readonly { frame: ExportFrame; names: readonly string[] }[]): string {
  const parts = describeFrames(groups);
  const list = parts.length === 2 ? `${parts[0]} and ${parts[1]}` : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `Not exported: measurements on ${list} use different coordinate frames; export one scan's measurements at a time.`;
}

/**
 * The single frame a set of measurements shares, or the refusal. Each entry is
 * the scans one measurement was taken on; an empty entry is a measurement with
 * no recorded owner, which keeps meaning the active scan (the legacy rule).
 * Returns `owners` empty when no measurement names a scan, so the caller keeps
 * its active-scan path unchanged.
 */
export function resolveOwnerFrame(
  entries: readonly (readonly OwnerRef[])[],
  frames: ExportFrames,
): { frame: ExportFrame; owners: readonly OwnerRef[] } | { refused: string } | { frame: null; owners: readonly [] } {
  const owners = new Map<string, OwnerRef>();
  const groups = new Map<string, { frame: ExportFrame; names: Set<string> }>();
  const add = (frame: ExportFrame, name: string): void => {
    const g = groups.get(frame.key) ?? { frame, names: new Set<string>() };
    g.names.add(name);
    groups.set(frame.key, g);
  };
  let unowned = false;
  for (const e of entries) {
    if (e.length === 0) {
      unowned = true;
      continue;
    }
    for (const o of e) {
      const f = frames.of(o.viewerId);
      if (!f) return { refused: `Not exported: the scan "${o.name}" is not open, so its coordinate frame cannot be resolved. Reopen it, then export again.` };
      owners.set(o.viewerId, o);
      add(f, o.name);
    }
  }
  if (owners.size === 0) return { frame: null, owners: [] };
  if (unowned) {
    const a = frames.active();
    add(a, a.geo.name ?? 'the active scan');
  }
  if (groups.size > 1) {
    return { refused: mixedFrameRefusal([...groups.values()].map((g) => ({ frame: g.frame, names: [...g.names].sort((a, b) => a.localeCompare(b)) }))) };
  }
  const only = [...groups.values()][0]!;
  return { frame: only.frame, owners: [...owners.values()] };
}

/** What the running app hands over so any open scan's frame can be resolved. */
export interface AppFrameSource {
  readonly activeId: () => string | null;
  /** The active scan's geo context (also covers a streaming scan). */
  readonly activeGeo: () => GeoExportContext;
  /** The active scan's resolved up-axis. */
  readonly activeUpAxis: () => SpatialUpAxis;
  readonly cloud: (viewerId: string) => PointCloud | undefined;
  /** A scan's classification edit epoch. */
  readonly classificationEpoch: (viewerId: string) => number;
  readonly crs: Pick<CrsService, 'context' | 'resolveFor'>;
}

/** Per-scan frames over the running app: the active scan from the live context, every other scan resolved on its own. */
export function framesOfApp(src: AppFrameSource): ExportFrames {
  return makeExportFrames({
    activeId: src.activeId,
    activeGeo: src.activeGeo,
    activeContext: () => src.crs.context(),
    activeUpAxis: src.activeUpAxis,
    cloud: src.cloud,
    // The scan's OWN resolved CRS, a remembered override included, as the
    // Inspector shows it; never the active scan's.
    resolveCrs: (c) => src.crs.resolveFor({ name: c.name, detected: c.metadata?.crs ?? undefined, source: 'las-vlr', identity: datasetIdentity(c) }),
    upAxisOf: (c, resolved) => sourceUpAxis(resolved, c.sourceFormat, false),
    geoOf: geoContextForCloud,
    epochOf: src.classificationEpoch,
  });
}
