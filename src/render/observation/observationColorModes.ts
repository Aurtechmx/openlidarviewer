/**
 * observationColorModes.ts — OB-PR-01: per-point presentation colour, built
 * from the canonical field, never from the geometry.
 *
 * No three.js dependency — safe to import in Node/Vitest tests, matching
 * `render/colorModes.ts`'s own convention. This is the "rendering adapter"
 * OB-INT-01 places in `src/render/observation/`: it is the only place a
 * `PointCloud`'s raw positions and the pure `src/observation/` field meet.
 *
 * DETERMINISM (OB-INV-06). Every function below is a pure map from
 * (positions, domain, voxelEdge, value-by-key) to a colour buffer. None of
 * them writes to `positions`, mutates a ledger row, or otherwise touches
 * anything `computeFieldDigest` folds in — varying the colour mode, the
 * strength component or the manual range therefore cannot move a
 * `fieldDigest`. `tests/observatoryColorModes.test.ts` proves this by
 * building a real ledger, taking its digest, running every mode, and taking
 * the digest again.
 *
 * "Built once per resident cloud per field version" (OB-PR-01) is a caching
 * discipline for the caller (`ObservationPointOverlay`, keyed on the field's
 * own version stamp), not something this module tracks itself — a pure
 * function has no version to remember.
 */
import { clamp01 } from '../../numeric';
import { domainGrid, packVoxelKey, type ObservationDomain } from '../../observation/ledger';
import type { ObservationState } from '../../observation/types';
import type { ObservationStrengthComponents } from '../../observation/strength';
import {
  BOUNDED_UNIT_RANGE,
  OBSERVATION_STATE_RGB,
  type ObservationColorMode,
  type StrengthComponentId,
} from '../../observation/presentationLegend';

/** What one point resolves to, keyed by its voxel — a sparse lookup, absent keys read as "no evidence". */
export interface ObservationFieldValues {
  readonly stateByKey: ReadonlyMap<number, ObservationState>;
  readonly strengthByKey: ReadonlyMap<number, ObservationStrengthComponents>;
  readonly hitFractionByKey: ReadonlyMap<number, number>;
}

/** Colour for a voxel with no recorded value at all — distinct from any real state's colour (near-black, low alpha carried separately by the caller). */
const NO_VALUE_RGB: readonly [number, number, number] = [0.03, 0.03, 0.04];

function voxelKeyForPoint(
  x: number,
  y: number,
  z: number,
  domain: ObservationDomain,
  voxelEdge: number,
  nx: number,
  ny: number,
): number | null {
  if (x < domain.min[0] || x >= domain.max[0]) return null;
  if (y < domain.min[1] || y >= domain.max[1]) return null;
  if (z < domain.min[2] || z >= domain.max[2]) return null;
  const ix = Math.floor((x - domain.min[0]) / voxelEdge);
  const iy = Math.floor((y - domain.min[1]) / voxelEdge);
  const iz = Math.floor((z - domain.min[2]) / voxelEdge);
  return packVoxelKey(ix, iy, iz, nx, ny);
}

/** A perceptual grey ramp for a [0, 1] scalar — bounded quantities never adapt (OB-PR-05). */
function scalarToRgb(v: number): readonly [number, number, number] {
  if (!Number.isFinite(v)) return NO_VALUE_RGB;
  const t = clamp01((v - BOUNDED_UNIT_RANGE.min) / (BOUNDED_UNIT_RANGE.max - BOUNDED_UNIT_RANGE.min));
  return [t, t, t];
}

/**
 * Builds one interleaved RGB byte per point (`render/colorModes.ts`'s own
 * `Uint8Array` convention), for `mode` over `positions` (a cloud's own
 * source-local frame, `sourcePositions()`).
 *
 * `strengthComponent` selects which of the five §2.5 components colours the
 * `observationStrength` mode; ignored otherwise.
 */
export function buildObservationPointColors(
  positions: Float32Array,
  domain: ObservationDomain,
  voxelEdge: number,
  values: ObservationFieldValues,
  mode: ObservationColorMode,
  strengthComponent: StrengthComponentId = 'consistency',
): Uint8Array {
  const pointCount = positions.length / 3;
  const out = new Uint8Array(pointCount * 3);
  const { nx, ny } = domainGrid(domain, voxelEdge);

  for (let i = 0; i < pointCount; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const key = voxelKeyForPoint(x, y, z, domain, voxelEdge, nx, ny);

    let rgb: readonly [number, number, number] = NO_VALUE_RGB;
    if (key !== null) {
      if (mode === 'observationState') {
        const state = values.stateByKey.get(key);
        rgb = state ? OBSERVATION_STATE_RGB[state] : NO_VALUE_RGB;
      } else if (mode === 'observationStrength') {
        const strength = values.strengthByKey.get(key);
        const v = strength ? strength[strengthComponent] : Number.NaN;
        rgb = scalarToRgb(v);
      } else {
        const f = values.hitFractionByKey.get(key);
        rgb = f === undefined ? NO_VALUE_RGB : scalarToRgb(f);
      }
    }

    out[i * 3] = Math.round(clamp01(rgb[0]) * 255);
    out[i * 3 + 1] = Math.round(clamp01(rgb[1]) * 255);
    out[i * 3 + 2] = Math.round(clamp01(rgb[2]) * 255);
  }

  return out;
}
