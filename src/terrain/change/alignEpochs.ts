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
 * Two epochs that declare one horizontal CRS keep their supplied coordinates:
 * no registration is estimated or applied (`frameKept`). A rigid fit cannot
 * tell a horizontal shift along a slope from a real change in height (on a
 * plane z = s·x, moving the after cloud by Δz/s in x removes a uniform uplift
 * Δz), so fitting the pair and then discarding the fitted Z lets the
 * horizontal terms absorb real change. The comparison runs in the original
 * frame and registration uncertainty stays unquantified. A caller can still
 * opt in with `commonFrame: 'estimate'`, under the gates below.
 *
 * Pairs without a common declared CRS (local frames) run the planar ICP core
 * ({@link icpRegister}) on a subsample. Before any damping, every iteration
 * tests the undamped point-to-plane information matrix of the full rigid
 * problem (yaw, x, y, z) and withholds the fit when it is rank-deficient or
 * ill-conditioned ({@link OBSERVABILITY_MIN_RATIO}); a plane, flat or sloped,
 * is refused. Correspondences farther apart than a few mean point spacings
 * (estimated from the before sample) are rejected in every iteration, and the
 * overlap is measured at that same distance. A fit is also withheld when the
 * overlap is low or its residual exceeds a spacing-scaled limit. The fit is
 * reported, not hidden, in {@link EpochAlignment}: the fitting residual, the
 * residual at the applied pose and the observability are separate figures, and
 * none of them is a registration uncertainty.
 *
 * Pure: no DOM, no three.js, no I/O. The clouds are strided down to a bounded
 * sample before the fit runs.
 */

import { icpRegister, applyIcp, type Vec3, type IcpResult } from './icpRegister';
import { OBSERVABILITY_MIN_RATIO, type RigidObservability } from './rigidObservability';
import { buildPointIndex, nearestPoint, nearestState } from './pointIndex';
import { meanPointSpacing } from './pointSpacing';

export { meanPointSpacing } from './pointSpacing';
import { verticalReferenceKey } from '../../model/layerCompatibility';
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
   * Keep only the best-residual `trimFraction` of the correspondences inside
   * the correspondence distance (trimmed ICP — see {@link icpRegister}).
   * Default {@link COMMON_FRAME_TRIM} when both epochs declare one CRS, and 1
   * (every gated pair) otherwise. Set lower when the two epochs carry gross
   * outliers (vegetation, moving objects, a construction blob) that would
   * otherwise drag the registration off the stable ground both surveys share.
   */
  readonly trimFraction?: number;
  /**
   * Apply only the horizontal part of the fit (yaw + x/y shift) and leave z
   * untouched. Default true, and the right choice for change detection: a
   * uniform vertical change (subsidence, uplift, fill) is the signal being
   * measured, so the alignment must not absorb it into a z-shift. Set false to
   * apply the full 3-D transform.
   */
  readonly horizontalOnly?: boolean;
  /**
   * False when the horizontal frame is PROJECTED but its linear unit is unknown
   * (a CRS whose `linearUnit` is 'unknown', carrying the inert placeholder
   * factor 1 in `linearUnitToMetres`). The fit still runs — the transform is
   * geometrically valid in the cloud's own units — but the residual and shift
   * this module reports "in metres" are computed with that placeholder, so they
   * are source-unit numbers (feet, US survey feet, links) wearing a metre label.
   * When false, `summarizeAlignment` withholds those metre figures rather than
   * captioning an unverified unit as metres — the same fail-closed posture as
   * `compareDtms`' `horizontalUnitKnown`. Omitted/true means the unit is known
   * (or a metre CRS) and the figures print. Geographic frames never reach this
   * option — they are refused before the fit (see {@link EpochAlignment.geographicSkipped}).
   */
  readonly horizontalUnitKnown?: boolean;
  /**
   * What to do with two epochs that declare one horizontal CRS. `'preserve'`
   * (default): compare them in their supplied coordinates, no fit at all.
   * `'estimate'`: run the gated fit from the identity pose.
   */
  readonly commonFrame?: 'preserve' | 'estimate';
}

/**
 * The degrees of freedom of the transform ACTUALLY applied to the `after`
 * cloud — provenance for the applied product, not the intermediate solver. The
 * solver (`icpRegister`, method `olv.registration.icp-planar`) computes yaw plus
 * a full 3-D translation; the repeat-epoch path (method
 * `olv.registration.epoch-horizontal-icp`) applies `yaw+xy` with Z locked to
 * preserve a real vertical change, or `yaw+xyz` only when a caller opts out of
 * the horizontal-only model. `none` when nothing was applied (refused,
 * degenerate, low overlap, geographic, or frame-incompatible).
 */
export type EpochAppliedDof = 'yaw+xy' | 'yaw+xyz' | 'none';

export interface EpochAlignment {
  /** A fit was attempted (both clouds had enough points). */
  readonly attempted: boolean;
  /** The solved transform was applied to the `after` cloud. */
  readonly applied: boolean;
  /**
   * Degrees of freedom of the APPLIED transform — describes what moved the
   * points, not what the solver computed. `yaw+xy` is the repeat-epoch default
   * (Z locked); a fit that is not applied reports `none`.
   */
  readonly appliedDof: EpochAppliedDof;
  /** The residual exceeded the gate, so the transform was NOT applied. */
  readonly refused: boolean;
  /** Too few finite points in a cloud to align. */
  readonly degenerate: boolean;
  /**
   * RMS nearest-neighbour residual of the SOLVER's transform (yaw + full x/y/z
   * translation), in metres. It describes the fit the solver found, which on
   * the default horizontal-only path is NOT the transform applied: the solver
   * absorbs a uniform vertical offset that the applied transform deliberately
   * keeps. Used for the residual gate. It is a fit misfit, not a vertical
   * registration uncertainty, and must never be fed into a level of detection.
   */
  readonly solverResidualM: number;
  /**
   * RMS nearest-neighbour residual re-measured at the pose ACTUALLY applied to
   * the `after` cloud (the identity when nothing was applied), in metres, over
   * the same sampled points and the same trim as the solver. For identical
   * clouds 1 m apart vertically this is 1 m while `solverResidualM` is 0. Like
   * the solver residual it is a fit statistic, not σreg.
   */
  readonly appliedTransformResidualM: number;
  /** Solved planar rotation about the vertical axis, in degrees. */
  readonly yawDeg: number;
  /**
   * Solved translation (metres) mapping `after` onto `before`: the transform's
   * own term, with the yaw about the WORLD origin. At projected coordinates a
   * fraction of a degree of yaw makes it hundreds of metres or more while no
   * point moves that far, so it is not a shift to show; see `centroidShiftM`.
   */
  readonly translation: Vec3;
  /**
   * How far the reported transform moves an after point lying at the before
   * sample's centroid (metres; z is the vertical term of `translation`). This
   * is the shift the summary and the registration record state, beside the
   * yaw. Absent only on outcomes with no fit.
   */
  readonly centroidShiftM?: Vec3;
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
  /**
   * True when the two epochs were not shown to share a spatial frame, so no
   * fit was attempted. Distinct from `degenerate`, which means a fit ran and
   * produced nothing usable — here there is nothing meaningful to fit.
   */
  readonly frameIncompatible?: boolean;
  /** Why the frames were refused, in plain language, for the summary. */
  readonly frameReason?: string;
  /**
   * True when the fit ran but the two epochs never PROVED a shared frame —
   * one or both declared no CRS or no vertical datum. The preflight lets that
   * pair through deliberately (comparing local scans is a real workflow), but
   * the resulting shift and residual describe the fit and say nothing about
   * the relationship. Without this flag a reader takes a residual in metres as
   * evidence of georeferenced agreement.
   */
  readonly frameUnverified?: boolean;
  /**
   * True when the fit ran on a projected frame whose linear unit is unknown
   * (see {@link AlignEpochOptions.horizontalUnitKnown}). The residual and shift
   * were scaled by the inert placeholder factor 1, so they carry source-unit
   * magnitudes under a metre label. `summarizeAlignment` then withholds those
   * metre figures — an unknown source unit cannot be multiplied into metres —
   * and keeps only the unit-free parts (yaw, sample count) plus the diagnosis.
   */
  readonly horizontalUnitUnknown?: boolean;
  /**
   * Inlier fraction of the fit (0..1) — how much of the sampled overlap the
   * transform actually explains. A small residual over a small overlap is the
   * classic "locked onto a subset" failure that RMS alone hides, so this is
   * surfaced and gated: below {@link LOW_OVERLAP_FRACTION} the transform is NOT
   * applied (the clouds are compared as-is), because a minority-of-points fit
   * would smear real vertical change across slopes and corrupt the cut/fill.
   */
  readonly overlapFraction: number;
  /** The fit ran but its overlap was too low to trust, so it was withheld. */
  readonly lowOverlap?: boolean;
  /**
   * The fit moved the after cloud (RMS horizontal displacement of the sampled
   * points) farther than the correspondence distance, so no pair formed at the
   * starting pose supports it. Withheld. Set only on the common-CRS path,
   * where the solve starts at the identity pose.
   */
  readonly unsupportedMove?: boolean;
  /**
   * Mean horizontal point spacing of the before sample (metres), estimated
   * from the occupied footprint. The correspondence distance, the overlap
   * distance and the residual limit are multiples of it. NaN when it could
   * not be estimated (a degenerate footprint), in which case no gate ran.
   */
  readonly pointSpacingM?: number;
  /** Correspondence and overlap distance used by the solve (metres). */
  readonly correspondenceDistanceM?: number;
  /** The solve started at the identity pose (both epochs declare one CRS). */
  readonly identityStart?: boolean;
  /**
   * Both epochs declare one horizontal CRS, so their supplied coordinates were
   * kept: no registration was estimated and none applied. This is not an
   * accuracy statement about that frame; registration uncertainty is not
   * quantified.
   */
  readonly frameKept?: boolean;
  /**
   * The geometry does not determine the rigid pose (yaw, x, y, z): the
   * undamped information matrix was rank-deficient or ill-conditioned, so no
   * pose was estimated and nothing was applied.
   */
  readonly unobservable?: boolean;
  /** Weakest observability of the fit (absent when no fit ran). */
  readonly observability?: RigidObservability;
}

/** Below this inlier fraction the fit is untrustworthy and is not applied. */
export const LOW_OVERLAP_FRACTION = 0.5;

/** Correspondence and overlap distance, in mean point spacings. */
export const CORRESPONDENCE_SPACINGS = 3;

/** Largest accepted fit residual, in mean point spacings. */
export const RESIDUAL_SPACINGS = 0.75;

/** Neighbour radius of the target normals for the plane metric, in mean point spacings. */
export const NORMAL_SPACINGS = 2;

/** Default trim on the common-CRS path: the best 90 % of the gated pairs. */
export const COMMON_FRAME_TRIM = 0.9;

/** Target sample size relative to the source sample: a denser target gives a tighter spacing. */
const TARGET_SAMPLE_FACTOR = 4;

/** Root-mean-square horizontal displacement of `pts` under a pose. */
function rmsHorizontalMove(pts: readonly Vec3[], pose: Pick<IcpResult, 'yawRad' | 'translation'>): number {
  let sum = 0;
  for (const p of pts) {
    const q = applyIcp(pose, p);
    sum += (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
  }
  return pts.length > 0 ? Math.sqrt(sum / pts.length) : 0;
}

const NO_ALIGNMENT: EpochAlignment = {
  attempted: false,
  applied: false,
  appliedDof: 'none',
  refused: false,
  degenerate: true,
  solverResidualM: Infinity,
  appliedTransformResidualM: Infinity,
  yawDeg: 0,
  translation: ZERO,
  sampleCount: 0,
  overlapFraction: 0,
};

/** Both epochs declare one CRS: coordinates kept, no fit attempted. */
const FRAME_KEPT: EpochAlignment = {
  ...NO_ALIGNMENT,
  degenerate: false,
  frameKept: true,
};

/** The geographic-frame refusal: nothing attempted, clouds untouched. */
const GEOGRAPHIC_SKIP: EpochAlignment = {
  ...NO_ALIGNMENT,
  degenerate: false,
  geographicSkipped: true,
};

/**
 * Whether two epochs have been shown to share a spatial frame, and why not.
 *
 * ICP fits a rigid transform between two point sets and reports a residual.
 * Given two epochs in different CRSs, or on different vertical datums, it
 * still converges on something and still reports a number — because the
 * residual describes the fit, not whether fitting was meaningful. That number
 * then reads as a quality figure for a comparison that never had a common
 * frame. The check therefore runs BEFORE any sampling, inside this function
 * rather than at a call site, so no caller can reach the fit without it.
 */
function epochFrameFailure(before: EpochCloud, after: EpochCloud): string | null {
  // Refused ONLY on a proven contradiction — the same rule `compareDtms`
  // already applies downstream. Silence on both sides is not a contradiction:
  // two undeclared local scans are a real workflow, and the comparison path
  // treats that pair as indicative-with-caveats rather than measured. Refusing
  // them here would forbid the case rather than qualify it, and would put this
  // gate at odds with the one that follows it.
  if (before.crs && after.crs && before.crs.trim() !== after.crs.trim()) {
    return `The epochs declare different horizontal reference systems `
      + `(${before.crs} vs ${after.crs}). They must be reprojected to a common `
      + 'CRS before they can be aligned or compared.';
  }
  const bv = verticalReferenceKey({ id: 'b', verticalDatum: before.verticalDatum });
  const av = verticalReferenceKey({ id: 'a', verticalDatum: after.verticalDatum });
  if (bv !== null && av !== null && bv !== av) {
    return `The epochs declare different vertical datums `
      + `(${before.verticalDatum} vs ${after.verticalDatum}), so height differences `
      + 'between them have no defined meaning.';
  }
  return null;
}

/** Stride-sample an interleaved xyz buffer into world-frame points (local + origin). */
function sampleWorld(
  positions: Float32Array,
  origin: readonly [number, number, number],
  maxSamples: number,
  /**
   * Z multiplier that puts the vertical axis in the SAME unit as X/Y.
   *
   * ICP's correspondence search is fully 3-D — `icpRegister`'s `nearest` sums
   * dx²+dy²+dz² — so a compound frame with foot heights over a metre grid fed
   * it a distorted distance: a 1-unit vertical separation counted as 1 when it
   * was really 0.3048 horizontal-equivalent. That biased which points paired
   * with which, the trimmed-inlier ranking, the convergence test and the
   * reported residual. The solved transform is constrained to yaw + x/y with
   * translation[2] zeroed, so scaling Z here needs no inverse afterwards — it
   * only removes the anisotropy from the fit.
   */
  zScale: number,
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
    const z = (positions[i * 3 + 2] + oz) * zScale;
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
 * RMS nearest-neighbour distance from `source` (moved by `pose`) to `target`,
 * in the fit's own units, over the best `trimFraction` of points when trimming
 * (mirroring the solver's objective so the two residuals are comparable).
 */
function residualAtPose(
  source: readonly Vec3[],
  target: readonly Vec3[],
  pose: Pick<IcpResult, 'yawRad' | 'translation'>,
  trimFraction: number | undefined,
  gate = Infinity,
): number {
  const index = buildPointIndex(target);
  const d2All = new Float64Array(source.length);
  for (let i = 0; i < source.length; i++) {
    const p = applyIcp(pose, source[i]);
    nearestPoint(index, p[0], p[1], p[2]);
    d2All[i] = nearestState.d2;
  }
  // Only the pairs inside the correspondence distance, as the solver scores.
  const d2 = Number.isFinite(gate) ? d2All.filter((v) => v <= gate * gate) : d2All;
  if (d2.length === 0) return Infinity;
  const trim = trimFraction !== undefined && trimFraction > 0 && trimFraction < 1 ? trimFraction : 1;
  const sorted = trim < 1 ? d2.slice().sort() : d2;
  const keep = Math.max(1, Math.min(sorted.length, Math.round(sorted.length * trim)));
  let sum = 0;
  for (let i = 0; i < keep; i++) sum += sorted[i];
  return Math.sqrt(sum / keep);
}

const IDENTITY_POSE: Pick<IcpResult, 'yawRad' | 'translation'> = { yawRad: 0, translation: [0, 0, 0] };

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

  // Spatial preflight, before any sampling or fitting. A refused pair gets no
  // residual, because there is no fit to score.
  const frameUnverified =
    !before.crs || !after.crs
    || verticalReferenceKey({ id: 'b', verticalDatum: before.verticalDatum }) === null
    || verticalReferenceKey({ id: 'a', verticalDatum: after.verticalDatum }) === null;

  const frameReason = epochFrameFailure(before, after);
  if (frameReason !== null) {
    return {
      after,
      alignment: { ...NO_ALIGNMENT, degenerate: false, frameIncompatible: true, frameReason },
    };
  }

  // One declared horizontal CRS on both sides (a contradiction was refused
  // above): keep the supplied coordinates. See the module header for why a
  // rigid fit here would read real change as a shift.
  const identityStart = Boolean(before.crs && after.crs);
  if (identityStart && options.commonFrame !== 'estimate') {
    return { after, alignment: { ...FRAME_KEPT, frameUnverified } };
  }

  // Projected frame with an UNKNOWN linear unit. The fit still runs (the
  // transform is valid in the cloud's own units and the residual gate is
  // self-consistent — both the span-derived threshold and the residual live in
  // source units), but the metresPerUnit below is the inert placeholder 1, so
  // the residual/shift this module labels "m" are actually source-unit numbers.
  // Carry the flag so the summary withholds those metre figures. Geographic
  // frames are already refused above, so this is purely the projected case.
  const horizontalUnitUnknown = options.horizontalUnitKnown === false;

  const maxSamples = options.maxSamples ?? 1500;
  // One isotropic space for the fit. `1` for every single-unit frame, so a
  // metre or foot scan is sampled exactly as before.
  const zScaleOf = (c: EpochCloud): number => {
    const h = Number.isFinite(c.linearUnitToMetres) && (c.linearUnitToMetres as number) > 0
      ? (c.linearUnitToMetres as number) : 1;
    const v = Number.isFinite(c.verticalUnitToMetres) && (c.verticalUnitToMetres as number) > 0
      ? (c.verticalUnitToMetres as number) : h;
    return v / h;
  };
  // The before epoch is the fixed target; a denser sample of it gives every
  // after point a closer partner and so a tighter spacing to gate against.
  const beforeSample = sampleWorld(before.positions, before.origin ?? ZERO, maxSamples * TARGET_SAMPLE_FACTOR, zScaleOf(before));
  const afterSample = sampleWorld(after.positions, after.origin ?? ZERO, maxSamples, zScaleOf(after));

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

  // An opted-in common-CRS fit starts at the identity pose: a centroid or
  // median warm start measures the difference in the two footprints. Local
  // scans keep the warm start: their frames may differ arbitrarily, and the
  // gates below still bound what is applied.
  const trimFraction = options.trimFraction ?? (identityStart ? COMMON_FRAME_TRIM : undefined);
  // Spacing in source units, from the target sample the solve pairs against.
  const spacing = meanPointSpacing(beforeSample);
  const gate = spacing > 0 ? CORRESPONDENCE_SPACINGS * spacing : Infinity;
  const spacingLimit = spacing > 0 ? RESIDUAL_SPACINGS * spacing : Infinity;
  const callerLimit = options.maxResidualM != null ? options.maxResidualM / metresPerUnit : Infinity;
  const residualLimit = Math.min(spacingLimit, callerLimit);

  const fit = icpRegister(afterSample, beforeSample, {
    maxIterations: options.maxIterations,
    maxResidual: Number.isFinite(residualLimit) ? residualLimit : undefined,
    trimFraction,
    initialPose: identityStart ? 'identity' : 'warm',
    maxCorrespondenceDistance: Number.isFinite(gate) ? gate : undefined,
    metric: 'plane',
    normalRadius: NORMAL_SPACINGS * spacing,
    minObservability: OBSERVABILITY_MIN_RATIO,
  });
  const sampleCount = Math.min(beforeSample.length, afterSample.length);
  const yawDeg = (fit.yawRad * 180) / Math.PI;
  const solverResidualM = fit.rmsResidual * metresPerUnit;
  // Overlap at the correspondence distance the solve used, never at the
  // looser residual limit.
  const overlapFraction = fit.overlapFraction ?? fit.inlierFraction;
  const gateFacts = {
    pointSpacingM: spacing * metresPerUnit,
    correspondenceDistanceM: gate * metresPerUnit,
    identityStart,
    ...(fit.observability ? { observability: fit.observability } : {}),
  };
  // Residual at the identity pose: what the comparison sees when nothing is applied.
  const unappliedResidualM = (): number =>
    fit.degenerate ? Infinity : residualAtPose(afterSample, beforeSample, IDENTITY_POSE, trimFraction, gate) * metresPerUnit;
  /** A source-unit translation reported in metres (the applied one stays in source units). */
  const toMetres = (t: Vec3): Vec3 => [t[0] * metresPerUnit, t[1] * metresPerUnit, t[2] * metresPerUnit];
  // The before sample's centroid, where the reported shift is measured.
  let cx = 0, cy = 0;
  for (const p of beforeSample) { cx += p[0]; cy += p[1]; }
  const centre: Vec3 = [cx / beforeSample.length, cy / beforeSample.length, 0];
  /** Displacement (metres) of an after point at the centroid under `pose`. */
  const shiftAtCentre = (pose: Pick<IcpResult, 'yawRad' | 'translation'>): Vec3 => {
    const q = applyIcp(pose, centre);
    return [(q[0] - centre[0]) * metresPerUnit, (q[1] - centre[1]) * metresPerUnit, pose.translation[2] * metresPerUnit];
  };

  // Unobservable: the geometry does not determine the pose, so there is no
  // estimate to report or apply. Checked first: nothing else about the fit
  // means anything without it.
  if (fit.unobservable) {
    return {
      after,
      alignment: {
        attempted: true,
        applied: false,
        appliedDof: 'none',
        refused: true,
        degenerate: false,
        solverResidualM: Infinity,
        appliedTransformResidualM: unappliedResidualM(),
        yawDeg: 0,
        translation: ZERO,
        sampleCount,
        overlapFraction: 0,
        unobservable: true,
        frameUnverified,
        horizontalUnitUnknown,
        ...gateFacts,
      },
    };
  }

  // Low overlap: too few sampled points have a partner within the
  // correspondence distance. Checked first: a residual over a small overlap
  // describes a subset, so the overlap is the governing fact.
  if (!fit.degenerate && overlapFraction < LOW_OVERLAP_FRACTION) {
    return {
      after,
      alignment: {
        attempted: true,
        applied: false,
        appliedDof: 'none',
        refused: false,
        degenerate: false,
        solverResidualM,
        appliedTransformResidualM: unappliedResidualM(),
        yawDeg,
        translation: toMetres(fit.translation),
        centroidShiftM: shiftAtCentre(fit),
        sampleCount,
        overlapFraction,
        lowOverlap: true,
        frameUnverified,
        horizontalUnitUnknown,
        ...gateFacts,
      },
    };
  }

  if (fit.degenerate || fit.refused) {
    return {
      after,
      alignment: {
        attempted: true,
        applied: false,
        appliedDof: 'none',
        refused: fit.refused,
        degenerate: fit.degenerate,
        solverResidualM,
        appliedTransformResidualM: unappliedResidualM(),
        yawDeg,
        translation: toMetres(fit.translation),
        centroidShiftM: shiftAtCentre(fit),
        sampleCount,
        overlapFraction,
        frameUnverified,
        horizontalUnitUnknown,
        ...gateFacts,
      },
    };
  }

  // Unsupported move: starting from the identity pose, every pair the solve
  // could form lay within the correspondence distance. A result that moves the
  // after cloud farther than that was reached by walking, not supported by the
  // data at the start, and is withheld.
  if (identityStart && Number.isFinite(gate) && rmsHorizontalMove(afterSample, fit) > gate) {
    return {
      after,
      alignment: {
        attempted: true,
        applied: false,
        appliedDof: 'none',
        refused: false,
        degenerate: false,
        solverResidualM,
        appliedTransformResidualM: unappliedResidualM(),
        yawDeg,
        translation: toMetres(fit.translation),
        centroidShiftM: shiftAtCentre(fit),
        sampleCount,
        overlapFraction,
        unsupportedMove: true,
        frameUnverified,
        horizontalUnitUnknown,
        ...gateFacts,
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
  // The fit ran in a space whose Z was scaled by zScale (metres per vertical
  // unit over metres per horizontal unit), so translation[2] is in that scaled
  // space and must come back to raw source Z before it is applied. The default
  // path zeroes it and never needed the inverse; the full 3-D path applied the
  // scaled shift to raw Z, leaving zScale-1 of the offset behind on a compound
  // frame while reporting the correct metre figure.
  const zBack = zScaleOf(after);
  const applied: Pick<IcpResult, 'yawRad' | 'translation'> = horizontalOnly
    ? { yawRad: fit.yawRad, translation: [fit.translation[0], fit.translation[1], 0] }
    : { yawRad: fit.yawRad, translation: [fit.translation[0], fit.translation[1], fit.translation[2] / zBack] };
  const aligned: EpochCloud = {
    positions: transformedLocal(after.positions, after.origin ?? ZERO, applied),
    origin: after.origin ?? ZERO,
    crs: after.crs,
    verticalDatum: after.verticalDatum,
    // Unit info must survive alignment — the shared-grid cell floor and the
    // confidence roughness slope read it downstream.
    isGeographic: after.isGeographic,
    linearUnitToMetres: after.linearUnitToMetres,
    // The VERTICAL factor too. Omitting it let a compound frame (foot heights
    // over a metre grid) lose its own Z scale the moment alignment succeeded,
    // so the ground filter downstream fell back to the horizontal factor and
    // the same pair was interpreted differently aligned than unaligned.
    verticalUnitToMetres: after.verticalUnitToMetres,
  };
  return {
    after: aligned,
    alignment: {
      attempted: true,
      applied: true,
      appliedDof: horizontalOnly ? 'yaw+xy' : 'yaw+xyz',
      refused: false,
      degenerate: false,
      solverResidualM,
      // Re-measured in the fit space at the pose actually applied (z shift in
      // fit space is the solver's own on the 3-D path, zero on the default).
      appliedTransformResidualM:
        residualAtPose(
          afterSample,
          beforeSample,
          horizontalOnly ? applied : { yawRad: fit.yawRad, translation: fit.translation },
          trimFraction,
          gate,
        ) * metresPerUnit,
      yawDeg,
      // Reported in metres; `applied.translation` (source units) is what
      // actually moved the points.
      translation: toMetres(applied.translation),
      centroidShiftM: shiftAtCentre(applied),
      sampleCount,
      overlapFraction,
      frameUnverified,
      horizontalUnitUnknown,
      ...gateFacts,
    },
  };
}

/**
 * The residual re-measured at a pose, worded for the readout. The residual is
 * Infinity when no sampled point has a partner within the correspondence
 * distance, which happens when the real change between the epochs is larger
 * than that distance; "Infinity m" is not a measurement and is never printed.
 */
function residualClause(label: string, residualM: number, a: Pick<EpochAlignment, 'correspondenceDistanceM'>): string {
  if (Number.isFinite(residualM)) return `${label} ${residualM.toFixed(2)} m`;
  const distance = a.correspondenceDistanceM !== undefined ? ` (${a.correspondenceDistanceM.toFixed(2)} m)` : '';
  return `${label} not measurable: change exceeds the correspondence distance${distance}`;
}

/** A one-line, human-readable summary of an alignment outcome for the UI. */
export function summarizeAlignment(a: EpochAlignment): string {
  if (a.frameIncompatible) {
    return `Alignment not attempted. ${a.frameReason ?? 'The epochs do not share a proven spatial frame.'}`;
  }
  if (a.frameKept) {
    return (
      'Registration: not estimated. Both epochs declare the same horizontal CRS, so they are ' +
      'compared in their supplied coordinates with no shift or yaw applied. Registration ' +
      'uncertainty is not quantified, so the level of detection is a lower bound.'
    );
  }
  if (a.geographicSkipped) {
    return (
      'Alignment: skipped — geographic (degree) coordinates cannot be rigidly ' +
      'aligned in the plane; reproject both epochs to a projected CRS first.'
    );
  }
  if (!a.attempted || a.degenerate) return 'Alignment: skipped (not enough points to register).';
  if (a.unobservable) {
    return (
      'Alignment: refused as unobservable. The surface does not constrain yaw and x, y, z ' +
      'independently (a plane or a single slope cannot separate a horizontal shift from a ' +
      'height change), so no shift was estimated and the clouds are compared as supplied. ' +
      'Registration uncertainty is not quantified.' +
      (a.frameUnverified ? ' Indicative local-frame result — one or both epochs declare no CRS or vertical datum.' : '')
    );
  }
  // Projected frame, unknown linear unit: the residual and shift were scaled by
  // the placeholder factor 1, so every "m" figure would be a source-unit number
  // wearing a metre label. Withhold them — the same fail-closed posture as
  // compareDtms — and keep only the unit-free parts (the applied/refused
  // outcome, the yaw angle, the sample count) plus the diagnosis. Checked before
  // the frameUnverified caveat: an unknown unit is the stronger claim (the
  // figures are not even metres), and its guidance already covers the fix.
  if (a.horizontalUnitUnknown) {
    const unitNote =
      'the horizontal linear unit is unknown, so the shift and residual have no confirmed ' +
      'metre scale and are withheld; set the CRS linear unit (or reproject to a metre/foot CRS) to report them.';
    if (a.refused) return `Alignment: refused — the solver fit residual exceeds the limit, so the clouds are compared as-is. Note: ${unitNote}`;
    return !a.applied
      ? `Alignment: withheld — the fit is not supported by the overlap or the correspondence distance, so the clouds are compared as-is. Note: ${unitNote}`
      : `Aligned the after cloud horizontally (${a.yawDeg.toFixed(2)}° yaw over ${a.sampleCount} sampled points); vertical change preserved. Note: ${unitNote}`;
  }
  if (a.refused) {
    return `Alignment: refused — solver fit residual ${a.solverResidualM.toFixed(2)} m exceeds the limit; comparing as-is (${residualClause('residual at the unshifted pose', a.appliedTransformResidualM, a)}).`;
  }
  if (a.lowOverlap) {
    return `Alignment: withheld — only ${(a.overlapFraction * 100).toFixed(0)}% of the sampled points registered (below ${(LOW_OVERLAP_FRACTION * 100).toFixed(0)}%), so the fit locked onto a subset; comparing as-is rather than shifting on a partial overlap.`;
  }
  if (a.unsupportedMove) {
    return `Alignment: withheld — the fit moved the after cloud farther than the ${CORRESPONDENCE_SPACINGS}-point-spacing correspondence distance, so the data at the starting pose do not support it; comparing as-is.`;
  }
  // The shift at the before sample's centroid: the transform's translation is
  // about the world origin and is not a distance any point moved.
  const moved = a.centroidShiftM ?? a.translation;
  const shift = Math.hypot(moved[0], moved[1]);
  const applied = a.appliedDof === 'yaw+xyz' ? 'yaw + x/y/z' : 'yaw + x/y, z kept';
  const base =
    `Aligned the after cloud (${applied}: ${shift.toFixed(2)} m shift at the before sample's centroid, ${a.yawDeg.toFixed(2)}° yaw; ` +
    `${(a.overlapFraction * 100).toFixed(0)}% overlap over ${a.sampleCount} sampled points). ` +
    `${residualClause('Residual at the applied pose', a.appliedTransformResidualM, a)}; solver fit residual ` +
    `(yaw + x/y/z, not what was applied) ${a.solverResidualM.toFixed(2)} m. Both are fit statistics, ` +
    `not a registration uncertainty, and a small fitting residual does not validate the alignment; ` +
    `registration uncertainty is not quantified.` +
    (a.appliedDof === 'yaw+xyz' ? '' : ' Vertical change preserved.');
  // The figures above describe the FIT. Without a declared frame on both sides
  // they say nothing about the relationship between the epochs, and a residual
  // quoted in metres reads as evidence of georeferenced agreement.
  return a.frameUnverified
    ? `${base} Indicative local-frame result — one or both epochs declare no CRS or vertical datum, so this is not a georeferenced agreement.`
    : base;
}

// The registration provenance record and its readout — re-exported here so the
// compare flow, which already lazy-loads this module, reaches them through the
// same import rather than a second lazy chunk.
export {
  buildRegistrationArtifact,
  summarizeRegistration,
  type RegistrationArtifact,
  type RegistrationScans,
} from './registrationArtifact';
