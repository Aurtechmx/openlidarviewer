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
 * With one scan open (or none recorded as static layers) the active scan is
 * the only candidate, as for the other measurement exports.
 */

import type { ResolvedCrs } from '../geo/CoordinateTypes';
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
  const open = d.clouds();
  if (open.length < 2) return contextOf(d.activeCrs(), d.activeName());
  const ids = m ? ownerIdsOf(m) : [];
  if (ids.length === 0) {
    return { crs: null, verticalDatum: null, scanName: null, refused: 'Not exported: this profile has no record of the scan it was measured on, so its name and coordinate system cannot be settled while several scans are open. Close every scan but the one it was measured on, then export again.' };
  }
  const owners = open.filter((id) => { const s = d.stableIdFor(id); return s !== null && ids.includes(s); });
  if (owners.length === 0) {
    return { crs: null, verticalDatum: null, scanName: null, refused: 'Not exported: the scan this profile was measured on is not open, so its name and coordinate system cannot be settled. Reopen it, then export again.' };
  }
  const active = d.activeId();
  const sources = owners.map((id) => {
    const c = d.cloud(id);
    return { name: c ? baseName(c.name) : id, cur: id === active ? d.activeCrs() : c ? d.crsOf(c) : null };
  });
  const labels = new Set(sources.map((s) => crsLabel(s.cur) ?? 'no CRS'));
  if (labels.size > 1) {
    const list = sources.map((s) => `${s.name} (${crsLabel(s.cur) ?? 'no CRS'})`).join(' and ');
    return { crs: null, verticalDatum: null, scanName: null, refused: `Not exported: this profile was measured on ${list}, which use different coordinate systems.` };
  }
  return contextOf(sources[0]!.cur, sources.map((s) => s.name).join('-'));
}
