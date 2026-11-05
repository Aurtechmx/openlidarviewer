/** chunkFailureWiring.test.ts: the surfaces that had to correct a state or a claim when a chunk fails. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetChunkFailuresForTests } from '../src/app/staleChunkReload';
import { decodeFullViaWorker, __setParseWorkerFactoryForTests } from '../src/io/loadFile';
import { contributeAnalysisActions } from '../src/app/actions/analysisActions';
import { createMeasurePanelMount } from '../src/app/measurePanelMount';
import { terrainFailureStatus } from '../src/app/terrainAnalysisRunner';

const chunk = vi.hoisted(() => ({ err: () => new TypeError('Failed to fetch dynamically imported module: http://h/a-1.js') }));
vi.mock('../src/lazyChunks', async (orig) => ({
  ...(await orig<object>()),
  loadTerrainAccessLab: () => Promise.reject(chunk.err()),
  loadObservatoryRun: () => Promise.reject(chunk.err()),
  loadMeasurePanel: () => Promise.reject(chunk.err()),
}));
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { resetChunkFailuresForTests(); });
afterEach(() => { __setParseWorkerFactoryForTests(undefined); vi.restoreAllMocks(); });

describe('labs from the command list', () => {
  for (const id of ['analyse.terrainAccess', 'analyse.observatory']) {
    it(`${id} shows a toast with Try again and no URL`, async () => {
      const calls: { m: string; a?: { label: string } }[] = [];
      const actions = contributeAnalysisActions({
        terrainAnalysisEntry: { showPanel: async () => ({}) } as never,
        observatoryEntry: {} as never,
        buildCurrentStoryInputs: () => ({}) as never,
        showLassoToast: { show: (m, a) => { calls.push({ m, a }); } },
      });
      actions.find((a) => a.id === id)!.run();
      await tick();
      expect(calls).toHaveLength(1);
      expect(calls[0].m).not.toContain('http');
      expect(calls[0].a?.label).toBe('Try again');
    });
  }
});

describe('the Measurements panel chunk fails', () => {
  const build = () => {
    const toast = vi.fn();
    const measure = new Proxy({
      onClearAll: null as null | ((r: unknown[]) => void),
      holdChange: (f: () => boolean) => f(),
      restoreMeasurement: vi.fn(() => true),
      removeMeasurement: vi.fn(() => ({ measurement: { name: 'Distance 1' } })),
      getSummaries: () => [],
      getMeasurements: () => [],
      drafting: false,
    } as Record<string, unknown>, { get: (t, k: string) => (k in t ? t[k] : () => {}), set: (t, k: string, v) => { t[k] = v; return true; } }) as unknown as { onClearAll: (r: unknown[]) => void; restoreMeasurement: ReturnType<typeof vi.fn> };
    const viewer = { measure, measureMode: false, layerProjectOffset: () => null, alignUpToLayer() {} };
    const mount = createMeasurePanelMount({
      getViewer: () => viewer as never,
      crsService: {} as never,
      getExportPanel: () => ({ refresh: () => {} }),
      exportSession: () => undefined,
      handleFile: () => undefined,
      recordUsage: () => {},
      toast,
    });
    return { toast, measure, mount };
  };
  const src = { clouds: () => [], cloud: () => undefined, activeId: () => null, stableIdFor: () => null } as never;

  it('Clear still offers Undo, with no panel', () => {
    const { toast, measure, mount } = build();
    mount.bindUnitFrames(src);
    measure.onClearAll([{}, {}]);
    expect(toast).toHaveBeenCalledWith('Deleted 2 measurements.', expect.objectContaining({ label: 'Undo' }));
    toast.mock.calls[0][1].onClick();
    expect(measure.restoreMeasurement).toHaveBeenCalledTimes(2);
  });

  it('a Delete still offers Undo', async () => {
    const { toast, mount } = build();
    expect(mount.deleteMeasurement('m1')).toBe(true);
    await tick(); await tick();
    expect(toast.mock.calls.some((c) => c[1]?.label === 'Undo')).toBe(true);
  });

  it('says once that the list could not load, however often it is refreshed', async () => {
    const { toast, mount } = build();
    mount.refresh(); await tick();
    mount.refresh(); await tick();
    const said = toast.mock.calls.filter((c) => /Measurements list could not load/.test(c[0]));
    expect(said).toHaveLength(1);
    expect(said[0][0]).toMatch(/Your measurements are kept/);
  });
});

describe('terrain analysis run', () => {
  it('names the reload and shows no URL', () => {
    const text = terrainFailureStatus(chunk.err(), true);
    expect(text).toMatch(/did not run.*Reload the page/);
    expect(text).not.toContain('http');
    expect(terrainFailureStatus(chunk.err(), false)).toMatch(/offline/);
    expect(terrainFailureStatus(new Error('no ground'), true)).toBe('Analysis failed: no ground');
  });
});

describe('a parse worker that lost a chunk', () => {
  class ErrWorker {
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: unknown = null;
    terminate = vi.fn();
    readonly error: string;
    constructor(error: string) { this.error = error; }
    postMessage(): void { queueMicrotask(() => this.onmessage?.({ data: { type: 'error', error: this.error } } as MessageEvent)); }
  }
  const go = async (error: string) => {
    const w = new ErrWorker(error);
    __setParseWorkerFactoryForTests(() => w as unknown as Worker);
    await expect(decodeFullViaWorker(new ArrayBuffer(8), 'a.las')).rejects.toThrow();
    return w;
  };
  it('is replaced, so the next open can refetch', async () => {
    expect((await go('Failed to fetch dynamically imported module: x')).terminate).toHaveBeenCalled();
  });
  it('is kept after an ordinary file error', async () => {
    expect((await go('corrupt header')).terminate).not.toHaveBeenCalled();
  });
});

describe('wiring read from the source', () => {
  const read = (p: string): string => readFileSync(resolve(__dirname, p), 'utf8');
  it('the shell wires the open-work check, the notice, the net, and the performance toast', () => {
    const main = read('../src/main.ts');
    expect(main).toContain('hasOpenWork: () => loading || (viewerReady && hasScan())');
    expect(main).toContain('onStaleWithWork: makeStaleWithWorkHandler(chunkSurface)');
    expect(main).toContain('installChunkFailureNet(window');
    expect(main).toMatch(/mountQualityControl\(stage, \{\s*toast:/);
  });
  it('Save session from a press is guarded, and the guards keep the rejecting one', () => {
    const main = read('../src/main.ts');
    expect(main.match(/exportSession: saveSessionFromUser/g)).toHaveLength(2);
    expect(main).toContain('saveSession: exportSession');
  });
  it('the header forwards the toast', () => {
    expect(read('../src/ui/headerControls.ts')).toContain('toast: deps.toast');
  });
  it('the analysis contributor gets the toast', () => {
    expect(read('../src/app/actionDefinitions.ts')).toContain('showLassoToast: { show: deps.showLassoToast }');
  });
});
