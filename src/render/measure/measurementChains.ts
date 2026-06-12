/**
 * measurementChains.ts
 *
 * Aggregate operations across a selection of placed measurements —
 * the "give me the sum of these distances" / "average grade across
 * these slopes" / "total cut+fill across the levee" workflow that
 * surveyors expect after years of using AutoCAD / TBC. Without this
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
 * Geometry math runs in RENDER (source) units — a foot-CRS scan keeps
 * feet in render space — so `aggregate` takes the CRS's
 * `unitToMetres` factor (B2, v0.4.5) and scales each contributed
 * value by f^power(dimension): lengths ×f, areas ×f², volumes ×f³,
 * heights ×f; angles and grades are dimensionless. The UI layer then
 * formats with the active unit system (metric / imperial) via
 * `formatLength` / `formatArea` / `formatVolume`.
 */

import type { Measurement, MeasurementKind } from './types';
import {
  angleAtVertex,
  distance,
  polygonAreaPlanar,
  polylineLength,
  slopeBetween,
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

/**
 * The power of the render-unit → metre factor each dimension needs:
 * 1 for lengths/heights, 2 for areas, 3 for volumes, 0 for the
 * dimensionless angle/grade. Single table so a future dimension can't
 * forget its unit behaviour (B2).
 */
const DIMENSION_UNIT_POWER: Readonly<Record<ChainDimension, number>> = {
  length: 1,
  area: 2,
  'volume-fill': 3,
  'volume-cut': 3,
  'volume-net': 3,
  height: 1,
  angle: 0,
  grade: 0,
};

/**
 * Compute a measurement's value FOR a specific dimension, or `null`
 * when the measurement doesn't contribute to that dimension.
 *
 * The math is the same the headline rows use — by going through
 * `geometry.ts` instead of duplicating, a future fix to `slopeBetween`
 * lands in the aggregate too without a second touch.
 */
export function valueForDimension(
  m: Measurement,
  dim: ChainDimension,
  worldUp: Vec3 = [0, 0, 1],
): number | null {
  const p = m.points;
  if (p.length < 2) return null;

  switch (dim) {
    case 'length':
      if (m.kind === 'distance' && p.length >= 2) return distance(p[0], p[1]);
      if (m.kind === 'polyline') return polylineLength(p).total;
      if (m.kind === 'slope' && p.length >= 2) return distance(p[0], p[1]);
      if (m.kind === 'profile' && p.length >= 2) return distance(p[0], p[1]);
      return null;

    case 'area':
      if (m.kind === 'area' && p.length >= 3) return polygonAreaPlanar(p);
      if (m.kind === 'volume' && p.length >= 3 && m.volume) {
        return m.volume.footprintArea;
      }
      if (m.kind === 'box' && p.length >= 2) {
        // For a box, "area" is the horizontal footprint (width × depth).
        const dx = Math.abs(p[1][0] - p[0][0]);
        const dy = Math.abs(p[1][1] - p[0][1]);
        return dx * dy;
      }
      return null;

    case 'volume-fill':
      if (m.kind === 'volume' && m.volume) return m.volume.fill;
      if (m.kind === 'box' && p.length >= 2) {
        const dx = Math.abs(p[1][0] - p[0][0]);
        const dy = Math.abs(p[1][1] - p[0][1]);
        const dz = Math.abs(p[1][2] - p[0][2]);
        return dx * dy * dz;
      }
      return null;

    case 'volume-cut':
      if (m.kind === 'volume' && m.volume) return m.volume.cut;
      return null;

    case 'volume-net':
      if (m.kind === 'volume' && m.volume) return m.volume.net;
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
        return angleAtVertex(p[0], p[1], p[2]);
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
export function aggregate(
  measurements: ReadonlyArray<Measurement>,
  operation: ChainOperation,
  dimension: ChainDimension,
  worldUp: Vec3 = [0, 0, 1],
  unitToMetres = 1,
): ChainResult {
  const totalCount = measurements.length;
  // B2 — geometry values arrive in render (source) units; convert into the
  // dimension's canonical metre-based unit ONCE, here, so min/max/mean all
  // operate on already-true values. Invalid factors fall back to 1 (the
  // pre-B2 "assume metres" behaviour — never multiply by garbage).
  const f = Number.isFinite(unitToMetres) && unitToMetres > 0 ? unitToMetres : 1;
  // `?? 0` guards a dimension string this build doesn't know (a forward-
  // compat session / embed caller): power 0 means "no scaling", and the
  // unknown dimension contributes nothing below — never a NaN aggregate.
  const k = Math.pow(f, DIMENSION_UNIT_POWER[dimension] ?? 0);
  const values: number[] = [];
  for (const m of measurements) {
    const v = valueForDimension(m, dimension, worldUp);
    if (v !== null && Number.isFinite(v)) values.push(v * k);
  }
  const contributingCount = values.length;
  const unit = DIMENSION_UNIT[dimension];

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
 */
export function formatChainResult(result: ChainResult): string {
  if (result.operation === 'count') {
    return `${result.value} of ${result.totalCount}`;
  }
  if (!Number.isFinite(result.value)) return '—';
  // 2 decimal places for most dimensions; angles and grades get 1
  // decimal because their meaningful precision is coarser.
  const decimals =
    result.dimension === 'angle' || result.dimension === 'grade' ? 1 : 2;
  return `${result.value.toFixed(decimals)} ${result.unit}`.trim();
}
