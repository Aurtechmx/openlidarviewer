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

const forPurpose = (p: Parameters<typeof applyPurpose>[1]) =>
  contourExportIntentFromState(applyPurpose(baseContourStudioState(), p));

describe('contourExportIntentFromState', () => {
  it('Survey Review exports exact analytical geometry (crisp, analytical method)', () => {
    const intent = forPurpose('survey-review');
    expect(intent.shapeStyle).toBe('crisp');
    expect(intent.methodId).toBe('olv.contour.analytical');
    expect(intent.methodTag).toBe('olv.contour.analytical@1');
  });

  it('Presentation Map exports generalized cartographic geometry with a generalize method', () => {
    const intent = forPurpose('presentation-map');
    expect(intent.shapeStyle).not.toBe('crisp');
    expect(intent.methodId).toBe('olv.contour.generalize.terrain-adaptive');
    expect(intent.labelsIndexOnly).toBe(true); // presentation maps label index lines only
  });

  it('two purposes produce materially different export intents', () => {
    const survey = forPurpose('survey-review');
    const presentation = forPurpose('presentation-map');
    expect(survey.shapeStyle).not.toBe(presentation.shapeStyle);
    expect(survey.methodId).not.toBe(presentation.methodId);
  });

  it('a smoothed purpose is never stamped as exact analytical geometry', () => {
    for (const p of ['engineering-plan', 'presentation-map', 'terrain-research'] as const) {
      const intent = forPurpose(p);
      if (intent.shapeStyle !== 'crisp') {
        expect(intent.methodId).toBe('olv.contour.generalize.terrain-adaptive');
      }
    }
  });

  it('carries the active purpose for provenance', () => {
    expect(forPurpose('engineering-plan').purpose).toBe('engineering-plan');
  });
});
