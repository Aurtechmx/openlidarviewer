/**
 * scanFitness.ts
 *
 * The single source of truth for the verdict-led "Data Fitness" panel: stop
 * showing the same number three times across two competing panels, and instead
 * lead with ONE plain-language verdict plus a traffic-light scorecard across the
 * dimensions a user actually needs to trust a scan.
 *
 * Pure data: it takes the values the analysis already computes (a flat,
 * decoupled input — the panel maps the result into it, exactly as
 * `terrainQualityScore` takes a `TerrainQualityInput`) and returns a verdict, a
 * six-dimension scorecard, an optional named tier badge, the headline accuracy,
 * and the NON-HIDEABLE survey-grade caveats (a held-out RMSE is internal
 * consistency, not independent checkpoint verification; a missing datum means
 * relative heights).
 *
 * Tones are deliberately warm — `ready` / `okay` / `review` — never an alarm
 * "error": a missing CRS or a sparse ground is a fitness fact, not a fault. No
 * DOM, no I/O, deterministic. Generic for ANY scan; nothing hard-coded.
 */

import { georefStatus } from '../../geo/georefStatus';

/** The fitness gate verdict carried in from the existing assessment. */
export type FitnessStatus = 'Good' | 'Preview' | 'Limited' | 'Blocked';

/** Warm three-step tone — never an error red (a missing fact is not a fault). */
export type FitnessTone = 'ready' | 'okay' | 'review';

/** The six verification dimensions a serious tool must answer. */
export type FitnessKey =
  | 'georeferencing'
  | 'coverage'
  | 'density'
  | 'accuracy'
  | 'classification'
  | 'integrity';

/** Flat, decoupled inputs — the panel maps an AnalyseContoursResult into this. */
export interface FitnessInputs {
  readonly status: FitnessStatus;
  /** 0–100 composite, or null when it could not be computed. */
  readonly score: number | null;
  // Georeferencing
  readonly crsKnown: boolean;
  readonly datumKnown: boolean;
  readonly crsName: string | null;
  readonly datumName: string | null;
  // Coverage (fraction of the surface actually measured, 0..1)
  readonly measuredFraction: number | null;
  // Ground-return density (points per m²) — the DTM-relevant density
  readonly groundDensityPerM2: number | null;
  /**
   * Median ground-return density (pts/m²) over measured cells — the robust
   * companion to the mean above. Surfaced only as a neutral regularity readout
   * (median vs mean) on the density line; it grades nothing and retunes no
   * threshold. Optional, so callers that predate it are unaffected (the readout
   * is simply omitted when absent).
   */
  readonly medianGroundDensityPerM2?: number | null;
  // Vertical accuracy (held-out RMSE, in DISPLAY units) + whether it is
  // self-consistency only (no independent checkpoints).
  readonly verticalRmse: number | null;
  readonly notSurveyGrade: boolean;
  /** Display unit for accuracy ('m' / 'ft' / …). Default 'm'. */
  readonly unit?: string;
  /**
   * Display-unit → metres factor (1 for metres, 0.3048 for feet). The accuracy
   * THRESHOLDS are metric, so the tone buckets on `verticalRmse * unitToMetres`;
   * without this a feet RMSE was graded against metre thresholds. Default 1.
   */
  readonly unitToMetres?: number;
  /**
   * Whether the source linear unit is KNOWN — the CRS resolved a real linear
   * unit. When explicitly `false`, the "pts/m²" density verdict and the "m"
   * vertical-accuracy verdict are assume-metres claims on an inert placeholder
   * factor (an unknown-unit or CRS-less scan), so they are HELD BACK (graded
   * `review`, the headline accuracy suppressed) and a unit-unverified caveat is
   * added instead of asserting a bare metric figure. `undefined` keeps the
   * legacy "assume known" behaviour (no change) for callers that predate the
   * flag. Mirrors the `crs.linearUnit !== 'unknown'` gate the streaming-extent /
   * space-metrics / lasso seams already apply.
   */
  readonly unitKnown?: boolean;
  // Classification: fraction unclassified (null = no classification at all) and
  // whether a ground class is present.
  readonly unclassifiedFraction: number | null;
  readonly hasGroundClass: boolean;
  // Integrity / provenance
  readonly coverageMode: string; // 'full' | 'resident-only' | 'sampled' | …
  /**
   * The strongest USGS 3DEP nominal-pulse-density FLOOR the measured
   * ground-return density clears (e.g. 'QL2'), or null. A reference threshold,
   * NOT a quality-level determination — ground-return density is not pulse
   * density.
   */
  readonly densityReferenceFloor?: string | null;
  /**
   * What the grade actually ran on. `coverageMode` stays the surface-coverage
   * verdict (it feeds the assessment's Preview cap and must not move); this is
   * the separate, disclosed BASIS: a strided sample of the loaded cloud is not
   * "the full cloud" even when the grid coverage reads 'full'. Optional —
   * absent keeps the legacy coverageMode-only wording.
   */
  readonly gradedBasis?: {
    /** True when the analysis strided the loaded cloud down to a sample. */
    readonly sampled: boolean;
    /** Points the grade ran on (the strided sample), or null when unknown. */
    readonly gradedPointCount: number | null;
    /** Ground returns the DTM actually analysed, when the sample size is unknown. */
    readonly analysedGroundCount?: number | null;
    /** Points resident in the viewer for this scan, when known. */
    readonly residentPointCount?: number | null;
  };
  /**
   * Mean analysed ground returns per MEASURED cell (unscaled counts). Below
   * `REGULARITY_MIN_COUNTS` the per-cell counts are integer-quantised at a
   * handful per cell and the median/mean readout carries no regularity
   * information, so it is withheld (the hint says why). Optional — absent
   * keeps the readout.
   */
  readonly meanCountsPerMeasuredCell?: number | null;
  /**
   * The assessment's OWN cause list for its verdict (`TerrainAssessment.
   * limiters`) — the caps and poor-rated metrics that actually produced the
   * status word. When present and non-empty the verdict's lead clause and its
   * "+N more" count come from here, so the sentence names what capped the
   * verdict rather than the highest-priority reviewed scorecard row. Absent or
   * empty ⇒ the scorecard-priority fallback.
   */
  readonly assessmentLimiters?: ReadonlyArray<string>;
}

/** One traffic-light row in the scorecard. */
export interface FitnessDimension {
  readonly key: FitnessKey;
  readonly label: string;
  readonly tone: FitnessTone;
  /** One-line plain-language summary with a benchmark where possible. */
  readonly summary: string;
  /**
   * Longer disclosure for the row's tooltip (basis, denominator, why a readout
   * is withheld). Absent ⇒ the summary is the hint.
   */
  readonly hint?: string;
}

/** The full verdict-led fitness model the panel renders. */
export interface ScanFitness {
  /** Plain-language verdict sentence — sometimes negative, by design. */
  readonly verdict: string;
  /** Worst dimension tone — drives the hero colour. */
  readonly overallTone: FitnessTone;
  /**
   * Named density-reference badge when earnable (e.g. "≥ QL2 density reference"),
   * else null. The badge reports which published nominal-pulse-density reference
   * floor the observed GROUND-RETURN density clears — never a true pulse-density
   * measurement (this codebase has no return-number-filtered first/only-return
   * metric) and never a 3DEP quality-level determination, so an unadorned "QL2"
   * is deliberately avoided.
   */
  readonly tierBadge: string | null;
  /** Headline accuracy string, or null when unvalidated. */
  readonly headlineAccuracy: string | null;
  readonly dimensions: FitnessDimension[];
  /** Non-hideable honesty caveats. */
  readonly caveats: string[];
  /**
   * True when the grade is provisional — only part of the cloud was analysed
   * (streaming / sampled). The hero should mark it "still streaming" rather than
   * read as a settled verdict, and a tier badge is never earned while provisional.
   */
  readonly provisional: boolean;
}

const SEVERITY: Record<FitnessTone, number> = { ready: 0, okay: 1, review: 2 };
const worst = (a: FitnessTone, b: FitnessTone): FitnessTone => (SEVERITY[a] >= SEVERITY[b] ? a : b);

/**
 * Ground-density thresholds (pts/m²), taken from the USGS 3DEP nominal density
 * floors: QL2 ≥ 2, QL1 ≥ 8. They are where the numbers come from, not a claim
 * about the scan — a 3DEP quality level also carries vertical accuracy against
 * independent checkpoints, coverage and collection requirements this
 * application does not validate, so density alone establishes no tier.
 */
const QL2_DENSITY = 2;
const QL1_DENSITY = 8;
/**
 * Scorecard TONE bands — the SAME bands the assessment's supporting-metric
 * chips use (terrainAssessment: bandHigh(density, 2, 1.0) and bandLow(rmse,
 * 0.1, 0.25)), so one number never carries two tones across the panel. The
 * chip bands feed the assessment's Limited rule and stay where they are; these
 * mirror them.
 */
const DENSITY_READY = QL2_DENSITY;
const DENSITY_OKAY = 1.0;
/** Coverage fractions where the measured surface is trustworthy vs sparse. */
const COVERAGE_READY = 0.8;
const COVERAGE_OKAY = 0.5;
/** Vertical RMSE thresholds (metres-equivalent) for ready/okay. */
const RMSE_READY = 0.1;
const RMSE_OKAY = 0.25;
/**
 * The density-reference badge's own gates — unchanged from before the tone
 * bands were aligned to the chips (density ≥ QL2, RMSE ≤ 0.3 m), so aligning
 * the row tones neither earns nor loses a badge.
 */
const BADGE_DENSITY_MIN = QL2_DENSITY;
const BADGE_RMSE_MAX = 0.3;
/** Mean analysed returns per measured cell below which median/mean is withheld. */
const REGULARITY_MIN_COUNTS = 10;
/** Disclosed on every density row: ground returns are not pulses. */
const DENSITY_BASIS_NOTE = 'Ground returns only; the USGS figure counts pulses of all classes.';
/** Unclassified fraction below which the cloud is well classified. */
const UNCLASSIFIED_OKAY = 0.1;
/**
 * Caveat when the source linear unit is unverified (unknown-unit or CRS-less
 * scan): every density / accuracy figure here would be labelled "pts/m²" / "m"
 * off an inert placeholder factor, so disclose the assumption rather than assert
 * metres. Parallels the space-metrics `UNVERIFIED_UNIT_CAVEAT` and the
 * streaming-extent "in source units" fallback.
 */
const UNVERIFIED_UNIT_CAVEAT =
  'Coordinate units are unverified — density (pts/m²) and vertical accuracy (m) would assume metres, so both are held back until the source CRS is confirmed.';

function pct(frac: number): number {
  return Math.round(frac * 100);
}

/** Thousands-grouped integer (locale-independent, so tests and exports agree). */
function fmtInt(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function georefDimension(inp: FitnessInputs): FitnessDimension {
  const gs = georefStatus(inp.crsKnown, inp.datumKnown, { crsName: inp.crsName, datumName: inp.datumName });
  let tone: FitnessTone;
  if (gs.tone === 'anchored') tone = 'ready';
  else if (gs.tone === 'partial') tone = 'okay';
  else tone = 'review';
  return { key: 'georeferencing', label: 'Location & height', tone, summary: gs.headline };
}

function coverageDimension(f: number | null): FitnessDimension {
  if (f == null) return { key: 'coverage', label: 'Coverage', tone: 'review', summary: 'Coverage unknown.' };
  let tone: FitnessTone;
  if (f >= COVERAGE_READY) tone = 'ready';
  else if (f >= COVERAGE_OKAY) tone = 'okay';
  else tone = 'review';
  const measured = pct(f);
  let summary: string;
  // Denominator disclosed: the fraction is of COVERED cells (measured +
  // interpolated), not of the whole grid — empty cells are outside it.
  if (tone === 'ready') summary = `${measured}% of covered cells are measured ground — well covered.`;
  else if (tone === 'okay') summary = `${measured}% of covered cells measured; the rest is interpolated between gaps.`;
  else summary = `Only ${measured}% of covered cells is measured ground — ${100 - measured}% is interpolated, so the surface is mostly inferred.`;
  return { key: 'coverage', label: 'Coverage', tone, summary };
}

/** Round a pts/m² figure the way the density line displays it. */
function densityRound(d: number): number {
  return d >= 100 ? Math.round(d) : Math.round(d * 10) / 10;
}

/**
 * Neutral regularity readout appended to the density line: the already-computed
 * median ground density and its ratio to the mean. A figure only — it sets no
 * threshold, downgrades no tone, and changes no graded surface. Empty when the
 * median is absent/non-finite or the mean is non-positive (ratio undefined).
 */
function densityRegularity(mean: number, median: number | null | undefined): string {
  if (median == null || !Number.isFinite(median) || !(mean > 0)) return '';
  const ratio = Math.round((median / mean) * 100) / 100;
  return ` Median ${densityRound(median)} ground pts/m² (median/mean ${ratio.toFixed(2)}).`;
}

function densityDimension(
  d: number | null,
  median: number | null | undefined,
  unitKnown: boolean,
  meanCounts: number | null | undefined,
): FitnessDimension {
  if (d == null) return { key: 'density', label: 'Ground detail', tone: 'review', summary: 'Ground density unknown.' };
  // Fail closed on an unverified scale: a pts/m² figure derived off an inert
  // placeholder factor is not assertable, so hold the metric verdict rather than
  // grade an unknown-unit scan against the metric 3DEP density floors.
  if (!unitKnown) {
    return {
      key: 'density',
      label: 'Ground detail',
      tone: 'review',
      summary: 'Coordinate units are unverified — ground density can’t be graded in pts/m² until the source CRS is confirmed.',
    };
  }
  let tone: FitnessTone;
  if (d >= DENSITY_READY) tone = 'ready';
  else if (d >= DENSITY_OKAY) tone = 'okay';
  else tone = 'review';
  const v = densityRound(d);
  // "reference" (not "floor met"/"quality level") — this is ground-return
  // density measured against a pulse-density figure, not a QL determination.
  let summary: string;
  if (d >= QL1_DENSITY) summary = `${v} ground pts/m² — clears the ${QL1_DENSITY} pts/m² QL1 pulse-density reference.`;
  else if (tone === 'ready') summary = `${v} ground pts/m² — clears the ${QL2_DENSITY} pts/m² QL2 pulse-density reference.`;
  else if (tone === 'okay') summary = `${v} ground pts/m² — below the ${QL2_DENSITY} pts/m² QL2 pulse-density reference.`;
  else summary = `${v} ground pts/m² — below the ${QL2_DENSITY} pts/m² QL2 pulse-density reference; sparse ground.`;
  // Median vs mean, when the median is supplied — a regularity signal only; the
  // tone above still buckets on the mean. Withheld when the per-cell counts are
  // too few to carry regularity information (integer-quantised at a handful of
  // returns per cell); the hint says so.
  let hint = `${summary} ${DENSITY_BASIS_NOTE}`;
  const tooFewCounts =
    meanCounts != null && Number.isFinite(meanCounts) && meanCounts < REGULARITY_MIN_COUNTS;
  if (tooFewCounts) {
    if (median != null && Number.isFinite(median)) {
      hint += ` Median/mean not shown: about ${Math.round(meanCounts as number)} returns per measured cell, too few for the per-cell counts to carry regularity information.`;
    }
  } else {
    summary += densityRegularity(d, median);
    hint = `${summary} ${DENSITY_BASIS_NOTE}`;
  }
  return { key: 'density', label: 'Ground detail', tone, summary, hint };
}

function accuracyDimension(rmse: number | null, unit: string, unitToMetres: number, unitKnown: boolean): FitnessDimension {
  if (rmse == null) {
    return { key: 'accuracy', label: 'Vertical accuracy', tone: 'review', summary: 'Not validated against any reference.' };
  }
  // Fail closed on an unverified scale: the RMSE would print "± m" and bucket
  // against metric thresholds off an inert placeholder factor, so hold the
  // verdict rather than assert a metre figure on an unknown-unit scan.
  if (!unitKnown) {
    return {
      key: 'accuracy',
      label: 'Vertical accuracy',
      tone: 'review',
      summary: 'Coordinate units are unverified — vertical accuracy can’t be stated in metres until the source CRS is confirmed.',
    };
  }
  // Bucket on the METRIC value; the thresholds are metres. The displayed value
  // stays in the file's unit.
  const rmseM = rmse * unitToMetres;
  let tone: FitnessTone;
  if (rmseM <= RMSE_READY) tone = 'ready';
  else if (rmseM <= RMSE_OKAY) tone = 'okay';
  else tone = 'review';
  // An RMSE is a dispersion statistic, not a symmetric "±" bound — print it as
  // what it is, and name the basis (internal hold-out, not checkpoints).
  const v = `RMSE ${rmse.toFixed(2)} ${unit} (internal hold-out)`;
  let summary: string;
  if (tone === 'ready') summary = `${v} — tight.`;
  else if (tone === 'okay') summary = `${v} — moderate.`;
  else summary = `${v} — loose.`;
  return { key: 'accuracy', label: 'Vertical accuracy', tone, summary };
}

function classificationDimension(unclassified: number | null, hasGround: boolean): FitnessDimension {
  if (unclassified == null || !hasGround) {
    return {
      key: 'classification',
      label: 'Classification',
      tone: 'review',
      summary: 'No ground classification — ground was derived, not provided.',
    };
  }
  let tone: FitnessTone;
  if (unclassified <= UNCLASSIFIED_OKAY) tone = 'ready';
  else if (unclassified < 0.5) tone = 'okay';
  else tone = 'review';
  const u = pct(unclassified);
  let summary: string;
  if (tone === 'ready') summary = `Classified ground present; ${u}% unclassified.`;
  else if (tone === 'okay') summary = `Partly classified — ${u}% of points are unclassified.`;
  else summary = `${u}% unclassified — classification is incomplete.`;
  return { key: 'classification', label: 'Classification', tone, summary };
}

function integrityDimension(inp: FitnessInputs): FitnessDimension {
  if (inp.status === 'Blocked') {
    return { key: 'integrity', label: 'Integrity', tone: 'review', summary: 'Analysis blocked — not enough usable surface.' };
  }
  if (inp.coverageMode !== 'full') {
    const mode = inp.coverageMode === 'resident-only' ? 'the streamed-in part' : 'a sample';
    return { key: 'integrity', label: 'Integrity', tone: 'okay', summary: `Graded on ${mode} of the cloud, not the whole dataset.` };
  }
  // A 'full' coverage mode says the grid spans the extent; it does not say every
  // point was graded. When the analysis strided the loaded cloud, say so — with
  // the sample size and, when known, how much of the cloud is resident.
  const basis = inp.gradedBasis;
  if (basis?.sampled) {
    const n = basis.gradedPointCount;
    const size = n != null && Number.isFinite(n) ? `a ${fmtInt(n)}-point sample` : 'a sample';
    const ground =
      n == null && basis.analysedGroundCount != null && Number.isFinite(basis.analysedGroundCount)
        ? `: ${fmtInt(basis.analysedGroundCount)} ground returns analysed`
        : '';
    const resident =
      basis.residentPointCount != null && Number.isFinite(basis.residentPointCount)
        ? ` (${fmtInt(basis.residentPointCount)} points resident)`
        : '';
    return {
      key: 'integrity',
      label: 'Integrity',
      tone: 'okay',
      summary: `Graded on ${size} of the loaded cloud${ground}${resident}.`,
    };
  }
  return { key: 'integrity', label: 'Integrity', tone: 'ready', summary: 'Graded on the full cloud.' };
}

/**
 * Priority order for the verdict's "lead limitation" — most use-limiting first.
 * Coverage (can a surface even be built) and georeferencing (can it be placed)
 * outrank the finer axes. Used to pick which reviewed dimension the verdict
 * names FIRST, instead of relying on dimension array order.
 */
const LIMITER_PRIORITY: readonly FitnessKey[] = [
  'coverage',
  'georeferencing',
  'density',
  'accuracy',
  'classification',
  'integrity',
];

/** Build the verdict-led fitness model from the analysis values. Generic. */
export function buildScanFitness(inp: FitnessInputs): ScanFitness {
  const unit = inp.unit ?? 'm';
  const unitToMetres = inp.unitToMetres ?? 1;
  // `undefined` keeps the legacy assume-known behaviour; only an explicit `false`
  // fails the metric verdicts closed (unknown-unit / CRS-less scan).
  const unitKnown = inp.unitKnown !== false;
  const provisional = inp.coverageMode !== 'full';
  const dimensions: FitnessDimension[] = [
    georefDimension(inp),
    coverageDimension(inp.measuredFraction),
    densityDimension(inp.groundDensityPerM2, inp.medianGroundDensityPerM2, unitKnown, inp.meanCountsPerMeasuredCell),
    accuracyDimension(inp.verticalRmse, unit, unitToMetres, unitKnown),
    classificationDimension(inp.unclassifiedFraction, inp.hasGroundClass),
    integrityDimension(inp),
  ];
  const overallTone = dimensions.reduce<FitnessTone>((t, d) => worst(t, d.tone), 'ready');

  // The verdict leads with what the scan IS good for, then names the biggest
  // limitation — ranked by LIMITER_PRIORITY (not array order), and willing to be
  // negative: a verdict that is always positive is one users stop reading.
  const reviews = dimensions
    .filter((d) => d.tone === 'review')
    .sort((a, b) => LIMITER_PRIORITY.indexOf(a.key) - LIMITER_PRIORITY.indexOf(b.key));
  const limiterPhrase: Record<FitnessKey, string> = {
    georeferencing: 'it isn’t placed in the real world (no map position or height datum)',
    coverage: 'ground coverage is sparse — most of the surface is interpolated',
    density: unitKnown
      ? 'ground-return density is below the pulse-density reference'
      : 'coordinate units are unverified, so density can’t be graded',
    accuracy: unitKnown
      ? 'vertical accuracy isn’t validated'
      : 'coordinate units are unverified, so accuracy can’t be stated',
    classification: 'points aren’t classified to ground',
    integrity: 'only part of the cloud was analysed',
  };
  // The verdict's LEAD WORD mirrors the authoritative fitness tier (the gate's
  // status) so it never disagrees with the hero verdict — a 'Limited' scan must
  // not read as "Preview only". The clause then names the biggest limitation.
  // The assessment's own cause list wins when it has one: those are the caps
  // and poor-rated metrics that actually produced the status word, so the
  // clause names the real limiter (and "+N more" counts the real causes). The
  // scorecard-priority pick is the fallback only.
  const causes = (inp.assessmentLimiters ?? []).filter((c) => c.trim().length > 0);
  const leadCause = causes[0];
  const lead = reviews[0];
  let limiterClause: string;
  if (leadCause) {
    const more = causes.length > 1 ? ` (+${causes.length - 1} more to review)` : '';
    limiterClause = ` — ${leadCause}${more}`;
  } else {
    const more = reviews.length > 1 ? ` (+${reviews.length - 1} more to review)` : '';
    limiterClause = lead ? ` — ${limiterPhrase[lead.key]}${more}` : '';
  }
  let verdict: string;
  if (inp.status === 'Blocked') {
    verdict = 'Not usable for terrain products as-is.';
  } else if (inp.status === 'Limited') {
    verdict = limiterClause ? `Limited${limiterClause}.` : 'Limited — not export-ready as-is.';
  } else if (inp.status === 'Preview') {
    verdict = limiterClause ? `Preview only${limiterClause}.` : 'Preview — re-run on the full cloud for a settled grade.';
  } else if (reviews.length === 0) {
    verdict = 'Ready for terrain products — coverage, density and accuracy all pass.';
  } else {
    // A 'Good' gate with a soft caveat on one axis — positive, but honest.
    verdict = `Usable, with caveats${limiterClause}.`;
  }
  // A provisional grade (partial / streaming cloud) must never read as settled —
  // prepend a "still streaming" lead so the user re-runs on the full cloud.
  if (provisional && inp.status !== 'Blocked') {
    verdict = `Still streaming — ${verdict.charAt(0).toLowerCase()}${verdict.slice(1)}`;
  }

  // A density-reference badge is shown only when density AND accuracy both pass,
  // the file is georeferenced, AND the figure is on the full cloud — otherwise a
  // partial/streaming sample would misrepresent the density. It names the 3DEP
  // pulse-density FLOOR the ground-return density clears as a REFERENCE, never a
  // quality-level grade (ground-return density is not a pulse determination).
  // Gated on the badge's OWN thresholds (not the row tones, which mirror the
  // assessment chips) so the badge is earned exactly where it was before.
  const badgeDensityOk =
    unitKnown && inp.groundDensityPerM2 != null && inp.groundDensityPerM2 >= BADGE_DENSITY_MIN;
  const badgeAccuracyOk =
    unitKnown && inp.verticalRmse != null && inp.verticalRmse * unitToMetres <= BADGE_RMSE_MAX;
  const tierBadge =
    inp.densityReferenceFloor && !provisional && badgeDensityOk && badgeAccuracyOk && inp.crsKnown
      ? `≥ ${inp.densityReferenceFloor} density reference`
      : null;

  // The headline is a bare "± m" claim, so it too is withheld on an unverified
  // scale (the unit-unverified caveat carries the disclosure instead).
  const headlineAccuracy =
    unitKnown && inp.verticalRmse != null ? `±${inp.verticalRmse.toFixed(2)} ${unit} vertical` : null;

  const caveats: string[] = [];
  // Lead with the unit-unverified disclosure when the scale is unconfirmed — it
  // is the most use-limiting caveat, since it holds back the metric verdicts.
  if (!unitKnown) caveats.push(UNVERIFIED_UNIT_CAVEAT);
  if (inp.notSurveyGrade && inp.verticalRmse != null) {
    caveats.push('Accuracy is internal consistency (held-out points), not independent checkpoint verification.');
  }
  if (!inp.datumKnown)
    caveats.push(
      inp.crsKnown
        ? 'No vertical datum declared — heights aren’t tied to a known reference (NAVD88, EGM, ellipsoid).'
        : 'No vertical datum — heights are relative, not real-world elevations.',
    );
  if (!inp.crsKnown) caveats.push('No map position (CRS) — the scan isn’t placed on Earth.');

  return { verdict, overallTone, tierBadge, headlineAccuracy, dimensions, caveats, provisional };
}
