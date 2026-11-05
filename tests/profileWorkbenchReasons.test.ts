/**
 * The Profile Workbench says why when it shows no chart, no dock or no plot:
 * scans with no proven shared datum, a narrow window, a failed mount and a
 * section read that threw.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { sharedDatumRefusal } from '../src/render/integrableClouds';
import { createProfileWorkbenchLauncher } from '../src/app/profileWorkbenchLauncher';
import { emptySectionStatus, presentWorkbenchSection } from '../src/app/profileWorkbenchSection';
import { createProfileSectionSeam } from '../src/render/measure/profileSectionSeam';
import { installFakeDom } from './support/measurePanelDom';

const scan = (compatibility: string, visible = true) => ({ mesh: { visible }, locked: false, compatibility, mounted: true }) as never;

describe('sharedDatumRefusal', () => {
  it('names the reason only when several scans are shown and none can be merged', () => {
    expect(sharedDatumRefusal([scan('unverified'), scan('unverified')])).toBe(
      'No chart: the visible scans have no proven shared vertical datum. Hide all but one, then draw the profile again.',
    );
    expect(sharedDatumRefusal([scan('unverified')])).toBeNull();
    expect(sharedDatumRefusal([scan('unverified'), scan('unverified', false)])).toBeNull();
    expect(sharedDatumRefusal([scan('verified'), scan('verified')])).toBeNull();
  });
});

describe('launcher', () => {
  const request = { id: 'p', kind: 'profile', name: 'P' };
  const stage = (dock: boolean) => ({ host: () => ({}) as never, canDock: () => dock, release: vi.fn() });

  it('tells the host when the window is too narrow to dock', async () => {
    const onCannotDock = vi.fn();
    const l = createProfileWorkbenchLauncher({ load: vi.fn(), stage: stage(false), onCannotDock } as never);
    expect(await l.open(request as never)).toBe(false);
    expect(onCannotDock).toHaveBeenCalledTimes(1);
  });

  it('reports a mount that throws, hands the stage back and answers false', async () => {
    const onPresentFailure = vi.fn();
    const s = stage(true);
    const l = createProfileWorkbenchLauncher({
      load: async () => ({ mountProfileWorkbench: () => { throw new Error('boom'); } }),
      stage: s,
      onPresentFailure,
    } as never);
    await expect(l.open(request as never)).resolves.toBe(false);
    expect(onPresentFailure).toHaveBeenCalledTimes(1);
    expect(s.release).toHaveBeenCalled();
  });
});

describe('a section read that throws', () => {
  it('replaces the working status with a reason', () => {
    const status: string[] = [];
    const handle = { canvas: {}, setScope: () => {}, setGroundBasis: () => {}, setStatus: (t: string) => status.push(t), setDetail: () => {} };
    const scene = {
      profile: () => ({ a: [0, 0, 0], b: [1, 0, 0] }),
      sectionChunks: function* () { yield 1; throw new Error('boom'); },
    };
    const raf = vi.fn((f: () => void) => { f(); return 1; });
    (globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = raf;
    (globalThis as unknown as { window: unknown }).window = { requestAnimationFrame: raf, setTimeout: (f: () => void) => { f(); return 1; } };
    presentWorkbenchSection(handle as never, 'p', scene as never);
    expect(status.at(-1)).toBe('The section could not be read. Close the workbench and open it again.');
  });
});

describe('wiring', () => {
  const mount = readFileSync(new URL('../src/app/measurePanelMount.ts', import.meta.url), 'utf8');
  it('turns a load failure and a narrow window into a toast', () => {
    expect(mount).toContain("'The Profile Workbench could not open, so this shows the focus view. Reload the page to try again.'");
    expect(mount).toContain("'The Profile Workbench needs a wider window, so this shows the focus view.'");
  });
  it('the shelf says why a profile has nothing to open', () => {
    expect(readFileSync(new URL('../src/app/results/resultsShelf.ts', import.meta.url), 'utf8')).toContain('it has no chart. Its row on the Measure page says why.');
  });
});

describe('scans left out of a section', () => {
  it('the seam counts visible scans it could not merge', () => {
    const l = (id: string, compatibility: string) => ({ id, mesh: { visible: true }, compatibility, positions: new Float32Array([1, 0, 5]), channels: null, bounds: null, placement: null }) as never;
    const seam = createProfileSectionSeam({ layers: () => [l('a', 'unverified'), l('b', 'unverified')], residentNodes: () => [], streamingMayCombine: () => false, worldUp: () => [0, 0, 1], streamingCoverage: () => null } as never);
    const walk = seam.sectionChunks({ a: [0, 0, 0], b: [2, 0, 0], corridorWidth: 2, chunkSize: 100, signal: { aborted: false } } as never);
    let step = walk.next();
    while (!step.done) step = walk.next();
    expect(step.value?.points.count).toBe(0);
    expect(step.value?.leftOutScans).toBe(2);
  });

  it('the status names them instead of blaming the corridor', () => {
    expect(emptySectionStatus(2)).toBe('No returns to show: 2 visible scans were left out, with no proven shared vertical datum. Hide all but one to section it.');
    expect(emptySectionStatus(1)).toBe('No returns to show: 1 visible scan was left out, with no proven shared vertical datum. Hide all but one to section it.');
    expect(emptySectionStatus(0)).toBe('No returns fell inside this corridor.');
    expect(emptySectionStatus(undefined)).toBe('No returns fell inside this corridor.');
  });
});

describe('the row of a profile with no chart', () => {
  it('carries the reason from draw time to the summary', async () => {
    installFakeDom({ ns: true });
    (globalThis as { window?: unknown }).window ??= { addEventListener: () => {}, removeEventListener: () => {} };
    const { MeasureController } = await import('../src/render/measure/MeasureController');
    const measure = new MeasureController({ onExit: () => {} } as never);
    measure.setProfileSampler(() => null);
    measure.profileChartRefusal = () => 'No chart: reason.';
    const inner = measure as unknown as { _draft: unknown; _newDraft(): { points: number[][] }; _commitDraft(): void };
    measure.setActive(true);
    measure.setKind('profile');
    const d = inner._newDraft();
    d.points = [[0, 0, 0], [3, 0, 0]];
    inner._draft = d;
    measure.finishCurrent();
    expect(measure.getSummaries()[0]!.profileChartWithheld).toBe('No chart: reason.');
    measure.dispose();
  });

  it('forgets the reason on delete, Clear and import, and an Undo brings it back', async () => {
    const { MeasureController } = await import('../src/render/measure/MeasureController');
    const measure = new MeasureController({ onExit: () => {} } as never);
    measure.setProfileSampler(() => null);
    measure.profileChartRefusal = () => 'No chart: reason.';
    const inner = measure as unknown as { _draft: unknown; _newDraft(): { points: number[][] }; _chartWithheld: Map<string, string> };
    measure.setActive(true);
    measure.setKind('profile');
    const draw = () => { const d = inner._newDraft(); d.points = [[0, 0, 0], [3, 0, 0]]; inner._draft = d; measure.finishCurrent(); };
    draw();
    const id = measure.getMeasurements()[0]!.id;
    const removed = measure.removeMeasurement(id)!;
    expect(inner._chartWithheld.size).toBe(0);
    expect(measure.restoreMeasurement(removed)).toBe(true);
    expect(measure.getSummaries()[0]!.profileChartWithheld).toBe('No chart: reason.');
    let cleared: Parameters<NonNullable<typeof measure.onClearAll>>[0] = [];
    measure.onClearAll = (r) => { cleared = r; };
    measure.clear();
    expect(inner._chartWithheld.size).toBe(0);
    measure.restoreMeasurement(cleared[0]!);
    expect(measure.getSummaries()[0]!.profileChartWithheld).toBe('No chart: reason.');
    measure.loadMeasurements([]);
    expect(inner._chartWithheld.size).toBe(0);
    measure.dispose();
  });

  it('the panel shows it', () => {
    expect(readFileSync(new URL('../src/ui/MeasurePanel.ts', import.meta.url), 'utf8')).toMatch(/if \(s\.profileChartWithheld\) breakdownEls\.push/);
  });
});
