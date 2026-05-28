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
