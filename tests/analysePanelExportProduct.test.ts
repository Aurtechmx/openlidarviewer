/**
 * analysePanelExportProduct.test.ts
 *
 * The Export mode's terrain lane runs the Analyse panel's own exports through
 * `exportProduct`. When a product cannot run, the lane must be told why, in
 * the words the Analyse panel uses, instead of getting a bare refusal it can
 * only drop.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { computeTerrainCore, contoursFromCore } from '../src/terrain/contour/analyseContours';
import type { TerrainCoreParams } from '../src/terrain/contour/analyseContours';
import { installAnalysePanelDom } from './helpers/analysePanelDom';

beforeAll(() => { installAnalysePanelDom({ ns: true }); });

function surface(z: (x: number, y: number) => number): Float32Array {
  const pts: number[] = [];
  for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) pts.push(x * 0.5, y * 0.5, z(x, y));
  return new Float32Array(pts);
}

async function panel(z: (x: number, y: number) => number) {
  const { AnalysePanel } = await import('../src/ui/AnalysePanel');
  const p = new AnalysePanel({ getActiveScanId: () => 'scan-a', getExportBasename: () => 'site' });
  const params: TerrainCoreParams = { cellSizeM: 1, crs: 'EPSG:32610', verticalUnitToMetres: 1 };
  const result = contoursFromCore(computeTerrainCore(surface(z), params), { intervalM: 0.5 });
  p.update(result);
  return { p, result };
}

describe('exportProduct refusals', () => {
  it('gives the reason the Analyse panel shows when the contour exports are disabled', async () => {
    const { p, result } = await panel(() => 50.25);
    expect(result.model.features).toHaveLength(0);
    const note = (p as unknown as { _exportNote: { textContent: string } })._exportNote.textContent;
    expect(note).toMatch(/^(Export disabled — |No contours at this interval to export\.)/);
    expect(p.exportProductStatus('contours')).toEqual({ ready: false, reason: note });
    expect(p.exportProduct('contours')).toEqual({ ok: false, reason: note });
  });

  it('says a terrain analysis is needed when there is no result', async () => {
    const { AnalysePanel } = await import('../src/ui/AnalysePanel');
    const p = new AnalysePanel({});
    expect(p.exportProduct('dem')).toEqual({ ok: false, reason: 'Run a terrain analysis first.' });
    expect(p.exportProductStatus('contours').ready).toBe(false);
  });

  it('reports the DEM package ready on a covered surface', async () => {
    const { p } = await panel((x, y) => 50 + 0.4 * x + 0.2 * y);
    expect(p.exportProductStatus('dem')).toEqual({ ready: true, reason: '' });
  });
});
