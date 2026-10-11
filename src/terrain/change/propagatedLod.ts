/**
 * propagatedLod.ts
 *
 * The minimum Level of Detection for a two-epoch DEM of difference, propagated
 * from the error of each surface and of their registration (Wheaton et al.
 * 2010, Earth Surf. Process. Landforms 35:136-156, eq. 1 and 3):
 *
 *   LoD = t · sqrt(σz_before² + σz_after² + σreg²),  t = 1.96 (95 %)
 *
 * Uniform form: each σz is ONE number for the whole surface, not a per-cell
 * field: that epoch's random-split hold-out RMSEz (point-vs-surface residual,
 * ground re-classified from the training points only), which includes the
 * epoch's own bias. It is not checkpoint accuracy and not a DEM-cell
 * uncertainty. The 95 % level holds only if the errors are normal, independent
 * and unbiased. σreg is the co-registration error; the alignment here reports
 * only a 3-D RMS residual, which is carried as a proxy (fit misfit; not shown
 * to bound vertical registration error; alignment does not solve z) and
 * labelled as such.
 *
 * Units: every term is in METRES before it enters the sum, and the threshold
 * is metres. Upstream does the conversion with the CRS factors: σz is the
 * hold-out residual scaled by the epoch's vertical metres-per-unit
 * (holdoutValidateDtm), σreg is the ICP residual scaled by the before epoch's
 * horizontal metres-per-unit (alignEpochClouds; its fit space puts z on the
 * horizontal unit, so one factor covers the 3-D residual), and the DoD it
 * thresholds is (z_after − z_before) · verticalUnitToMetres (detectChange),
 * also metres. When a factor is only the inert placeholder 1 (unknown unit),
 * the caller says so via `verticalUnitKnown` / `horizontalUnitKnown` and the
 * affected term is treated as missing: a source-unit number is never summed
 * as metres.
 *
 * When any term is missing the threshold falls back to the fixed default and
 * is labelled "assumed, not measured". A level of detection the user typed
 * wins over both and is labelled "user-set".
 *
 * Pure data: no DOM, no I/O.
 */

/** 95 % two-sided Student/normal multiplier used by Wheaton et al. (2010). */
export const LOD_T_95 = 1.96;

/** Fixed fallback (m) when a propagated term is unavailable. Same value as DEFAULT_LOD_M. */
export const FALLBACK_LOD_M = 0.1;

/** Where the applied threshold came from. */
export type LodBasis = 'propagated' | 'user-set' | 'assumed';

export interface LodInputs {
  /** Hold-out RMSEz (m) of the BEFORE surface; null/undefined when not measured. */
  readonly sigmaZBeforeM?: number | null;
  /** Hold-out RMSEz (m) of the AFTER surface. */
  readonly sigmaZAfterM?: number | null;
  /** Co-registration error (m); null/undefined when no alignment was applied. */
  readonly sigmaRegM?: number | null;
  /**
   * True when `sigmaRegM` is a vertical residual. False (default) means it is
   * the alignment's 3-D RMS, used as a proxy (fit misfit; not shown to bound
   * vertical registration error; alignment does not solve z).
   */
  readonly sigmaRegIsVertical?: boolean;
  /**
   * False when the vertical metres-per-unit is unknown (placeholder 1), so the
   * σz values are source units, not metres. Both σz terms are then missing.
   */
  readonly verticalUnitKnown?: boolean;
  /**
   * False when the horizontal metres-per-unit is unknown, so the alignment
   * residual is in source units. σreg is then missing.
   */
  readonly horizontalUnitKnown?: boolean;
  /** A level of detection the user typed (m). Wins when finite and ≥ 0. */
  readonly userLodM?: number | null;
  /** Fallback threshold (m) when a term is missing. Default {@link FALLBACK_LOD_M}. */
  readonly fallbackLodM?: number;
}

export interface LevelOfDetection {
  /** The threshold applied (m). |Δ| ≤ this is no change. */
  readonly valueM: number;
  readonly basis: LodBasis;
  /** Coverage factor applied to the combined σ (1.96 for 95 %). */
  readonly t: number;
  readonly sigmaZBeforeM: number | null;
  readonly sigmaZAfterM: number | null;
  readonly sigmaRegM: number | null;
  readonly sigmaRegIsVertical: boolean;
  /**
   * Per-cell random σ (m) for the volume band: sqrt(σz_before² + σz_after²)
   * when both are measured, else LoD / t. Registration is NOT folded in here;
   * the band carries it as its separate systematic term.
   */
  readonly cellSigmaM: number;
  /** Names of the terms that were missing (empty when propagated). */
  readonly missing: readonly string[];
}

function usable(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** Compute the applied level of detection and its basis. */
export function propagatedLevelOfDetection(input: LodInputs): LevelOfDetection {
  const t = LOD_T_95;
  const vKnown = input.verticalUnitKnown !== false;
  const hKnown = input.horizontalUnitKnown !== false;
  const zb = vKnown && usable(input.sigmaZBeforeM) ? input.sigmaZBeforeM : null;
  const za = vKnown && usable(input.sigmaZAfterM) ? input.sigmaZAfterM : null;
  // A zero registration RMS means "no alignment term", not a perfect fit.
  const regRaw = usable(input.sigmaRegM) && input.sigmaRegM > 0 ? input.sigmaRegM : null;
  const reg = hKnown ? regRaw : null;
  const regVertical = input.sigmaRegIsVertical === true;
  const missing: string[] = [];
  const vWhy = ' (vertical unit unknown, cannot be expressed in metres)';
  if (zb === null) missing.push(`before-epoch σz (hold-out RMSEz)${vKnown ? '' : vWhy}`);
  if (za === null) missing.push(`after-epoch σz (hold-out RMSEz)${vKnown ? '' : vWhy}`);
  if (reg === null) {
    missing.push(
      regRaw !== null && !hKnown
        ? 'registration σ (horizontal unit unknown, cannot be expressed in metres)'
        : 'registration σ (no alignment applied)',
    );
  }
  const randomSigma = zb !== null && za !== null ? Math.hypot(zb, za) : null;

  const base = { t, sigmaZBeforeM: zb, sigmaZAfterM: za, sigmaRegM: reg, sigmaRegIsVertical: regVertical, missing };
  if (usable(input.userLodM)) {
    const valueM = input.userLodM;
    return { ...base, valueM, basis: 'user-set', cellSigmaM: randomSigma ?? valueM / t };
  }
  if (zb !== null && za !== null && reg !== null) {
    const valueM = t * Math.sqrt(zb * zb + za * za + reg * reg);
    return { ...base, valueM, basis: 'propagated', cellSigmaM: randomSigma as number };
  }
  const fb = usable(input.fallbackLodM) ? input.fallbackLodM : FALLBACK_LOD_M;
  return { ...base, valueM: fb, basis: 'assumed', cellSigmaM: randomSigma ?? fb / t };
}

/** A fixed or user-supplied threshold with no propagated terms. */
export function fixedLevelOfDetection(valueM: number, userSet: boolean): LevelOfDetection {
  return propagatedLevelOfDetection(userSet ? { userLodM: valueM } : { fallbackLodM: valueM });
}

const mm = (m: number): string => `${(m * 1000).toFixed(1)} mm`;

/** Short label for the threshold, e.g. "0.072 m (propagated, 95 %)". */
export function lodLabel(lod: LevelOfDetection): string {
  const v = `${lod.valueM.toFixed(3)} m`;
  if (lod.basis === 'propagated') return `${v} (propagated, 95 %)`;
  if (lod.basis === 'user-set') return `${v} (user-set)`;
  return `${v} (assumed, not measured)`;
}

/** Report lines stating the threshold, its components and its basis. */
export function describeLevelOfDetection(lod: LevelOfDetection): string[] {
  const lines: string[] = [`Level of detection: ${lodLabel(lod)}.`];
  const regName = lod.sigmaRegIsVertical
    ? 'registration σ (vertical residual)'
    : 'registration σ (alignment 3-D RMS, a proxy: fit misfit, not shown to bound vertical registration error; alignment does not solve z)';
  const comp = [
    `before σz ${lod.sigmaZBeforeM === null ? 'not measured' : mm(lod.sigmaZBeforeM)}`,
    `after σz ${lod.sigmaZAfterM === null ? 'not measured' : mm(lod.sigmaZAfterM)}`,
    `${regName} ${lod.sigmaRegM === null ? 'not available' : mm(lod.sigmaRegM)}`,
  ].join(', ');
  if (lod.basis === 'propagated') {
    lines.push(
      `Basis: LoD = ${lod.t} · √(σz_before² + σz_after² + σreg²) (Wheaton et al. 2010, uniform form); ` +
        `${comp}. Each σz is that epoch's random-split hold-out RMSEz (point-vs-surface residual, ` +
        `ground re-classified from the training points only; includes the epoch's bias), not ` +
        `checkpoint accuracy nor a DEM-cell uncertainty. The 95 % level holds only if the errors ` +
        `are normal, independent and unbiased.`,
    );
  } else if (lod.basis === 'user-set') {
    lines.push(`Basis: user-set threshold; the propagated terms were not used (${comp}).`);
  } else {
    lines.push(
      `Basis: assumed, not measured — the fixed ${lod.valueM} m default is used because ` +
        `${lod.missing.join(', ')} ${lod.missing.length === 1 ? 'is' : 'are'} unavailable (${comp}).`,
    );
  }
  return lines;
}

/**
 * Disclosure: the epoch alignment estimates yaw and x/y only, so a constant
 * vertical offset between epochs (datum, geoid or sensor bias) is neither
 * estimated nor removed and reads as uniform change.
 */
export const VERTICAL_OFFSET_DISCLOSURE =
  'Vertical offset not estimated: epoch alignment solves yaw and x/y only, so a systematic ' +
  'vertical offset between the epochs (a datum, geoid or sensor bias) is not removed and ' +
  'appears as change everywhere. Check the difference over ground known to be stable; a ' +
  'non-zero mean there is a bias, not change.';
