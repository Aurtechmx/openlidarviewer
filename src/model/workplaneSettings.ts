/**
 * workplaneSettings.ts
 *
 * The reference plane's settings as plain data: what the user chose, in the
 * scan's source coordinates. The session file stores exactly this, and
 * {@link parseWorkplaneSettings} is the schema-safe reader: anything missing,
 * malformed or out of range falls back to the default rather than throwing,
 * and a block that cannot be read at all is dropped.
 *
 * The plane is a VIEW setting. Nothing here is measured, and no analysis,
 * export or digest reads it.
 */

export type WorkplaneOrientationSetting = 'horizontal' | 'vertical-x' | 'vertical-north' | 'three-point';

/** How the elevation was set. There is no "ground" source on purpose. */
export type WorkplaneElevationSource = 'typed' | 'picked' | 'scan-minimum' | 'plane';

export type WorkplaneTriple = readonly [number, number, number];

export interface WorkplaneSettings {
  /** Drawn or not. Off by default. */
  readonly enabled: boolean;
  readonly orientation: WorkplaneOrientationSetting;
  /**
   * Origin on the two horizontal source axes (X and Y on a Z-up scan, X and Z
   * on a Y-up scan), or null for the scan's horizontal centre rounded to the
   * current major spacing, which the readout states as such.
   */
  readonly originH: readonly [number, number] | null;
  /** Elevation of the origin in source vertical units; null until the user sets it. */
  readonly elevation: number | null;
  readonly elevationSource: WorkplaneElevationSource | null;
  /** Fixed major spacing in source units, or null for automatic. */
  readonly fixedSpacing: number | null;
  /** The three picked points, source coordinates, when the orientation is three-point. */
  readonly points: readonly [WorkplaneTriple, WorkplaneTriple, WorkplaneTriple] | null;
}

export const WORKPLANE_DEFAULTS: WorkplaneSettings = {
  enabled: false,
  orientation: 'horizontal',
  originH: null,
  elevation: null,
  elevationSource: null,
  fixedSpacing: null,
  points: null,
};

const ORIENTATIONS: readonly WorkplaneOrientationSetting[] = ['horizontal', 'vertical-x', 'vertical-north', 'three-point'];
const SOURCES: readonly WorkplaneElevationSource[] = ['typed', 'picked', 'scan-minimum', 'plane'];

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function triple(v: unknown): WorkplaneTriple | null {
  return Array.isArray(v) && v.length === 3 && v.every(finite) ? [v[0], v[1], v[2]] : null;
}

/**
 * Read a settings block from an untrusted source (a session file). Returns null
 * when `raw` is not an object; otherwise every field is checked on its own and
 * an invalid one takes its default. A three-point orientation without three
 * valid points falls back to horizontal, so a damaged file can never draw a
 * plane through points it does not carry.
 */
export function parseWorkplaneSettings(raw: unknown): WorkplaneSettings | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const points = Array.isArray(o.points) && o.points.length === 3 ? o.points.map(triple) : null;
  const validPoints =
    points && points[0] && points[1] && points[2] ? ([points[0], points[1], points[2]] as const) : null;
  let orientation = ORIENTATIONS.includes(o.orientation as WorkplaneOrientationSetting)
    ? (o.orientation as WorkplaneOrientationSetting)
    : WORKPLANE_DEFAULTS.orientation;
  if (orientation === 'three-point' && !validPoints) orientation = 'horizontal';
  const originH =
    Array.isArray(o.originH) && o.originH.length === 2 && o.originH.every(finite)
      ? ([o.originH[0], o.originH[1]] as const)
      : null;
  const elevation = finite(o.elevation) ? o.elevation : null;
  const elevationSource =
    elevation !== null && SOURCES.includes(o.elevationSource as WorkplaneElevationSource)
      ? (o.elevationSource as WorkplaneElevationSource)
      : elevation !== null
        ? 'typed'
        : null;
  return {
    enabled: o.enabled === true,
    orientation,
    originH,
    elevation,
    elevationSource,
    fixedSpacing: finite(o.fixedSpacing) && o.fixedSpacing > 0 ? o.fixedSpacing : null,
    points: orientation === 'three-point' ? validPoints : null,
  };
}
