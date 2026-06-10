/**
 * recommendedWorkflow.test.ts
 *
 * The pure decision core that turns the two assessment axes (Surface Quality +
 * Export Readiness) into a FIXED, ordered checklist of the workflows the app
 * supports, each graded good / caution / blocked. No new geometry — it reads
 * only the verdicts the assessment already computes.
 *
 * Grading rules under test:
 *   - Inspection-class rows (Profile / Measurement / Surface sampling) key off
 *     Surface Quality `status`: Good/Preview ⇒ good; Limited ⇒ caution;
 *     Blocked ⇒ blocked.
 *   - Deliverable-class rows (DEM / Contour / Map sheet) key off Export
 *     Readiness: Ready ⇒ good; Preview ⇒ caution; Blocked ⇒ blocked.
 *   - The row order + labels are stable.
 */

import { describe, it, expect } from 'vitest';
import {
  recommendedWorkflows,
  type WorkflowItem,
} from '../src/terrain/contour/recommendedWorkflow';
import type { TerrainAssessment } from '../src/terrain/contour/terrainAssessment';

/** A minimal assessment with only the fields the workflow grader reads. */
function assess(o: Partial<TerrainAssessment> = {}): TerrainAssessment {
  return {
    status: o.status ?? 'Good',
    exportReadiness: o.exportReadiness ?? 'Ready',
    exportReason: o.exportReason ?? '',
    score: o.score ?? 84,
    scoreKnown: o.scoreKnown ?? true,
    reason: o.reason ?? '',
    bestFor: o.bestFor ?? '',
    useCaution: o.useCaution ?? '',
    notRecommendedFor: o.notRecommendedFor ?? '',
    supportingMetrics: o.supportingMetrics ?? [],
  };
}

const labelsOf = (items: ReadonlyArray<WorkflowItem>): string[] => items.map((i) => i.label);
const byLabel = (items: ReadonlyArray<WorkflowItem>, label: string): WorkflowItem =>
  items.find((i) => i.label === label)!;

/** The fixed, ordered set of workflow labels — inspection first, deliverables after. */
const EXPECTED_ORDER = [
  'Profile analysis',
  'Measurement review',
  'Surface sampling / inspection',
  'DEM export',
  'Contour generation',
  'Map sheet (PDF)',
];

describe('recommendedWorkflows', () => {
  it('returns the fixed, ordered list of supported workflows (stable labels)', () => {
    const items = recommendedWorkflows(assess());
    expect(labelsOf(items)).toEqual(EXPECTED_ORDER);
  });

  it('Good surface + Ready export → every workflow is good', () => {
    const items = recommendedWorkflows(assess({ status: 'Good', exportReadiness: 'Ready' }));
    expect(items.every((i) => i.status === 'good')).toBe(true);
  });

  it('Preview surface + Preview export → inspection good, deliverables caution', () => {
    const items = recommendedWorkflows(
      assess({ status: 'Preview', exportReadiness: 'Preview', exportReason: 'vertical datum unknown' }),
    );
    expect(byLabel(items, 'Profile analysis').status).toBe('good');
    expect(byLabel(items, 'Measurement review').status).toBe('good');
    expect(byLabel(items, 'Surface sampling / inspection').status).toBe('good');
    expect(byLabel(items, 'DEM export').status).toBe('caution');
    expect(byLabel(items, 'Contour generation').status).toBe('caution');
    expect(byLabel(items, 'Map sheet (PDF)').status).toBe('caution');
  });

  it('Limited surface → inspection rows caution', () => {
    const items = recommendedWorkflows(assess({ status: 'Limited', exportReadiness: 'Preview' }));
    expect(byLabel(items, 'Profile analysis').status).toBe('caution');
    expect(byLabel(items, 'Measurement review').status).toBe('caution');
    expect(byLabel(items, 'Surface sampling / inspection').status).toBe('caution');
  });

  it('Blocked surface → every workflow is blocked', () => {
    const items = recommendedWorkflows(assess({ status: 'Blocked', exportReadiness: 'Blocked' }));
    expect(items.every((i) => i.status === 'blocked')).toBe(true);
  });

  it('Good surface but Preview export (datum unknown) → inspection good, deliverables caution', () => {
    // The headline two-axis case: a clean surface that simply isn't georeferenced
    // enough to hand off. Inspection stays green; deliverables drop to caution.
    const items = recommendedWorkflows(
      assess({ status: 'Good', exportReadiness: 'Preview', exportReason: 'vertical datum unknown' }),
    );
    expect(byLabel(items, 'Profile analysis').status).toBe('good');
    expect(byLabel(items, 'DEM export').status).toBe('caution');
    expect(byLabel(items, 'Contour generation').status).toBe('caution');
  });

  it('caution deliverable rows carry a short, honest note', () => {
    const items = recommendedWorkflows(
      assess({ status: 'Preview', exportReadiness: 'Preview', exportReason: 'vertical datum unknown' }),
    );
    const dem = byLabel(items, 'DEM export');
    expect(dem.note).toBeTruthy();
    expect((dem.note ?? '').length).toBeGreaterThan(0);
    // The note must never claim survey-grade.
    expect(dem.note ?? '').not.toMatch(/survey.?grade|certified|guaranteed/i);
  });

  it('is deterministic — same input yields identical output', () => {
    const a = recommendedWorkflows(assess({ status: 'Preview', exportReadiness: 'Preview' }));
    const b = recommendedWorkflows(assess({ status: 'Preview', exportReadiness: 'Preview' }));
    expect(a).toEqual(b);
  });
});
