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
 * Pure and deterministic. `generatedAt` is a parameter, so the same inputs
 * always produce the same bytes.
 */

import type { UnitSystem } from './types';
import { formatStation } from './profileSummary';
import { classificationLabel } from '../pointInfo';
import { heightLabel, heightReferenceNote, type VerticalReference } from '../../geo/height';
import { profileSectionHas, type ProfileSectionPoints } from './profileSectionBuilder';

/** Receipt/format version stamped into the sidecar. */
export const PROFILE_RETURNS_RECEIPT_VERSION = 1;

/**
 * Where a source's classification codes came from.
 *
 * `source` = the producer wrote them; `derived` = OLV's heuristic classifier
 * did. Taken from the layer's own metadata (`classificationIsDerived` on the
 * cloud), never inferred from the codes themselves: a derived classifier
 * emits the same ASPRS numbers a producer does, so the value carries no
 * evidence about its own origin. `none` = the layer classifies nothing.
 */
export type ClassificationProvenance = 'source' | 'derived' | 'none';

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
   * xyz-interleaved world positions in this source's OWN index space, so a
   * row's coordinates are read at its `source_point_index`. Absent means the
   * caller did not supply coordinates for this layer, and the x/y/z cells
   * stay blank rather than being reconstructed from the section frame.
   */
  readonly positions?: Float64Array | Float32Array;
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
}

export interface ProfileReturnsSourceReceipt {
  readonly slot: number;
  readonly layerId: string;
  readonly layerName: string;
  readonly classificationSource: ClassificationProvenance | 'unknown';
  readonly streamingNodeKey?: string;
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
  readonly visualLodInUse: boolean;
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
    readonly crs: string | null;
  };
  readonly columns: readonly string[];
  readonly generatedAt: string;
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

function normalise(up: readonly [number, number, number]): [number, number, number] {
  const len = Math.hypot(up[0], up[1], up[2]);
  if (!Number.isFinite(len) || len === 0) return [0, 0, 1];
  return [up[0] / len, up[1] / len, up[2] / len];
}

/**
 * Build the returns CSV and its sidecar receipt.
 *
 * Every column is present only when the inputs support it: a channel no
 * source carried is left out of the header entirely, and a channel some but
 * not all sources carried is present with blank cells where it is absent.
 */
export function buildProfileReturnsCsv(
  points: ProfileSectionPoints,
  options: ProfileReturnsCsvOptions,
): ProfileReturnsCsvResult {
  const n = points.count;
  const system: UnitSystem = options.system ?? 'metric';
  const metresPerUnit =
    typeof options.unitToMetres === 'number' &&
    Number.isFinite(options.unitToMetres) &&
    options.unitToMetres > 0
      ? options.unitToMetres
      : null;

  const bySlot = new Map<number, ProfileReturnsSource>();
  for (const s of options.sources) bySlot.set(s.slot, s);

  // Only an orthometric reference asserts a sea-level datum, so only it earns
  // the name `elevation`. Ellipsoidal, depth, local and unknown all write
  // `height`, which claims nothing the source did not carry.
  const heightColumn: 'height' | 'elevation' =
    options.verticalReference === 'orthometric' ? 'elevation' : 'height';

  const hasStation = metresPerUnit !== null;
  const hasXyz = options.sources.some((s) => s.positions !== undefined);
  const hasStreamingKey = options.sources.some((s) => s.streamingNodeKey !== undefined);
  const hasIntensity = points.intensity !== undefined;
  const hasClassification = points.classification !== undefined;
  const hasClassSource =
    hasClassification &&
    options.sources.some(
      (s) => s.classificationSource === 'source' || s.classificationSource === 'derived',
    );
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
    ...(hasIntensity ? ['intensity'] : []),
    ...(hasClassification ? ['classification', 'classification_label'] : []),
    ...(hasClassSource ? ['classification_source'] : []),
    ...(hasReturnNumber ? ['return_number'] : []),
    ...(hasReturnCount ? ['return_count'] : []),
    ...(hasPointSourceId ? ['point_source_id'] : []),
    ...(hasGpsTime ? ['gps_time'] : []),
    ...(hasRgb ? ['r', 'g', 'b'] : []),
  ];

  const lines: string[] = [columns.join(',')];
  const acceptedPerSlot = new Map<number, number>();

  for (let i = 0; i < n; i++) {
    const slot = points.sourceSlot[i]!;
    const src = bySlot.get(slot);
    const idx = points.pointIndex[i]!;
    const chainage = points.chainage[i]!;
    acceptedPerSlot.set(slot, (acceptedPerSlot.get(slot) ?? 0) + 1);

    const row: string[] = [];
    if (hasStation) {
      row.push(
        Number.isFinite(chainage) ? csvText(formatStation(chainage * metresPerUnit!, system)) : '',
      );
    }
    row.push(csvNumber(chainage, COORD_DECIMALS));
    row.push(csvNumber(points.height[i]!, COORD_DECIMALS));
    row.push(csvNumber(points.lateralOffset[i]!, COORD_DECIMALS));
    row.push(src ? csvText(src.layerId) : '');
    row.push(src ? csvText(src.layerName) : '');
    row.push(csvInt(idx));

    if (hasStreamingKey) row.push(src?.streamingNodeKey ? csvText(src.streamingNodeKey) : '');

    if (hasXyz) {
      const pos = src?.positions;
      // A short/misaligned array writes blanks rather than reading a
      // neighbouring point's coordinates into this row.
      const ok = pos !== undefined && (idx + 1) * 3 <= pos.length;
      row.push(ok ? csvNumber(pos[idx * 3]!, COORD_DECIMALS) : '');
      row.push(ok ? csvNumber(pos[idx * 3 + 1]!, COORD_DECIMALS) : '');
      row.push(ok ? csvNumber(pos[idx * 3 + 2]!, COORD_DECIMALS) : '');
    }

    if (hasIntensity) {
      row.push(
        profileSectionHas(points, i, 'intensity') ? csvInt(points.intensity![i]!) : '',
      );
    }

    if (hasClassification) {
      const present = profileSectionHas(points, i, 'classification');
      const code = points.classification![i]!;
      row.push(present ? csvInt(code) : '');
      row.push(present ? csvText(classificationLabel(code)) : '');
    }

    if (hasClassSource) {
      const provenance = src?.classificationSource;
      const usable =
        profileSectionHas(points, i, 'classification') &&
        (provenance === 'source' || provenance === 'derived');
      row.push(usable ? provenance : '');
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
      const present = profileSectionHas(points, i, 'rgb');
      row.push(present ? csvInt(points.rgb![i * 3]!) : '');
      row.push(present ? csvInt(points.rgb![i * 3 + 1]!) : '');
      row.push(present ? csvInt(points.rgb![i * 3 + 2]!) : '');
    }

    lines.push(row.join(','));
  }

  const receipt: ProfileReturnsReceipt = {
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
      acceptedCount: acceptedPerSlot.get(s.slot) ?? 0,
    })),
    acceptedCount: n,
    displayedCount: options.displayedIndices ? options.displayedIndices.length : null,
    visualLodInUse: options.visualLodInUse ?? false,
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
      crs: options.crsName ?? null,
    },
    columns,
    generatedAt: options.generatedAt,
  };

  return {
    csv: lines.join('\n') + '\n',
    receipt,
    receiptJson: JSON.stringify(receipt, null, 2),
  };
}
