/**
 * profileChartStretch.ts: the vertical stretch of the profile's compact chart,
 * one setting for every profile row.
 */
import { storageGet } from './safeStorage';

/**
 * Vertical stretch of the compact chart. A number is a stated exaggeration of
 * the horizontal scale (1 is true scale); 0 is Fit, the relief filling the
 * chart height. True scale is the default: flat ground reads flat.
 */
export const PROFILE_VEX_OPTIONS = [1, 5, 10, 20, 0] as const;
export type ProfileVex = (typeof PROFILE_VEX_OPTIONS)[number];
export const PROFILE_VEX_DEFAULT: ProfileVex = 1;
export const PROFILE_VEX_KEY = 'olv:measure:profile:vex:v2';
/** The chart box the first render assumes; the resize observer redraws at the real size. */
export const PROFILE_CHART_ASSUMED_BOX = { width: 260, height: 280 } as const;

export function readProfileVex(): ProfileVex {
  const raw = storageGet(PROFILE_VEX_KEY);
  if (raw === null || raw.trim() === '') return PROFILE_VEX_DEFAULT;
  const n = Number(raw);
  return (PROFILE_VEX_OPTIONS as readonly number[]).includes(n) ? (n as ProfileVex) : PROFILE_VEX_DEFAULT;
}

export function profileVexChipLabel(v: ProfileVex): string {
  return v === 0 ? 'Fit' : v === 1 ? '1:1' : `${v}×`;
}
