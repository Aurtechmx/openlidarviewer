/**
 * scanStory.ts
 *
 * The "fitness-for-use" synthesis engine — ONE source of truth that turns the
 * scattered honesty signals a loaded scan already produces (terrain assessment,
 * dataset intelligence, classification state, georeferencing, capture
 * provenance) into two plain, render-ready views:
 *
 *   - {@link buildScanStory}  → the Dataset Story card: what the scan IS, how
 *     good it is, the single biggest limiter, what it's best for, what to use
 *     with caution, what isn't established, and the one next step.
 *   - {@link buildExportHealth} → the Export Health Check: a pre-hand-off summary
 *     of exactly what is about to leave the app (scope, source-vs-derived
 *     classification, CRS, datum, density, product readiness) with a single
 *     ready / caution / blocked verdict and an actionable blocker list.
 *
 * Both are pure reductions over a plain {@link ScanStoryInputs} — the caller
 * pre-flattens the runtime types (terrainAssessment, datasetIntelligence,
 * classificationCoverage, metadata) into facts, so this module stays free of
 * the engine, the DOM, and three.js, and is exhaustively unit-testable.
 *
 * Honesty contract: nothing here upgrades a verdict. Unknown stays unknown,
 * unmeasured stays unmeasured, and derived classification is never presented as
 * a producer's. The story can only ever be as confident as its inputs.
 */

import type {
  DensityBucket,
  GroundVisibilityBucket,
  CoverageBucket,
} from '../terrain/datasetIntelligence';

/** Surface-quality / fitness tier, mirroring terrainAssessment's axis. */
export type FitnessTier = 'Good' | 'Preview' | 'Limited' | 'Blocked' | 'Unknown';

/** One graded terrain/inspection product (Profiles, DTM export, …). */
export interface StoryProduct {
  readonly label: string;
  readonly status: 'Ready' | 'Preview' | 'Blocked';
}

/** The flattened facts the synthesis reduces. Every field optional — a partial
 *  scan still tells a partial, honest story. */
export interface ScanStoryInputs {
  /** Capture-type label from provenance, e.g. "Aerial / airborne ALS". */
  readonly captureLabel?: string;
  /** Source point count (the whole cloud, not the resident subset). */
  readonly pointCount?: number;
  /** Footprint area in m² (NaN/absent ⇒ omitted from the headline). */
  readonly areaM2?: number;
  /** Surface-quality verdict from terrainAssessment. */
  readonly surfaceTier?: FitnessTier;
  /** The terrain/inspection product grades (the bestFor / caution / not split). */
  readonly products?: readonly StoryProduct[];
  /** Dataset-intelligence buckets. */
  readonly density?: DensityBucket;
  readonly groundVisibility?: GroundVisibilityBucket;
  readonly coverageMode?: CoverageBucket | 'unknown';
  /** Georeferencing knowledge. */
  readonly crsKnown?: boolean;
  readonly datumKnown?: boolean;
  /** Classification provenance + (for derived) its 0..1 confidence. */
  readonly classification?: 'none' | 'source' | 'derived';
  readonly classConfidence?: number | null;
}

/** The Dataset Story — render-ready. */
export interface ScanStory {
  readonly headline: string;
  readonly assessment: FitnessTier;
  readonly primaryLimiter: string;
  readonly bestFor: readonly string[];
  readonly useCaution: readonly string[];
  readonly notRecommended: readonly string[];
  readonly notEstablished: readonly string[];
  readonly nextStep: string;
}

/** Export Health verdict + the per-axis rows the panel renders. */
export type HealthVerdict = 'ready' | 'caution' | 'blocked';
export type HealthTier = 'good' | 'caution' | 'blocked' | 'info';

export interface ExportHealthRow {
  readonly label: string;
  readonly value: string;
  readonly tier: HealthTier;
}

export interface ExportHealth {
  readonly verdict: HealthVerdict;
  readonly rows: readonly ExportHealthRow[];
  /** Actionable "double-check this before hand-off" lines (caution/blocked only). */
  readonly blockers: readonly string[];
}

// ── small local formatters (kept here so the module is dependency-light) ──────

function formatCount(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return 'unknown count';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M points`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K points`;
  return `${Math.round(n)} points`;
}

function formatArea(m2: number | undefined): string | null {
  if (m2 === undefined || !Number.isFinite(m2) || m2 <= 0) return null;
  if (m2 >= 1_000_000) return `${(m2 / 1_000_000).toFixed(2)} km²`;
  if (m2 >= 10_000) return `${(m2 / 10_000).toFixed(2)} ha`;
  return `${Math.round(m2)} m²`;
}

const isPartial = (m: ScanStoryInputs['coverageMode']): boolean =>
  m === 'resident-only' || m === 'sampled';

// ── Dataset Story ─────────────────────────────────────────────────────────────

/**
 * Pick the SINGLE biggest thing holding the scan back, in severity order, so the
 * card leads with the one fact that most shapes how the scan can be used. Order
 * matters: a streaming preview dominates (everything below it is provisional),
 * then ground/density (terrain reliability), then georeferencing (export only).
 */
function primaryLimiter(i: ScanStoryInputs): string {
  if (i.surfaceTier === 'Blocked') return 'Surface quality — no usable bare-earth model';
  if (isPartial(i.coverageMode)) return 'Partial coverage — analysis is a streaming preview';
  if (i.groundVisibility === 'poor' || i.groundVisibility === 'fair') {
    return 'Ground visibility — bare earth is partly obscured';
  }
  if (i.density === 'sparse') return 'Low point density';
  if (i.surfaceTier === 'Limited' || i.surfaceTier === 'Preview') {
    return 'Surface quality — below export grade';
  }
  if (i.crsKnown === false) return 'No coordinate system — exports cannot be georeferenced';
  if (i.datumKnown === false) return 'Vertical datum unknown';
  if (i.surfaceTier === 'Good') return 'None — full quality within its capture limits';
  return 'Not yet analysed';
}

/** The one most-useful next action, derived from the primary limiter. */
function nextStep(i: ScanStoryInputs): string {
  if (i.surfaceTier === 'Blocked') return 'Re-capture or densify — the current surface has too little bare earth.';
  if (isPartial(i.coverageMode)) return 'Let the full cloud stream in, then re-run the analysis for a settled grade.';
  if (i.groundVisibility === 'poor' || i.groundVisibility === 'fair') {
    return 'Capture more exposed ground, or validate the surface against control points.';
  }
  if (i.density === 'sparse') return 'Use a denser capture if you need reliable terrain products.';
  if (i.crsKnown === false) return 'Set the coordinate system to enable georeferenced export.';
  if (i.datumKnown === false) return 'Provide the vertical datum before any survey hand-off.';
  return 'Validate against ground control before any survey-grade use.';
}

/** Things this viewer never establishes, named so they are not assumed. */
function notEstablished(i: ScanStoryInputs): string[] {
  const out = ['Vertical accuracy (never measured in-app)'];
  if (i.crsKnown === false) out.push('Coordinate system (CRS)');
  if (i.datumKnown === false) out.push('Vertical datum');
  return out;
}

export function buildScanStory(i: ScanStoryInputs): ScanStory {
  const area = formatArea(i.areaM2);
  const captureLabel = i.captureLabel ?? 'Point cloud';
  const headline = area
    ? `${captureLabel} — ${area}, ${formatCount(i.pointCount)}`
    : `${captureLabel} — ${formatCount(i.pointCount)}`;

  const products = i.products ?? [];
  const bestFor = products.filter((p) => p.status === 'Ready').map((p) => p.label);
  const useCaution = products.filter((p) => p.status === 'Preview').map((p) => p.label);
  const notRecommended = products.filter((p) => p.status === 'Blocked').map((p) => p.label);

  return {
    headline,
    assessment: i.surfaceTier ?? 'Unknown',
    primaryLimiter: primaryLimiter(i),
    bestFor,
    useCaution,
    notRecommended,
    notEstablished: notEstablished(i),
    nextStep: nextStep(i),
  };
}

// ── Export Health Check ───────────────────────────────────────────────────────

/** Worst tier wins → verdict. */
function verdictOf(rows: readonly ExportHealthRow[]): HealthVerdict {
  if (rows.some((r) => r.tier === 'blocked')) return 'blocked';
  if (rows.some((r) => r.tier === 'caution')) return 'caution';
  return 'ready';
}

export function buildExportHealth(i: ScanStoryInputs): ExportHealth {
  const rows: ExportHealthRow[] = [];

  // Scope — what slice of the cloud the figures describe.
  const scope =
    i.coverageMode === 'full'
      ? { value: 'Full cloud', tier: 'good' as HealthTier }
      : i.coverageMode === 'resident-only'
        ? { value: 'Resident preview', tier: 'caution' as HealthTier }
        : i.coverageMode === 'sampled'
          ? { value: 'Sampled', tier: 'caution' as HealthTier }
          : { value: 'Unknown', tier: 'info' as HealthTier };
  rows.push({ label: 'Scan scope', value: scope.value, tier: scope.tier });

  // Classification — source vs derived is the trust line the reviewer cares about.
  if (i.classification === 'derived') {
    const pct =
      typeof i.classConfidence === 'number' && Number.isFinite(i.classConfidence)
        ? ` · ${Math.round(i.classConfidence * 100)}% confidence`
        : '';
    rows.push({ label: 'Classification', value: `Derived (heuristic)${pct}`, tier: 'caution' });
  } else if (i.classification === 'source') {
    rows.push({ label: 'Classification', value: 'Source (producer)', tier: 'good' });
  } else {
    rows.push({ label: 'Classification', value: 'None', tier: 'info' });
  }

  // Georeferencing.
  rows.push(
    i.crsKnown === false
      ? { label: 'Coordinate system', value: 'Unknown', tier: 'caution' }
      : i.crsKnown === true
        ? { label: 'Coordinate system', value: 'Known', tier: 'good' }
        : { label: 'Coordinate system', value: '—', tier: 'info' },
  );
  rows.push(
    i.datumKnown === false
      ? { label: 'Vertical datum', value: 'Unknown', tier: 'caution' }
      : i.datumKnown === true
        ? { label: 'Vertical datum', value: 'Known', tier: 'good' }
        : { label: 'Vertical datum', value: '—', tier: 'info' },
  );

  // Density.
  if (i.density && i.density !== 'unknown') {
    const label = i.density.replace('-', ' ');
    rows.push({
      label: 'Point density',
      value: label.charAt(0).toUpperCase() + label.slice(1),
      tier: i.density === 'sparse' ? 'caution' : 'good',
    });
  }

  // Terrain-product readiness — the surface verdict in export terms.
  const tprTier: HealthTier =
    i.surfaceTier === 'Good'
      ? 'good'
      : i.surfaceTier === 'Blocked'
        ? 'blocked'
        : i.surfaceTier === undefined || i.surfaceTier === 'Unknown'
          ? 'info'
          : 'caution';
  const tprValue =
    i.surfaceTier === 'Good'
      ? 'Export-ready'
      : i.surfaceTier === 'Blocked'
        ? 'Blocked'
        : i.surfaceTier === undefined || i.surfaceTier === 'Unknown'
          ? 'Not analysed'
          : 'Preview only';
  rows.push({ label: 'Terrain products', value: tprValue, tier: tprTier });

  // Actionable blockers — the caution/blocked rows phrased as a checklist.
  const blockers: string[] = [];
  if (scope.tier === 'caution') {
    blockers.push('Figures describe only the streamed-in part of the scan, not the full cloud.');
  }
  if (i.classification === 'derived') {
    blockers.push('Classification is heuristic, not survey-grade — validate before relying on it.');
  }
  if (i.crsKnown === false) blockers.push('No coordinate system — exports cannot be georeferenced.');
  if (i.datumKnown === false) blockers.push('Vertical datum unknown — heights are not datum-referenced.');
  if (i.density === 'sparse') blockers.push('Point density is sparse — terrain products will be coarse.');
  if (i.surfaceTier === 'Blocked') blockers.push('Surface quality gate failed — terrain-product export is disabled.');

  return { verdict: verdictOf(rows), rows, blockers };
}
