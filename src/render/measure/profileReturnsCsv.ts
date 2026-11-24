/**
 * profileReturnsCsv.ts
 *
 * Export the returns a profile corridor actually accepted, one row per return.
 *
 * The station CSV (`buildProfileCsv`) is a REDUCTION: one robust height per
 * station bin. It answers "what is the ground doing here", and it throws away
 * the returns the estimate was derived from. This export is the other half —
 * the accepted set itself, each return still carrying the layer and source
 * index it came from and only the attributes its own source really had.
 *
 * Three properties this file exists to hold:
 *
 *   - An absent channel stays absent. A source that carries no intensity
 *     writes an empty cell, never `0`; a measured intensity of 0 and a
 *     missing one have to stay different values in the file, because a
 *     spreadsheet cannot recover the difference afterwards. Presence is read
 *     per point from `channelPresence`, so a section mixing an RGB source
 *     with a non-RGB one is written honestly row by row.
 *
 *   - The file is the FULL accepted set. A caller may pass the indices it is
 *     currently drawing (visual LOD thins what is on screen); that count is
 *     recorded in the receipt and never removes a row. An export that
 *     silently shipped the drawn subset would be a different measurement
 *     from the one the panel reported.
 *
 *   - The height column is named for what the vertical datum supports. Only
 *     an `orthometric` reference earns `elevation`; every other reference
 *     writes `height`, the same split `heightLabel` (geo/height.ts) applies
 *     to the inspector row and `buildProfileCsv` applies to its own header.
 *
 * The metadata receipt is a SIDECAR JSON, not a comment block. `toXyz` in
 * io/exporters.ts states the rule this follows: a CSV never gets comment
 * lines, because a naive parser must see the header row first.
 *
 *   - A coordinate is the one the scene holds now for that source point, and
 *     it is written only while it is still the return the section recorded.
 *     A source that has been evicted, removed or hidden, or a point that no
 *     longer matches its recorded chainage and height, leaves the x/y/z cells
 *     blank, and the receipt counts those rows by reason.
 *
 * The rows come out of a generator, so a caller can build a large section in
 * slices. Pure and deterministic. `generatedAt` is a parameter, so the same
 * inputs always produce the same bytes.
 */

import type { UnitSystem } from './types';
import { formatStation } from './profileSummary';
import { classificationLabel } from '../pointInfo';
import { heightLabel, heightReferenceNote, type VerticalReference } from '../../geo/height';
import { profileSectionHas, type ProfileSectionPoints } from './profileSectionBuilder';
import { ATTR_COLOUR_INVALID, ATTR_INTENSITY_INVALID } from '../../model/PointCloud';
import type { WithheldReadCounts } from '../../science/withheldCounts';

/**
 * Receipt/format version stamped into the sidecar. 2 adds `withheld`: the
 * section walk leaves Withheld points out, so the receipt says how many. 3 adds
 * the coordinate accounting, the display filter, the read scope and the
 * provenance record.
 */
export const PROFILE_RETURNS_RECEIPT_VERSION = 3;

/**
 * Where a source's classification codes came from.
 *
 * `source` = the producer wrote them; `derived` = OLV's heuristic classifier
 * did; `edited` = the producer's codes, changed by hand in the app; `cleared` =
 * the producer's codes were cleared in the app; `unknown` = not settled. Taken from the layer's own metadata (`classificationIsDerived` on the
 * cloud), never inferred from the codes themselves: a derived classifier
 * emits the same ASPRS numbers a producer does, so the value carries no
 * evidence about its own origin. `none` = the layer classifies nothing.
 */
export type ClassificationProvenance = 'source' | 'derived' | 'edited' | 'cleared' | 'none' | 'unknown';

/** One contributing layer, keyed by the slot its returns were pushed under. */
export interface ProfileReturnsSource {
  /** The slot passed to `ProfileSectionBuilder.beginSource`. */
  readonly slot: number;
  readonly layerId: string;
  readonly layerName: string;
  /** Classification provenance for THIS layer; absent reads as unknown. */
  readonly classificationSource?: ClassificationProvenance;
  /** Octree node id (`"depth-x-y-z"`) when the slot is a streaming node. */
  readonly streamingNodeKey?: string;
  /**
   * Reads this source's coordinate at its OWN point index into `out[0..2]`,
   * returning false when the index carries no coordinate.
   *
   * A reader rather than an array, so the frame a row's x/y/z is written in
   * is the one the caller resolved rather than whatever a raw buffer happens
   * to hold. Absent means the caller supplied no coordinates for this layer,
   * and the x/y/z cells stay blank rather than being reconstructed from the
   * section frame. `row` is the section row being written, so a caller can
   * refuse a coordinate that is no longer the return recorded there.
   */
  readonly readXYZ?: (index: number, out: Float64Array, row?: number) => boolean;
  /** Why this source has no coordinate to read, when it is gone as a whole. */
  readonly missing?: 'evicted' | 'unavailable';
  /**
   * The source's own per-point validity mask (`PointCloud.attributeInvalid`).
   * A value it flags is not a measurement and leaves its cell blank.
   */
  readonly attributeInvalid?: Uint8Array;
  /** Set when the stored intensity was rescaled at load, and how. */
  readonly intensityNote?: string | null;
  /** How this source's points were read, and its file digest, for the receipt. */
  readonly basis?: ProfileReturnsSourceBasis;
}

/** What the receipt states about one source beyond its name. */
export interface ProfileReturnsSourceBasis {
  /** "Point basis: ..." */
  readonly pointBasis: string | null;
  readonly sourceSha256: string | null;
  readonly sourceSha256Note: string | null;
}

/** What the viewer was drawing when the export was taken. Never removes a row. */
export interface ProfileReturnsDisplay {
  /** The display filter's active rules; empty when nothing was filtered. */
  readonly filters: readonly string[];
  /** Returns the filter kept, before thinning. */
  readonly keptCount: number;
}

/** Rows with a coordinate, and rows left blank by reason. */
export interface ProfileReturnsCoordinates {
  readonly written: number;
  /** The streaming node is no longer resident. */
  readonly blankEvicted: number;
  /** The source is closed, hidden or no longer eligible, or supplied none. */
  readonly blankUnavailable: number;
  /** The source point no longer matches the recorded chainage and height. */
  readonly blankUnmatched: number;
}

export interface ProfileReturnsCsvOptions {
  readonly measurementId: string;
  readonly measurementName: string;
  /** Section endpoints in the project frame. */
  readonly a: readonly [number, number, number];
  readonly b: readonly [number, number, number];
  /** Up axis; normalised into the receipt, so the caller's scale is irrelevant. */
  readonly up: readonly [number, number, number];
  /** Corridor half width, in the same unit as the section geometry. */
  readonly corridorHalfWidth: number;
  readonly verticalReference: VerticalReference;
  readonly sources: readonly ProfileReturnsSource[];
  /** ISO timestamp from the caller. The builder never reads a clock. */
  readonly generatedAt: string;
  /** Station notation. Metric km+m, imperial 100-ft. Default metric. */
  readonly system?: UnitSystem;
  /**
   * Metres per section unit. Civil stationing is defined on a real length,
   * so with no known scale the `station` column is omitted rather than
   * labelling raw render units as chainage in metres.
   */
  readonly unitToMetres?: number;
  /** Display name of the section unit, for the receipt. */
  readonly unitName?: string;
  readonly crsName?: string;
  /** Whether the viewer was drawing a thinned set when the export was taken. */
  readonly visualLodInUse?: boolean;
  /**
   * The section indices currently DRAWN. Recorded in the receipt as
   * `displayedCount` and read for nothing else — it can never remove a row.
   */
  readonly displayedIndices?: ArrayLike<number>;
  /** The section's Withheld accounting (`ProfileSectionResult.withheld`). */
  readonly withheld?: WithheldReadCounts;
  /** The display filter in force. Recorded, and read for nothing else. */
  readonly display?: ProfileReturnsDisplay;
  /** Sources the section read; more than `sources` when some contributed nothing. */
  readonly sourcesRead?: number;
  /** Metres per height unit, only when the source declares a vertical unit. */
  readonly verticalUnitToMetres?: number | null;
  /** Facts carried into the receipt as they are. */
  readonly record?: Readonly<Record<string, unknown>>;
}

export interface ProfileReturnsSourceReceipt {
  readonly slot: number;
  readonly layerId: string;
  readonly layerName: string;
  readonly classificationSource: ClassificationProvenance;
  readonly streamingNodeKey?: string;
  readonly intensityNote?: string;
  readonly basis?: ProfileReturnsSourceBasis;
  /** Returns this layer contributed to the accepted set. */
  readonly acceptedCount: number;
}

export interface ProfileReturnsReceipt {
  readonly kind: 'profile-returns';
  readonly version: number;
  readonly measurement: { readonly id: string; readonly name: string };
  readonly endpoints: {
    readonly a: readonly [number, number, number];
    readonly b: readonly [number, number, number];
  };
  /** The up axis after normalisation. */
  readonly up: readonly [number, number, number];
  readonly corridorHalfWidth: number;
  readonly sources: readonly ProfileReturnsSourceReceipt[];
  /** Rows in the CSV. Always the full accepted set. */
  readonly acceptedCount: number;
  /** Returns drawn at export time, or null when the caller passed none. */
  readonly displayedCount: number | null;
  /** Points examined, Withheld left out, points read; null when not supplied. */
  readonly withheld: WithheldReadCounts | null;
  readonly visualLodInUse: boolean;
  /** The display filter, or null when the caller stated none. */
  readonly display: ProfileReturnsDisplay | null;
  readonly sourcesRead: number;
  readonly coordinates: ProfileReturnsCoordinates;
  readonly vertical: {
    readonly reference: VerticalReference;
    readonly column: 'height' | 'elevation';
    readonly label: string;
    readonly note: string;
  };
  readonly units: {
    readonly system: UnitSystem;
    readonly unitName: string | null;
    readonly metresPerUnit: number | null;
    readonly verticalMetresPerUnit: number | null;
    readonly crs: string | null;
  };
  readonly columns: readonly string[];
  readonly generatedAt: string;
  readonly record: Readonly<Record<string, unknown>>;
}

export interface ProfileReturnsCsvResult {
  readonly csv: string;
  readonly receipt: ProfileReturnsReceipt;
  /** The sidecar, pretty-printed like the GeoJSON export. */
  readonly receiptJson: string;
}

/**
 * Escape a TEXT cell per RFC 4180 and neutralise spreadsheet formula
 * injection — the same rule `csvCell` applies in export/measurementExport.ts.
 * A cell beginning `= + - @` or a tab/CR is executed as a formula by Excel and
 * Sheets, and a layer name is file data, so it gets a literal `'` prefix and
 * is force-quoted to keep it.
 */
function csvText(v: string): string {
  const neutralise = /^[=+\-@\t\r]/.test(v);
  const cell = neutralise ? `'${v}` : v;
  return neutralise || /[",\n\r]/.test(cell) ? `"${cell.replaceAll(/"/g, '""')}"` : cell;
}

/**
 * A NUMERIC cell. Never neutralised, so `-1.500` stays a plain number rather
 * than becoming the text `'-1.500` — the same carve-out `csvCell` makes by
 * only neutralising `typeof v === 'string'`.
 */
function csvNumber(v: number, decimals: number): string {
  return Number.isFinite(v) ? v.toFixed(decimals) : '';
}

/** An integer channel value. */
function csvInt(v: number): string {
  return Number.isFinite(v) ? String(v) : '';
}

/** Millimetre precision, matching `coord()` in io/exporters.ts. */
const COORD_DECIMALS = 3;

/**
 * A world coordinate at the precision it is held, as plain decimal text. A
 * fixed three decimals would round away what a fine source scale records.
 */
function csvExact(v: number): string {
  if (!Number.isFinite(v)) return '';
  const s = String(v);
  return s.includes('e') ? v.toFixed(20).replace(/\.?0+$/, '') : s;
}

/** Rows per yielded chunk. */
export const CHUNK_ROWS = 2048;

/** The provenances a row may name. */
const NAMED_CLASS_SOURCES: ReadonlySet<string> = new Set(['source', 'derived', 'edited', 'cleared', 'unknown']);

function normalise(up: readonly [number, number, number]): [number, number, number] {
  const len = Math.hypot(up[0], up[1], up[2]);
  if (!Number.isFinite(len) || len === 0) return [0, 0, 1];
  return [up[0] / len, up[1] / len, up[2] / len];
}

/**
 * The returns CSV as text chunks, with the receipt as the return value.
 *
 * Every column is present only when the inputs support it: a channel no
 * source carried is left out of the header entirely, and a channel some but
 * not all sources carried is present with blank cells where it is absent.
 */
export function* profileReturnsCsvChunks(
  points: ProfileSectionPoints,
  options: ProfileReturnsCsvOptions,
  chunkRows: number = CHUNK_ROWS,
): Generator<string, ProfileReturnsReceipt, void> {
  const n = points.count;
  const system: UnitSystem = options.system ?? 'metric';
  const metresPerUnit =
    typeof options.unitToMetres === 'number' &&
    Number.isFinite(options.unitToMetres) &&
    options.unitToMetres > 0
      ? options.unitToMetres
      : null;

  // Text cells are escaped once per source rather than once per row.
  interface SlotRow {
    readonly src: ProfileReturnsSource | null;
    readonly names: string;
    readonly key: string;
    readonly classSource: string;
    accepted: number;
  }
  const slotRow = (src: ProfileReturnsSource | null): SlotRow => ({
    src,
    names: src ? `${csvText(src.layerId)},${csvText(src.layerName)}` : ',',
    key: src?.streamingNodeKey ? csvText(src.streamingNodeKey) : '',
    classSource:
      src?.classificationSource !== undefined && NAMED_CLASS_SOURCES.has(src.classificationSource)
        ? src.classificationSource
        : '',
    accepted: 0,
  });
  const bySlot = new Map<number, SlotRow>();
  for (const s of options.sources) bySlot.set(s.slot, slotRow(s));
  const classCells = new Map<number, string>();

  // Only an orthometric reference asserts a sea-level datum, so only it earns
  // the name `elevation`. Ellipsoidal, depth, local and unknown all write
  // `height`, which claims nothing the source did not carry.
  const heightColumn: 'height' | 'elevation' =
    options.verticalReference === 'orthometric' ? 'elevation' : 'height';

  const hasStation = metresPerUnit !== null;
  const hasXyz = options.sources.some((s) => s.readXYZ !== undefined || s.missing !== undefined);
  // Reused across every row, so a full export allocates nothing per point.
  const xyzScratch = new Float64Array(3);
  const hasStreamingKey = options.sources.some((s) => s.streamingNodeKey !== undefined);
  const hasIntensity = points.intensity !== undefined;
  const hasClassification = points.classification !== undefined;
  const hasClassSource = hasClassification && [...bySlot.values()].some((r) => r.classSource !== '');
  const hasReturnNumber = points.returnNumber !== undefined;
  const hasReturnCount = points.returnCount !== undefined;
  const hasPointSourceId = points.pointSourceId !== undefined;
  const hasGpsTime = points.gpsTime !== undefined;
  const hasRgb = points.rgb !== undefined;

  const columns: string[] = [
    ...(hasStation ? ['station'] : []),
    'chainage',
    heightColumn,
    'lateral_offset',
    'layer_id',
    'layer_name',
    'source_point_index',
    ...(hasStreamingKey ? ['streaming_node_key'] : []),
    ...(hasXyz ? ['x', 'y', 'z'] : []),
    // An intensity rescaled at load is a display mapping, named as toXyz names it.
    ...(hasIntensity ? [options.sources.some((s) => s.intensityNote) ? 'intensity_normalised' : 'intensity'] : []),
    ...(hasClassification ? ['classification', 'classification_label'] : []),
    ...(hasClassSource ? ['classification_source'] : []),
    ...(hasReturnNumber ? ['return_number'] : []),
    ...(hasReturnCount ? ['return_count'] : []),
    ...(hasPointSourceId ? ['point_source_id'] : []),
    ...(hasGpsTime ? ['gps_time'] : []),
    ...(hasRgb ? ['r', 'g', 'b'] : []),
  ];

  let text = columns.join(',') + '\n';
  let pending = 0;
  let written = 0;
  let blankEvicted = 0;
  let blankUnavailable = 0;
  let blankUnmatched = 0;

  for (let i = 0; i < n; i++) {
    const slot = points.sourceSlot[i]!;
    let entry = bySlot.get(slot);
    if (!entry) bySlot.set(slot, (entry = slotRow(null)));
    const src = entry.src;
    const idx = points.pointIndex[i]!;
    const chainage = points.chainage[i]!;
    entry.accepted++;

    const row: string[] = [];
    if (hasStation) {
      row.push(
        Number.isFinite(chainage) ? csvText(formatStation(chainage * metresPerUnit!, system)) : '',
      );
    }
    row.push(csvNumber(chainage, COORD_DECIMALS));
    row.push(csvNumber(points.height[i]!, COORD_DECIMALS));
    row.push(csvNumber(points.lateralOffset[i]!, COORD_DECIMALS));
    row.push(entry.names);
    row.push(csvInt(idx));

    if (hasStreamingKey) row.push(entry.key);

    if (hasXyz) {
      // A reader that declines the index writes blanks rather than putting a
      // neighbouring point's coordinates into this row.
      const ok =
        src?.readXYZ !== undefined &&
        src.readXYZ(idx, xyzScratch, i) &&
        Number.isFinite(xyzScratch[0]!) && Number.isFinite(xyzScratch[1]!) && Number.isFinite(xyzScratch[2]!);
      if (ok) {
        written++;
        row.push(csvExact(xyzScratch[0]!), csvExact(xyzScratch[1]!), csvExact(xyzScratch[2]!));
      } else {
        if (src?.missing === 'evicted') blankEvicted++;
        else if (src?.readXYZ !== undefined) blankUnmatched++;
        else blankUnavailable++;
        row.push('', '', '');
      }
    }

    const mask = src?.attributeInvalid;
    const invalid = mask && idx < mask.length ? mask[idx]! : 0;
    if (hasIntensity) {
      const present = profileSectionHas(points, i, 'intensity') && (invalid & ATTR_INTENSITY_INVALID) === 0;
      row.push(present ? csvInt(points.intensity![i]!) : '');
    }

    if (hasClassification) {
      const present = profileSectionHas(points, i, 'classification');
      const code = points.classification![i]!;
      let cells = ',';
      if (present) {
        cells = classCells.get(code) ?? `${csvInt(code)},${csvText(classificationLabel(code))}`;
        classCells.set(code, cells);
      }
      row.push(cells);
    }

    if (hasClassSource) {
      row.push(profileSectionHas(points, i, 'classification') ? entry.classSource : '');
    }

    if (hasReturnNumber) {
      row.push(
        profileSectionHas(points, i, 'returnNumber') ? csvInt(points.returnNumber![i]!) : '',
      );
    }
    if (hasReturnCount) {
      row.push(profileSectionHas(points, i, 'returnCount') ? csvInt(points.returnCount![i]!) : '');
    }
    if (hasPointSourceId) {
      row.push(
        profileSectionHas(points, i, 'pointSourceId') ? csvInt(points.pointSourceId![i]!) : '',
      );
    }
    if (hasGpsTime) {
      // GPS time is a large seconds value whose fraction carries the pulse
      // ordering, so it keeps six decimals rather than the spatial three.
      row.push(profileSectionHas(points, i, 'gpsTime') ? csvNumber(points.gpsTime![i]!, 6) : '');
    }
    if (hasRgb) {
      const present = profileSectionHas(points, i, 'rgb') && (invalid & ATTR_COLOUR_INVALID) === 0;
      row.push(present ? csvInt(points.rgb![i * 3]!) : '');
      row.push(present ? csvInt(points.rgb![i * 3 + 1]!) : '');
      row.push(present ? csvInt(points.rgb![i * 3 + 2]!) : '');
    }

    text += row.join(',') + '\n';
    if (++pending >= chunkRows) {
      yield text;
      text = '';
      pending = 0;
    }
  }
  if (text !== '') yield text;
  // Without x/y/z columns no row has a coordinate to count.
  if (!hasXyz) blankUnavailable = n;

  return {
    kind: 'profile-returns',
    version: PROFILE_RETURNS_RECEIPT_VERSION,
    measurement: { id: options.measurementId, name: options.measurementName },
    endpoints: { a: [...options.a] as [number, number, number], b: [...options.b] as [number, number, number] },
    up: normalise(options.up),
    corridorHalfWidth: options.corridorHalfWidth,
    sources: options.sources.map((s) => ({
      slot: s.slot,
      layerId: s.layerId,
      layerName: s.layerName,
      classificationSource: s.classificationSource ?? 'unknown',
      ...(s.streamingNodeKey !== undefined ? { streamingNodeKey: s.streamingNodeKey } : {}),
      ...(s.intensityNote ? { intensityNote: s.intensityNote } : {}),
      ...(s.basis ? { basis: s.basis } : {}),
      acceptedCount: bySlot.get(s.slot)?.accepted ?? 0,
    })),
    acceptedCount: n,
    displayedCount: options.displayedIndices ? options.displayedIndices.length : null,
    withheld: options.withheld ?? null,
    visualLodInUse: options.visualLodInUse ?? false,
    display: options.display ?? null,
    sourcesRead: options.sourcesRead ?? options.sources.length,
    coordinates: { written, blankEvicted, blankUnavailable, blankUnmatched },
    vertical: {
      reference: options.verticalReference,
      column: heightColumn,
      label: heightLabel(options.verticalReference),
      note: heightReferenceNote(options.verticalReference),
    },
    units: {
      system,
      unitName: options.unitName ?? null,
      metresPerUnit,
      verticalMetresPerUnit: options.verticalUnitToMetres ?? null,
      crs: options.crsName ?? null,
    },
    columns,
    generatedAt: options.generatedAt,
    record: options.record ?? {},
  };
}

/** The sidecar text: pretty-printed, like the GeoJSON export. */
export function profileReturnsReceiptJson(receipt: ProfileReturnsReceipt): string {
  return JSON.stringify(receipt, null, 2);
}

/** {@link profileReturnsCsvChunks} run to completion, as one string. */
export function buildProfileReturnsCsv(
  points: ProfileSectionPoints,
  options: ProfileReturnsCsvOptions,
): ProfileReturnsCsvResult {
  const it = profileReturnsCsvChunks(points, options);
  let csv = '';
  let step = it.next();
  while (!step.done) {
    csv += step.value;
    step = it.next();
  }
  return { csv, receipt: step.value, receiptJson: profileReturnsReceiptJson(step.value) };
}
