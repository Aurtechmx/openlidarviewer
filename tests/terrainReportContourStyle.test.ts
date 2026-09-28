/**
 * The terrain report and the map sheet state one contour style: the report is
 * built from the result at the selected export style, the same field the map
 * sheet's regeneration reads, so one run cannot read "Generalized" on the
 * sheet and "Smooth" in the report.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { analyseContours, type AnalyseContoursResult } from '../src/terrain/contour/analyseContours';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';
import type { ContourShapeStyle } from '../src/terrain/contour/contourShapeStyle';

const hoisted = vi.hoisted(() => ({ reportStyles: [] as (string | undefined)[] }));

vi.mock('../src/io/download', () => ({ triggerDownload: () => {}, downloadBytes: () => {} }));
vi.mock('../src/render/measure/terrainReportPdf', () => ({
  buildTerrainReportPdf: async (r: AnalyseContoursResult) => {
    hoisted.reportStyles.push(r.generationParams?.contourStyle);
    return new Uint8Array([1]);
  },
}));

import { FakeEl, installAnalysePanelDom } from './helpers/analysePanelDom';

beforeAll(() => { installAnalysePanelDom({ ns: true }); });

function hill(): TerrainPoint[] {
  const pts: TerrainPoint[] = [];
  for (let x = 0; x <= 30; x++) for (let y = 0; y <= 30; y++) {
    const dx = x - 15; const dy = y - 15;
    pts.push({ x, y, z: 6 * Math.exp(-(dx * dx + dy * dy) / 200) });
  }
  return pts;
}

describe('terrain report contour style', () => {
  it('reports the selected export style, not the on-screen default', async () => {
    const { AnalysePanel } = await import('../src/ui/AnalysePanel');
    const base = { cellSizeM: 2, crs: 'EPSG:32610', verticalDatum: 'EPSG:5703' };
    const panel = new AnalysePanel({
      getActiveScanId: () => 'a',
      buildResultForExport: async (o: { shapeStyle: ContourShapeStyle }) =>
        analyseContours(hill(), { ...base, shapeStyle: o.shapeStyle }),
    });
    panel.update(analyseContours(hill(), base));
    const internals = panel as unknown as {
      _contourStyle: string;
      _exportTerrainReport(btn: unknown): Promise<void>;
    };
    internals._contourStyle = 'generalized';
    await internals._exportTerrainReport(new FakeEl('button'));
    expect(hoisted.reportStyles).toEqual(['generalized']);
  });
});
