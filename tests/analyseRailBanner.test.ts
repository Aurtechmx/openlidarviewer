/**
 * analyseRailBanner.test.ts — v0.5.5 P12 Analyse-rail consolidation pins.
 *
 * Two duplication defects, pinned against a REAL analysis result rendered
 * through the panel (node environment via the same recording DOM stub as
 * analysePanelCoverageTile.test.ts):
 *
 *  1. SINGLE-BANNER PIN — the DEM caveat ("Preliminary DEM — …") and the
 *     contour preview caveat ("Preview export — not survey-grade …") used to
 *     stack as two adjacent banners. When both apply they must render as ONE
 *     consolidated caveat that still states BOTH facts (preliminary DEM
 *     coverage/readiness + not-survey-grade + README caveat). When neither
 *     applies, no banner renders.
 *
 *  2. ONE HINT AND ONE PNG EXPORT: the raster tiles (coverage / relief /
 *     canopy) share one sample hint and one PNG export that lists every map.
 *     Each tile keeps its own readout.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { analyseContours } from '../src/terrain/contour/analyseContours';
import { terrainAssessment } from '../src/terrain/contour/terrainAssessment';
import { NOT_SURVEY_GRADE_NOTE } from '../src/terrain/export/exportNotes';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

import { FakeEl, installAnalysePanelDom } from './helpers/analysePanelDom';

beforeAll(() => {
  installAnalysePanelDom({ ns: true, noRaf: true });
});

/** A small hill so the analysis yields real contours + coverage. */
function hillScene(): TerrainPoint[] {
  const pts: TerrainPoint[] = [];
  for (let x = 0; x <= 30; x++) {
    for (let y = 0; y <= 30; y++) {
      const dx = x - 15;
      const dy = y - 15;
      pts.push({ x, y, z: 6 * Math.exp(-(dx * dx + dy * dy) / 200) });
    }
  }
  return pts;
}

describe('AnalysePanel — consolidated not-survey-grade banner', () => {
  it('preview readiness renders ONE caveat stating both facts, not two stacked banners', async () => {
    const { AnalysePanel } = await import('../src/ui/AnalysePanel');
    const panel = new AnalysePanel({});
    // No CRS / datum → the export gate lands on previewOnly with reasons.
    const result = analyseContours(hillScene(), { cellSizeM: 2 });
    expect(result.quality.exportReadiness).toBe('previewOnly');
    expect(result.model.features.length).toBeGreaterThan(0);
    panel.update(result);
    const root = panel.element as unknown as FakeEl;

    // Exactly one banner element carries the DEM caveat…
    const dem = root.findContaining('Preliminary DEM');
    expect(dem).toHaveLength(1);
    // …and that single banner states BOTH facts (nothing disclosed is lost).
    expect(dem[0].ownText).toContain('not survey-grade');
    expect(dem[0].ownText).toContain('README');
    expect(dem[0].ownText).toContain('export readiness: preview');

    // The old second banner no longer renders as a separate element.
    const previewBanners = root.findContaining('Preview export — not survey-grade');
    expect(previewBanners).toHaveLength(0);

    // Two elements state the limitation, and they are different things: the
    // consolidated banner above (conditional) and the panel's standing footer
    // (always present, carrying the canonical note verbatim). P12 consolidated
    // two stacked BANNERS; the footer is not a banner and is not conditional.
    const stating = root.findContaining('not survey-grade');
    const footers = stating.filter((e) => e.className.includes('olv-analyse-footer'));
    expect(footers).toHaveLength(1);
    expect(footers[0].ownText).toBe(NOT_SURVEY_GRADE_NOTE);
    // Exactly one banner states it — the consolidated one, and no other.
    expect(stating.length - footers.length).toBe(1);
  });

  it('fully georeferenced full-coverage result renders NO caveat banner', async () => {
    const { AnalysePanel } = await import('../src/ui/AnalysePanel');
    const panel = new AnalysePanel({});
    const result = analyseContours(hillScene(), {
      cellSizeM: 2,
      crs: 'EPSG:32610',
      verticalDatum: 'EPSG:5703',
    });
    panel.update(result);
    const root = panel.element as unknown as FakeEl;
    // The panel's banners follow terrainAssessment, so branch on the same verdict.
    if (terrainAssessment(result).exportReadiness === 'Ready' && result.dtm.coverageMode === 'full') {
      expect(root.findContaining('Preliminary DEM')).toHaveLength(0);
      expect(root.findContaining('Preview export')).toHaveLength(0);
    } else {
      // Georeferenced but still partial → a single banner, never two. The
      // standing footer is excluded: it always states the limitation and is
      // not one of the banners this pin is about.
      expect(root.findContaining('Preliminary DEM').length).toBeLessThanOrEqual(1);
      const banners = root
        .findContaining('not survey-grade')
        .filter((e) => !e.className.includes('olv-analyse-footer'));
      expect(banners.length).toBeLessThanOrEqual(1);
    }
  });
});

describe('AnalysePanel: repeated statements', () => {
  async function shown(): Promise<FakeEl> {
    const { AnalysePanel } = await import('../src/ui/AnalysePanel');
    const panel = new AnalysePanel({});
    panel.update(analyseContours(hillScene(), { cellSizeM: 2, crs: 'EPSG:32610', verticalDatum: 'EPSG:5703' }));
    return panel.element as unknown as FakeEl;
  }
  const inDetails = (node: FakeEl): boolean => {
    for (let n = node.parent; n; n = n.parent) if (n.tagName === 'details') return true;
    return false;
  };

  it('the raster tiles share one sample hint and one PNG export listing every map', async () => {
    const root = await shown();
    const tiles = root.findByClass('olv-analyse-raster-tile');
    expect(tiles.length).toBeGreaterThanOrEqual(2);
    expect(root.findContaining('Click the map to sample a point.')).toHaveLength(1);
    const buttons = root.findByText('Export PNG');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].title).toContain('Not a georeferenced raster.');
    const select = buttons[0].parent!.children.find((n) => n.tagName === 'select')!;
    expect(select.getAttribute('aria-label')).toBe('Map to export');
    expect(select.children.map((o) => o.ownText)).toEqual(
      tiles.map((t) => t.findByClass('olv-analyse-sublabel')[0].ownText),
    );
    // Each tile keeps its own live readout, empty until a sample.
    for (const tile of tiles) {
      const [readout] = tile.findByClass('olv-analyse-sample');
      expect(readout.ownText).toBe('');
      expect(readout.getAttribute('aria-live')).toBe('polite');
    }
  });

  it('states the canopy height figures once, with the unit', async () => {
    const root = await shown();
    const stats = root.findContaining('p95 ');
    expect(stats).toHaveLength(1);
    expect(stats[0].ownText).toMatch(/^Above-ground height: p95 .*(m|ft|unverified)/);
  });

  it('has one Validation detail, holding the check rows and the hold-out figures', async () => {
    const root = await shown();
    expect(root.findContaining('Validation detail')).toHaveLength(1);
    const [checks] = root.findByClass('olv-fit-checks');
    expect(checks.findByClass('olv-fit-row').length).toBeGreaterThan(0);
    expect(checks.textContent).toMatch(/Vertical RMSE:/);
    expect(root.findContaining('Vertical RMSE:')).toHaveLength(1);
  });

  it('puts the contour share definitions in the visible key', async () => {
    const root = await shown();
    const [defs] = root.findContaining('Sparse ground: measured, but with fewer ground returns than a typical cell.');
    expect(defs.className).toBe('olv-analyse-legend-item');
    expect(defs.ownText).toContain('Interpolated: filled from nearby ground. Gap: too little support to trust.');
    expect(root.hints().some((t) => t.includes('Sparse ground'))).toBe(false);
  });

  it('keeps the derived complexity figure in Surface model stats and its caveat visible at rest', async () => {
    const root = await shown();
    const [caveat] = root.findByClass('olv-analyse-derived-caveat');
    expect(caveat.ownText).toContain('reliability threshold');
    expect(inDetails(caveat)).toBe(false);
    const [value] = root.findByClass('olv-analyse-derived-value');
    expect(value.parent!.className).toBe('olv-analyse-assess-metricwrap');
  });
});
