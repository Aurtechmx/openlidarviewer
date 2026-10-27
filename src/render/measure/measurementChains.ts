/**
 * measurementChains.ts
 *
 * Aggregate operations across a selection of placed measurements —
 * the "give me the sum of these distances" / "average grade across
 * these slopes" / "total cut+fill across the levee" workflow that
 * surveyors expect after years of using CAD and survey software. Without this
 * the user has to read N rows and tap a calculator.
 *
 * The module is pure data — no DOM, no three.js. Routing rules:
 *
 *   - Each measurement KIND advertises which DIMENSIONS it contributes.
 *     A `distance` contributes length; an `area` contributes area; a
 *     `volume` contributes area AND fill / cut / net. Measurements
 *     that can't contribute the requested dimension are silently
 *     skipped (so a chain over a mixed selection still answers the
 *     question for the kinds that can).
 *
 *   - Arithmetic uses doubles. `mean` is the arithmetic mean over the
 *     contributing measurements (NOT length-weighted; weight = 1 per
 *     measurement). `count` is the contributing-measurement count.
 *
 *   - Empty contributing set: `value` is 0 for sum / mean / count, and
 *     `NaN` for min / max so the caller can render "—" rather than
 *     "0 m" (which would imply a real measured value of zero).
 *
 * All values are returned in metres / square metres / cubic metres.
 * Points are stored in RENDER (source) units, and a compound CRS can carry a
 * different unit on each axis, so every point-derived figure is computed on
 * points mapped into the metre frame the exporter uses (`toMetricFrame`):
 * horizontal components ×fH, the up component ×fV. A 3D length, a tilted area,
 * a grade and an angle then match the exported figure. Stored volumes (not
 * point-derived) scale by fH²·fV. The UI layer then formats with the active
 * unit system (metric / imperial).
 *
 * On an unconfirmed scale the unit names source units, never metres. On a
 * geographic (degree) frame every dimension but height is refused, the same
 * rule the live grade and the exports apply.
 */

import { unresolvedMetricKeys, type AxisSteps } from './geometry';
import { areaRingVerdict } from './areaValidity';
import type { Measurement, MeasurementKind, UnitSystem } from './types';
import { displayDecimals, formatArea, formatLength, formatVolume } from './format';
import { GEOGRAPHIC_NOT_AVAILABLE, VERTICAL_NOT_AVAILABLE, VERTICAL_SCALE_NOT_AVAILABLE } from './types';
import {
  angleAtVertex,
  boxFromCorners,
  boxMetrics,
  distance,
  polygonAreaPlanar,
  polylineLength,
  slopeBetween,
  toMetricFrame,
  verticalDelta,
} from './geometry';
import type { Vec3 } from '../navMath';

/** The operation to apply across the contributing measurements. */
export type ChainOperation = 'sum' | 'mean' | 'min' | 'max' | 'count';

/** The dimension to aggregate over. */
export type ChainDimension =
  | 'length' // metres
  | 'area' // square metres
  | 'volume-fill' // cubic metres
  | 'volume-cut' // cubic metres
  | 'volume-net' // cubic metres (fill − cut, signed)
  | 'height' // metres
  | 'angle' // degrees
  | 'grade'; // percent grade

/** A chain result. */
export interface ChainResult {
  /** The numeric aggregate, in the dimension's canonical unit. */
  readonly value: number;
  /** The dimension's canonical unit symbol — `'m'`, `'m²'`, `'m³'`, `'°'`, `'%'`. */
  readonly unit: string;
  /** How many measurements actually contributed to the aggregate. */
  readonly contributingCount: number;
  /** The total measurements in the input (≥ contributingCount). */
  readonly totalCount: number;
  /** The operation that produced the value. */
  readonly operation: ChainOperation;
  /** The dimension the aggregate is in. */
  readonly dimension: ChainDimension;
  /**
   * Set when the frame refuses this dimension (a geographic CRS): `value` is
   * NaN, `unit` is empty, and this is the text to show instead.
   */
  readonly refusal?: string;
  /** Set when some members were left out for a stated reason the total should carry. */
  readonly note?: string;
}

/** A chain over clip-region boxes only: no volume to give. */
export const CHAIN_CLIP_REGION_WITHHELD =
  "Volume withheld: a clip region spans the scan's full height, so it has no measured volume.";
/** A chain that totals real boxes and leaves clip regions out. */
export const CHAIN_CLIP_REGION_LEFT_OUT =
  "clip regions left out: they span the scan's full height, so they have no measured volume";

/** The scale context a chain runs in; see {@link aggregate}. */
export interface ChainScale {
  /** False when the linear scale is not confirmed: units read source units. Defaults true. */
  readonly unitsVerified?: boolean;
  /** True on a geographic (degree) frame: every dimension but height is refused. */
  readonly geographic?: boolean;
  /**
   * True when the frame has no valid local vertical (geocentric, depth-down):
   * height, grade and the volume dimensions are refused too.
   */
  readonly verticalRefused?: boolean;
  /**
   * True when the source declares a vertical unit that cannot be read. Every
   * dimension reads Z at that scale (a 3D length, a tilted area, an angle, a
   * height, a grade, a volume), so every one is refused.
   */
  readonly verticalScaleInvalid?: boolean;
  /**
   * The step each measurement's positions are held at on its own layer(s). A
   * chain with a member whose figure is below it is refused, never summed.
   */
  readonly positionSteps?: (m: Measurement) => AxisSteps | null;
}

/**
 * Which dimensions each measurement KIND can contribute to. Used by
 * the UI to grey out dimension chips that no measurement in the
 * current selection supports.
 */
export const KIND_DIMENSIONS: Readonly<
  Record<MeasurementKind, readonly ChainDimension[]>
> = {
  distance: ['length'],
  polyline: ['length'],
  area: ['area'],
  height: ['height'],
  angle: ['angle'],
  slope: ['length', 'height', 'grade'],
  profile: ['length', 'height', 'grade'],
  box: ['area', 'volume-fill'],
  volume: ['area', 'volume-fill', 'volume-cut', 'volume-net'],
};

/** Display label for each operation — drives the picker UI. */
export const OPERATION_LABEL: Readonly<Record<ChainOperation, string>> = {
  sum: 'Sum',
  mean: 'Average',
  min: 'Minimum',
  max: 'Maximum',
  count: 'Count',
};

/** Display label for each dimension. */
export const DIMENSION_LABEL: Readonly<Record<ChainDimension, string>> = {
  length: 'Length',
  area: 'Area',
  'volume-fill': 'Volume (fill)',
  'volume-cut': 'Volume (cut)',
  'volume-net': 'Volume (net)',
  height: 'Height',
  angle: 'Angle',
  grade: 'Grade',
};

/** The canonical unit string per dimension. */
const DIMENSION_UNIT: Readonly<Record<ChainDimension, string>> = {
  length: 'm',
  area: 'm²',
  'volume-fill': 'm³',
  'volume-cut': 'm³',
  'volume-net': 'm³',
  height: 'm',
  angle: '°',
  grade: '%',
};

/** The unit a dimension reads in when the linear scale is not confirmed. */
const SOURCE_UNIT: Readonly<Record<ChainDimension, string>> = {
  length: 'source units',
  area: 'source units²',
  'volume-fill': 'source units³',
  'volume-cut': 'source units³',
  'volume-net': 'source units³',
  height: 'source units',
  angle: '°',
  grade: '%',
};

/**
 * Compute a measurement's value FOR a specific dimension, or `null`
 * when the measurement doesn't contribute to that dimension.
 *
 * The math is the same the headline rows use — by going through
 * `geometry.ts` instead of duplicating, a future fix to `slopeBetween`
 * lands in the aggregate too without a second touch.
 *
 * `fH` / `fV` are the horizontal and vertical render-unit → metre factors.
 * Points are mapped into the metre frame before any geometry runs, so a figure
 * mixing the two axes is correct on a compound CRS; stored (not point-derived)
 * areas and volumes scale by fH² and fH²·fV. The defaults (1) return the
 * native figure.
 */
export function valueForDimension(
  m: Measurement,
  dim: ChainDimension,
  worldUp: Vec3 = [0, 0, 1],
  fH = 1,
  fV = fH,
): number | null {
  if (m.points.length < 2) return null;
  const p = fH === 1 && fV === 1 ? m.points : m.points.map((q) => toMetricFrame(q, worldUp, fH, fV));
  const storedArea = fH * fH;
  const storedVolume = fH * fH * fV;

  switch (dim) {
    case 'length':
      if (m.kind === 'distance' && p.length >= 2) return distance(p[0], p[1]);
      if (m.kind === 'polyline') return polylineLength(p).total;
      if (m.kind === 'slope' && p.length >= 2) return distance(p[0], p[1]);
      if (m.kind === 'profile' && p.length >= 2) return distance(p[0], p[1]);
      return null;

    case 'area':
      if (m.kind === 'area' && p.length >= 3) return areaRingVerdict(p).ok ? polygonAreaPlanar(p) : null;
      if (m.kind === 'volume' && p.length >= 3 && m.volume) {
        return m.volume.footprintArea * storedArea;
      }
      if (m.kind === 'box' && p.length >= 2) {
        // For a box, "area" is the horizontal footprint (width × depth), and
        // which two edges those are depends on the scan's up-axis. Reading
        // them off X and Y multiplied one horizontal extent by the HEIGHT on a
        // Y-up frame, and the horizontal unit factor then scaled that height
        // as well. `boxMetrics` already answers
        // this correctly, so the chain asks it rather than keeping a second
        // opinion about which axis points up.
        const b = boxMetrics(boxFromCorners(p[0], p[1]), worldUp);
        return b.width * b.depth;
      }
      return null;

    case 'volume-fill':
      // A withheld grid figure carries no fill/cut/net — it contributes
      // nothing to a chain total rather than a borrowed cut-and-fill number.
      if (m.kind === 'volume' && m.volume) return m.volume.fill != null ? m.volume.fill * storedVolume : null;
      if (m.kind === 'box' && p.length >= 2) {
        // A clip region spans the scan's full height: no measured volume.
        if (m.clipRegion === true) return null;
        // The box is built on metre-frame corners, so the up-aware answer the
        // area branch and the box readout use already carries fH²·fV.
        return boxMetrics(boxFromCorners(p[0], p[1]), worldUp).volume;
      }
      return null;

    case 'volume-cut':
      if (m.kind === 'volume' && m.volume) return m.volume.cut != null ? m.volume.cut * storedVolume : null;
      return null;

    case 'volume-net':
      if (m.kind === 'volume' && m.volume) return m.volume.net != null ? m.volume.net * storedVolume : null;
      return null;

    case 'height':
      if (m.kind === 'height' && p.length >= 2) {
        return Math.abs(verticalDelta(p[0], p[1], worldUp).vertical);
      }
      if (m.kind === 'slope' && p.length >= 2) {
        return Math.abs(verticalDelta(p[0], p[1], worldUp).vertical);
      }
      if (m.kind === 'profile' && p.length >= 2) {
        return Math.abs(verticalDelta(p[0], p[1], worldUp).vertical);
      }
      return null;

    case 'angle':
      if (m.kind === 'angle' && p.length >= 3) {
        const deg = angleAtVertex(p[0], p[1], p[2]);
        return Number.isFinite(deg) ? deg : null;
      }
      return null;

    case 'grade':
      if (m.kind === 'slope' && p.length >= 2) {
        return slopeBetween(p[0], p[1], worldUp).gradePercent;
      }
      if (m.kind === 'profile' && p.length >= 2) {
        return slopeBetween(p[0], p[1], worldUp).gradePercent;
      }
      return null;
  }
}

/**
 * Run an aggregate operation over a measurement selection in a given
 * dimension. Pure: the same input always produces the same output.
 */
/** The refusal a chain carries when a member's figure cannot be given on its scan's position step. */
export const CHAIN_UNRESOLVED =
  "not resolved: a measurement in it is held too coarsely on its scan to give this figure; load a smaller tile to measure it";

/**
 * The `measurementMetrics` keys a chain dimension's value is made from, for
 * every kind `valueForDimension` reads from the points. A figure read from the
 * cloud rather than the points (a volume's cut and fill) has none.
 */
export function chainMetricKeys(kind: Measurement['kind'], dimension: ChainDimension, clipRegion = false): readonly string[] {
  // A clip region has no measured height or volume, so offers neither.
  if (kind === 'box' && clipRegion && (dimension === 'volume-fill' || dimension === 'height')) return [];
  switch (dimension) {
    case 'length':
      if (kind === 'slope') return ['run_m', 'rise_m'];
      return kind === 'distance' || kind === 'polyline' || kind === 'profile' ? ['length_m'] : [];
    case 'area':
      if (kind === 'box') return ['width_m', 'depth_m'];
      return kind === 'area' || kind === 'volume' ? ['area_m2'] : [];
    case 'volume-fill':
      return kind === 'box' ? ['width_m', 'depth_m', 'height_m', 'volume_m3'] : [];
    case 'height':
      if (kind === 'height' || kind === 'profile') return ['vertical_m'];
      return kind === 'slope' ? ['rise_m'] : kind === 'box' ? ['height_m'] : [];
    case 'angle':
      return kind === 'angle' ? ['angle_deg'] : kind === 'slope' ? ['angle_deg'] : [];
    case 'grade':
      return kind === 'slope' || kind === 'profile' ? ['grade_pct'] : [];
    default:
      return [];
  }
}

export function aggregate(
  measurements: ReadonlyArray<Measurement>,
  operation: ChainOperation,
  dimension: ChainDimension,
  worldUp: Vec3 = [0, 0, 1],
  unitToMetres = 1,
  verticalUnitToMetres = unitToMetres,
  scale: ChainScale = {},
): ChainResult {
  const totalCount = measurements.length;
  // No local vertical: every dimension that reads Z as elevation is refused.
  if (scale.verticalRefused === true && (dimension === 'height' || dimension === 'grade' || dimension.startsWith('volume'))) {
    return { value: Number.NaN, unit: '', contributingCount: 0, totalCount, operation, dimension, refusal: VERTICAL_NOT_AVAILABLE };
  }
  // A geographic frame refuses every figure that mixes degree X/Y with a
  // linear Z; only a height (along up, in the Z unit) is left. An unreadable
  // vertical unit refuses the rest, the height included.
  const geographicRefusal = scale.geographic === true && dimension !== 'height';
  if (geographicRefusal || scale.verticalScaleInvalid === true) {
    return {
      value: Number.NaN,
      unit: '',
      contributingCount: 0,
      totalCount,
      operation,
      dimension,
      refusal: geographicRefusal ? GEOGRAPHIC_NOT_AVAILABLE : VERTICAL_SCALE_NOT_AVAILABLE,
    };
  }
  // A member whose figure cannot be given on its scan's position step has no
  // honest value, so no total, mean or extreme of it is given: the chain is refused.
  if (scale.positionSteps) {
    for (const m of measurements) {
      const keys = chainMetricKeys(m.kind, dimension, m.clipRegion === true);
      const steps = keys.length > 0 ? scale.positionSteps(m) : null;
      const unresolved = steps ? unresolvedMetricKeys(m, worldUp, unitToMetres, verticalUnitToMetres, steps) : [];
      if (keys.some((k) => unresolved.includes(k))) {
        return { value: Number.NaN, unit: '', contributingCount: 0, totalCount, operation, dimension, refusal: CHAIN_UNRESOLVED };
      }
    }
  }
  // Geometry values arrive in render (source) units; each value is converted
  // into metres ONCE, inside valueForDimension, so min/max/mean all operate on
  // already-true values. Invalid factors fall back to 1 (never multiply by
  // garbage).
  const fH = Number.isFinite(unitToMetres) && unitToMetres > 0 ? unitToMetres : 1;
  const fV = Number.isFinite(verticalUnitToMetres) && verticalUnitToMetres > 0 ? verticalUnitToMetres : fH;
  const values: number[] = [];
  for (const m of measurements) {
    const v = valueForDimension(m, dimension, worldUp, fH, fV);
    if (v !== null && Number.isFinite(v)) values.push(v);
  }
  const contributingCount = values.length;
  const clipLeftOut = dimension === 'volume-fill' && measurements.some((m) => m.kind === 'box' && m.clipRegion === true);
  if (clipLeftOut && contributingCount === 0 && operation !== 'count') {
    return { value: Number.NaN, unit: '', contributingCount: 0, totalCount, operation, dimension, refusal: CHAIN_CLIP_REGION_WITHHELD };
  }
  const note = clipLeftOut ? CHAIN_CLIP_REGION_LEFT_OUT : undefined;
  // A geographic frame has no confirmed linear scale either.
  const verified = (scale.unitsVerified ?? true) && scale.geographic !== true;
  const unit = (verified ? DIMENSION_UNIT : SOURCE_UNIT)[dimension] ?? '';

  if (operation === 'count') {
    return {
      value: contributingCount,
      unit: '',
      contributingCount,
      totalCount,
      operation,
      dimension,
    };
  }
  if (contributingCount === 0) {
    return {
      value: operation === 'min' || operation === 'max' ? Number.NaN : 0,
      unit,
      contributingCount: 0,
      totalCount,
      operation,
      dimension,
    };
  }

  let value = 0;
  switch (operation) {
    case 'sum':
      for (const v of values) value += v;
      break;
    case 'mean': {
      let sum = 0;
      for (const v of values) sum += v;
      value = sum / contributingCount;
      break;
    }
    case 'min': {
      value = values[0];
      for (let i = 1; i < values.length; i++) {
        if (values[i] < value) value = values[i];
      }
      break;
    }
    case 'max': {
      value = values[0];
      for (let i = 1; i < values.length; i++) {
        if (values[i] > value) value = values[i];
      }
      break;
    }
  }

  return {
    value,
    unit,
    contributingCount,
    totalCount,
    operation,
    dimension,
    ...(note ? { note } : {}),
  };
}

/**
 * Helper: which dimensions does this MIX of measurements support?
 * Used by the UI to render only the dimension chips that at least one
 * selected measurement can contribute to.
 */
export function supportedDimensions(
  measurements: ReadonlyArray<Measurement>,
): ChainDimension[] {
  const seen = new Set<ChainDimension>();
  for (const m of measurements) {
    // A measurement kind this build doesn't know (an imported session from a
    // newer version) has no table row — iterating `undefined` would throw in
    // the panel's render path, so it simply contributes no dimensions.
    const dims = KIND_DIMENSIONS[m.kind];
    if (!dims) continue;
    for (const dim of dims) {
      seen.add(dim);
    }
  }
  // Stable order — matches the DIMENSION_LABEL order so the UI rail
  // doesn't reshuffle as the selection changes.
  const ORDER: ChainDimension[] = [
    'length',
    'area',
    'volume-fill',
    'volume-cut',
    'volume-net',
    'height',
    'angle',
    'grade',
  ];
  return ORDER.filter((d) => seen.has(d));
}

/**
 * Compact one-line summary for a chain result, ready to drop into a
 * panel chip. Returns `'—'` when the operation produced NaN (empty
 * min/max).
 *
 * Lengths, areas and volumes go through the panel's own formatters, so a
 * total reads in the active unit system at the same significant figures as
 * the rows it sums (a 3 mm total is "0.3000 cm", not "0.00 m"). A figure in
 * source units keeps the same significant-figure policy without converting.
 */
export function formatChainResult(result: ChainResult, system: UnitSystem = 'metric'): string {
  if (result.refusal) return result.refusal;
  if (result.operation === 'count') {
    return `${result.value} of ${result.totalCount}`;
  }
  if (!Number.isFinite(result.value)) return '—';
  // Angles and grades read at 1 decimal, as the panel prints them.
  if (result.dimension === 'angle' || result.dimension === 'grade') {
    return `${result.value.toFixed(1)} ${result.unit}`.trim();
  }
  const sign = result.value < 0 ? '-' : '';
  const abs = Math.abs(result.value);
  let text: string;
  switch (result.unit) {
    case 'm':
      text = formatLength(abs, system);
      break;
    case 'm²':
      text = formatArea(abs, system);
      break;
    case 'm³':
      text = formatVolume(abs, system);
      break;
    default:
      text = `${abs.toFixed(displayDecimals(abs, 2, 4))} ${result.unit}`.trim();
  }
  return `${sign}${text}${result.note ? ` (${result.note})` : ''}`;
}
