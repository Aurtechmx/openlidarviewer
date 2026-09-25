/**
 * measurePanelWorkbenchDock.test.ts
 *
 * The docked workbench as the Measurements-panel mount actually wires it: a
 * real MeasurePanel, the real launcher, the real dock, and a scene seam over a
 * stand-in profile seam.
 *
 * Two things are pinned that no smaller piece can pin on its own.
 *
 *   - The mount hands the presenter the corridor GENERATOR. Running the walk
 *     to completion instead freezes the app with the dock already mounted and
 *     empty, and that is invisible to anything that only checks the result.
 *   - The dock is closed on the two events that make its plot a picture of a
 *     scene nobody is looking at any more: the measurement is deleted, and a
 *     scan is loaded. A dock left behind keeps its `calc(100% - Npx)` claim on
 *     the stage over an unrelated scene.
 *
 * Node environment, per-test recording DOM stub, the convention the other
 * MeasurePanel suites use. No jsdom.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { createMeasurePanelMount } from '../src/app/measurePanelMount';
import { SLICE_BUDGET_MS } from '../src/app/profileWorkbenchSection';
import type { MeasurementSummary } from '../src/render/measure/MeasureController';
import type { ProfileChartSample } from '../src/render/measure/types';
import type { ProfileSectionResult } from '../src/render/measure/profileSectionSeam';

import { FakeEl, installFakeDom, uninstallFakeDom } from './support/measurePanelDom';

/** Frames the presenter asked for, run only when a test says so. */
let frames: (() => void)[] = [];

beforeEach(() => {
  frames = [];
  installFakeDom({ ns: true, docListeners: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.requestAnimationFrame = (fn: () => void): number => frames.push(fn);
  g.window = {
    innerWidth: 1440,
    innerHeight: 900,
    devicePixelRatio: 1,
    matchMedia: () => ({ matches: false }),
  };
});

afterEach(() => {
  uninstallFakeDom();
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.requestAnimationFrame;
  delete g.window;
});

/** A section over a handful of returns, enough to describe and draw. */
function tinySection(count = 32): ProfileSectionResult {
  const chainage = new Float32Array(count);
  const height = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    chainage[i] = i;
    height[i] = i * 0.25;
  }
  return {
    points: {
      count,
      chainage,
      height,
      lateralOffset: new Float32Array(count),
      sourceSlot: new Uint16Array(count),
      pointIndex: new Uint32Array(count),
      channelPresence: new Uint8Array(count),
    },
    frame: null as never,
    band: 1.5,
    scope: 'static' as never,
    scopeLabel: 'One loaded layer.',
    classificationOnEverySource: true,
    streamingComplete: null,
    sources: [],
    generation: 1,
    aborted: false,
    skippedSlots: [],
    examined: count,
    withheld: { sourcePoints: count, withheldExcluded: 0, analysedPoints: count },
  };
}

/** A profile row with enough samples for the chart strip (and its Expand). */
function profileSummary(id = 'p1', name = 'Section A'): MeasurementSummary {
  const profileChart: ProfileChartSample[] = [];
  for (let i = 0; i < 8; i++) {
    profileChart.push({ distance: i * 10, height: 100 + i * 0.5, count: 12 });
  }
  return { id, kind: 'profile', name, value: '70.00 m', profileChart };
}

interface Rig {
  readonly mount: ReturnType<typeof createMeasurePanelMount>;
  readonly appRoot: FakeEl;
  readonly stageEl: FakeEl;
  readonly section: ReturnType<typeof vi.fn>;
  readonly sectionChunks: ReturnType<typeof vi.fn>;
  readonly removed: string[];
  /** Chunks the fake seam has been asked for. */
  chunks(): number;
}

/**
 * The mount, wired to a stand-in scene.
 *
 * `chunkCount` chunks are yielded, each holding the thread past the slice
 * budget, so a walk that is genuinely spread across frames cannot finish
 * inside the first slice and a walk that is not, does.
 */
function rig(chunkCount = 2): Rig {
  const appRoot = new FakeEl('div');
  appRoot.clientHeight = 900;
  const stageEl = new FakeEl('div');
  appRoot.append(stageEl);

  let pulled = 0;
  const section = vi.fn(() => tinySection());
  const sectionChunks = vi.fn(function* (): Generator<number, ProfileSectionResult | null, void> {
    for (let i = 0; i < chunkCount; i++) {
      const from = Date.now();
      // Past the budget, deterministically: the presenter must hand the thread
      // back rather than carry on to the end of the scene.
      while (Date.now() - from <= SLICE_BUDGET_MS) {
        /* hold the slice */
      }
      pulled++;
      yield pulled * 1000;
    }
    return tinySection();
  });

  const removed: string[] = [];
  const measurements = [
    { id: 'p1', kind: 'profile', name: 'Section A', points: [[0, 0, 0], [70, 0, 0]] },
  ];
  const viewer = {
    measure: {
      datumResolved: false,
      worldUp: [0, 0, 1],
      unitToMetres: 1,
      verticalUnitToMetres: 1,
      unitSystem: 'metric',
      getMeasurements: () => measurements,
      getSummaries: () => [profileSummary()],
      removeMeasurement: (id: string) => void removed.push(id),
      renameMeasurement: () => {},
      resampleProfile: () => {},
      setHoveredStation: () => false,
    },
    measureMode: false,
    clouds: () => [{}],
    profileSeam: { section, sectionChunks },
    requestFrame: () => {},
  };

  const mount = createMeasurePanelMount({
    getViewer: () => viewer as never,
    crsService: {
      context: () => ({ linearUnitKnown: true, linearUnitToMetres: 1 }),
      current: () => null,
    } as never,
    getExportPanel: () => ({ refresh: () => {} }),
    exportSession: () => {},
    handleFile: () => {},
    recordUsage: () => {},
    workbenchStage: { root: stageEl as unknown as HTMLElement },
  });

  return { mount, appRoot, stageEl, section, sectionChunks, removed, chunks: () => pulled };
}

/**
 * Wait for `done`, one macrotask at a time.
 *
 * Expand answers through two chained dynamic imports, and the panel's own
 * handler is fire-and-forget, so there is no promise a caller can await.
 */
async function settleUntil(done: () => boolean, ticks = 500): Promise<void> {
  for (let i = 0; i < ticks && !done(); i++) await new Promise((r) => setTimeout(r, 0));
}

const dockOf = (r: Rig): FakeEl | null => r.appRoot.querySelector('section.olv-workbench');

/** Mount the panel, press Expand on its profile row, and let the dock mount. */
async function openDock(r: Rig): Promise<void> {
  await r.mount.ensure();
  const panel = r.mount.panel!;
  const expand = (panel.element as unknown as FakeEl).querySelector('button.olv-mp-chart-expand');
  expect(expand).not.toBeNull();
  expand!.dispatchEvent({ type: 'click', stopPropagation: () => {} });
  await settleUntil(() => dockOf(r) !== null);
  expect(dockOf(r)).not.toBeNull();
}
const statusOf = (r: Rig): string =>
  dockOf(r)?.querySelector('div.olv-workbench-status')?.textContent ?? '';

describe('the mount hands the presenter the corridor generator', () => {
  it('walks the corridor in chunks and never calls the run-to-completion seam', async () => {
    const r = rig(2);
    await openDock(r);

    expect(r.sectionChunks).toHaveBeenCalledTimes(1);
    expect(r.section).not.toHaveBeenCalled();
    const request = r.sectionChunks.mock.calls[0]![0] as { chunkSize: number; signal: unknown };
    expect(request.chunkSize).toBeGreaterThan(0);
    expect(request.signal).toBeDefined();

    // The dock is mounted, sized and saying what it is doing, with the walk
    // still outstanding: the extraction did not run to the end in one pass.
    expect(dockOf(r)).not.toBeNull();
    expect(r.stageEl.style.height).toMatch(/^calc\(100% - \d+px\)$/);
    expect(r.chunks()).toBe(1);
    expect(frames).toHaveLength(1);
    expect(statusOf(r)).toBe('Reading the returns inside this corridor.');

    while (frames.length > 0) frames.shift()!();
    expect(r.chunks()).toBe(2);
    expect(statusOf(r)).toBe('Showing 32 returns.');
  });
});

describe('the dock does not outlive what it is a section of', () => {
  it('closes when the measurement it plots is deleted, and hands the stage back', async () => {
    const r = rig(1);
    await openDock(r);
    while (frames.length > 0) frames.shift()!();
    expect(dockOf(r)).not.toBeNull();

    const del = (r.mount.panel!.element as unknown as FakeEl).querySelector('button.olv-mp-del');
    expect(del).not.toBeNull();
    del!.dispatchEvent({ type: 'click' });

    expect(r.removed).toEqual(['p1']);
    expect(dockOf(r)).toBeNull();
    expect(r.stageEl.style.height).toBe('');
  });

  it('closes on a scan load, which is the call every reveal makes', async () => {
    const r = rig(1);
    await openDock(r);
    while (frames.length > 0) frames.shift()!();
    expect(dockOf(r)).not.toBeNull();

    await r.mount.ensure();
    expect(dockOf(r)).toBeNull();
    expect(r.stageEl.style.height).toBe('');
  });

  it('closes when the session resets to the empty state', async () => {
    const r = rig(1);
    await openDock(r);
    while (frames.length > 0) frames.shift()!();
    r.mount.hide();
    expect(dockOf(r)).toBeNull();
    expect(r.stageEl.style.height).toBe('');
  });
});
