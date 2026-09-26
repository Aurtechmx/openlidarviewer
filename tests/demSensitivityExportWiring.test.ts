/**
 * demSensitivityExportWiring.test.ts
 *
 * The "Include sensitivity" option on the DEM package: unchecked writes no
 * sensitivity raster, checked runs the recorded ensemble over the points and
 * parameters that built the DTM and writes it. A failed ensemble still
 * exports the rest of the package and says why; a cancelled one downloads
 * nothing.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { computeTerrainCore, contoursFromCore } from '../src/terrain/contour/analyseContours';
import { getOrComputeCoreAsync } from '../src/terrain/contour/terrainCoreCache';
import type { TerrainCoreParams } from '../src/terrain/contour/analyseContours';
import { extractEntry } from './helpers/zipReader';

const hoisted = vi.hoisted(() => ({
  downloads: [] as { name: string; blob: Blob }[],
  runs: [] as TerrainCoreParams[],
  fail: false,
  onRun: null as null | (() => void),
}));

vi.mock('../src/io/download', () => ({
  triggerDownload: (blob: Blob, name: string) => { hoisted.downloads.push({ name, blob }); },
  downloadBytes: () => {},
}));

import { FakeEl, installAnalysePanelDom } from './helpers/analysePanelDom';

beforeAll(() => { installAnalysePanelDom({ ns: true }); });
beforeEach(() => {
  hoisted.downloads.length = 0;
  hoisted.runs.length = 0;
  hoisted.fail = false;
  hoisted.onRun = null;
});

interface Internals {
  _exportDemPackage(btn: unknown): Promise<void>;
  _demSensitivityCheck: { checked: boolean };
  _demSensitivityStatus: FakeEl;
  _demSensitivityAbort: AbortController | null;
}

function plane(): Float32Array {
  const pts: number[] = [];
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 24; x++) {
      if (x >= 9 && x <= 13 && y >= 9 && y <= 13) continue;
      pts.push(x * 0.5, y * 0.5, 50 + 0.05 * x + (x >= 16 ? 1 : 0));
    }
  }
  return new Float32Array(pts);
}

async function panel(cached = true) {
  const { AnalysePanel } = await import('../src/ui/AnalysePanel');
  const p = new AnalysePanel({
    getActiveScanId: () => 'scan-a',
    getExportBasename: () => 'site',
    getMapContext: () => ({ worldOrigin: { x: 0, y: 0, z: 0 }, linearUnit: 'metre' as const }),
  });
  const positions = plane();
  const params: TerrainCoreParams = { cellSizeM: 1, crs: 'EPSG:32610' };
  // The compute the runner hands the cache; the ensemble re-runs through it.
  let counting = false;
  const compute = async (i: unknown, q: TerrainCoreParams) => {
    if (counting) {
      hoisted.runs.push(q);
      hoisted.onRun?.();
      if (hoisted.fail) throw new Error('worker lost');
    }
    return computeTerrainCore(i as Float32Array, q);
  };
  const core = cached
    ? await getOrComputeCoreAsync(positions, params, compute)
    : computeTerrainCore(positions, params);
  counting = true;
  p.update(contoursFromCore(core, { intervalM: 0.5 }));
  return p as unknown as Internals;
}

async function zip(): Promise<Uint8Array> {
  expect(hoisted.downloads).toHaveLength(1);
  return new Uint8Array(await hoisted.downloads[0].blob.arrayBuffer());
}

describe('DEM export: Include sensitivity', () => {
  it('is unchecked by default and then writes no sensitivity raster', async () => {
    const p = await panel();
    expect(p._demSensitivityCheck.checked).toBe(false);
    await p._exportDemPackage(new FakeEl('button'));
    const bytes = await zip();
    expect(extractEntry(bytes, 'site_sensitivity.tif')).toBeNull();
    expect(extractEntry(bytes, 'site-dtm.tif')).not.toBeNull();
    expect(hoisted.runs).toEqual([]);
  });

  it('runs members 1 to 3 on the canonical parameters and writes the raster when checked', async () => {
    const p = await panel();
    p._demSensitivityCheck.checked = true;
    await p._exportDemPackage(new FakeEl('button'));
    const bytes = await zip();
    expect(extractEntry(bytes, 'site_sensitivity.tif')).not.toBeNull();
    expect(hoisted.runs.map((r) => [r.ground?.slope, r.interpolation])).toEqual([
      [0.15, undefined], [0.2, undefined], [undefined, 'idw'],
    ]);
    expect(hoisted.runs.every((r) => r.crs === 'EPSG:32610' && r.cellSizeM === 1)).toBe(true);
  });

  it('still exports the rest of the package and says why when the ensemble fails', async () => {
    const p = await panel();
    p._demSensitivityCheck.checked = true;
    hoisted.fail = true;
    await p._exportDemPackage(new FakeEl('button'));
    const bytes = await zip();
    expect(extractEntry(bytes, 'site_sensitivity.tif')).toBeNull();
    expect(p._demSensitivityStatus.ownText).toContain('Sensitivity raster not included: worker lost');
  });

  it('says so when the points behind the surface are not held', async () => {
    const p = await panel(false);
    p._demSensitivityCheck.checked = true;
    await p._exportDemPackage(new FakeEl('button'));
    expect(extractEntry(await zip(), 'site_sensitivity.tif')).toBeNull();
    expect(p._demSensitivityStatus.ownText).toContain('run the analysis again');
  });

  it('reports a terrain run stopped by a newer analysis as a failure, not a cancel', async () => {
    const p = await panel();
    p._demSensitivityCheck.checked = true;
    hoisted.onRun = () => { throw new DOMException('superseded', 'AbortError'); };
    await p._exportDemPackage(new FakeEl('button'));
    expect(extractEntry(await zip(), 'site_sensitivity.tif')).toBeNull();
    expect(p._demSensitivityStatus.ownText).toContain('stopped by a newer analysis');
  });

  it('downloads nothing when cancelled', async () => {
    const p = await panel();
    p._demSensitivityCheck.checked = true;
    hoisted.onRun = () => p._demSensitivityAbort?.abort();
    await p._exportDemPackage(new FakeEl('button'));
    expect(hoisted.downloads).toEqual([]);
    expect(p._demSensitivityStatus.ownText).toContain('cancelled');
  });
});
