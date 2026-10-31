/**
 * terrainScanScopeOnDisplaySample.test.ts
 *
 * The Terrain page's "Scan scope" chip (primary row and All metrics) read
 * "full" on a display-sample load. The runner hands the panel its frame after
 * the result, and the metrics block was drawn only with the result, before the
 * frame said the load is a sample. The chip follows the frame either way round;
 * a full load whose analysis read a subsample stays "full".
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { analyseContours } from '../src/terrain/contour/analyseContours';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';
import type { AnalysedBasis } from '../src/terrain/export/analysedBasis';
import { FakeEl, installAnalysePanelDom } from './helpers/analysePanelDom';

beforeAll(() => {
  installAnalysePanelDom({ ns: true });
});

function hill(): TerrainPoint[] {
  return Array.from({ length: 41 * 41 }, (_, i) => {
    const x = i % 41;
    const y = Math.floor(i / 41);
    return { x, y, z: 6 * Math.sin(x / 7) * Math.cos(y / 9) };
  });
}

/** A display sample: 2,271,607 loaded of 210,887,303 declared. */
const DISPLAY_SAMPLE: AnalysedBasis = {
  analysedPointCount: 300_000, declaredPointCount: 210_887_303, coverage: 'sampled', loadStride: null, residentPointCount: 2_271_607,
};
/** A full load whose terrain run analysed a subsample of it. */
const FULL_SUBSAMPLED: AnalysedBasis = {
  analysedPointCount: 300_000, declaredPointCount: 4_000_000, coverage: 'full', loadStride: null,
};

async function scopeChips(basis: AnalysedBasis, frameFirst: boolean): Promise<string[]> {
  const { AnalysePanel } = await import('../src/ui/AnalysePanel');
  const panel = new AnalysePanel({});
  const result = analyseContours(hill(), { cellSizeM: 2, crs: 'EPSG:32610', horizontalUnitToMetres: 1, verticalUnitToMetres: 1 });
  const frame = { analysedBasis: basis } as never;
  if (frameFirst) panel.setContourFrame(frame);
  panel.update(result);
  if (!frameFirst) panel.setContourFrame(frame);
  const root = panel.element as unknown as FakeEl;
  return root.querySelectorAll('.olv-analyse-assess-metric')
    .filter((p) => p.textContent.includes('Scan scope'))
    .map((p) => p.textContent);
}

describe('Scan scope on the Terrain page', () => {
  it('reads display sample in the primary row and All metrics, whichever arrives first', async () => {
    for (const first of [true, false]) {
      const chips = await scopeChips(DISPLAY_SAMPLE, first);
      expect(chips.length).toBeGreaterThanOrEqual(2);
      for (const c of chips) expect(c).toContain('display sample');
    }
  });
  it('stays full on a full load whose analysis read a subsample', async () => {
    const chips = await scopeChips(FULL_SUBSAMPLED, false);
    expect(chips.length).toBeGreaterThanOrEqual(2);
    for (const c of chips) expect(c).toContain('full');
  });
});
