/**
 * scanFitness.ts
 *
 * The single source of truth for the verdict-led "Data Fitness" panel — the
 * reorganisation the design council converged on: stop showing the same number
 * three times across two competing panels, and instead lead with ONE
 * plain-language verdict plus a traffic-light scorecard across the dimensions a
 * user actually needs to trust a scan.
 *
 * Pure data: it takes the values the analysis already computes (a flat,
 * decoupled input — the panel maps the result into it, exactly as
 * `terrainQualityScore` takes a `TerrainQualityInput`) and returns a verdict, a
 * six-dimension scorecard, an optional named tier badge, the headline accuracy,
 * and the NON-HIDEABLE caveats the surveyor on the council insisted on (a
 * held-out RMSE is internal consistency, not independent checkpoint
 * verification; a missing datum means relative heights).
 *
 * Tones are deliberately warm — `ready` / `okay` / `review` — never an alarm
 * "error": a missing CRS or a sparse ground is a fitness fact, not a fault. No
 * DOM, no I/O, deterministic. Generic for ANY scan; nothing hard-coded.
 */

import { georefStatus } from '../../ui/georefStatus';

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
  // Vertical accuracy (held-out RMSE, in display units) + whether it is
  // self-consistency only (no independent checkpoints).
  readonly verticalRmse: number | null;
  readonly notSurveyGrade: boolean;
  /** Display unit for accuracy ('m' / 'ft' / …). Default 'm'. */
  readonly unit?: string;
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
  /** Named tier badge when earnable (e.g. "USGS QL2-class"), else null. */
  readonly tierBadge: string | null;
  /** Headline accuracy string, or null when unvalidated. */
  readonly headlineAccuracy: string | null;
  readonly dimensions: FitnessDimension[];
  /** Non-hideable honesty caveats. */
  readonly caveats: string[];
}

const SEVERITY: Record<FitnessTone, number> = { ready: 0, okay: 1, review: 2 };
const worst = (a: FitnessTone, b: FitnessTone): FitnessTone => (SEVERITY[a] >= SEVERITY[b] ? a : b);

/** USGS 3DEP nominal ground density floors (pts/m²): QL2 ≥ 2, QL1 ≥ 8. */
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

function pct(frac: number): number {
  return Math.round(frac * 100);
}

function georefDimension(inp: FitnessInputs): FitnessDimension {
  const gs = georefStatus(inp.crsKnown, inp.datumKnown, { crsName: inp.crsName, datumName: inp.datumName });
  const tone: FitnessTone = gs.tone === 'anchored' ? 'ready' : gs.tone === 'partial' ? 'okay' : 'review';
  return { key: 'georeferencing', label: 'Location & height', tone, summary: gs.headline };
}

function coverageDimension(f: number | null): FitnessDimension {
  if (f == null) return { key: 'coverage', label: 'Coverage', tone: 'review', summary: 'Coverage unknown.' };
  const tone: FitnessTone = f >= COVERAGE_READY ? 'ready' : f >= COVERAGE_OKAY ? 'okay' : 'review';
  const measured = pct(f);
  const summary =
    tone === 'ready'
      ? `${measured}% of the surface is measured ground — well covered.`
      : tone === 'okay'
        ? `${measured}% measured; the rest is interpolated between gaps.`
        : `Only ${measured}% is measured ground — ${100 - measured}% is interpolated, so the surface is mostly inferred.`;
  return { key: 'coverage', label: 'Coverage', tone, summary };
}

function densityDimension(d: number | null): FitnessDimension {
  if (d == null) return { key: 'density', label: 'Ground detail', tone: 'review', summary: 'Ground density unknown.' };
  const tone: FitnessTone = d >= QL1_DENSITY ? 'ready' : d >= QL2_DENSITY ? 'okay' : 'review';
  const v = d >= 100 ? Math.round(d) : Math.round(d * 10) / 10;
  const summary =
    tone === 'ready'
      ? `${v} ground pts/m² — dense (QL1-class).`
      : tone === 'okay'
        ? `${v} ground pts/m² — meets the USGS QL2 floor (2 pts/m²).`
        : `${v} ground pts/m² — below the USGS QL2 floor of 2 pts/m².`;
  return { key: 'density', label: 'Ground detail', tone, summary };
}

function accuracyDimension(rmse: number | null, unit: string): FitnessDimension {
  if (rmse == null) {
    return { key: 'accuracy', label: 'Vertical accuracy', tone: 'review', summary: 'Not validated against any reference.' };
  }
  const tone: FitnessTone = rmse <= RMSE_READY ? 'ready' : rmse <= RMSE_OKAY ? 'okay' : 'review';
  const v = `±${rmse.toFixed(2)} ${unit}`;
  const summary =
    tone === 'ready'
      ? `${v} vertical (held-out check) — tight.`
      : tone === 'okay'
        ? `${v} vertical (held-out check) — moderate.`
        : `${v} vertical (held-out check) — loose.`;
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
  const tone: FitnessTone = unclassified <= UNCLASSIFIED_OKAY ? 'ready' : unclassified < 0.5 ? 'okay' : 'review';
  const u = pct(unclassified);
  const summary =
    tone === 'ready'
      ? `Classified ground present; ${u}% unclassified.`
      : tone === 'okay'
        ? `Partly classified — ${u}% of points are unclassified.`
        : `${u}% unclassified — classification is incomplete.`;
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

/** Build the verdict-led fitness model from the analysis values. Generic. */
export function buildScanFitness(inp: FitnessInputs): ScanFitness {
  const unit = inp.unit ?? 'm';
  const dimensions: FitnessDimension[] = [
    georefDimension(inp),
    coverageDimension(inp.measuredFraction),
    densityDimension(inp.groundDensityPerM2),
    accuracyDimension(inp.verticalRmse, unit),
    classificationDimension(inp.unclassifiedFraction, inp.hasGroundClass),
    integrityDimension(inp),
  ];
  const overallTone = dimensions.reduce<FitnessTone>((t, d) => worst(t, d.tone), 'ready');

  // The verdict leads with what the scan IS good for (the ready dimensions),
  // then names the single biggest limitation (the first reviewed dimension) —
  // and is willing to be negative, which the council called the real moat.
  const reviews = dimensions.filter((d) => d.tone === 'review');
  const limiterPhrase: Record<FitnessKey, string> = {
    georeferencing: 'it isn’t placed in the real world (no map position or height datum)',
    coverage: 'ground coverage is sparse — most of the surface is interpolated',
    density: 'ground density is below survey thresholds',
    accuracy: 'vertical accuracy isn’t validated',
    classification: 'points aren’t classified to ground',
    integrity: 'only part of the cloud was analysed',
  };
  let verdict: string;
  if (inp.status === 'Blocked') {
    verdict = 'Not usable for terrain products as-is.';
  } else if (reviews.length === 0 && inp.status === 'Good') {
    verdict = 'Ready for terrain products — coverage, density and accuracy all pass.';
  } else if (reviews.length === 0) {
    verdict = 'Usable for terrain products, with minor limits.';
  } else {
    const lead = reviews[0];
    const more = reviews.length > 1 ? ` (+${reviews.length - 1} more to review)` : '';
    verdict = `Preview only — ${limiterPhrase[lead.key]}${more}.`;
  }

  // A named tier is only earned when density AND accuracy both pass and the file
  // is georeferenced — otherwise the QL label would overclaim.
  const densTone = dimensions.find((d) => d.key === 'density')!.tone;
  const accTone = dimensions.find((d) => d.key === 'accuracy')!.tone;
  const tierBadge =
    inp.qualityLevel && densTone !== 'review' && accTone !== 'review' && inp.crsKnown ? inp.qualityLevel : null;

  const headlineAccuracy = inp.verticalRmse != null ? `±${inp.verticalRmse.toFixed(2)} ${unit} vertical` : null;

  const caveats: string[] = [];
  if (inp.notSurveyGrade && inp.verticalRmse != null) {
    caveats.push('Accuracy is internal consistency (held-out points), not independent checkpoint verification.');
  }
  if (!inp.datumKnown) caveats.push('No vertical datum — heights are relative, not real-world elevations.');
  if (!inp.crsKnown) caveats.push('No map position (CRS) — the scan isn’t placed on Earth.');

  return { verdict, overallTone, tierBadge, headlineAccuracy, dimensions, caveats };
}
