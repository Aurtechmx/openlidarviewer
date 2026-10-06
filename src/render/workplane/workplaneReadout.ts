/**
 * workplaneReadout.ts
 *
 * What the reference plane panel says: the unit each number is in, and the
 * readout lines for orientation, origin, elevation and spacing.
 *
 * UNITS. The grid is drawn in the scan's own source units. A number is called
 * metres or feet only when the spatial context resolves that unit, through the
 * same `SpatialContext` the measurement labels read. A geographic CRS has
 * horizontal coordinates in degrees, which are not a length, so its grid is in
 * "units". Elevation is labelled from the vertical unit, falling back to the
 * horizontal unit only when that unit is itself known
 * (`verticalMetresPerUnit(ctx, 'horizontal-when-known')`, the policy for a
 * label). A plane that spans a horizontal and the vertical axis (a vertical or
 * three-point plane) has one spacing on both, so it names a unit only when the
 * two agree.
 *
 * Pure: no DOM, no three.js.
 */

import { verticalMetresPerUnit, type SpatialContext } from '../../geo/SpatialContext';
import { horizontalUnitLabel, verticalUnitLabel } from '../../units/units';
import type { WorkplaneElevationSource, WorkplaneOrientationSetting } from '../../model/workplaneSettings';

export type WorkplaneUnitLabel = 'm' | 'ft' | 'units';

export interface WorkplaneUnits {
  /** Unit of the horizontal source axes. */
  readonly horizontal: WorkplaneUnitLabel;
  /** Unit of the up axis. */
  readonly vertical: WorkplaneUnitLabel;
  /** Why a unit reads "units", when it does. */
  readonly note: string | null;
}

/** Resolve the units the plane's numbers are stated in. */
export function workplaneUnits(ctx: SpatialContext | null): WorkplaneUnits {
  if (!ctx) return { horizontal: 'units', vertical: 'units', note: 'No coordinate system is resolved, so lengths are in source units.' };
  let horizontal: WorkplaneUnitLabel = 'units';
  let note: string | null = null;
  if (ctx.isGeographic) {
    note = 'Geographic coordinates are in degrees, which are not a length, so the grid is in source units.';
  } else if (!ctx.metricClaimsPermitted) {
    note = 'The horizontal unit is not resolved, so the grid is in source units.';
  } else {
    const h = horizontalUnitLabel({ isGeographic: ctx.isGeographic, linearUnit: ctx.linearUnit });
    horizontal = h === 'm' || h === 'ft' ? h : 'units';
  }
  const v = verticalMetresPerUnit(ctx, 'horizontal-when-known');
  const vertical: WorkplaneUnitLabel = v === undefined ? 'units' : verticalUnitLabel(v);
  return { horizontal, vertical, note };
}

/** The unit of the grid spacing for a given orientation. */
export function spacingUnit(units: WorkplaneUnits, orientation: WorkplaneOrientationSetting): WorkplaneUnitLabel {
  if (orientation === 'horizontal') return units.horizontal;
  return units.horizontal === units.vertical ? units.horizontal : 'units';
}

/** A value and its unit, joined by a no-break space. */
export function withUnit(text: string, unit: WorkplaneUnitLabel): string {
  return `${text} ${unit}`;
}

/** A grid step for display: no float noise, no trailing zeros. */
export function formatStep(v: number): string {
  return String(Number(v.toPrecision(6)));
}

/** A coordinate or elevation for display, to the millimetre of its unit. */
export function formatCoord(v: number): string {
  return v.toFixed(3);
}

const ORIENTATION_TEXT: Record<Exclude<WorkplaneOrientationSetting, 'three-point'>, (northAxis: string) => string> = {
  horizontal: () => 'Horizontal',
  'vertical-x': () => 'Vertical, along X',
  'vertical-north': (n) => `Vertical, along ${n}`,
};

const SOURCE_TEXT: Record<WorkplaneElevationSource, string> = {
  typed: 'typed',
  picked: 'picked point',
  'scan-minimum': 'lowest point in the scan, not ground',
  plane: 'on the picked plane',
};

export interface WorkplaneReadoutInput {
  readonly orientation: WorkplaneOrientationSetting;
  /** Dip of a three-point plane, degrees. */
  readonly dipDeg?: number | null;
  /** Names of the two horizontal axes, east first ('X','Y' or 'X','Z'). */
  readonly axisNames: readonly [string, string];
  readonly originH: readonly [number, number] | null;
  /** True when the origin is the scan centre rounded to the grid, not a set value. */
  readonly originAuto?: boolean;
  readonly elevation: number | null;
  readonly elevationSource: WorkplaneElevationSource | null;
  readonly spacing: { readonly major: number; readonly minor: number; readonly showMinor: boolean; readonly fixed: boolean } | null;
  readonly units: WorkplaneUnits;
  /** False when the open layers share no datum, so coordinates are scene coordinates. */
  readonly datumKnown: boolean;
}

/** The readout lines, in display order. */
export function workplaneReadout(input: WorkplaneReadoutInput): string[] {
  const { units } = input;
  const orientation =
    input.orientation === 'three-point'
      ? `Through 3 picked points${input.dipDeg != null && Number.isFinite(input.dipDeg) ? `, dip ${input.dipDeg.toFixed(1)}°` : ''}`
      : ORIENTATION_TEXT[input.orientation](input.axisNames[1]);
  const lines = [`Orientation: ${orientation}`];
  lines.push(
    input.originH === null
      ? 'Origin: scan centre (rounded to grid), placed once the plane is drawn'
      : `Origin: ${input.axisNames[0]} ${withUnit(formatCoord(input.originH[0]), units.horizontal)}, ` +
          `${input.axisNames[1]} ${withUnit(formatCoord(input.originH[1]), units.horizontal)}` +
          (input.originAuto ? ' (scan centre, rounded to grid)' : ''),
  );
  lines.push(
    input.elevation === null
      ? 'Elevation: not set'
      : `Elevation: ${withUnit(formatCoord(input.elevation), units.vertical)}` +
          (input.elevationSource ? ` (${SOURCE_TEXT[input.elevationSource]})` : ''),
  );
  if (input.spacing) {
    const u = spacingUnit(units, input.orientation);
    const major = withUnit(formatStep(input.spacing.major), u);
    const minor = input.spacing.showMinor ? `, minor ${withUnit(formatStep(input.spacing.minor), u)}` : ', minor lines hidden at this zoom';
    lines.push(`Grid ${major}${minor}${input.spacing.fixed ? ' (fixed)' : ''}`);
  } else {
    lines.push('Grid: not drawn until the elevation is set');
  }
  if (!input.datumKnown) lines.push('The open layers share no datum, so these are scene coordinates.');
  if (units.note) lines.push(units.note);
  return lines;
}

/** The one-line provenance note a snapshot carries while the plane is drawn. */
export function workplaneFigureNote(lines: readonly string[]): string {
  return `Reference plane, not measured terrain. ${lines.slice(0, 4).join('; ')}`;
}
