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
 * v0.4.5 convergence: the grading + note table above no longer lives here —
 * it is {@link productGradesFor} in the readiness engine, the SAME table
 * {@link deriveReadiness} folds into its verdict. This module only assigns
 * the two class grades to the six fixed rows.
 *
 * Honesty contract: caution/blocked deliverable rows carry a short, plain note
 * (e.g. "preview only — additional validation recommended", "georeferencing
 * incomplete") that NEVER claims survey-grade. Deterministic and pure.
 */

import type { TerrainAssessment } from './terrainAssessment';
import { productGradesFor } from '../quality/readinessEngine';
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

/**
 * Project the assessment onto the fixed, ordered workflow checklist.
 *
 * Grades and deliverable notes come from the readiness engine's single
 * grading table ({@link productGradesFor}), fed the two tiers the assessment
 * already carries — so a row here can never grade apart from the engine's
 * verdict (or from the Terrain Products view downstream).
 *
 * `gate` is accepted for parity with the assessment (the contour gate already
 * feeds export readiness upstream); it is not required to grade the rows, since
 * export readiness already folds the gate's verdict in.
 */
export function recommendedWorkflows(
  assessment: TerrainAssessment,
  _gate?: DtmQualityReport,
): WorkflowItem[] {
  const grades = productGradesFor(assessment.status, assessment.exportReadiness);
  const surface = grades.inspection.status;
  const exportGrade = grades.deliverable.status;
  const note = grades.deliverable.note;

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
