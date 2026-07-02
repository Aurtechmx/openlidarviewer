/**
 * alignEpochs.ts
 *
 * Coarse pre-alignment for two-epoch change detection.
 *
 * `compareEpochClouds` assumes the two clouds already sit in a common world
 * frame (each recentred by its own origin, same CRS). Real repeat surveys carry
 * a small residual misalignment — a few centimetres of horizontal shift, a
 * fraction of a degree of yaw — and a raw cell-for-cell difference reads that
 * registration error as if it were real ground movement.
 *
 * This module runs the planar ICP core ({@link icpRegister}) on a subsample of
 * the two clouds and, when the fit is trustworthy, applies the solved transform
 * to the `after` cloud so the comparison starts from a registered pair. The fit
 * is reported, not hidden: the residual, the solved yaw and shift, and whether
 * the transform was applied or refused all ride out in {@link EpochAlignment},
 * so a reader can see what the alignment did. A fit whose residual exceeds the
 * gate is refused and the clouds are left untouched, so alignment never invents
 * a shift it cannot stand behind.
 *
 * Pure: no DOM, no three.js, no I/O. ICP nearest-neighbour search is O(n·m), so
 * the clouds are strided down to a bounded sample before the fit runs.
 */

import { icpRegister, applyIcp, type Vec3, type IcpResult } from './icpRegister';
import type { EpochCloud } from './compareEpochs';

const ZERO: readonly [number, number, number] = [0, 0, 0];

export interface AlignEpochOptions {
  /** Points sampled per cloud for the fit (ICP nearest is O(n·m)). Default 1500. */
  readonly maxSamples?: number;
  /**
   * Refuse the alignment when the final RMS residual (metres) exceeds this, so
   * the comparison is not distorted by a fit that never registered. Default
   * Infinity — report the residual but always apply. Set to the survey's noise
   * floor to gate honestly.
   */
  readonly maxResidualM?: number;
  /** ICP iteration cap. Default 25. */
  readonly maxIterations?: number;
  /**
   * Apply only the horizontal part of the fit (yaw + x/y shift) and leave z
   * untouched. Default true, and the right choice for change detection: a
   * uniform vertical change (subsidence, uplift, fill) is the signal being
   * measured, so the alignment must not absorb it into a z-shift. Set false to
   * apply the full 3-D transform.
   */
  readonly horizontalOnly?: boolean;
}

export interface EpochAlignment {
  /** A fit was attempted (both clouds had enough points). */
  readonly attempted: boolean;
  /** The solved transform was applied to the `after` cloud. */
  readonly applied: boolean;
  /** The residual exceeded the gate, so the transform was NOT applied. */
  readonly refused: boolean;
  /** Too few finite points in a cloud to align. */
  readonly degenerate: boolean;
  /** Final RMS nearest-neighbour residual after alignment, in metres. */
  readonly rmsResidualM: number;
  /** Solved planar rotation about the vertical axis, in degrees. */
  readonly yawDeg: number;
  /** Solved translation (metres) mapping `after` onto `before`. */
  readonly translation: Vec3;
  /** Points actually used per cloud in the fit. */
  readonly sampleCount: number;
  /**
   * The frame is geographic (degrees), so no fit was attempted at all. A
   * planar "rigid" transform is geometrically invalid in lon/lat space —
   * 1° of longitude ≠ 1° of latitude (cos φ), so a yaw solved in degree
   * space is a SHEAR in metres, and the convergence tolerance / residual
   * gate would be comparing degree-denominated numbers against metre
   * thresholds. Reproject to a projected CRS to align epochs.
   */
  readonly geographicSkipped?: boolean;
}

const NO_ALIGNMENT: EpochAlignment = {
  attempted: false,
  applied: false,
  refused: false,
  degenerate: true,
  rmsResidualM: Infinity,
  yawDeg: 0,
  translation: ZERO,
  sampleCount: 0,
};

/** The geographic-frame refusal: nothing attempted, clouds untouched. */
const GEOGRAPHIC_SKIP: EpochAlignment = {
  ...NO_ALIGNMENT,
  degenerate: false,
  geographicSkipped: true,
};

/** Stride-sample an interleaved xyz buffer into world-frame points (local + origin). */
function sampleWorld(
  positions: Float32Array,
  origin: readonly [number, number, number],
  maxSamples: number,
): Vec3[] {
  const n = (positions.length / 3) | 0;
  if (n === 0) return [];
  const stride = Math.max(1, Math.floor(n / Math.max(1, maxSamples)));
  const ox = origin[0];
  const oy = origin[1];
  const oz = origin[2];
  const out: Vec3[] = [];
  for (let i = 0; i < n; i += stride) {
    const x = positions[i * 3] + ox;
    const y = positions[i * 3 + 1] + oy;
    const z = positions[i * 3 + 2] + oz;
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) out.push([x, y, z]);
  }
  return out;
}

/**
 * Apply a solved ICP transform to every point of a cloud, returning a buffer
 * that is still LOCAL to the cloud's own origin. The transform is computed in
 * float64 world space (local + origin), then the origin is subtracted back
 * before the float32 store. This preservation is not cosmetic: the origin /
 * local split exists because a Float32Array cannot hold georeferenced
 * coordinates — at a UTM northing of ~4,000,000 the f32 quantum is ~0.25–0.5 m,
 * larger than the centimetre-level misalignment ICP corrects, so storing
 * absolute world values would inject more error than the alignment removes.
 * Only the small post-transform residual is rounded to f32 here; the
 * subtraction itself is exact in float64.
 */
function transformedLocal(
  positions: Float32Array,
  origin: readonly [number, number, number],
  result: Pick<IcpResult, 'yawRad' | 'translation'>,
): Float32Array {
  const n = (positions.length / 3) | 0;
  const ox = origin[0];
  const oy = origin[1];
  const oz = origin[2];
  const out = new Float32Array(positions.length);
  for (let i = 0; i < n; i++) {
    const w: Vec3 = [positions[i * 3] + ox, positions[i * 3 + 1] + oy, positions[i * 3 + 2] + oz];
    const t = applyIcp(result, w);
    out[i * 3] = t[0] - ox;
    out[i * 3 + 1] = t[1] - oy;
    out[i * 3 + 2] = t[2] - oz;
  }
  return out;
}

/**
 * Coarse-align `after` onto `before` before a comparison. Returns the (possibly
 * transformed) `after` cloud and a report of what the fit did. When the fit is
 * refused or degenerate, `after` is returned unchanged.
 */
export function alignEpochClouds(
  before: EpochCloud,
  after: EpochCloud,
  options: AlignEpochOptions = {},
): { readonly after: EpochCloud; readonly alignment: EpochAlignment } {
  // Geographic (degree) frames are refused before any fit: the planar rigid
  // model is invalid in lon/lat space (see EpochAlignment.geographicSkipped).
  // Measurements already refuse geographic frames through the trust system;
  // alignment must not silently apply transforms in one.
  if (before.isGeographic === true || after.isGeographic === true) {
    return { after, alignment: GEOGRAPHIC_SKIP };
  }

  const maxSamples = options.maxSamples ?? 1500;
  const beforeSample = sampleWorld(before.positions, before.origin ?? ZERO, maxSamples);
  const afterSample = sampleWorld(after.positions, after.origin ?? ZERO, maxSamples);

  if (beforeSample.length < 3 || afterSample.length < 3) {
    return { after, alignment: NO_ALIGNMENT };
  }

  // icpRegister works in the clouds' OWN units; EpochAlignment promises
  // metres (and the UI prints "N m"). Convert at this seam, both ways: the
  // metre-denominated gate becomes source units going in, and the residual /
  // translation become metres coming out — a foot-CRS survey shifted 10 ft
  // must report ≈3.05 m, never "10 m" (the wrong-units failure mode the
  // measurement trust system refuses). Geographic frames never reach here
  // (refused above), so a plain linear factor is always sufficient. The
  // BEFORE epoch's factor is the reference, matching sharedGrid; an
  // inter-epoch unit mismatch surfaces through compareDtms' CRS check.
  const metresPerUnit =
    before.linearUnitToMetres && before.linearUnitToMetres > 0 ? before.linearUnitToMetres : 1;

  const fit = icpRegister(afterSample, beforeSample, {
    maxIterations: options.maxIterations,
    maxResidual:
      options.maxResidualM != null ? options.maxResidualM / metresPerUnit : undefined,
  });
  const sampleCount = Math.min(beforeSample.length, afterSample.length);
  const yawDeg = (fit.yawRad * 180) / Math.PI;
  const rmsResidualM = fit.rmsResidual * metresPerUnit;
  /** A source-unit translation reported in metres (the applied one stays in source units). */
  const toMetres = (t: Vec3): Vec3 => [t[0] * metresPerUnit, t[1] * metresPerUnit, t[2] * metresPerUnit];

  if (fit.degenerate || fit.refused) {
    return {
      after,
      alignment: {
        attempted: true,
        applied: false,
        refused: fit.refused,
        degenerate: fit.degenerate,
        rmsResidualM,
        yawDeg,
        translation: toMetres(fit.translation),
        sampleCount,
      },
    };
  }

  // Trustworthy fit: move the after cloud into before's frame. The transform
  // is applied in float64 world space but the result stays LOCAL to the
  // cloud's own origin (see transformedLocal — absolute world values do not
  // survive a Float32Array at georeferenced magnitudes). For change detection
  // (horizontalOnly), apply yaw + x/y only and keep z, so a real vertical change
  // is preserved rather than absorbed into the fit's z-shift.
  const horizontalOnly = options.horizontalOnly ?? true;
  const applied: Pick<IcpResult, 'yawRad' | 'translation'> = horizontalOnly
    ? { yawRad: fit.yawRad, translation: [fit.translation[0], fit.translation[1], 0] }
    : { yawRad: fit.yawRad, translation: fit.translation };
  const aligned: EpochCloud = {
    positions: transformedLocal(after.positions, after.origin ?? ZERO, applied),
    origin: after.origin ?? ZERO,
    crs: after.crs,
    verticalDatum: after.verticalDatum,
    // Unit info must survive alignment — the shared-grid cell floor and the
    // confidence roughness slope read it downstream.
    isGeographic: after.isGeographic,
    linearUnitToMetres: after.linearUnitToMetres,
  };
  return {
    after: aligned,
    alignment: {
      attempted: true,
      applied: true,
      refused: false,
      degenerate: false,
      rmsResidualM,
      yawDeg,
      // Reported in metres; `applied.translation` (source units) is what
      // actually moved the points.
      translation: toMetres(applied.translation),
      sampleCount,
    },
  };
}

/** A one-line, human-readable summary of an alignment outcome for the UI. */
export function summarizeAlignment(a: EpochAlignment): string {
  if (a.geographicSkipped) {
    return (
      'Alignment: skipped — geographic (degree) coordinates cannot be rigidly ' +
      'aligned in the plane; reproject both epochs to a projected CRS first.'
    );
  }
  if (!a.attempted || a.degenerate) return 'Alignment: skipped (not enough points to register).';
  if (a.refused) {
    return `Alignment: refused — residual ${a.rmsResidualM.toFixed(2)} m exceeds the limit; comparing as-is.`;
  }
  const shift = Math.hypot(a.translation[0], a.translation[1]);
  return `Aligned the after cloud horizontally (${shift.toFixed(2)} m shift, ${a.yawDeg.toFixed(2)}° yaw, ${a.rmsResidualM.toFixed(2)} m residual over ${a.sampleCount} sampled points); vertical change preserved.`;
}
