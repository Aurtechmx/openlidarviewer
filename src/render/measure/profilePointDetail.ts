/**
 * profilePointDetail.ts
 *
 * One selected return of a profile cross-section, as an ordered list of
 * labelled rows a card can render. Pure and DOM-free.
 *
 * `buildProfileReturnsCsv` writes the whole accepted set to a file; this is
 * the same facts for a SINGLE return, on screen. Both read presence from
 * `channelPresence` per point rather than per section, so the two can never
 * disagree about what a return actually carried, and both take their source
 * identity from the same `ProfileReturnsSource` records the export already
 * defines — the card cannot name a layer, a provenance, or a streaming node
 * the export would name differently.
 *
 * Three properties this module exists to hold:
 *
 *   - Absence is not zero. A channel no source carried produces NO row. A
 *     channel some source carried, at a point whose presence bit is clear,
 *     produces a row with `known: false` and a null value. A measured
 *     intensity of 0 is `{ value: '0', known: true }`, which no consumer can
 *     confuse with the absent case. The typed arrays are zero-filled, so
 *     reading one without consulting its bit invents a measurement.
 *
 *   - Only channels `PointCloud` retains appear. There is no scan angle rank,
 *     no LAS user data, no scanner channel and no waveform row: the loader
 *     keeps none of them, so a row for any of them could only be fabricated.
 *     `PROFILE_ATTRIBUTES` is the closed list, and the row ids below cover it
 *     exactly.
 *
 *   - The height row is named for what the vertical datum supports. The
 *     wording comes from `heightLabel` (geo/height.ts) unchanged, so only an
 *     `orthometric` reference reads "Elevation"; ellipsoidal, depth, local and
 *     unknown each read their own honest height wording. The same split the
 *     returns CSV applies to its height column and the inspector to its Z row.
 *
 * Return number and return count are separate rows, not a combined "2 of 3".
 * They have INDEPENDENT presence bits in `channelPresence`, and a source that
 * carried one but not the other would have to be rendered under a single
 * joint decision — which is exactly the absent-reads-as-zero failure, one
 * level up.
 */

import type { ResolvedCrs } from '../../geo/CoordinateTypes';
import {
  heightLabel,
  heightReferenceNote,
  type VerticalReference,
} from '../../geo/height';
import {
  classificationLabel,
  heightRowLabel,
  pointVerticalReference,
  worldCoordLabels,
} from '../pointInfo';
import { formatStation } from './profileSummary';
import { profileSectionHas, type ProfileSectionPoints } from './profileSectionBuilder';
import type { ClassificationProvenance, ProfileReturnsSource } from './profileReturnsCsv';
import type { UnitSystem } from './types';

/**
 * Identity of a row, stable across locales and label changes so a consumer can
 * address a row without matching its display text.
 *
 * Deliberately closed, and deliberately WITHOUT `scanAngleRank`, `userData`,
 * `scannerChannel` or any waveform id. Adding one would require a value, and
 * no value exists to give it.
 */
export type ProfileDetailRowId =
  | 'station'
  | 'chainage'
  | 'height'
  | 'lateralOffset'
  | 'layerName'
  | 'layerId'
  | 'sourcePointIndex'
  | 'streamingNodeKey'
  | 'coordX'
  | 'coordY'
  | 'coordZ'
  | 'rgb'
  | 'intensity'
  | 'classification'
  | 'classificationSource'
  | 'returnNumber'
  | 'returnCount'
  | 'pointSourceId'
  | 'gpsTime'
  | 'normal';

/**
 * Which block of the card a row belongs to.
 *
 * `section` and `coordinates` can both carry a datum-named height row, so the
 * group is what keeps two identically-labelled rows distinguishable without
 * re-spelling either label.
 */
export type ProfileDetailGroup = 'section' | 'identity' | 'coordinates' | 'attributes';

/** One labelled row. */
export interface ProfileDetailRow {
  readonly id: ProfileDetailRowId;
  readonly group: ProfileDetailGroup;
  /** Display label. Height wording comes from `heightLabel`, never re-spelled. */
  readonly label: string;
  /**
   * Rendered value, or `null` when this return does not carry the channel.
   *
   * `null` is only ever paired with `known: false`, and a `known: false` row is
   * only emitted when the SECTION carries the channel but this point does not.
   */
  readonly value: string | null;
  /** False when the value is genuinely unknown for this return. */
  readonly known: boolean;
}

/** The finished descriptor for one selected return. */
export interface ProfilePointDetail {
  /** Index into the section arrays. */
  readonly index: number;
  /** Heading for the coordinate block, e.g. `World (NAD83 / UTM 13N)`. */
  readonly coordinateHeading: string;
  /** The reference the height row is measured from. */
  readonly verticalReference: VerticalReference;
  /** One-line explanation of that reference, from `heightReferenceNote`. */
  readonly verticalNote: string;
  readonly rows: readonly ProfileDetailRow[];
}

export interface ProfilePointDetailOptions {
  /** The same source records the returns CSV is given, keyed by slot. */
  readonly sources: readonly ProfileReturnsSource[];
  /**
   * Resolved CRS of the section frame, when known.
   *
   * The ONLY input the vertical reference is derived from, via
   * `pointVerticalReference`. There is no separate reference option, so the
   * card cannot be handed a datum that contradicts the CRS naming its axes.
   */
  readonly crs?: ResolvedCrs;
  /** Station notation. Metric km+m, imperial 100-ft. Default metric. */
  readonly system?: UnitSystem;
  /**
   * Metres per section unit. Civil stationing is defined on a real length, so
   * with no known scale the station row is omitted rather than labelling raw
   * render units as chainage in metres — the returns CSV omits its `station`
   * column under the same rule.
   */
  readonly unitToMetres?: number;
}

/** Millimetre precision, matching `coord()` in io/exporters.ts. */
const COORD_DECIMALS = 3;

/**
 * GPS time keeps six decimals rather than the spatial three: it is a large
 * seconds value whose fraction carries the pulse ordering.
 */
const GPS_DECIMALS = 6;

/** Normal components, matching the 4-decimal rounding `makePointInfo` applies. */
const NORMAL_DECIMALS = 4;

/**
 * Display text for a classification's origin.
 *
 * `'derived'` reuses the "Derived (heuristic)" wording the class legend already
 * shows, so a user who has seen the legend reads the same claim here. Taken
 * from the layer's metadata, never inferred from the codes: a derived
 * classifier emits the same ASPRS numbers a producer does.
 */
function provenanceText(p: ClassificationProvenance): string | null {
  switch (p) {
    case 'source':
      return 'Producer supplied';
    case 'derived':
      return 'Derived (heuristic)';
    case 'none':
      return null;
  }
}

/** Fixed-decimal text, or `null` for a non-finite magnitude. */
function num(v: number, decimals: number): string | null {
  return Number.isFinite(v) ? v.toFixed(decimals) : null;
}

/** Integer text, or `null` for a non-finite value. */
function int(v: number): string | null {
  return Number.isFinite(v) ? String(v) : null;
}

/**
 * A signed magnitude: positives carry an explicit `+` so which side of the
 * alignment a return sits on is readable without comparing against a
 * neighbour. `toFixed` already supplies the `-`.
 */
function signed(v: number, decimals: number): string | null {
  if (!Number.isFinite(v)) return null;
  const text = v.toFixed(decimals);
  return v > 0 ? `+${text}` : text;
}

/** A row whose value is known. */
function known(
  id: ProfileDetailRowId,
  group: ProfileDetailGroup,
  label: string,
  value: string,
): ProfileDetailRow {
  return { id, group, label, value, known: true };
}

/** A row the section supports but this return does not carry. */
function unknownRow(
  id: ProfileDetailRowId,
  group: ProfileDetailGroup,
  label: string,
): ProfileDetailRow {
  return { id, group, label, value: null, known: false };
}

/**
 * A channel row, gated on the point's own presence bit.
 *
 * `channelPresent` is whether the SECTION carries the channel at all; when it
 * does not, the caller passes `false` and gets nothing back, so no row is
 * emitted. When it does, a point whose bit is clear yields the explicit
 * unknown row rather than the zero sitting in the typed array.
 */
function channelRow(
  channelPresent: boolean,
  pointHasIt: boolean,
  id: ProfileDetailRowId,
  group: ProfileDetailGroup,
  label: string,
  render: () => string | null,
): ProfileDetailRow | null {
  if (!channelPresent) return null;
  if (!pointHasIt) return unknownRow(id, group, label);
  const value = render();
  return value === null ? unknownRow(id, group, label) : known(id, group, label, value);
}

/**
 * Build the detail descriptor for return `i`, or `null` when `i` is not a
 * return of this section.
 *
 * Row order is the card's reading order: where the return sits in the section,
 * which point it is, where it is in the world, then what it measured.
 */
export function buildProfilePointDetail(
  points: ProfileSectionPoints,
  i: number,
  options: ProfilePointDetailOptions,
): ProfilePointDetail | null {
  if (!Number.isInteger(i) || i < 0 || i >= points.count) return null;

  const crs = options.crs;
  const system: UnitSystem = options.system ?? 'metric';
  const reference = pointVerticalReference(crs);
  const axes = worldCoordLabels(crs);

  const metresPerUnit =
    typeof options.unitToMetres === 'number' &&
    Number.isFinite(options.unitToMetres) &&
    options.unitToMetres > 0
      ? options.unitToMetres
      : null;

  const slot = points.sourceSlot[i]!;
  const src = options.sources.find((s) => s.slot === slot);
  const idx = points.pointIndex[i]!;
  const chainage = points.chainage[i]!;

  const rows: ProfileDetailRow[] = [];
  const push = (row: ProfileDetailRow | null): void => {
    if (row) rows.push(row);
  };

  // ── Section placement ──────────────────────────────────────────────────
  if (metresPerUnit !== null && Number.isFinite(chainage)) {
    push(known('station', 'section', 'Station', formatStation(chainage * metresPerUnit, system)));
  }
  const chainageText = num(chainage, COORD_DECIMALS);
  if (chainageText !== null) push(known('chainage', 'section', 'Chainage', chainageText));

  // Wording straight from `heightLabel`, so "Elevation" appears for an
  // orthometric reference and for nothing else.
  const heightText = num(points.height[i]!, COORD_DECIMALS);
  if (heightText !== null) {
    push(known('height', 'section', heightLabel(reference), heightText));
  }

  const offsetText = signed(points.lateralOffset[i]!, COORD_DECIMALS);
  if (offsetText !== null) {
    push(known('lateralOffset', 'section', 'Lateral offset', offsetText));
  }

  // ── Identity ───────────────────────────────────────────────────────────
  // A return always came from some layer, so an unregistered slot is a real
  // unknown and says so rather than dropping the row.
  push(
    src
      ? known('layerName', 'identity', 'Layer', src.layerName)
      : unknownRow('layerName', 'identity', 'Layer'),
  );
  push(
    src
      ? known('layerId', 'identity', 'Layer id', src.layerId)
      : unknownRow('layerId', 'identity', 'Layer id'),
  );
  const idxText = int(idx);
  if (idxText !== null) {
    push(known('sourcePointIndex', 'identity', 'Source point index', idxText));
  }
  // Only when this return's own source IS a streaming node. A static layer in
  // a mixed section has no node key, and an empty row would imply it lost one.
  if (src?.streamingNodeKey !== undefined) {
    push(known('streamingNodeKey', 'identity', 'Streaming node', src.streamingNodeKey));
  }

  // ── Coordinates ────────────────────────────────────────────────────────
  // Read through the source's own reader, so the frame is the one the caller
  // resolved. A reader that declines the index yields unknown rows rather than
  // a neighbouring point's position.
  if (src?.readXYZ !== undefined) {
    const out = new Float64Array(3);
    const ok = src.readXYZ(idx, out);
    const axis = (
      id: ProfileDetailRowId,
      label: string,
      value: number,
      unit: string,
    ): ProfileDetailRow => {
      if (!ok) return unknownRow(id, 'coordinates', label);
      const text = num(value, COORD_DECIMALS);
      return text === null
        ? unknownRow(id, 'coordinates', label)
        : known(id, 'coordinates', label, `${text}${unit}`);
    };
    push(axis('coordX', axes.x, out[0]!, axes.xUnit));
    push(axis('coordY', axes.y, out[1]!, axes.yUnit));
    // `heightRowLabel`, not `axes.z`: the world-group Z label reads "Elevation"
    // for every projected CRS, which asserts a sea-level datum an undeclared
    // vertical reference never carried.
    push(axis('coordZ', heightRowLabel(crs), out[2]!, axes.zUnit));
  }

  // ── Attributes ─────────────────────────────────────────────────────────
  push(
    channelRow(
      points.rgb !== undefined,
      profileSectionHas(points, i, 'rgb'),
      'rgb',
      'attributes',
      'RGB',
      () => `${points.rgb![i * 3]!}, ${points.rgb![i * 3 + 1]!}, ${points.rgb![i * 3 + 2]!}`,
    ),
  );
  push(
    channelRow(
      points.intensity !== undefined,
      profileSectionHas(points, i, 'intensity'),
      'intensity',
      'attributes',
      'Intensity',
      () => int(points.intensity![i]!),
    ),
  );

  const hasClassAtPoint = profileSectionHas(points, i, 'classification');
  push(
    channelRow(
      points.classification !== undefined,
      hasClassAtPoint,
      'classification',
      'attributes',
      'Classification',
      () => {
        const code = points.classification![i]!;
        return `${code} (${classificationLabel(code)})`;
      },
    ),
  );
  // Provenance belongs to the code, so it is shown only where a code is. A
  // layer that declares neither `source` nor `derived` has an unstated origin,
  // which is an unknown row rather than a silent "producer".
  if (points.classification !== undefined) {
    const text = src?.classificationSource
      ? provenanceText(src.classificationSource)
      : null;
    push(
      !hasClassAtPoint || text === null
        ? unknownRow('classificationSource', 'attributes', 'Classification source')
        : known('classificationSource', 'attributes', 'Classification source', text),
    );
  }

  push(
    channelRow(
      points.returnNumber !== undefined,
      profileSectionHas(points, i, 'returnNumber'),
      'returnNumber',
      'attributes',
      'Return number',
      () => int(points.returnNumber![i]!),
    ),
  );
  push(
    channelRow(
      points.returnCount !== undefined,
      profileSectionHas(points, i, 'returnCount'),
      'returnCount',
      'attributes',
      'Returns in pulse',
      () => int(points.returnCount![i]!),
    ),
  );
  push(
    channelRow(
      points.pointSourceId !== undefined,
      profileSectionHas(points, i, 'pointSourceId'),
      'pointSourceId',
      'attributes',
      'Point source id',
      () => int(points.pointSourceId![i]!),
    ),
  );
  push(
    channelRow(
      points.gpsTime !== undefined,
      profileSectionHas(points, i, 'gpsTime'),
      'gpsTime',
      'attributes',
      'GPS time',
      () => num(points.gpsTime![i]!, GPS_DECIMALS),
    ),
  );
  push(
    channelRow(
      points.normals !== undefined,
      profileSectionHas(points, i, 'normals'),
      'normal',
      'attributes',
      'Normal',
      () => {
        const x = num(points.normals![i * 3]!, NORMAL_DECIMALS);
        const y = num(points.normals![i * 3 + 1]!, NORMAL_DECIMALS);
        const z = num(points.normals![i * 3 + 2]!, NORMAL_DECIMALS);
        return x === null || y === null || z === null ? null : `${x}, ${y}, ${z}`;
      },
    ),
  );

  return {
    index: i,
    coordinateHeading: axes.heading,
    verticalReference: reference,
    verticalNote: heightReferenceNote(reference),
    rows,
  };
}

/** The row with this id, or `null` when the descriptor carries none. */
export function profileDetailRow(
  detail: ProfilePointDetail,
  id: ProfileDetailRowId,
): ProfileDetailRow | null {
  return detail.rows.find((r) => r.id === id) ?? null;
}
