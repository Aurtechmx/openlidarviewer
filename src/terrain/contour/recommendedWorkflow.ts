/**
 * recommendedWorkflow.ts
 *
 * Turns the two assessment axes into DECISIONS: a FIXED, ordered checklist of
 * the real workflows the app supports, each graded from the verdicts the
 * assessment already computed. No new geometry — pure projection of
 * {@link TerrainAssessment} (and, optionally, the contour gate) onto a stable
 * list of rows.
 *
 * TWO CLASSES OF ROW, keyed off the two axes (deliberately separated, just like
 * the assessment):
 *
 *   INSPECTION-class (Profile / Measurement / Surface sampling) — these only
 *   need an internally valid surface, so they key off SURFACE QUALITY
 *   (`status`): Good/Preview ⇒ good; Limited ⇒ caution; Blocked ⇒ blocked.
 *
 *   DELIVERABLE-class (DEM export / Contour generation / Map sheet) — these are
 *   a hand-off, so they key off EXPORT READINESS (the surface verdict further
 *   gated by a known CRS + vertical datum, plus the contour gate): Ready ⇒ good;
 *   Preview ⇒ caution; Blocked ⇒ blocked.
 *
 * Honesty contract: caution/blocked deliverable rows carry a short, plain note
 * (e.g. "preview only — not for final deliverables", "georeferencing
 * incomplete") that NEVER claims survey-grade. Deterministic and pure.
 */

import type { TerrainAssessment, TerrainStatus, ExportReadinessStatus } from './terrainAssessment';
import type { DtmQualityReport } from '../quality/dtmQualityGate';

/** A single graded workflow row. */
export interface WorkflowItem {
  /** Stable, human label for the workflow. */
  readonly label: string;
  /** good ⇒ ✓, caution ⇒ ⚠, blocked ⇒ ✕. */
  readonly status: 'good' | 'caution' | 'blocked';
  /** Short, honest qualifier for caution/blocked rows (absent for good). */
  readonly note?: string;
}

/** Inspection-class rows grade off SURFACE QUALITY. */
function gradeFromSurface(status: TerrainStatus): WorkflowItem['status'] {
  switch (status) {
    case 'Good':
    case 'Preview':
      return 'good';
    case 'Limited':
      return 'caution';
    case 'Blocked':
    default:
      return 'blocked';
  }
}

/** Deliverable-class rows grade off EXPORT READINESS. */
function gradeFromExport(readiness: ExportReadinessStatus): WorkflowItem['status'] {
  switch (readiness) {
    case 'Ready':
      return 'good';
    case 'Preview':
      return 'caution';
    case 'Blocked':
    default:
      return 'blocked';
  }
}

/**
 * The deliverable note. For caution we explain WHY the deliverable is held back
 * (georeferencing incomplete vs. preview-only surface) so the row is actionable
 * at a glance; for blocked we say the gate stopped it. Never survey-grade.
 */
function deliverableNote(
  grade: WorkflowItem['status'],
  assessment: TerrainAssessment,
): string | undefined {
  if (grade === 'good') return undefined;
  if (grade === 'blocked') return 'quality gate stopped this surface';
  // caution: a known georef gap means the surface is fine but the hand-off frame
  // is incomplete; otherwise the surface itself is only preview-grade.
  const georefOnly =
    assessment.status === 'Good' && assessment.exportReadiness === 'Preview';
  return georefOnly ? 'georeferencing incomplete' : 'preview only — not for final deliverables';
}

/**
 * Project the assessment onto the fixed, ordered workflow checklist.
 *
 * `gate` is accepted for parity with the assessment (the contour gate already
 * feeds export readiness upstream); it is not required to grade the rows, since
 * export readiness already folds the gate's verdict in.
 */
export function recommendedWorkflows(
  assessment: TerrainAssessment,
  _gate?: DtmQualityReport,
): WorkflowItem[] {
  const surface = gradeFromSurface(assessment.status);
  const exportGrade = gradeFromExport(assessment.exportReadiness);
  const note = deliverableNote(exportGrade, assessment);

  const item = (label: string, status: WorkflowItem['status'], n?: string): WorkflowItem =>
    n != null ? { label, status, note: n } : { label, status };

  return [
    // Inspection-class — keyed off Surface Quality.
    item('Profile analysis', surface),
    item('Measurement review', surface),
    item('Surface sampling / inspection', surface),
    // Deliverable-class — keyed off Export Readiness (+ the contour gate upstream).
    item('DEM export', exportGrade, note),
    item('Contour generation', exportGrade, note),
    item('Map sheet (PDF)', exportGrade, note),
  ];
}
