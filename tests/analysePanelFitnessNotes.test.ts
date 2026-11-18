/**
 * analysePanelFitnessNotes.test.ts — the fitness notes (the caveats from
 * buildScanFitness) are open when the result renders. The per-dimension
 * validation detail stays closed.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { analyseContours } from '../src/terrain/contour/analyseContours';
import { hillScene } from './helpers/hillSceneFixture';

import { FakeEl, installAnalysePanelDom } from './helpers/analysePanelDom';

beforeAll(() => {
  installAnalysePanelDom({ ns: true });
});

describe('AnalysePanel fitness notes', () => {
  it('shows the fitness notes without a click', async () => {
    const { AnalysePanel } = await import('../src/ui/AnalysePanel');
    const panel = new AnalysePanel({});
    // No CRS and no vertical datum, so the scorecard carries caveats.
    panel.update(analyseContours(hillScene(), { cellSizeM: 2 }));
    const root = panel.element as unknown as FakeEl & { open?: boolean };

    const notes = root.findByClass('olv-fit-caveats')[0] as FakeEl & { open?: boolean };
    expect(notes).toBeDefined();
    expect(notes.findByClass('olv-fit-caveat').length).toBeGreaterThan(0);
    expect(notes.open).toBe(true);

    const checks = root.findByClass('olv-fit-checks')[0] as FakeEl & { open?: boolean };
    expect(checks).toBeDefined();
    expect(checks.open).toBeFalsy();
  });
});
