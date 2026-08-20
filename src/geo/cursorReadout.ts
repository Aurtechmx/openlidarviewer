/**
 * src/geo/cursorReadout.ts
 *
 * The truth model behind a persistent location banner: given the CRS the user
 * is actually working in and, optionally, the point under the cursor, it
 * answers what a continuous coordinate readout is allowed to say.
 *
 * Today a coordinate is only visible inside the Probe tool, so the frame a user
 * is looking at has no continuous statement anywhere on screen. A banner that
 * fills that gap is one line of text repeated on every mouse move, which makes
 * it the single easiest place in the product to state something false — a
 * source-unit number suffixed with "m", a CRS the user has already overridden,
 * an elevation read off Z in a Y-up scan, a latitude nobody computed.
 *
 * This module owns those decisions and nothing else. It renders no DOM, holds
 * no state, and recomputes no coordinate mathematics: the world position comes
 * from `makePointInfo`, the axis labels and unit suffixes from
 * `worldCoordLabels`, the datum-aware height label from `heightRowLabel`, and
 * every unit fact from the one {@link SpatialContext}. Pure, so the rules below
 * are testable in Node.
 *
 * THE RULES, each enforced in one place here:
 *
 *   1. The ACTIVE resolved CRS is the only CRS read. A file's declared CRS is
 *      provenance; once the user has resolved to something else — another EPSG,
 *      Local coordinates, or nothing at all — the declaration is not a fallback
 *      to reach for when the resolved frame turns out to be less informative.
 *      {@link activeReadoutCrs} is the whole of that decision.
 *   2. Units come from the context. An unresolved linear unit is stated as
 *      source units and carries no suffix; no source-unit magnitude is ever
 *      labelled metres, and the inert `linearUnitToMetres: 1` placeholder is
 *      reported as `null` rather than as a factor.
 *   3. With no point under the cursor the readout still names the frame, and
 *      invents no coordinate to sit beside it.
 *   4. A Y-up scan is read against its own vertical. Height comes off Y, the
 *      horizontal pair is X/Z, and that pair is NOT the CRS easting/northing
 *      pair, so it is labelled neutrally (the same refusal
 *      `footprintUpAxisRefusal` makes for scan outlines, for the same reason).
 *   5. Latitude and longitude appear only when a conversion actually ran and
 *      succeeded on the horizontal pair the converter consumes.
 */

import type { CrsLinearUnit } from '../io/crs';
import type { RawPointInfo } from '../render/pointInfo';
import { heightRowLabel, makePointInfo, worldCoordLabels } from '../render/pointInfo';
import type { ConversionResult, ConverterMethod } from './CoordinateConverter';
import type { GeographicPoint, ResolvedCrs } from './CoordinateTypes';
import type { SpatialContext, SpatialUpAxis } from './SpatialContext';
import { spatialContextFrom } from './SpatialContext';

// ─────────────────────────────────────────────────────────────────────────────
// Which CRS the readout is allowed to read
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The two CRSs a caller has in hand, kept apart on purpose.
 *
 * `declared` is what the source file said. It is carried here so a caller can
 * pass what it already holds without pre-filtering, and so the rule that the
 * readout ignores it is expressed in code rather than in a convention.
 * `active` is the CRS the session resolved to — `CrsService.current()` — after
 * any user override, including an explicit choice of Local coordinates.
 */
export interface CursorCrsSelection {
  /** The CRS the file declared. Provenance only; never read for the readout. */
  readonly declared?: ResolvedCrs;
  /** The active resolved CRS. `undefined` when no scan is open. */
  readonly active?: ResolvedCrs;
}

/**
 * The CRS the readout reads: the active one, always.
 *
 * The tempting bug this exists to refuse is a fallback — showing the declared
 * EPSG because the resolved frame is Local, or has no EPSG code, or is
 * unknown. Every one of those is a state the user chose or the data failed to
 * supply, and answering it with the declaration puts a coordinate system on
 * screen that nothing in the session is using.
 */
export function activeReadoutCrs(selection: CursorCrsSelection): ResolvedCrs | undefined {
  return selection.active;
}

// ─────────────────────────────────────────────────────────────────────────────
// The readout model
// ─────────────────────────────────────────────────────────────────────────────

/** How well the frame is known. Drives the banner's status text. */
export type CursorFrameStatus = 'georeferenced' | 'local' | 'unresolved';

/** One displayed axis. `value` is the number; `text` is the number plus unit. */
export interface CursorAxisReadout {
  /** Which stored axis this is — the frame's own axis, not a display slot. */
  readonly axis: 'x' | 'y' | 'z';
  /** Axis name: `Easting` / `Longitude` / `Elevation` / plain `X`. */
  readonly label: string;
  /** Unit suffix, `' m'` / `' ft'` / `'°'` / `''`. Empty asserts no unit. */
  readonly unit: string;
  /** The world-frame magnitude, origin already restored by `makePointInfo`. */
  readonly value: number;
  /** Display form — grouped digits plus {@link unit}. */
  readonly text: string;
}

/** The picked position, split into the axes the frame actually has. */
export interface CursorPositionReadout {
  /** All three axes in banner display order (the elevation axis last). */
  readonly axes: readonly CursorAxisReadout[];
  /**
   * The elevation axis, or `null` when the up axis was never determined. An
   * undetected axis is not evidence of Z-up, so no axis is named the height.
   */
  readonly vertical: CursorAxisReadout | null;
  /** The up axis this position was read against. */
  readonly upAxis: SpatialUpAxis;
}

/** The horizontal linear unit, reported without a fabricated fallback. */
export interface CursorUnitReadout {
  /** The unit token from the context. */
  readonly token: CrsLinearUnit;
  /**
   * Metres per unit, or `null` when the unit is unresolved. Never the inert
   * `1` placeholder: an unknown unit has no factor, and the international foot
   * (0.3048) and the US survey foot (1200/3937) stay distinct here because a
   * survey deliverable cannot absorb the 2 ppm between them.
   */
  readonly metresPerUnit: number | null;
  /** Short unit name — `m`, `ft`, `ftUS` — or `null` when unresolved. */
  readonly label: string | null;
  /** Axis suffix the values carry. Empty string when the unit is unresolved. */
  readonly suffix: string;
  /** Whether the unit is a real declared unit. */
  readonly known: boolean;
}

/** A latitude / longitude pair that a converter actually produced. */
export interface CursorGeographicReadout {
  readonly lat: number;
  readonly lon: number;
  /** Which converter produced it, for the same provenance the inspector shows. */
  readonly method: ConverterMethod;
  /** Display form — `Lat 29.051230° Lon -111.002340°`. */
  readonly text: string;
}

/** Everything a location banner needs, and nothing it must not claim. */
export interface CursorReadout {
  /** `EPSG:<code>` when a code is known, else the CRS name. */
  readonly crsLabel: string;
  /** Frame status the banner badges. */
  readonly status: CursorFrameStatus;
  /** Frame caveat, or `null` when the frame is georeferenced. */
  readonly statusNote: string | null;
  /** The horizontal linear unit, with no invented fallback. */
  readonly unit: CursorUnitReadout;
  /** Source-units caveat, or `null` when the unit is known. */
  readonly unitNote: string | null;
  /** The picked position, or `null` when nothing is under the cursor. */
  readonly position: CursorPositionReadout | null;
  /** Lat/lon, or `null` when no conversion is available for this frame. */
  readonly geographic: CursorGeographicReadout | null;
  /** The assembled one-line banner text. */
  readonly text: string;
}

/** Inputs for {@link cursorReadout}. */
export interface CursorReadoutInput {
  /** The declared / active CRS pair. Only `active` is read. */
  readonly crs: CursorCrsSelection;
  /**
   * The point under the cursor, in the same raw shape the picker already
   * builds for the inspector (recentred local position plus the load-time
   * origin). Omit it when the cursor is over empty space.
   */
  readonly point?: RawPointInfo;
  /**
   * Which stored axis is elevation. Required, and `'unknown'` is a real answer
   * — the readout names no height rather than defaulting to Z.
   */
  readonly upAxis: SpatialUpAxis;
  /**
   * The result of a geographic conversion the caller ACTUALLY ran. Omit it
   * when no converter handles this CRS pair; a failure is passed through as a
   * failure. The readout never converts anything itself.
   */
  readonly geographic?: ConversionResult<GeographicPoint>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────────────────────

/** Decimals for an angular axis — ~1 cm of latitude, the survey convention. */
const DEGREE_DECIMALS = 6;
/** Decimals for a linear axis — centimetres in metres, ~3 mm in feet. */
const LINEAR_DECIMALS = 2;

/**
 * Fixed-decimal number with thousands grouping, written out rather than taken
 * from `Intl` so the banner text is identical on every runtime and locale the
 * viewer and its tests run on.
 */
function formatNumber(value: number, decimals: number): string {
  const negative = value < 0;
  const [whole, fraction] = Math.abs(value).toFixed(decimals).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = fraction ? `${grouped}.${fraction}` : grouped;
  return negative ? `-${body}` : body;
}

/** Short name for a linear unit; `null` keeps an unresolved unit unnamed. */
function unitLabel(token: CrsLinearUnit): string | null {
  switch (token) {
    case 'metre':
      return 'm';
    case 'foot':
      return 'ft';
    case 'us-survey-foot':
      // Distinct from the international foot on purpose: they differ by about
      // 2 ppm, which is metres across a state-plane grid.
      return 'ftUS';
    case 'unknown':
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The model
// ─────────────────────────────────────────────────────────────────────────────

/** Frame status from the resolved kind. */
function frameStatus(ctx: SpatialContext): CursorFrameStatus {
  if (ctx.kind === 'local') return 'local';
  if (ctx.kind === 'unknown') return 'unresolved';
  return 'georeferenced';
}

/** The caveat that travels with a non-georeferenced frame. */
function statusNoteFor(status: CursorFrameStatus): string | null {
  if (status === 'local') return 'local frame, no CRS';
  if (status === 'unresolved') return 'CRS not resolved';
  return null;
}

/** One axis, formatted. */
function axisReadout(
  axis: 'x' | 'y' | 'z',
  label: string,
  unit: string,
  value: number,
  decimals: number,
): CursorAxisReadout {
  return { axis, label, unit, value, text: `${formatNumber(value, decimals)}${unit}` };
}

/**
 * Build the readout. The only entry point; everything above is the shape it
 * returns and everything below is assembly.
 */
export function cursorReadout(input: CursorReadoutInput): CursorReadout {
  // RULE 1. The active CRS, and no fallback to the declaration.
  const crs = activeReadoutCrs(input.crs);
  // RULE 2. One context, built from that CRS, is the source of every unit fact
  // below. The up axis travels with it so the context and the readout cannot
  // disagree about which axis is elevation.
  const ctx = spatialContextFrom(crs, undefined, { upAxis: input.upAxis });
  const labels = worldCoordLabels(crs);
  const upAxis = ctx.upAxis;

  const status = frameStatus(ctx);
  const crsLabel = ctx.epsg !== undefined ? `EPSG:${ctx.epsg}` : ctx.crsName;
  const unit: CursorUnitReadout = {
    token: ctx.linearUnit,
    // The placeholder factor an unknown unit carries is not a measurement.
    metresPerUnit: ctx.linearUnitKnown ? ctx.linearUnitToMetres : null,
    label: unitLabel(ctx.linearUnit),
    suffix: labels.xUnit,
    known: ctx.linearUnitKnown,
  };
  const unitNote = ctx.linearUnitKnown
    ? null
    : 'source units, no linear unit declared';

  const position = positionReadout(input, ctx, labels, crs);
  // RULE 5. Only a conversion that ran, succeeded, and consumed the frame's
  // real horizontal pair.
  const geographic = geographicReadout(input.geographic, upAxis, position !== null);

  return {
    crsLabel,
    status,
    statusNote: statusNoteFor(status),
    unit,
    unitNote,
    position,
    geographic,
    text: bannerText(crsLabel, position, geographic, statusNoteFor(status), unitNote),
  };
}

/** The picked position, or `null` — RULES 3 and 4. */
function positionReadout(
  input: CursorReadoutInput,
  ctx: SpatialContext,
  labels: ReturnType<typeof worldCoordLabels>,
  crs: ResolvedCrs | undefined,
): CursorPositionReadout | null {
  // RULE 3. No point under the cursor, no coordinate. The frame is still named
  // by the caller of this function; nothing is invented to stand beside it.
  if (!input.point) return null;

  const upAxis = ctx.upAxis;
  const yUp = upAxis === 'y';
  // A Y-up frame's horizontal pair is X/Z, which is not the pair a geographic
  // frame's degree rounding applies to, so the degree precision follows the
  // frame that actually has lon/lat on X/Y.
  const geographicHorizontal = ctx.isGeographic && !yUp;
  const world = makePointInfo({ ...input.point, geographicHorizontal });
  if (![world.x, world.y, world.z].every((n) => Number.isFinite(n))) return null;

  const horizontalDecimals = geographicHorizontal ? DEGREE_DECIMALS : LINEAR_DECIMALS;
  // The datum-aware height label is axis-independent; `'Z'` is the neutral
  // name `heightRowLabel` returns for a frame with no datum, and in a Y-up
  // scan the neutral name of the elevation axis is Y.
  const datumLabel = heightRowLabel(crs);
  const verticalLabel = datumLabel === 'Z' ? (yUp ? 'Y' : 'Z') : datumLabel;

  if (yUp) {
    // RULE 4. Elevation is Y. The remaining pair is X/Z, and it is NOT the
    // CRS's easting/northing pair — the source-local to CRS placement that
    // would make it one has never been derived for a Y-up scan — so it keeps
    // neutral axis names and the CRS's linear suffix, which is a unit claim
    // and not a placement claim.
    const x = axisReadout('x', 'X', labels.xUnit, world.x, LINEAR_DECIMALS);
    const z = axisReadout('z', 'Z', labels.xUnit, world.z, LINEAR_DECIMALS);
    const y = axisReadout('y', verticalLabel, labels.zUnit, world.y, LINEAR_DECIMALS);
    return { axes: [x, z, y], vertical: y, upAxis };
  }

  const x = axisReadout('x', labels.x, labels.xUnit, world.x, horizontalDecimals);
  const y = axisReadout('y', labels.y, labels.yUnit, world.y, horizontalDecimals);
  const z = axisReadout('z', verticalLabel, labels.zUnit, world.z, LINEAR_DECIMALS);
  // An undetermined up axis names no height: the three stored axes are
  // reported as they are, and `vertical` stays null.
  return { axes: [x, y, z], vertical: upAxis === 'z' ? z : null, upAxis };
}

/** Lat/lon, or `null` — RULE 5. */
function geographicReadout(
  result: ConversionResult<GeographicPoint> | undefined,
  upAxis: SpatialUpAxis,
  hasPosition: boolean,
): CursorGeographicReadout | null {
  if (!result || !result.ok || !hasPosition) return null;
  // A converter reads the horizontal pair as easting/northing on X/Y. In a
  // Y-up or undetermined frame that pair is not the horizontal plane, so the
  // result describes a vertical slice of the site and is withheld.
  if (upAxis !== 'z') return null;
  const { lat, lon } = result.value;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    lat,
    lon,
    method: result.method,
    text:
      `Lat ${formatNumber(lat, DEGREE_DECIMALS)}° ` +
      `Lon ${formatNumber(lon, DEGREE_DECIMALS)}°`,
  };
}

/** The one-line banner text, assembled from the parts above. */
function bannerText(
  crsLabel: string,
  position: CursorPositionReadout | null,
  geographic: CursorGeographicReadout | null,
  statusNote: string | null,
  unitNote: string | null,
): string {
  const parts: string[] = [crsLabel];
  if (statusNote) parts.push(statusNote);
  parts.push(
    position
      ? position.axes.map((a) => `${a.label} ${a.text}`).join(' ')
      : 'no point under the cursor',
  );
  if (geographic) parts.push(geographic.text);
  // The source-units caveat is stated only where there are values it qualifies.
  if (unitNote && position) parts.push(unitNote);
  return parts.join(' | ');
}
