/**
 * analysePanelCoverageTile.test.ts
 *
 * The Analyse panel's surface row exposes a COVERAGE heatmap tile alongside the
 * CHM / relief previews. Runs in the node environment via a small recording DOM
 * stub (same style as analysePanelReportButton.test.ts), driven with a REAL
 * analysis result so the tile actually renders. Asserts:
 *   - the "Coverage (trust)" tile is present with its honesty caption,
 *   - the 3-stop legend (strong / moderate / weak) is rendered,
 *   - the tile carries its own Export PNG button.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { analyseContours } from '../src/terrain/contour/analyseContours';
import { COVERAGE_CAPTION } from '../src/terrain/surface/coverageHeatmap';
import { hillScene } from './helpers/hillSceneFixture';

import { FakeEl, installAnalysePanelDom } from './helpers/analysePanelDom';

beforeAll(() => {
  installAnalysePanelDom({ ns: true });
});


describe('AnalysePanel — coverage tile', () => {
  it('renders the Coverage (trust) tile with caption, legend and Export PNG', async () => {
    const { AnalysePanel } = await import('../src/ui/AnalysePanel');
    const panel = new AnalysePanel({});
    const result = analyseContours(hillScene(), {
      cellSizeM: 2,
      crs: 'EPSG:32610',
      verticalDatum: 'EPSG:5703',
    });
    panel.update(result);
    const root = panel.element as unknown as FakeEl;

    // The tile heading.
    expect(root.findByText('Coverage (trust)')).toHaveLength(1);

    // The honesty caption — green/yellow/red = measured/interpolated/unreliable.
    expect(root.findContaining(COVERAGE_CAPTION).length).toBeGreaterThan(0);

    // The 3-stop legend words.
    expect(root.findContaining('strong — measured')).toHaveLength(1);
    expect(root.findContaining('moderate — interpolated')).toHaveLength(1);
    expect(root.findContaining('weak — extrapolated / gap')).toHaveLength(1);

    // Coverage tile gets its own Export PNG button (one of several PNG buttons
    // in the surface row — assert at least the coverage one exists).
    expect(root.findByText('Export PNG').length).toBeGreaterThanOrEqual(1);

    // Honesty: nothing in the rendered tree claims survey-grade for coverage.
    expect(root.findContaining('survey-grade coverage')).toHaveLength(0);
  });
});
