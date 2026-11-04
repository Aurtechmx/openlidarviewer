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

/** What the caller wanted the source for; the refusal names that, and the step that retries it. */
export type ProfileSourcePurpose = 'export' | 'workbench';
type Purpose = ProfileSourcePurpose;

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

/** A withheld source. `again` in the text is replaced by the step that retries the caller's action. */
function refuse(purpose: Purpose, text: string): ProfileExportContext {
  const again = purpose === 'export' ? 'export again' : 'reopen the Profile Workbench';
  const head = purpose === 'export' ? 'Not exported' : 'Not opened';
  return { crs: null, verticalDatum: null, scanName: null, refused: `${head}: ${text.replace('{again}', again)}` };
}

function sourceOf(m: OwnedItem | undefined, d: ProfileSourceDeps, purpose: Purpose): ProfileExportContext {
  if (!m) return refuse(purpose, 'this profile is no longer available.');
  const open = d.clouds();
  const ids = ownerIdsOf(m);
  if (ids.length === 0) {
    const stream = d.hasStreamingCloud?.() === true;
    if ((open.length === 1 && !stream && open[0] === d.activeId()) || (open.length === 0 && stream)) return contextOf(d.activeCrs(), d.activeName());
    if (open.length === 0) return refuse(purpose, 'no source scan is open. Reopen the scan this profile was measured on.');
    return refuse(purpose, 'this profile has no record of the scan it was measured on, so its name and coordinate system cannot be settled while several scans are open. Close every scan but the one it was measured on, then {again}.');
  }
  const active = d.activeId();
  const sources: Array<{ name: string; cur: ResolvedCrs | null }> = [];
  for (const owner of new Set(ids)) {
    const matches = open.filter((id) => d.stableIdFor(id) === owner);
    if (matches.length > 1) {
      return refuse(purpose, 'more than one open scan matches a recorded source of this profile. Close the duplicate scan, then {again}.');
    }
    const id = matches[0];
    const cloud = id !== undefined ? d.cloud(id) : undefined;
    if (!cloud) {
      return refuse(purpose, 'a scan this profile was measured on is not open. Reopen every contributing scan, then {again}.');
    }
    sources.push({ name: baseName(cloud.name), cur: id === active ? d.activeCrs() : d.crsOf(cloud) });
  }
  // One scan is its own frame: nothing to compare, and this runs per row on every panel render.
  if (sources.length === 1) return contextOf(sources[0]!.cur, sources[0]!.name);
  const frames = sources.map((s, i) => ({ ...compatibilityFrameOf(s.cur), id: String(i) }));
  const firstKey = horizontalKey(frames[0]!);
  if (frames.some((frame) => {
    const key = horizontalKey(frame);
    return !key || !firstKey || compareHorizontalKeys(firstKey, key) !== 'same';
  })) {
    const list = sources.map((s) => `${s.name} (${crsLabel(s.cur) ?? 'no CRS'})`).join(' and ');
    return refuse(purpose, `this profile was measured on ${list}, whose horizontal coordinate systems cannot be verified as the same.`);
  }
  const first = sources[0]!.cur;
  const firstVertical = verticalReferenceKey(frames[0]!);
  if (sources.some(({ cur }, i) => !firstVertical || verticalReferenceKey(frames[i]!) !== firstVertical ||
    (cur?.verticalUnitToMetres ?? cur?.linearUnitToMetres) !== (first?.verticalUnitToMetres ?? first?.linearUnitToMetres) ||
    (cur?.verticalAxisDown === true) !== (first?.verticalAxisDown === true))) {
    // The vertical reference is read from each file's coordinate system; it
    // cannot be set here, so the step is a different pick or different files.
    return refuse(purpose, 'the contributing scans do not share a vertical reference, unit and axis direction, so their heights cannot be combined in one profile. Measure the profile on one scan, or reopen the scans from files whose coordinate system names the same vertical datum, then {again}.');
  }
  return contextOf(first, sources.map((s) => s.name).join('-'));
}

/** The source of one profile's export. `m` is the profile, or undefined when it is gone. */
export function profileExportContext(m: OwnedItem | undefined, d: ProfileSourceDeps): ProfileExportContext {
  return sourceOf(m, d, 'export');
}

/**
 * The raw section walks the active scene's up, scale and height datum. The
 * dock's PNG export passes 'export': it reads the same section, but what was
 * withheld is a file, not the dock.
 */
export function profileWorkbenchSource(m: OwnedItem | undefined, d: ProfileSourceDeps, purpose: Purpose = 'workbench'): ProfileExportContext {
  const source = sourceOf(m, d, purpose);
  if (source.refused || !m) return source;
  const ids = ownerIdsOf(m);
  const active = d.activeId();
  const activeOwner = active === null ? null : d.stableIdFor(active);
  if (ids.length && (activeOwner === null || !ids.includes(activeOwner))) {
    return refuse(purpose, `select the profile's source (${source.scanName}) in Data, then {again}. The saved profile is available in Measure.`);
  }
  return source;
}
