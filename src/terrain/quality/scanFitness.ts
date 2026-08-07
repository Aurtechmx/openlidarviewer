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
  /** A USGS-style named tier when one is earnable, else null. */
  readonly qualityLevel?: string | null;
}

/** One traffic-light row in the scorecard. */
export interface FitnessDimension {
  readonly key: FitnessKey;
  readonly label: string;
  readonly tone: FitnessTone;
  /** One-line plain-language summary with a benchmark where possible. */
  readonly summary: string;
}

/** The full verdict-led fitness model the panel renders. */
export interface ScanFitness {
  /** Plain-language verdict sentence — sometimes negative, by design. */
  readonly verdict: string;
  /** Worst dimension tone — drives the hero colour. */
  readonly overallTone: FitnessTone;
  /**
   * Named tier badge when earnable, carrying the "(estimated)" qualifier every
   * other surface stamps on the level (e.g. "QL2 (estimated)"), else null. The
   * level's RMSEz leg is hold-out, not independent checkpoints, so an unadorned
   * "QL2" on the hero would read as a 3DEP determination.
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
/** Coverage fractions where the measured surface is trustworthy vs sparse. */
const COVERAGE_READY = 0.8;
const COVERAGE_OKAY = 0.5;
/** Vertical RMSE thresholds (metres-equivalent) for ready/okay. */
const RMSE_READY = 0.1;
const RMSE_OKAY = 0.3;
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
  if (tone === 'ready') summary = `${measured}% of the surface is measured ground — well covered.`;
  else if (tone === 'okay') summary = `${measured}% measured; the rest is interpolated between gaps.`;
  else summary = `Only ${measured}% is measured ground — ${100 - measured}% is interpolated, so the surface is mostly inferred.`;
  return { key: 'coverage', label: 'Coverage', tone, summary };
}

function densityDimension(d: number | null, unitKnown: boolean): FitnessDimension {
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
  if (d >= QL1_DENSITY) tone = 'ready';
  else if (d >= QL2_DENSITY) tone = 'okay';
  else tone = 'review';
  const v = d >= 100 ? Math.round(d) : Math.round(d * 10) / 10;
  let summary: string;
  if (tone === 'ready') summary = `${v} ground pts/m² — at or above ${QL1_DENSITY} pts/m² (the 3DEP QL1 density floor).`;
  else if (tone === 'okay') summary = `${v} ground pts/m² — at or above ${QL2_DENSITY} pts/m² (the 3DEP QL2 density floor).`;
  else summary = `${v} ground pts/m² — below ${QL2_DENSITY} pts/m² (the 3DEP QL2 density floor).`;
  return { key: 'density', label: 'Ground detail', tone, summary };
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
  const v = `±${rmse.toFixed(2)} ${unit}`;
  let summary: string;
  if (tone === 'ready') summary = `${v} vertical (held-out check) — tight.`;
  else if (tone === 'okay') summary = `${v} vertical (held-out check) — moderate.`;
  else summary = `${v} vertical (held-out check) — loose.`;
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
    densityDimension(inp.groundDensityPerM2, unitKnown),
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
      ? 'ground density is below survey thresholds'
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
  const lead = reviews[0];
  const more = reviews.length > 1 ? ` (+${reviews.length - 1} more to review)` : '';
  const limiterClause = lead ? ` — ${limiterPhrase[lead.key]}${more}` : '';
  let verdict: string;
  if (inp.status === 'Blocked') {
    verdict = 'Not usable for terrain products as-is.';
  } else if (inp.status === 'Limited') {
    verdict = lead ? `Limited${limiterClause}.` : 'Limited — not export-ready as-is.';
  } else if (inp.status === 'Preview') {
    verdict = lead ? `Preview only${limiterClause}.` : 'Preview — re-run on the full cloud for a settled grade.';
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

  // A named tier is only earned when density AND accuracy both pass, the file is
  // georeferenced, AND the grade is on the full cloud — otherwise the QL label
  // would overclaim (a partial/streaming sample can't earn a tier).
  const densTone = dimensions.find((d) => d.key === 'density')!.tone;
  const accTone = dimensions.find((d) => d.key === 'accuracy')!.tone;
  const tierBadge =
    inp.qualityLevel && !provisional && densTone !== 'review' && accTone !== 'review' && inp.crsKnown
      ? `${inp.qualityLevel} (estimated)`
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
