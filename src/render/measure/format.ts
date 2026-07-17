/**
 * format.ts
 *
 * Unit-aware formatting of measurement values for on-screen labels and the
 * Measurements panel. Pure — unit-tested in Node.
 *
 * The metric length format delegates to `navMath.formatDistance`, so the
 * distance tool's labels stay byte-identical to the original implementation
 * (no regression). The imperial branch and the area / angle / grade
 * formatters live here.
 */

import { formatDistance } from '../navMath';
import type { UnitSystem } from './types';

/**
 * The measurement stack's honest limitation on a GEOGRAPHIC (degree) CRS.
 * Render X/Y are degrees while Z is a linear unit, so 3D lengths, areas,
 * grades and profile chainage mix units and NO single `unitToMetres` factor
 * can fix them (a degree of longitude alone varies with cos φ). Rather than
 * silently mislabel degrees as metres — a 0.35-"m" corridor is really
 * ≈ 39 km — the stack keeps working but states this limit everywhere
 * measurements surface: the measure-bar hint, the Measurements panel's
 * persistent caveat, and each affected measurement's trust grade. ONE
 * string, shared by all three, so the wording cannot fork.
 */
export const GEOGRAPHIC_CRS_MEASURE_NOTICE =
  'Geographic CRS (degrees): X/Y are in degrees, not metres, so lengths, ' +
  'areas, grades and profiles are NOT reliable distances. Reproject to a ' +
  'projected CRS for measurement work.';

/**
 * The measurement stack's honest limitation on a COMPOUND CRS whose vertical
 * (height) unit differs from its horizontal linear unit — e.g. UTM metres with
 * a NAVD88 height in US survey feet. Pure-vertical readouts (heights, box
 * height, cut/fill thickness) are scaled by the vertical factor and stay
 * honest, but a 3D length, a tilted planar area, or a grade combines the two
 * units and no single factor makes it a true distance. Rather than dress up a
 * figure that is off by the units' ratio, the stack refuses those kinds and
 * states why — the same red-grade + caveat pattern as the geographic case, so
 * the wording cannot fork.
 */
export const VERTICAL_UNIT_MISMATCH_MEASURE_NOTICE =
  'Compound CRS: the height unit differs from the horizontal unit, so 3D ' +
  'lengths, areas and grades mix units and are NOT reliable distances. ' +
  'Heights are scaled correctly; use them, or reproject to a single unit.';

const FEET_PER_METRE = 3.280839895013123;
const SQFT_PER_SQM = FEET_PER_METRE * FEET_PER_METRE;
const SQFT_PER_ACRE = 43_560;
const FEET_PER_MILE = 5_280;

/** Group digits for readability — e.g. "1,234.56". */
function grouped(value: number, decimals: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Format a length given in metres for the active unit system. */
export function formatLength(metres: number, system: UnitSystem): string {
  if (!Number.isFinite(metres)) return '—';
  if (system === 'metric') return formatDistance(metres);

  const feet = metres * FEET_PER_METRE;
  const abs = Math.abs(feet);
  if (abs < 1) return `${(feet * 12).toFixed(1)} in`;
  if (abs < FEET_PER_MILE) return `${feet.toFixed(2)} ft`;
  return `${(feet / FEET_PER_MILE).toFixed(3)} mi`;
}

/**
 * Format an elevation given in metres for the active unit system.
 *
 * An elevation is not a length, and formatting it like one misreads it twice.
 * A length is a magnitude, so it may drop to centimetres or climb to
 * kilometres as it shrinks and grows; an elevation is a signed reading against
 * a datum, and a survey states every one of them in the same working unit — a
 * ground at 1200 m is "1200.00 m", never "1.200 km", and a 0.4 m benchmark is
 * not "40.0 cm". Holding one unit is also what makes a column of elevations
 * comparable at a glance, which is the whole point of printing them.
 */
export function formatElevation(metres: number, system: UnitSystem): string {
  if (!Number.isFinite(metres)) return '—';
  if (system === 'metric') return `${metres.toFixed(2)} m`;
  return `${(metres * FEET_PER_METRE).toFixed(2)} ft`;
}

/** Format an area given in square metres for the active unit system. */
export function formatArea(squareMetres: number, system: UnitSystem): string {
  if (!Number.isFinite(squareMetres) || squareMetres < 0) return '—';
  if (system === 'metric') {
    if (squareMetres < 1e6) return `${grouped(squareMetres, 2)} m²`;
    return `${grouped(squareMetres / 1e6, 3)} km²`;
  }
  const squareFeet = squareMetres * SQFT_PER_SQM;
  if (squareFeet < SQFT_PER_ACRE) return `${grouped(squareFeet, 1)} ft²`;
  return `${grouped(squareFeet / SQFT_PER_ACRE, 3)} acre`;
}

/** Format an angle in degrees. Unit-system independent. */
export function formatAngle(degrees: number): string {
  return Number.isFinite(degrees) ? `${degrees.toFixed(1)}°` : '—';
}

/**
 * Format a slope grade as a percentage. A non-finite grade means the pair is
 * vertical (zero run), which reads as "vertical" rather than a number.
 */
export function formatGrade(percent: number): string {
  return Number.isFinite(percent) ? `${percent.toFixed(1)}%` : 'vertical';
}

/**
 * Format a compass azimuth as a zero-padded whole-degree bearing, e.g. 42° →
 * "042°". A non-finite azimuth (a purely vertical segment) has no bearing.
 */
export function formatBearing(azimuthDeg: number): string {
  if (!Number.isFinite(azimuthDeg)) return '—';
  const deg = Math.round(((azimuthDeg % 360) + 360) % 360) % 360;
  return `${String(deg).padStart(3, '0')}°`;
}

/**
 * Format a profile measurement's headline readout — a single compact line
 * that captures the 3D length and the vertical drop with grade, matching the
 * tags an engineer reads off a paper cross-section card.
 */
export function formatProfileHeadline(
  length3d: number,
  verticalDrop: number,
  gradePercent: number,
  system: UnitSystem,
): string {
  const len = formatLength(length3d, system);
  const drop = formatLength(Math.abs(verticalDrop), system);
  const grade = formatGrade(gradePercent);
  const sign = verticalDrop < 0 ? '−' : verticalDrop > 0 ? '+' : '';
  return `${len}  · Δh ${sign}${drop}  · ${grade}`;
}

/**
 * Render-space variants (v0.4.5, B2). Measurement geometry lives in the
 * scan's SOURCE units — a foot-CRS LAS keeps feet in render space — so every
 * display boundary must multiply by the CRS's `linearUnitToMetres` factor
 * exactly ONCE before the metre-based formatters above run. Lengths scale
 * ×f, areas ×f², volumes ×f³; angles/grades are dimensionless and need no
 * factor. These wrappers exist (rather than inlining `v * f` at ~35 call
 * sites in the DOM-bound controller) so the foot-CRS truth tests can pin the
 * exact labels in Node. An invalid factor (NaN, 0, negative) falls back to 1
 * — mislabelling a local scan as metres is the pre-B2 status quo; multiplying
 * by garbage would be strictly worse.
 */
function safeFactor(unitToMetres: number): number {
  return Number.isFinite(unitToMetres) && unitToMetres > 0 ? unitToMetres : 1;
}

/** Format a length given in render (source) units. */
export function formatLengthRender(
  renderUnits: number,
  unitToMetres: number,
  system: UnitSystem,
): string {
  return formatLength(renderUnits * safeFactor(unitToMetres), system);
}

/** Format an area given in square render (source) units. */
export function formatAreaRender(
  renderUnitsSq: number,
  unitToMetres: number,
  system: UnitSystem,
): string {
  const f = safeFactor(unitToMetres);
  return formatArea(renderUnitsSq * f * f, system);
}

/** Format a volume given in cubic render (source) units. */
export function formatVolumeRender(
  renderUnitsCu: number,
  unitToMetres: number,
  system: UnitSystem,
): string {
  const f = safeFactor(unitToMetres);
  return formatVolume(renderUnitsCu * f * f * f, system);
}

/** Format a volume in cubic metres for the active unit system. */
export function formatVolume(cubicMetres: number, system: UnitSystem): string {
  if (!Number.isFinite(cubicMetres) || cubicMetres < 0) return '—';
  if (system === 'metric') {
    if (cubicMetres < 1) return `${grouped(cubicMetres * 1000, 0)} dm³`;
    if (cubicMetres < 1e6) return `${grouped(cubicMetres, 2)} m³`;
    return `${grouped(cubicMetres / 1e9, 3)} km³`;
  }
  // Imperial: cubic feet, switching to cubic yards above a yard.
  const cubicFeet = cubicMetres * FEET_PER_METRE * FEET_PER_METRE * FEET_PER_METRE;
  if (cubicFeet < 27) return `${grouped(cubicFeet, 1)} ft³`;
  return `${grouped(cubicFeet / 27, 2)} yd³`;
}

/**
 * Format a Box measurement's headline — `W × D × H · volume`. The three
 * axis lengths read left to right, matching the per-axis order a surveyor
 * writes when sketching a slice.
 */
export function formatBoxHeadline(
  width: number,
  depth: number,
  height: number,
  volume: number,
  system: UnitSystem,
): string {
  const w = formatLength(width, system);
  const d = formatLength(depth, system);
  const h = formatLength(height, system);
  const v = formatVolume(volume, system);
  return `${w} × ${d} × ${h}  · ${v}`;
}
