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
 * and unbiased.  * Uniform form: each σz is ONE number for the whole surface (that epoch's
 * hold-out RMSEz), not a per-cell field.
 *
 * σreg is the VERTICAL co-registration uncertainty. It is accepted only from an
 * independent assessment: vertical differences measured over stable reference
 * areas (ground known not to have changed) after the registration was applied.
 * The epoch alignment's fit residuals (solver residual, applied-pose residual)
 * are fit misfits that also carry horizontal mismatch, point spacing, roughness
 * and real change; they are NOT σreg and are never passed here. The app has no
 * stable-area assessment yet, so in the live workflow σreg is unavailable and
 * the threshold is labelled incomplete.
 *
 * Units: every term is in METRES before it enters the sum, and the threshold
 * is metres. σz is the hold-out residual scaled by the epoch's vertical
 * metres-per-unit (holdoutValidateDtm); the DoD it thresholds is
 * (z_after − z_before) · verticalUnitToMetres (detectChange), also metres. When
 * a factor is only the inert placeholder 1 (unknown unit), the caller says so
 * via `verticalUnitKnown` / `horizontalUnitKnown` and the affected term is
 * treated as missing: a source-unit number is never summed as metres.
 *
 * Threshold rule (missing information never shrinks known uncertainty):
 *   - every term present            → 'propagated': t·√(Σσ²).
 *   - some terms known, some missing → 'incomplete': max(t·√(Σ known σ²), floor),
 *     a LOWER BOUND on the full threshold; significance counts and detectable
 *     volumes computed with it are labelled as such.
 *   - no term known                 → 'assumed': the fixed floor, "assumed, not measured".
 *   - a level of detection the user typed wins over all three ('user-set'), with
 *     a warning when it is below the known-component threshold.
 *
 * Pure data: no DOM, no I/O.
 */

/** 95 % two-sided Student/normal multiplier used by Wheaton et al. (2010). */
export const LOD_T_95 = 1.96;

/** Fixed fallback (m) when a propagated term is unavailable. Same value as DEFAULT_LOD_M. */
export const FALLBACK_LOD_M = 0.1;

/** Where the applied threshold came from. */
export type LodBasis = 'propagated' | 'incomplete' | 'user-set' | 'assumed';

export interface LodInputs {
  /** Hold-out RMSEz (m) of the BEFORE surface; null/undefined when not measured. */
  readonly sigmaZBeforeM?: number | null;
  /** Hold-out RMSEz (m) of the AFTER surface. */
  readonly sigmaZAfterM?: number | null;
  /**
   * Vertical co-registration uncertainty (m) from an INDEPENDENT stable-area
   * assessment; null/undefined when none exists. Never an alignment fit residual.
   */
  readonly sigmaRegM?: number | null;
  /**
   * False when the vertical metres-per-unit is unknown (placeholder 1), so the
   * σz values are source units, not metres. Both σz terms are then missing.
   */
  readonly verticalUnitKnown?: boolean;
  /**
   * False when the horizontal metres-per-unit is unknown, so the stable-area
   * σreg cannot be confirmed in metres. σreg is then missing.
   */
  readonly horizontalUnitKnown?: boolean;
  /** A level of detection the user typed (m). Wins when finite and ≥ 0. */
  readonly userLodM?: number | null;
  /**
   * Floor (m): the threshold when no term is known, and the minimum when only
   * some are. Default {@link FALLBACK_LOD_M}.
   */
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
  /**
   * Per-cell random σ (m) for the volume band. 'propagated': sqrt(σz_before² +
   * σz_after²) (registration is the band's separate systematic term).
   * 'incomplete' / 'assumed': LoD / t, which is never smaller than the known
   * σz terms, so the band and the threshold rest on one uncertainty and the
   * LoD is never below what the band's σ implies. 'user-set': the measured
   * random σ when both σz are known, else LoD / t.
   */
  readonly cellSigmaM: number;
  /** Names of the terms that were missing (empty when propagated). */
  readonly missing: readonly string[];
  /**
   * t·√(Σ known σ²) (m): the threshold the KNOWN terms alone imply, or null
   * when no term is known. The applied threshold is never below it except
   * under an explicit user override, which then sets `belowKnownComponent`.
   */
  readonly knownComponentM: number | null;
  /** A user-set threshold is below {@link knownComponentM}. */
  readonly belowKnownComponent: boolean;
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
  // A zero σreg means "no assessment", not a perfect registration.
  const regRaw = usable(input.sigmaRegM) && input.sigmaRegM > 0 ? input.sigmaRegM : null;
  const reg = hKnown ? regRaw : null;
  const missing: string[] = [];
  const vWhy = ' (vertical unit unknown, cannot be expressed in metres)';
  if (zb === null) missing.push(`before-epoch σz (hold-out RMSEz)${vKnown ? '' : vWhy}`);
  if (za === null) missing.push(`after-epoch σz (hold-out RMSEz)${vKnown ? '' : vWhy}`);
  if (reg === null) {
    missing.push(
      regRaw !== null && !hKnown
        ? 'registration σreg (horizontal unit unknown, cannot be expressed in metres)'
        : 'registration σreg (no independent stable-area assessment)',
    );
  }
  const known = [zb, za, reg].filter((v): v is number => v !== null);
  const knownComponentM = known.length > 0 ? t * Math.sqrt(known.reduce((acc, v) => acc + v * v, 0)) : null;
  const randomSigma = zb !== null && za !== null ? Math.hypot(zb, za) : null;
  const fb = usable(input.fallbackLodM) ? input.fallbackLodM : FALLBACK_LOD_M;

  const base = { t, sigmaZBeforeM: zb, sigmaZAfterM: za, sigmaRegM: reg, missing, knownComponentM };
  if (usable(input.userLodM)) {
    const valueM = input.userLodM;
    return {
      ...base,
      valueM,
      basis: 'user-set',
      cellSigmaM: randomSigma ?? valueM / t,
      belowKnownComponent: knownComponentM !== null && valueM < knownComponentM,
    };
  }
  if (missing.length === 0) {
    return { ...base, valueM: knownComponentM as number, basis: 'propagated', cellSigmaM: randomSigma as number, belowKnownComponent: false };
  }
  if (knownComponentM !== null) {
    const valueM = Math.max(knownComponentM, fb);
    return { ...base, valueM, basis: 'incomplete', cellSigmaM: valueM / t, belowKnownComponent: false };
  }
  return { ...base, valueM: fb, basis: 'assumed', cellSigmaM: fb / t, belowKnownComponent: false };
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
  if (lod.basis === 'incomplete') return `${v} (incomplete — lower bound, missing: ${lod.missing.join(', ')})`;
  if (lod.basis === 'user-set') return `${v} (user-set)`;
  return `${v} (assumed, not measured)`;
}

/** Report lines stating the threshold, its components and its basis. */
export function describeLevelOfDetection(lod: LevelOfDetection): string[] {
  const lines: string[] = [`Level of detection: ${lodLabel(lod)}.`];
  const comp = [
    `before σz ${lod.sigmaZBeforeM === null ? 'not measured' : mm(lod.sigmaZBeforeM)}`,
    `after σz ${lod.sigmaZAfterM === null ? 'not measured' : mm(lod.sigmaZAfterM)}`,
    `registration σreg (stable-area vertical assessment) ${lod.sigmaRegM === null ? 'not available' : mm(lod.sigmaRegM)}`,
  ].join(', ');
  const fitNote =
    'Alignment fit residuals are not used as σreg: they measure the fit, not vertical registration error.';
  if (lod.basis === 'propagated') {
    lines.push(
      `Basis: LoD = ${lod.t} · √(σz_before² + σz_after² + σreg²) (Wheaton et al. 2010, uniform form); ` +
        `${comp}. Each σz is that epoch's random-split hold-out RMSEz (point-vs-surface residual, ` +
        `ground re-classified from the training points only; includes the epoch's bias), not ` +
        `checkpoint accuracy nor a DEM-cell uncertainty. The 95 % level holds only if the errors ` +
        `are normal, independent and unbiased.`,
    );
  } else if (lod.basis === 'incomplete') {
    lines.push(
      `Basis: incomplete — ${lod.t} · √(Σ known σ²) = ${(lod.knownComponentM as number).toFixed(3)} m ` +
        `from the known terms (or the floor, whichever is larger); ${lod.missing.join(', ')} ` +
        `${lod.missing.length === 1 ? 'is' : 'are'} unavailable, so the full threshold is at least this ` +
        `large and significance counts and detectable volumes are computed with a lower-bound threshold ` +
        `(${comp}). ${fitNote}`,
    );
  } else if (lod.basis === 'user-set') {
    lines.push(`Basis: user-set threshold; the propagated terms were not used (${comp}).`);
    if (lod.belowKnownComponent && lod.knownComponentM !== null) {
      lines.push(
        `⚠ The user-set threshold is below the ${lod.knownComponentM.toFixed(3)} m that the known ` +
          `uncertainty terms alone imply; changes between the two are within measured noise.`,
      );
    }
  } else {
    lines.push(
      `Basis: assumed, not measured — the fixed ${lod.valueM} m default is used because ` +
        `${lod.missing.join(', ')} ${lod.missing.length === 1 ? 'is' : 'are'} unavailable (${comp}). ${fitNote}`,
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
