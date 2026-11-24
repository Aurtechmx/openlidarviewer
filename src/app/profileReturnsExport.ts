/**
 * profileReturnsExport.ts
 *
 * Save the returns an open Profile Workbench read: one ZIP holding the CSV and
 * its JSON receipt, so neither file travels without the other.
 *
 * THE SECTION ON SCREEN IS WHAT IS WRITTEN. The rows are the section the dock
 * read, whole, whatever its filter or thinning draws. The scene may have moved
 * on since: a line redrawn or a project frame that moved refuses the export,
 * because the rows would no longer describe the profile they are named after.
 * A source that has gone leaves its coordinates blank, as
 * `profileReturnsCsv.ts` defines. Class provenance is the one that held while
 * the section was read; codes that changed during the read are `unknown`.
 *
 * BUILT IN SLICES, AND BOUNDED. The rows come out of a generator and are folded
 * into Blobs as they fill, so no single buffer holds the file. The size is
 * projected from the rows built so far, and a section that would pass
 * {@link MAX_RETURNS_BYTES} is refused with that sentence.
 */

import { zipStoreParts, crc32 } from '../convert/zipStore';
import { softwareLine, pointBasisOfCloud } from '../export/exportProvenanceLines';
import { sourceDigestOf } from '../export/exportDigests';
import { lightProvenance } from '../export/lightProvenance';
import { safeEntryName } from '../export/safeText';
import { exportDigests, type SourceDigest } from '../science/exportDigestRecord';
import { triggerDownload } from '../io/download';
import { intensityNormalisationLine, type PointCloud } from '../model/PointCloud';
import {
  profileReturnsCsvChunks,
  profileReturnsReceiptJson,
  type ClassificationProvenance,
  type ProfileReturnsReceipt,
  type ProfileReturnsSource,
} from '../render/measure/profileReturnsCsv';
import { describeSampleBasis, describeSampleCaveat, formatCount } from '../render/measure/profileProvenance';
import { profileCsvRefusal, profileExportFileName, safeFileStem } from '../render/measure/profileSummary';
import { resolveProfileVerticalReference } from '../render/measure/profileVerticalReference';

import type { ProfileExportContext } from './profileExportSource';
import type { WorkbenchSectionPlot } from './profileWorkbenchSection';
import type { ResolvedCrs } from '../geo/CoordinateTypes';
import type { MeasureController } from '../render/measure/MeasureController';
import type { ProfileFrame } from '../render/measure/profileGeometry';
import type { ProfileSectionPoints } from '../render/measure/profileSectionBuilder';
import type { ProfileReturnReader, ProfileSectionResult } from '../render/measure/profileSectionSeam';

/**
 * Most bytes the CSV may reach. A section past it is refused: the file is
 * assembled in this page, and a page that runs out of memory takes the session
 * with it.
 */
export const MAX_RETURNS_BYTES = 1024 * 1024 * 1024;

/** Milliseconds one slice may hold the main thread. */
const SLICE_MS = 10;

/** Bytes folded into one Blob, which the browser may hold outside the page's heap. */
const BLOB_BYTES = 8 * 1024 * 1024;

/** What streamed rows are. Stated in the receipt and beside the saved message. */
export const RESIDENT_ONLY_NOTE = 'resident points only: streamed points that were not loaded when the section was read are not in this file';

/** A reason the export cannot be made, in words for the user. */
export class ProfileReturnsRefusal extends Error {
  override readonly name = 'ProfileReturnsRefusal';
}

/** The slice of the app this export reads. Every member is read when it is needed. */
export interface ProfileReturnsPorts {
  measure(): Pick<
    MeasureController,
    'getMeasurements' | 'getSummaries' | 'unitFrameOf' | 'profileCorridorOf' | 'sceneOrigin' | 'elevationDatum' | 'unitSystem'
  >;
  /** The source of the profile's raw section, with the refusal when it cannot be settled. */
  source(id: string): ProfileExportContext;
  /** The open static layers, and which of them is active. */
  layers(): {
    readonly clouds: () => readonly string[];
    readonly cloud: (viewerId: string) => PointCloud | undefined;
    readonly stableIdFor: (viewerId: string) => string | null;
  } | null;
  classificationEpoch(viewerId: string): number;
  returnReaders(): (kind: 'static' | 'resident', id: string) => ProfileReturnReader;
  crs(): ResolvedCrs | null;
  metresPerUnit(): number | null;
}

interface OpenLayer {
  readonly viewerId: string;
  readonly cloud: PointCloud;
}

/** What a section is only valid under, read when the walk starts and compared after. */
interface SectionState {
  readonly frame: string | null;
  readonly classes: ReadonlyMap<string, { readonly source: ClassificationProvenance; readonly epoch: number; readonly cloud: PointCloud }>;
}

/** A section's circumstances, fixed when it finished. Taken once per dock. */
export interface ProfileReturnsSnapshot {
  /** Null when the line, the frame or the sources moved while the section was read. */
  readonly frame: string | null;
  readonly origin: readonly [number, number, number] | null;
  readonly datum: number | null;
  readonly classOf: (layerId: string) => ClassificationProvenance;
  /** Display name, basis and attribute facts of each static source, as read. */
  readonly clouds: ReadonlyMap<string, PointCloud>;
  readonly readAt: string;
}

/** The open layers by the id the section records them under. A shared id names none. */
function openLayers(ports: ProfileReturnsPorts): Map<string, OpenLayer> {
  const src = ports.layers();
  const out = new Map<string, OpenLayer>();
  const shared = new Set<string>();
  for (const viewerId of src?.clouds() ?? []) {
    const cloud = src?.cloud(viewerId);
    if (!cloud) continue;
    const id = src?.stableIdFor(viewerId) ?? cloud.name;
    if (out.has(id)) shared.add(id);
    out.set(id, { viewerId, cloud });
  }
  for (const id of shared) out.delete(id);
  return out;
}

/** The line, corridor, origin and datum a section is valid under, or null when the profile is gone. */
function frameKey(ports: ProfileReturnsPorts, id: string): string | null {
  const measure = ports.measure();
  const m = measure.getMeasurements().find((x) => x.id === id);
  if (!m?.points[0] || !m.points[1]) return null;
  return JSON.stringify([
    m.points[0], m.points[1], measure.profileCorridorOf(m), measure.sceneOrigin ?? null, measure.elevationDatum ?? null,
    measure.unitFrameOf(m).up ?? null,
  ]);
}

/** Read what the section depends on. Call before the walk starts. */
export function beginReturnsSection(ports: ProfileReturnsPorts, id: string): SectionState {
  const classes = new Map<string, { source: ClassificationProvenance; epoch: number; cloud: PointCloud }>();
  for (const [layerId, { viewerId, cloud }] of openLayers(ports)) {
    const epoch = ports.classificationEpoch(viewerId);
    const state = cloud.classificationProvenance;
    classes.set(layerId, { source: state === 'source' && epoch > 0 ? 'edited' : state, epoch, cloud });
  }
  return { frame: frameKey(ports, id), classes };
}

/** Fix the section's circumstances. Call when the section has finished. */
export function finishReturnsSection(ports: ProfileReturnsPorts, id: string, before: SectionState, readAt: string): ProfileReturnsSnapshot {
  const after = beginReturnsSection(ports, id);
  const measure = ports.measure();
  return {
    frame: before.frame !== null && before.frame === after.frame ? after.frame : null,
    origin: measure.sceneOrigin ?? null,
    datum: measure.elevationDatum ?? null,
    classOf: (layerId) => {
      const was = before.classes.get(layerId);
      const is = after.classes.get(layerId);
      // Codes edited while they were being read have no one provenance.
      return was && is && was.cloud === is.cloud && was.source === is.source && was.epoch === is.epoch ? was.source : 'unknown';
    },
    clouds: new Map([...before.classes].filter(([layerId, c]) => after.classes.get(layerId)?.cloud === c.cloud).map(([layerId, c]) => [layerId, c.cloud])),
    readAt,
  };
}

/**
 * True when `project` is still the return section row `row` records. The scene
 * is read after the section was: a layer placed elsewhere, or a buffer replaced
 * under the same id, would otherwise lend its coordinate to another return.
 * The tolerance is for float32 storage of the recorded values, not for drift.
 */
export function coordinateMatchesRow(
  points: ProfileSectionPoints, frame: ProfileFrame, datum: number, row: number, project: ArrayLike<number>,
): boolean {
  const u = frame.up;
  const x = project[0]!;
  const y = project[1]!;
  const z = project[2]!;
  const height = x * u[0] + y * u[1] + z * u[2];
  const dx = x - u[0] * height - frame.horizontalAnchor[0];
  const dy = y - u[1] * height - frame.horizontalAnchor[1];
  const dz = z - u[2] * height - frame.horizontalAnchor[2];
  const along = dx * frame.along[0] + dy * frame.along[1] + dz * frame.along[2];
  const lateral = dx * frame.lateral[0] + dy * frame.lateral[1] + dz * frame.lateral[2];
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-6 * (1 + Math.abs(b));
  return near(along, points.chainage[row]!) && near(lateral, points.lateralOffset[row]!) && near(height + datum, points.height[row]!);
}

/** The refusal in force, or the profile as it is now. */
function settled(ports: ProfileReturnsPorts, id: string, section: ProfileSectionResult, snap: ProfileReturnsSnapshot) {
  const refuse = (why: string): never => { throw new ProfileReturnsRefusal(why); };
  const measure = ports.measure();
  const summary = measure.getSummaries().find((s) => s.id === id);
  const m = measure.getMeasurements().find((x) => x.id === id);
  if (!summary || !m) return refuse('This profile is no longer open.');
  const frame = measure.unitFrameOf(m);
  // The same refusals, in the same order, as the station CSV and the sheet.
  const frameRefusal = profileCsvRefusal(summary, frame.geographic, frame.verticalRefused);
  if (frameRefusal) return refuse(frameRefusal);
  const context = ports.source(id);
  if (context.refused) return refuse(context.refused);
  if (!summary.profileChart || summary.profileChart.length < 2) return refuse('Not exported: this profile has no height chart to export returns beside.');
  if (section.aborted) return refuse('Not exported: the section was not read to the end. Close the Profile Workbench and open it again.');
  if (!section.frame) return refuse('Not exported: the profile line has no horizontal length to section.');
  const up = frame.up;
  const cut = section.frame.up;
  if (up && up[0] * cut[0] + up[1] * cut[1] + up[2] * cut[2] < 1 - 1e-9) {
    return refuse('Not exported: the section was cut along a different up axis than this profile. Close the Profile Workbench and open it again.');
  }
  if (snap.frame === null || snap.frame !== frameKey(ports, id)) {
    return refuse('Not exported: the profile line, its corridor or the scene frame changed after this section was read. Close the Profile Workbench and open it again.');
  }
  if (section.points.count === 0) return refuse('Not exported: no returns fell inside this corridor.');
  return { summary, frame, context };
}

/** Let the page draw and take input between slices, without a timer's clamp. */
function pauser(): { pause(): Promise<void>; close(): void } {
  if (typeof MessageChannel === 'undefined') return { pause: () => new Promise((r) => setTimeout(r, 0)), close: () => {} };
  const { port1, port2 } = new MessageChannel();
  let wake: (() => void) | null = null;
  port1.onmessage = () => wake?.();
  return {
    pause: () => new Promise((r) => { wake = r; port2.postMessage(0); }),
    close: () => { port1.close(); port2.close(); },
  };
}

/** The base name of the two files and the ZIP. */
function returnsStem(scanName: string | null, profileName: string): string {
  const csv = profileExportFileName(scanName, profileName, 'csv') ?? `${safeFileStem(profileName) || 'profile'}-profile.csv`;
  // Cut before the suffix, so a long name never loses "-returns".
  let stem = csv.replace(/\.csv$/, '');
  while (new TextEncoder().encode(stem).length > 160) stem = [...stem].slice(0, -1).join('');
  return safeEntryName(`${stem}-returns`, 'profile-returns');
}

export interface ProfileReturnsRequest {
  readonly id: string;
  readonly plot: WorkbenchSectionPlot;
  readonly snapshot: ProfileReturnsSnapshot;
  /** True once the dock this was asked from is gone: nothing is saved then. */
  readonly cancelled?: () => boolean;
  readonly onProgress?: (fraction: number) => void;
  readonly download?: (blob: Blob, filename: string) => void;
  readonly digestOf?: (cloud: PointCloud) => Promise<SourceDigest>;
  readonly now?: () => Date;
  /** For tests of the bound. */
  readonly maxBytes?: number;
}

export interface ProfileReturnsSaved {
  readonly filename: string;
  readonly receipt: ProfileReturnsReceipt;
  /** One line saying what was saved, and what is not in it. */
  readonly message: string;
}

/**
 * Build and save the two files. Null when the dock closed first. Throws a
 * {@link ProfileReturnsRefusal} when the export cannot be made.
 */
export async function exportProfileReturns(ports: ProfileReturnsPorts, r: ProfileReturnsRequest): Promise<ProfileReturnsSaved | null> {
  const { id, snapshot: snap } = r;
  const { section, filter, indices } = r.plot;
  const points = section.points;
  const { summary, frame, context } = settled(ports, id, section, snap);
  const generatedAt = (r.now?.() ?? new Date()).toISOString();
  const crs = ports.crs();
  const origin = snap.origin;
  const datum = snap.datum ?? 0;
  const metresPerUnit = ports.metresPerUnit();

  const contributing = new Set<number>();
  for (let i = 0; i < points.count; i++) contributing.add(points.sourceSlot[i]!);
  const refs = section.sources.filter((s) => contributing.has(s.slot));
  const streamed = refs.some((s) => s.kind === 'resident');
  const digestOf = r.digestOf ?? ((cloud: PointCloud) => sourceDigestOf({ key: cloud, streamed: false }));
  const streamId = section.streamingSourceId ?? 'streaming';

  const readers = ports.returnReaders();
  const digests = new Map<string, SourceDigest>();
  await Promise.all(refs.filter((s) => s.kind === 'static').map(async (s) => {
    const cloud = snap.clouds.get(s.id);
    if (cloud) digests.set(s.id, await digestOf(cloud));
  }));
  const sources = refs.map((s): ProfileReturnsSource => {
    const reader = readers(s.kind, s.id);
    const cloud = s.kind === 'static' ? snap.clouds.get(s.id) : undefined;
    const digest = digests.get(s.id);
    const mask = cloud?.attributeInvalid;
    const note = cloud?.intensity ? intensityNormalisationLine(cloud.metadata) : null;
    return {
      slot: s.slot,
      layerId: s.kind === 'static' ? s.id : streamId,
      layerName: s.kind === 'static' ? s.name ?? s.id : streamId.replace(/^streaming:/, ''),
      // A streamed node's codes are the ones its file holds; the per-row
      // presence bit leaves the cell blank where it carries none.
      classificationSource: s.kind === 'static' ? snap.classOf(s.id) : 'source',
      ...(s.kind === 'resident' ? { streamingNodeKey: s.id } : {}),
      ...(mask && mask.length === s.pointCount ? { attributeInvalid: mask } : {}),
      ...(note ? { intensityNote: note } : {}),
      ...(s.kind === 'static'
        ? {
            basis: {
              pointBasis: cloud ? pointBasisOfCloud(cloud, null) : null,
              sourceSha256: digest?.sha256 ?? null,
              sourceSha256Note: digest ? digest.note : 'not available: the source was closed or replaced, or shares its id with another open scan',
            },
          }
        : {}),
      // Without a scene origin there is no world coordinate to write.
      ...(origin === null || typeof reader === 'string'
        ? { missing: typeof reader === 'string' ? reader : ('unavailable' as const) }
        : {
            readXYZ: (index: number, out: Float64Array, row?: number): boolean => {
              if (!reader(index, out)) return false;
              if (row === undefined || !coordinateMatchesRow(points, section.frame, datum, row, out)) return false;
              out[0] = out[0]! + origin[0];
              out[1] = out[1]! + origin[1];
              out[2] = out[2]! + origin[2];
              return true;
            },
          }),
    };
  });

  const single = refs.length === 1 && refs[0]!.kind === 'static' ? digests.get(refs[0]!.id) ?? null : null;
  const provenance = lightProvenance({
    generatedAt,
    source: context.scanName,
    crsName: context.crs,
    crs,
    digests: streamed || single ? exportDigests(streamed ? await sourceDigestOf({ key: {}, streamed: true }) : single, crs) : null,
  });
  // With no shared datum the heights stay in the scene's own frame.
  const verticalReference = resolveProfileVerticalReference({
    datumKnown: snap.datum !== null && summary.profileDatumKnown,
    provenance: summary.profileProvenance,
    verticalDatum: context.verticalDatum,
  });
  const at = (p: readonly [number, number, number]): [number, number, number] =>
    origin ? [p[0] + origin[0], p[1] + origin[1], p[2] + origin[2]] : [p[0], p[1], p[2]];
  const line = JSON.parse(snap.frame!) as [[number, number, number], [number, number, number]];
  const rows = profileReturnsCsvChunks(points, {
    measurementId: id,
    measurementName: summary.name,
    a: at(line[0]),
    b: at(line[1]),
    up: section.frame.up,
    corridorHalfWidth: section.band,
    verticalReference,
    sources,
    sourcesRead: section.sources.length,
    generatedAt,
    system: ports.measure().unitSystem,
    ...(metresPerUnit === null ? {} : { unitToMetres: metresPerUnit }),
    ...(metresPerUnit !== null && crs?.linearUnit ? { unitName: crs.linearUnit } : {}),
    verticalUnitToMetres: frame.verticalUnitKnown ? frame.verticalUnitToMetres : null,
    ...(context.crs ? { crsName: context.crs } : {}),
    visualLodInUse: indices.length < (filter?.keptCount ?? points.count),
    displayedIndices: indices,
    display: {
      filters: filter ? filter.scopes.filter((s) => s.active).map((s) => s.rule) : [],
      keptCount: filter?.keptCount ?? points.count,
    },
    withheld: section.withheld,
    record: {
      rows: 'Every return the corridor accepted when the section was read. A display filter or thinning changes the picture and never removes a row; Withheld points are left out and counted in withheld.',
      values: 'chainage, lateral_offset and the height column are in the units of the source coordinates. The height is read along the up axis.',
      coordinateFrame: origin ? 'source coordinates, as x, y, z in the file\'s axis order; the endpoints are in the same frame' : 'scene-local: the open scans share no origin, so x, y, z are blank and the endpoints are scene positions',
      sourcePointIndex: 'the index in the points as loaded (or in the streamed node), not a record number in the file',
      sectionReadAt: snap.readAt,
      scope: section.scopeLabel,
      streamedPoints: streamed ? (section.streamingComplete === true ? 'every known node was resident when the section was read' : RESIDENT_ONLY_NOTE) : null,
      classificationOnEverySource: section.classificationOnEverySource,
      scansLeftOut: section.leftOutScans ?? null,
      reduction: section.reduction ? { basis: describeSampleBasis(section.reduction), caveat: describeSampleCaveat(section.reduction) } : null,
      software: softwareLine(),
      provenance: { ...provenance, methodNote: 'The rows are points read from the sources inside the corridor; no method was applied to them.' },
    },
  });

  const cap = r.maxBytes ?? MAX_RETURNS_BYTES;
  const encoder = new TextEncoder();
  const blobs: Blob[] = [];
  let pending: Uint8Array<ArrayBuffer>[] = [];
  let pendingBytes = 0;
  let size = 0;
  let crc = 0;
  let chunks = 0;
  const { pause, close } = pauser();
  let receipt: ProfileReturnsReceipt;
  try {
    let since = performance.now();
    const perChunk = 2048;
    for (;;) {
      const step = rows.next();
      if (step.done) {
        receipt = step.value;
        break;
      }
      const bytes = encoder.encode(step.value);
      crc = crc32(bytes, crc);
      size += bytes.length;
      chunks++;
      // Refused on the projection, so a section that cannot fit is not built first.
      const done = Math.min(points.count, chunks * perChunk);
      if (size > cap || (size / done) * points.count > cap) {
        throw new ProfileReturnsRefusal(
          `Not exported: ${formatCount(points.count)} returns would make a file over ${Math.round(cap / (1024 * 1024))} MiB. Narrow the corridor or draw a shorter profile, then export again.`,
        );
      }
      pending.push(bytes);
      pendingBytes += bytes.length;
      if (pendingBytes >= BLOB_BYTES) {
        blobs.push(new Blob(pending));
        pending = [];
        pendingBytes = 0;
      }
      if (performance.now() - since >= SLICE_MS) {
        r.onProgress?.(done / points.count);
        await pause();
        if (r.cancelled?.()) return null;
        since = performance.now();
      }
    }
  } finally {
    close();
  }
  if (r.cancelled?.()) return null;
  // The digest and the slices took time: a scan closed or a line moved since
  // refuses the file as it would have refused the press.
  settled(ports, id, section, snap);

  const stem = returnsStem(context.scanName, summary.name);
  const json = encoder.encode(profileReturnsReceiptJson(receipt) + '\n');
  const zip = zipStoreParts<Blob | Uint8Array<ArrayBuffer>>([
    { name: `${stem}.csv`, size, crc: () => crc, parts: [...blobs, ...pending] },
    { name: `${stem}.receipt.json`, size: json.length, crc: () => crc32(json), parts: [json] },
  ]);
  const filename = `${stem}.zip`;
  (r.download ?? triggerDownload)(new Blob(zip, { type: 'application/zip' }), filename);

  const c = receipt.coordinates;
  const blank = c.blankEvicted + c.blankUnavailable + c.blankUnmatched;
  const notes = [
    `Saved ${filename} with ${formatCount(points.count)} ${points.count === 1 ? 'return' : 'returns'} and the receipt.`,
    blank > 0 ? `${formatCount(blank)} ${blank === 1 ? 'row has' : 'rows have'} no coordinate: the source is no longer loaded, or has changed.` : null,
    streamed && section.streamingComplete !== true ? `Streamed: ${RESIDENT_ONLY_NOTE}.` : null,
  ];
  return { filename, receipt, message: notes.filter((n) => n !== null).join(' ') };
}
