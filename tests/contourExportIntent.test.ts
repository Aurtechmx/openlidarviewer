/**
 * contourExportIntent.test.ts
 *
 * Proves the export intent genuinely differs by purpose — the core of making the
 * purposes "real": Survey Review exports exact analytical geometry, the
 * cartographic purposes export generalized geometry, and each carries the
 * correct method stamp. Same states the workspace drives, via applyPurpose.
 */

import { describe, it, expect } from 'vitest';
import { contourExportIntentFromState } from '../src/terrain/contourStudio/contourExportIntent';
import { baseContourStudioState } from '../src/terrain/contourStudio/contourStudioState';
import { applyPurpose } from '../src/terrain/contourStudio/contourStudioPurpose';
import { defaultContourShapeStyle } from '../src/terrain/contour/contourShapeStyle';

const forPurpose = (p: Parameters<typeof applyPurpose>[1]) =>
  contourExportIntentFromState(applyPurpose(baseContourStudioState(), p));

describe('contourExportIntentFromState', () => {
  it('Survey Review exports exact analytical geometry (crisp, analytical method, tolerance 0)', () => {
    const intent = forPurpose('survey-review');
    expect(intent.shapeStyle).toBe('crisp');
    expect(intent.methodId).toBe('olv.contour.analytical');
    expect(intent.methodTag).toBe('olv.contour.analytical@1');
    expect(intent.generalizeToleranceCells).toBe(0); // exact — no generalization
  });

  it('Presentation Map exports generalized cartographic geometry with the HONEST generalize method', () => {
    const intent = forPurpose('presentation-map');
    expect(intent.shapeStyle).toBe('generalized');
    // Honesty: the shipped pass is a UNIFORM-tolerance simplify, so the stamp is
    // `olv.contour.generalize` — NEVER `terrain-adaptive` (an unwired module).
    expect(intent.methodId).toBe('olv.contour.generalize');
    expect(intent.methodTag).toBe('olv.contour.generalize@1');
    expect(intent.generalizeToleranceCells).toBe(1.0); // strongest preset
    expect(intent.labelsIndexOnly).toBe(true); // presentation maps label index lines only
  });

  it('no purpose is ever stamped with the unwired terrain-adaptive method', () => {
    for (const p of ['engineering-plan', 'survey-review', 'terrain-research', 'presentation-map', 'custom'] as const) {
      expect(forPurpose(p).methodId).not.toBe('olv.contour.generalize.terrain-adaptive');
    }
  });

  it('each cartographic purpose carries its own bounded generalization tolerance', () => {
    expect(forPurpose('terrain-research').generalizeToleranceCells).toBe(0.25); // light/faithful
    expect(forPurpose('engineering-plan').generalizeToleranceCells).toBe(0.5); // moderate default
    expect(forPurpose('presentation-map').generalizeToleranceCells).toBe(1.0); // strong
    // Custom rides the neutral base default (coincides with Engineering).
    expect(forPurpose('custom').generalizeToleranceCells).toBe(0.5);
    // Bounded: every tolerance is within [0, 1] cell.
    for (const p of ['engineering-plan', 'survey-review', 'terrain-research', 'presentation-map', 'custom'] as const) {
      const t = forPurpose(p).generalizeToleranceCells;
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(1);
    }
  });

  it('the four non-custom purposes carry PAIRWISE-DISTINCT tolerances (so geometry can differ)', () => {
    const tols = (['survey-review', 'terrain-research', 'engineering-plan', 'presentation-map'] as const).map(
      (p) => forPurpose(p).generalizeToleranceCells,
    );
    expect(new Set(tols).size).toBe(tols.length);
  });

  it('two purposes produce materially different export intents', () => {
    const survey = forPurpose('survey-review');
    const presentation = forPurpose('presentation-map');
    expect(survey.shapeStyle).not.toBe(presentation.shapeStyle);
    expect(survey.methodId).not.toBe(presentation.methodId);
    expect(survey.generalizeToleranceCells).not.toBe(presentation.generalizeToleranceCells);
  });

  it('a generalized purpose is never stamped as exact analytical geometry', () => {
    for (const p of ['engineering-plan', 'presentation-map', 'terrain-research'] as const) {
      const intent = forPurpose(p);
      expect(intent.shapeStyle).toBe('generalized');
      expect(intent.methodId).toBe('olv.contour.generalize');
      expect(intent.generalizeToleranceCells).toBeGreaterThan(0);
    }
  });

  it('a generalized intent never resolves to the on-screen default style (the "same file" bug)', () => {
    // 'smooth' is the panel default; an intent that resolved to it would reuse the
    // on-screen result and regenerate nothing. No purpose may map to it.
    for (const p of ['engineering-plan', 'survey-review', 'terrain-research', 'presentation-map', 'custom'] as const) {
      expect(forPurpose(p).shapeStyle).not.toBe(defaultContourShapeStyle);
    }
  });

  it('carries the active purpose for provenance', () => {
    expect(forPurpose('engineering-plan').purpose).toBe('engineering-plan');
  });
});
