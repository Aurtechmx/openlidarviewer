/**
 * recommendView.ts
 *
 * A cheap, honest "recommended view" heuristic: pick the camera preset that
 * best suits a freshly loaded scan from a few signals that are free at load
 * time (colour, classification, and how flat the bounding box is). It is a
 * suggestion, not a claim — the reason string keeps it modest.
 *
 * Pure — no DOM, no three.js — unit-tested in Node.
 */

import type { CameraPresetName } from './cameraPresets';

/** The signals the recommendation reads — all cheap at load time. */
export interface ViewRecommendationInput {
  /** The cloud carries per-point RGB. */
  readonly hasRgb: boolean;
  /** The cloud carries an ASPRS classification channel. */
  readonly hasClassification: boolean;
  /**
   * Horizontal extent over vertical extent: `max(width, depth) / height`.
   * Large values mean a wide, flat scan (aerial / terrain tile); ~1 means a
   * compact or tall object/interior. Pass a safe finite number.
   */
  readonly flatness: number;
}

/** A preset suggestion with a short, modest rationale. */
export interface ViewRecommendation {
  readonly preset: CameraPresetName;
  readonly reason: string;
}

/** Above this width-to-height ratio a scan reads as a wide, flat surface. */
const FLAT_RATIO = 6;

/**
 * Recommend a camera preset for a scan. Deterministic and conservative: a wide,
 * classified surface reads best from straight overhead; a colour scan shows its
 * form and texture from an oblique angle; everything else starts from the
 * balanced isometric view.
 */
export function recommendCameraPreset(input: ViewRecommendationInput): ViewRecommendation {
  const flat = Number.isFinite(input.flatness) ? input.flatness : 1;
  if (flat >= FLAT_RATIO && input.hasClassification) {
    return { preset: 'top', reason: 'wide, classified scan — a plan view reads the layout' };
  }
  if (input.hasRgb) {
    return { preset: 'oblique', reason: 'colour scan — an oblique view shows form and texture' };
  }
  return { preset: 'iso', reason: 'a balanced 3D view to start from' };
}

/**
 * Derive the `flatness` ratio from a local bounding box (min/max triples in the
 * cloud's frame). Returns a large finite number for a zero-height box and 1 for
 * a degenerate one, so the recommendation never sees NaN.
 */
export function flatnessFromBounds(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): number {
  const width = Math.abs(max[0] - min[0]);
  const depth = Math.abs(max[1] - min[1]);
  const height = Math.abs(max[2] - min[2]);
  const horizontal = Math.max(width, depth);
  if (horizontal <= 0) return 1;
  if (height <= 0) return FLAT_RATIO; // flat-as-a-sheet → plan view
  return horizontal / height;
}

/** A scan's extents for the Project card. */
export interface ProjectSize {
  /** Extents in {@link sizeUnit}, ordered width, depth, height. */
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  readonly sizeUnit: 'm' | 'source units';
  /** Largest extent in physical metres, or null when the linear scale is unresolved. */
  readonly maxPhysicalDimM: number | null;
}

/**
 * The scan's extents for the Project card, in physical metres when the CRS
 * resolves a linear unit and in raw source units otherwise (labelled as such, so
 * a foot cloud is never shown as metres). The up-axis picks which extent is
 * height, so a Y-up scan reports its vertical extent as height rather than a
 * horizontal axis. `maxPhysicalDimM` is null when the scale is unknown, so a
 * caller does not map an unknown-unit size onto metre navigation thresholds.
 */
export function describeProjectSize(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
  frame: {
    readonly upAxis: 'z' | 'y' | 'unknown';
    readonly linearUnitKnown: boolean;
    readonly linearUnitToMetres: number;
    readonly verticalUnitToMetres?: number;
  },
): ProjectSize {
  const ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const upIdx = frame.upAxis === 'y' ? 1 : 2; // 'z' | 'unknown' -> Z
  const [hA, hB] = [0, 1, 2].filter((i) => i !== upIdx);
  const rawW = ext[hA];
  const rawD = ext[hB];
  const rawH = ext[upIdx];
  if (!frame.linearUnitKnown || !(frame.linearUnitToMetres > 0)) {
    return { width: rawW, depth: rawD, height: rawH, sizeUnit: 'source units', maxPhysicalDimM: null };
  }
  const hz = frame.linearUnitToMetres;
  const vt = frame.verticalUnitToMetres && frame.verticalUnitToMetres > 0 ? frame.verticalUnitToMetres : hz;
  const width = rawW * hz;
  const depth = rawD * hz;
  const height = rawH * vt;
  return { width, depth, height, sizeUnit: 'm', maxPhysicalDimM: Math.max(width, depth, height) };
}
