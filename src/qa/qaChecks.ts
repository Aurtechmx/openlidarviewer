/**
 * qaChecks.ts — independent quality checks (Phase 2 foundation).
 *
 * A set of INDEPENDENT diagnostics over a loaded scan, each returning its own
 * PASS / REVIEW / BLOCK verdict with a reason. Deliberately NO single global
 * "quality score": a failed spatial-reference check must not drag down an
 * unrelated cloud-quality check, and collapsing them into one number hides which
 * property is actually wrong. Each check reads the same fail-closed ScanFacts the
 * capability model reads, so QA and eligibility can never disagree about the raw
 * facts. Diagnostics, not evidence claims — pure and side-effect-free.
 */

import type { ScanFacts } from '../process/ProcessPlan';
import { isLinearUnitKnown } from '../geo/CoordinateTypes';

export type QaStatus = 'pass' | 'review' | 'block';

export interface QaCheck {
  /** Stable UPPER_SNAKE id — greppable. */
  readonly id: string;
  /** Short human label. */
  readonly label: string;
  readonly status: QaStatus;
  /** One sentence: what was checked and why it landed here. */
  readonly reason: string;
}

/**
 * File integrity: is there actually any point data to work with?
 *
 * Three answers, because there are three facts. A stated positive total passes.
 * A stated ZERO blocks — the scan is empty, and saying so is a measurement. An
 * UNSTATED total (a 3D Tiles tileset states none) is neither: it is a check that
 * could not be run, which is `review`, the same verdict cloud quality gives an
 * unmeasured spacing. Blocking on it would report an empty scan that is drawn on
 * screen; passing it would quote a figure nothing measured.
 */
function fileIntegrity(f: ScanFacts): QaCheck {
  if (f.pointCount == null) {
    return { id: 'FILE_INTEGRITY', label: 'File integrity', status: 'review', reason: "The source states no point total, so the scan's size could not be checked." };
  }
  if (f.pointCount <= 0) {
    return { id: 'FILE_INTEGRITY', label: 'File integrity', status: 'block', reason: 'No points are present in the scan.' };
  }
  return { id: 'FILE_INTEGRITY', label: 'File integrity', status: 'pass', reason: `${f.pointCount.toLocaleString()} points present.` };
}

/** Spatial reference: is the horizontal unit known? Unknown blocks metric work. */
function spatialReference(f: ScanFacts): QaCheck {
  if (isLinearUnitKnown(f.crs)) {
    return { id: 'SPATIAL_REFERENCE', label: 'Spatial reference', status: 'pass', reason: 'A coordinate reference with a known linear unit is present.' };
  }
  return {
    id: 'SPATIAL_REFERENCE', label: 'Spatial reference', status: 'block',
    reason: 'No coordinate reference with a known linear unit — metric products are blocked until it is set.',
  };
}

/** Cloud quality: is the point spacing measured and reasonable? */
function cloudQuality(f: ScanFacts): QaCheck {
  if (f.medianSpacing === undefined || !Number.isFinite(f.medianSpacing)) {
    return { id: 'CLOUD_QUALITY', label: 'Cloud quality', status: 'review', reason: 'Point spacing has not been measured yet.' };
  }
  if (f.medianSpacing <= 0) {
    return { id: 'CLOUD_QUALITY', label: 'Cloud quality', status: 'review', reason: 'Measured point spacing is not positive; treat density as unverified.' };
  }
  return { id: 'CLOUD_QUALITY', label: 'Cloud quality', status: 'pass', reason: `Median point spacing ~${f.medianSpacing.toFixed(2)} m.` };
}

/** Coverage honesty: a resident-only streaming view is not the whole cloud. */
function coverage(f: ScanFacts): QaCheck {
  if (f.coverage === 'full') {
    return { id: 'COVERAGE', label: 'Coverage', status: 'pass', reason: 'The whole cloud is available to the operation.' };
  }
  if (f.coverage === 'sampled') {
    return { id: 'COVERAGE', label: 'Coverage', status: 'review', reason: 'Only a sampled subset is available; whole-dataset products are limited.' };
  }
  return { id: 'COVERAGE', label: 'Coverage', status: 'review', reason: 'Only the resident set is available; whole-dataset products cannot be produced from this view.' };
}

/** Classification: is any producer/derived classification present? */
function classification(f: ScanFacts): QaCheck {
  if (f.classification === 'none') {
    return { id: 'CLASSIFICATION', label: 'Classification', status: 'review', reason: 'No classification is present; classify before class-dependent products.' };
  }
  if (f.classification === 'partial') {
    return { id: 'CLASSIFICATION', label: 'Classification', status: 'review', reason: 'Classification is partial; some class-dependent products may be incomplete.' };
  }
  return { id: 'CLASSIFICATION', label: 'Classification', status: 'pass', reason: 'A full classification is present.' };
}

/** Terrain readiness: is there trustworthy ground for a bare-earth surface? */
function terrainReadiness(f: ScanFacts): QaCheck {
  if (f.groundClassified) {
    return { id: 'TERRAIN_READINESS', label: 'Terrain readiness', status: 'pass', reason: 'Trusted ground (class 2) is present for a bare-earth surface.' };
  }
  return { id: 'TERRAIN_READINESS', label: 'Terrain readiness', status: 'review', reason: 'No trusted ground; a DTM would need ground to be derived first.' };
}

/**
 * Run every independent check over one scan. Order is stable and each check is
 * self-contained; the caller renders them side by side, never as a single score.
 */
export function runQaChecks(f: ScanFacts): QaCheck[] {
  return [
    fileIntegrity(f),
    spatialReference(f),
    cloudQuality(f),
    coverage(f),
    classification(f),
    terrainReadiness(f),
  ];
}

/**
 * The most severe status across a set of checks — block beats review beats pass.
 * This is a SEVERITY roll-up for a headline banner, explicitly NOT a quality
 * score: it tells the reader whether anything needs attention, and the checks
 * themselves say what.
 */
export function worstStatus(checks: readonly QaCheck[]): QaStatus {
  if (checks.some((c) => c.status === 'block')) return 'block';
  if (checks.some((c) => c.status === 'review')) return 'review';
  return 'pass';
}
