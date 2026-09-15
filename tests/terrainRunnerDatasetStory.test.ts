/**
 * terrainRunnerDatasetStory.test.ts
 *
 * The runner mounts the Dataset Story on the Analyse panel as soon as a scan
 * gathers, and again once the result lands, because the analysis is itself one
 * of the story's inputs. It reduces the host's canonical inputs with
 * `buildScanStory` and never derives a fitness of its own.
 *
 * A host that wires no input builder gets the runner it had before: no story,
 * and no failed call.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createTerrainAnalysisRunner } from '../src/app/terrainAnalysisRunner';
import { clearTerrainCoreCache } from '../src/terrain/contour/terrainCoreCache';
import type { Viewer } from '../src/render/Viewer';
import type { AnalysePanel } from '../src/ui/AnalysePanel';
import type { CrsService } from '../src/geo/CrsService';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import type { ScanStoryInputs } from '../src/intelligence/scanStory';

class FakeEl {
  className = '';
  private _text = '';
  readonly children: FakeEl[] = [];
  readonly dataset: Record<string, string> = {};
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  setAttribute(): void { /* no-op */ }
  set textContent(v: string) { this._text = v; }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  append(...kids: FakeEl[]): void { this.children.push(...kids.filter(Boolean)); }
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
});

function plane(): Float32Array {
  const pts: number[] = [];
  for (let x = 0; x < 20; x += 1) for (let y = 0; y < 20; y += 1) pts.push(x, y, 0.02 * x + 0.01 * y);
  return Float32Array.from(pts);
}

const resolved = { kind: 'projected', name: 'Test / metre grid', linearUnit: 'metre', linearUnitToMetres: 1, verticalUnitToMetres: 1 } as const;

const INPUTS: ScanStoryInputs = {
  captureLabel: 'Aerial / airborne ALS',
  pointCount: 15_700_000,
  areaM2: 1_000_000,
  surfaceTier: 'Good',
  products: [{ label: 'Profiles', status: 'Ready' }],
  density: 'dense',
  groundVisibility: 'good',
  coverageMode: 'full',
  crsKnown: true,
  datumKnown: true,
  classification: 'source',
};

function harness(buildStoryInputs?: () => ScanStoryInputs) {
  const mounted: (FakeEl | null)[] = [];
  const cloud = {
    sourceOrigin: [500_000, 4_500_000, 0] as [number, number, number],
    bounds: () => ({ min: [0, 0, 0] as [number, number, number], max: [2_000, 2_000, 100] as [number, number, number] }),
  };
  const fakeViewer = {
    gatherTerrainPositions: () => ({ positions: plane(), classification: undefined, groundIsDerived: false, residentOnly: false, sampled: false, totalPoints: plane().length / 3, sourceUpAxis: 'z' as const }),
    getCloud: () => cloud,
    streamingCloud: null,
    clouds: () => [cloud],
  } as unknown as Viewer;
  const fakePanel = {
    isVisible: () => true, setBusy: () => {}, setStatus: () => {}, update: () => {},
    setContourFrame: () => {},
    setDatasetStory: (e: unknown) => mounted.push(e as FakeEl | null),
  } as unknown as AnalysePanel;
  const context = spatialContextFrom(resolved as unknown as Parameters<typeof spatialContextFrom>[0]);
  const fakeCrs: Pick<CrsService, 'current' | 'context' | 'crsRevision'> = {
    crsRevision: () => 0,
    current: () => resolved as unknown as ReturnType<CrsService['current']>,
    context: () => context,
  };
  const runner = createTerrainAnalysisRunner({
    getViewer: () => fakeViewer,
    getAnalysePanel: () => fakePanel,
    getActiveId: () => 'scan-1',
    crsService: fakeCrs,
    buildStoryInputs,
  });
  return { runner, mounted };
}

describe('the runner mounts the Dataset Story on the panel', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => warnSpy.mockRestore());

  it('renders the card from the host inputs when a scan gathers, and again on the result', async () => {
    clearTerrainCoreCache();
    const { runner, mounted } = harness(() => INPUTS);
    await runner.run();
    expect(mounted.length).toBeGreaterThanOrEqual(2);
    const card = mounted[0]!;
    expect(card.textContent).toContain('Dataset Story');
    expect(card.textContent).toContain('Aerial / airborne ALS');
  });

  it('a host that wires no builder gets no story and no failure', async () => {
    clearTerrainCoreCache();
    const { runner, mounted } = harness();
    await runner.run();
    expect(mounted).toHaveLength(0);
  });

  it('a failing input builder costs the analysis nothing', async () => {
    clearTerrainCoreCache();
    const { runner, mounted } = harness(() => { throw new Error('no facts yet'); });
    await expect(runner.run()).resolves.toBeUndefined();
    expect(mounted).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
  });
});
