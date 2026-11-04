/**
 * profileExportSource.ts: the scan a profile export names, and its CRS.
 *
 * The profile sheet, its station CSV and the workbench image print a project
 * name and a horizontal CRS. Those read the active scan, so with two scans
 * open, selecting the other one relabelled a profile measured on the first:
 * its file name, title block and CRS field changed while the stations stayed
 * the first scan's. The export now names the scan(s) the profile records it
 * was picked on, in their own CRS, and is withheld when that cannot be
 * settled.
 *
 * A legacy profile with no recorded scan may use the sole open candidate.
 */

import type { ResolvedCrs } from '../geo/CoordinateTypes';
import { compatibilityFrameOf } from '../model/compatibilityFrame';
import { compareHorizontalKeys, horizontalKey, verticalReferenceKey } from '../model/layerCompatibility';
import type { PointCloud } from '../model/PointCloud';
import { ownerIdsOf, type OwnedItem } from './measurementOwnership';

/** What a profile export prints about its source. */
export interface ProfileExportContext {
  /** "EPSG:NNNN — name", the CRS name alone, or null for a local or unknown frame. */
  readonly crs: string | null;
  readonly verticalDatum: string | null;
  /** Base name of the source scan(s), for the files and the sheet's project. */
  readonly scanName: string | null;
  /** Set when the source cannot be settled: the export is withheld with this sentence. */
  readonly refused?: string;
}

export interface ProfileSourceDeps {
  readonly activeId: () => string | null;
  /** Viewer ids of the open static layers. */
  readonly clouds: () => readonly string[];
  readonly hasStreamingCloud?: () => boolean;
  readonly cloud: (viewerId: string) => PointCloud | undefined;
  readonly stableIdFor: (viewerId: string) => string | null;
  /** The active scan's resolved CRS, override included. */
  readonly activeCrs: () => ResolvedCrs | null;
  /** A scan's own resolved CRS, override included, without making it active. */
  readonly crsOf: (cloud: PointCloud) => ResolvedCrs | null;
  /** The active scan's base name, as the other exports name it. */
  readonly activeName: () => string | null;
}

/** The file name without its extension. */
function baseName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function crsLabel(cur: ResolvedCrs | null): string | null {
  if (!cur || (cur.kind !== 'projected' && cur.kind !== 'geographic')) return null;
  return cur.epsg != null ? `EPSG:${cur.epsg} — ${cur.name}` : cur.name;
}

function contextOf(cur: ResolvedCrs | null, scanName: string | null): ProfileExportContext {
  const crs = crsLabel(cur);
  return { crs, verticalDatum: crs ? cur?.verticalDatum ?? null : null, scanName };
}

/** The source of one profile's export. `m` is the profile, or undefined when it is gone. */
export function profileExportContext(m: OwnedItem | undefined, d: ProfileSourceDeps): ProfileExportContext {
  if (!m) return { crs: null, verticalDatum: null, scanName: null, refused: 'Not exported: this profile is no longer available.' };
  const open = d.clouds();
  const ids = ownerIdsOf(m);
  if (ids.length === 0) {
    const stream = d.hasStreamingCloud?.() === true;
    if ((open.length === 1 && !stream && open[0] === d.activeId()) || (open.length === 0 && stream)) return contextOf(d.activeCrs(), d.activeName());
    if (open.length === 0) return { crs: null, verticalDatum: null, scanName: null, refused: 'Not exported: no source scan is open. Reopen the scan this profile was measured on.' };
    return { crs: null, verticalDatum: null, scanName: null, refused: 'Not exported: this profile has no record of the scan it was measured on, so its name and coordinate system cannot be settled while several scans are open. Close every scan but the one it was measured on, then export again.' };
  }
  const active = d.activeId();
  const sources: Array<{ name: string; cur: ResolvedCrs | null }> = [];
  for (const owner of new Set(ids)) {
    const matches = open.filter((id) => d.stableIdFor(id) === owner);
    if (matches.length > 1) {
      return { crs: null, verticalDatum: null, scanName: null, refused: 'Not exported: more than one open scan matches a recorded source of this profile. Close the duplicate scan, then export again.' };
    }
    const id = matches[0];
    const cloud = id !== undefined ? d.cloud(id) : undefined;
    if (!cloud) {
      return { crs: null, verticalDatum: null, scanName: null, refused: 'Not exported: a scan this profile was measured on is not open. Reopen every contributing scan, then export again.' };
    }
    sources.push({ name: baseName(cloud.name), cur: id === active ? d.activeCrs() : d.crsOf(cloud) });
  }
  const frames = sources.map((s, i) => ({ ...compatibilityFrameOf(s.cur), id: String(i) }));
  const firstKey = horizontalKey(frames[0]!);
  if (frames.length > 1 && frames.some((frame) => {
    const key = horizontalKey(frame);
    return !key || !firstKey || compareHorizontalKeys(firstKey, key) !== 'same';
  })) {
    const list = sources.map((s) => `${s.name} (${crsLabel(s.cur) ?? 'no CRS'})`).join(' and ');
    return { crs: null, verticalDatum: null, scanName: null, refused: `Not exported: this profile was measured on ${list}, whose horizontal coordinate systems cannot be verified as the same.` };
  }
  const first = sources[0]!.cur;
  const firstVertical = verticalReferenceKey(frames[0]!);
  if (sources.length > 1 && sources.some(({ cur }, i) => !firstVertical || verticalReferenceKey(frames[i]!) !== firstVertical ||
    (cur?.verticalUnitToMetres ?? cur?.linearUnitToMetres) !== (first?.verticalUnitToMetres ?? first?.linearUnitToMetres) ||
    (cur?.verticalAxisDown === true) !== (first?.verticalAxisDown === true))) {
    return { crs: null, verticalDatum: null, scanName: null, refused: 'Not exported: the contributing scans do not share a vertical reference, unit and axis direction. Their heights cannot be combined in one profile.' };
  }
  return contextOf(first, sources.map((s) => s.name).join('-'));
}

/** The raw section walks the active scene's up, scale and height datum. */
export function profileWorkbenchSource(m: OwnedItem | undefined, d: ProfileSourceDeps): ProfileExportContext {
  const source = profileExportContext(m, d);
  if (source.refused || !m) return source;
  const ids = ownerIdsOf(m);
  const active = d.activeId();
  const activeOwner = active === null ? null : d.stableIdFor(active);
  if (ids.length && (activeOwner === null || !ids.includes(activeOwner))) {
    return { ...source, refused: `Select the profile's source (${source.scanName}) in Data, then reopen the Profile Workbench. The saved profile is available in Measure.` };
  }
  return source;
}
