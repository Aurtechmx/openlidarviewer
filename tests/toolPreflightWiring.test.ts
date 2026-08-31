/**
 * toolPreflightWiring.test.ts — the tool preflight, wired to the running app.
 *
 * `tests/toolPreflight.test.ts` pins the MODEL. This pins the WIRING: that live
 * app state assembles into the input the model reads, that a limited tool says
 * why on the surface the user meets it, that the remediation the model names
 * reaches a real app action, and that a tool nothing limits is left alone.
 *
 * The honesty property under test throughout: the panel shows the model's own
 * status word and the model's own sentence. It may not upgrade a verdict, and it
 * may not write a reason of its own.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import type { CrsInfo } from '../src/io/crs';
import type { PreflightInput } from '../src/process/toolPreflight';
import { preflightFor, toolMeasurementKind } from '../src/process/toolPreflight';
import { buildPreflightInput, preflightSnapshot } from '../src/app/toolPreflightInput';
import {
  UNPERFORMABLE_ACTIONS,
  createPreflightActionRunner,
  type PreflightActionHost,
} from '../src/app/preflightActions';
import type { ProcessStudioShell, StudioViewer } from '../src/app/processStudioMount';

// ─────────────────────────────────────────────────────────────────────────────
// A recording DOM, enough for the panel (which is DOM-only) to build in node.
// ─────────────────────────────────────────────────────────────────────────────

class FakeEl {
  className = '';
  title = '';
  type = '';
  hidden = false;
  open = false;
  innerHTML = '';
  readonly dataset: Record<string, string> = {};
  readonly children: FakeEl[] = [];
  private _text = '';
  private readonly _listeners: Record<string, Array<() => void>> = {};
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  set textContent(v: string) { this._text = v; }
  get textContent(): string { return this._text; }
  setAttribute(): void { /* aria-label — unused by assertions */ }
  append(...kids: FakeEl[]): void { this.children.push(...kids.filter(Boolean)); }
  replaceChildren(...kids: FakeEl[]): void { this.children.length = 0; this.children.push(...kids); }
  addEventListener(type: string, fn: () => void): void {
    (this._listeners[type] ??= []).push(fn);
  }
  click(): void { for (const fn of this._listeners.click ?? []) fn(); }
  blur(): void { /* focus handling is not modelled */ }
  querySelector(sel: string): FakeEl | null {
    const cls = sel.replace(/^\./, '');
    const walk = (n: FakeEl): FakeEl | null => {
      for (const c of n.children) {
        if (c.className.split(' ').includes(cls)) return c;
        const hit = walk(c);
        if (hit) return hit;
      }
      return null;
    };
    return walk(this);
  }
  collect(cls: string, out: FakeEl[] = []): FakeEl[] {
    for (const c of this.children) {
      if (c.className.split(' ').includes(cls)) out.push(c);
      c.collect(cls, out);
    }
    return out;
  }
  text(cls: string): string[] {
    return this.collect(cls).map((n) => n.textContent);
  }
}

let createProcessStudioFromShell: typeof import('../src/app/processStudioMount').createProcessStudioFromShell;

beforeAll(async () => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
  ({ createProcessStudioFromShell } = await import('../src/app/processStudioMount'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** A projected metre CRS with an orthometric vertical datum — nothing unknown. */
const KNOWN_CRS = {
  source: 'epsg',
  name: 'WGS 84 / UTM zone 12N',
  epsg: 32612,
  linearUnit: 'metre',
  linearUnitToMetres: 1,
  isGeographic: false,
  verticalEpsg: 5703,
  verticalDatum: 'NAVD88',
  verticalUnitToMetres: 1,
} as unknown as CrsInfo;

interface FakeShellOptions {
  readonly crs?: CrsInfo | null;
  readonly datumResolved?: boolean;
  readonly classCodes?: readonly number[];
  readonly classificationDerived?: boolean;
  /** Extra loaded layers beside the active one, as [id, pointCount]. */
  readonly companions?: ReadonlyArray<readonly [string, number]>;
  readonly companionCrs?: CrsInfo | null;
  readonly noScan?: boolean;
}

/** What the shell was asked to do — the far end of every remediation. */
interface Performed {
  focusCrs: number;
  focusLayers: number;
  solo: string[];
  classify: number;
  addDataset: number;
  measureMode: boolean[];
  kinds: string[];
}

function fakeShell(options: FakeShellOptions = {}): { shell: ProcessStudioShell; done: Performed } {
  const done: Performed = { focusCrs: 0, focusLayers: 0, solo: [], classify: 0, addDataset: 0, measureMode: [], kinds: [] };
  const companions = options.companions ?? [];
  const viewer: StudioViewer = {
    streamingCloud: null,
    clouds: () => ['active', ...companions.map(([id]) => id)],
    getCloud: (id) => {
      if (id === 'active') return { name: 'active.laz', pointCount: 1_000_000, metadata: { crs: options.crs ?? null } };
      const hit = companions.find(([cid]) => cid === id);
      return hit ? { name: `${hit[0]}.laz`, pointCount: hit[1], metadata: { crs: options.companionCrs ?? null } } : undefined;
    },
    measure: {
      datumResolved: options.datumResolved === true,
      setKind: (kind) => { done.kinds.push(kind); },
    },
    setMeasureMode: (on) => { done.measureMode.push(on); },
  };
  const crs = options.crs ?? null;
  const shell: ProcessStudioShell = {
    getViewer: () => viewer,
    getActiveCloud: () => (options.noScan ? null : { pointCount: 1_000_000 }),
    getActiveLayerId: () => (options.noScan ? null : 'active'),
    crsService: {
      current: () => crs,
      context: () => spatialContextFrom(crs),
    },
    classLegend: {
      presentCodes: () => options.classCodes ?? [],
      classificationIsDerived: () => options.classificationDerived === true,
    },
    resolveLayerCrs: (_name, detected) => detected ?? null,
    soloLayer: (id) => { done.solo.push(id); },
    classifyScan: () => { done.classify += 1; },
    focusCrs: () => { done.focusCrs += 1; },
    focusLayers: () => { done.focusLayers += 1; },
    addDataset: () => { done.addDataset += 1; },
  };
  return { shell, done };
}

/** The panel's row for a label, from either the products or the tools list. */
function row(panel: { element: unknown }, cls: string, label: string): FakeEl | undefined {
  const root = panel.element as unknown as FakeEl;
  return root.collect(cls).find((li) => li.collect('olv-ps-name').some((s) => s.textContent === label));
}
const badge = (r: FakeEl): string => r.collect('olv-ps-badge')[0]?.textContent ?? '';
const reason = (r: FakeEl): string => r.collect('olv-ps-reason')[0]?.textContent ?? '';
const buttons = (r: FakeEl): FakeEl[] => r.collect('olv-ps-remedy');
const advice = (r: FakeEl): string[] => r.text('olv-ps-advice');

/**
 * Mount the studio over a fake shell and wait for the preflight to land. The
 * model rides a lazy chunk, so the panel paints twice: once from the single-scan
 * service alone, then again with the preflight's verdicts and remediations.
 */
async function mounted(shell: ProcessStudioShell): Promise<ReturnType<typeof createProcessStudioFromShell>> {
  const studio = createProcessStudioFromShell(shell);
  studio.refresh();
  await vi.waitFor(() => {
    const root = studio.panel.element as unknown as FakeEl;
    expect(root.collect('olv-ps-tool').length).toBeGreaterThan(0);
  });
  return studio;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Live state → the model's input
// ─────────────────────────────────────────────────────────────────────────────

describe('building the preflight input from live state', () => {
  it('puts the active scan first, with every loaded layer behind it', () => {
    const { shell } = fakeShell({ crs: KNOWN_CRS, companions: [['epoch-b', 500_000]], companionCrs: KNOWN_CRS });
    createProcessStudioFromShell(shell).refresh(); // exercises the same reads the panel uses
    const input = buildPreflightInput({
      getActiveSignals: () => ({ kind: 'static', pointCount: 1_000_000, crs: KNOWN_CRS }),
      getSpatialContext: () => spatialContextFrom(KNOWN_CRS),
      getCompanionSignals: () => [{ kind: 'static', pointCount: 500_000, crs: KNOWN_CRS }],
      getDatumResolved: () => true,
    }) as PreflightInput;
    expect(input.scans).toHaveLength(2);
    expect(input.scans[0].pointCount).toBe(1_000_000);
    expect(input.datumResolved).toBe(true);
  });

  it('reads no scan as no scan, so every tool is blocked rather than assumed ready', () => {
    const input = buildPreflightInput({
      getActiveSignals: () => null,
      getSpatialContext: () => spatialContextFrom(null),
      getCompanionSignals: () => [],
      getDatumResolved: () => false,
    }) as PreflightInput;
    expect(input.scans).toHaveLength(0);
    expect(preflightFor('measure-distance', input).status).toBe('blocked');
  });

  it('degrades a throwing live read instead of propagating it', () => {
    const input = buildPreflightInput({
      getActiveSignals: () => { throw new Error('viewer not ready'); },
      getSpatialContext: () => spatialContextFrom(KNOWN_CRS),
      getCompanionSignals: () => { throw new Error('no clouds'); },
      getDatumResolved: () => { throw new Error('no controller'); },
    }) as PreflightInput;
    expect(input.scans).toHaveLength(0);
    expect(input.datumResolved).toBe(false);
  });

  it('says nothing at all when the frame description cannot be read', () => {
    // An empty snapshot is "no verdict", which the panel renders as no rows —
    // never as a permissive one.
    expect(
      preflightSnapshot({
        getActiveSignals: () => ({ kind: 'static', pointCount: 10 }),
        getSpatialContext: () => { throw new Error('no crs service'); },
        getCompanionSignals: () => [],
        getDatumResolved: () => true,
      }),
    ).toEqual([]);
  });

  it('omits layer compatibility, so several layers read as unproven, never compatible', () => {
    const input = buildPreflightInput({
      getActiveSignals: () => ({ kind: 'static', pointCount: 10, crs: KNOWN_CRS }),
      getSpatialContext: () => spatialContextFrom(KNOWN_CRS),
      getCompanionSignals: () => [{ kind: 'static', pointCount: 10, crs: KNOWN_CRS }],
      getDatumResolved: () => true,
    }) as PreflightInput;
    expect(input.layerCompatibility).toBeUndefined();
    const p = preflightFor('measure-distance', input);
    expect(p.status).toBe('review');
    expect(p.reasons.map((r) => r.code)).toContain('SHARED_REFERENCE_UNPROVEN');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Remediations reach an action — or say they cannot
// ─────────────────────────────────────────────────────────────────────────────

describe('remediation dispatch', () => {
  const host: PreflightActionHost = {
    openCoordinateSystem: () => {},
    inspectLayerCrs: () => {},
    soloActiveLayer: () => {},
    classifyScan: () => {},
    armMeasurement: () => {},
    addDataset: () => {},
  };

  it('carries out every action a host can perform', () => {
    const runner = createPreflightActionRunner(host);
    expect(runner.canRun('set-coordinate-system', 'measure-volume')).toBe(true);
    expect(runner.canRun('inspect-layer-crs', 'measure-area')).toBe(true);
    expect(runner.canRun('solo-active-layer', 'measure-area')).toBe(true);
    expect(runner.canRun('classify-scan', 'terrain-dtm')).toBe(true);
  });

  it('runs "load a second scan" through the host, which opens the add-dataset picker', () => {
    const { shell, done } = fakeShell();
    const runner = createPreflightActionRunner({ addDataset: () => shell.addDataset() });
    expect(runner.canRun('load-second-scan', 'cross-epoch-change')).toBe(true);
    expect(runner.run('load-second-scan', 'cross-epoch-change')).toBe(true);
    expect(done.addDataset).toBe(1);
  });

  it('reports "load a second scan" unavailable when the host cannot add one', () => {
    const runner = createPreflightActionRunner({});
    expect(runner.canRun('load-second-scan', 'cross-epoch-change')).toBe(false);
    expect(runner.run('load-second-scan', 'cross-epoch-change')).toBe(false);
  });

  it('offers "continue" only for a measurement, where proceeding is a real action', () => {
    const runner = createPreflightActionRunner(host);
    expect(toolMeasurementKind('measure-volume')).toBe('volume');
    expect(runner.canRun('continue-exploratory', 'measure-volume')).toBe(true);
    expect(toolMeasurementKind('contours')).toBeNull();
    expect(runner.canRun('continue-exploratory', 'contours')).toBe(false);
  });

  it('refuses the actions no host can perform, and runs nothing', () => {
    const runner = createPreflightActionRunner(host);
    for (const action of UNPERFORMABLE_ACTIONS) {
      expect(runner.canRun(action, 'cross-epoch-change')).toBe(false);
      expect(runner.run(action, 'cross-epoch-change')).toBe(false);
    }
  });

  it('reports an unavailable action rather than pretending it ran', () => {
    const runner = createPreflightActionRunner({});
    expect(runner.canRun('classify-scan', 'terrain-dtm')).toBe(false);
    expect(runner.run('classify-scan', 'terrain-dtm')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The surface: a limited tool says why, and what would lift it
// ─────────────────────────────────────────────────────────────────────────────

describe('the Process Studio surface', () => {
  it('shows a blocked tool its own status and its own reason', async () => {
    // No CRS: building footprints is a metric product with no exploratory path,
    // so the capability model blocks it on the unconfirmed linear unit.
    const { shell } = fakeShell({ crs: null });
    const studio = await mounted(shell);
    const footprints = row(studio.panel, 'olv-ps-product', 'Building footprints')!;
    expect(badge(footprints)).toBe('blocked');
    const model = preflightFor('building-footprints', buildPreflightInput({
      getActiveSignals: () => ({ kind: 'static', pointCount: 1_000_000, crs: null }),
      getSpatialContext: () => spatialContextFrom(null),
      getCompanionSignals: () => [],
      getDatumResolved: () => false,
    })!);
    expect(model.status).toBe('blocked');
    // Verbatim: the panel writes no sentence of its own.
    expect(reason(footprints)).toBe(model.reasons[0].message);
    // A blocked verdict drops the permissive "continue" step, so the row offers
    // only what would actually lift the block.
    expect(buttons(footprints).map((b) => b.textContent)).toEqual(['Set the coordinate system']);
  });

  it('offers the remediation the model named, and the click reaches the app', async () => {
    const { shell, done } = fakeShell({ crs: null });
    const studio = await mounted(shell);
    const dtm = row(studio.panel, 'olv-ps-product', 'DTM')!;
    const labels = buttons(dtm).map((b) => b.textContent);
    expect(labels).toContain('Set the coordinate system');
    buttons(dtm).find((b) => b.textContent === 'Set the coordinate system')!.click();
    expect(done.focusCrs).toBe(1);
  });

  it('arms the measurement when the user chooses to continue, labelled exploratory', async () => {
    const { shell, done } = fakeShell({ crs: null, datumResolved: true });
    const studio = await mounted(shell);
    const volume = row(studio.panel, 'olv-ps-tool', 'Volume')!;
    expect(badge(volume)).toBe('review');
    const proceed = buttons(volume).find((b) => b.textContent === 'Continue, labelled exploratory');
    expect(proceed).toBeDefined();
    proceed!.click();
    expect(done.measureMode).toEqual([true]);
    expect(done.kinds).toEqual(['volume']);
  });

  it('names a step the app cannot take as guidance, never as a dead control', async () => {
    // Two loaded scans with no proven frame: the model offers "align the two
    // scans", which nothing in the app performs.
    const { shell } = fakeShell({ crs: KNOWN_CRS, datumResolved: true, companions: [['epoch-b', 500_000]], companionCrs: KNOWN_CRS });
    const studio = await mounted(shell);
    const change = row(studio.panel, 'olv-ps-product', 'Change (cross-epoch)')!;
    expect(badge(change)).toBe('review');
    expect(advice(change)).toContain('Align the two scans');
    expect(buttons(change).map((b) => b.textContent)).not.toContain('Align the two scans');
  });

  it('routes the classification remediation to the derive the app really runs', async () => {
    const { shell, done } = fakeShell({ crs: KNOWN_CRS, datumResolved: true });
    const studio = await mounted(shell);
    const fp = row(studio.panel, 'olv-ps-product', 'Building footprints')!;
    const classify = buttons(fp).find((b) => b.textContent === 'Classify the scan first');
    expect(classify).toBeDefined();
    classify!.click();
    expect(done.classify).toBe(1);
  });

  it('isolates the active layer through the idempotent solo, from the tool row', async () => {
    const { shell, done } = fakeShell({ crs: KNOWN_CRS, companions: [['epoch-b', 10]], companionCrs: KNOWN_CRS });
    const studio = await mounted(shell);
    const distance = row(studio.panel, 'olv-ps-tool', 'Distance')!;
    expect(badge(distance)).toBe('review');
    buttons(distance).find((b) => b.textContent === 'Show the active layer on its own')!.click();
    expect(done.solo).toEqual(['active']);
  });

  it('leaves a ready tool unobstructed — no reason, no remediation', async () => {
    const { shell } = fakeShell({
      crs: KNOWN_CRS,
      datumResolved: true,
      classCodes: [2],
    });
    const studio = await mounted(shell);
    const distance = row(studio.panel, 'olv-ps-tool', 'Distance')!;
    expect(badge(distance)).toBe('ready');
    expect(reason(distance)).toBe('');
    expect(buttons(distance)).toHaveLength(0);
    expect(advice(distance)).toHaveLength(0);
  });

  it('never reads more permissive than the model, tool for tool', async () => {
    for (const state of [
      fakeShell({ crs: null }),
      fakeShell({ crs: KNOWN_CRS }),
      fakeShell({ crs: KNOWN_CRS, datumResolved: true, classCodes: [2, 6] }),
    ]) {
      const studio = await mounted(state.shell);
      const root = studio.panel.element as unknown as FakeEl;
      for (const li of root.collect('olv-ps-tool')) {
        const label = li.collect('olv-ps-name')[0].textContent;
        const model = preflightSnapshot({
          getActiveSignals: () => ({
            kind: 'static',
            pointCount: 1_000_000,
            crs: state.shell.crsService.current(),
            classification: 'none',
          }),
          getSpatialContext: () => state.shell.crsService.context(),
          getCompanionSignals: () => [],
          getDatumResolved: () => state.shell.getViewer().measure.datumResolved,
        }).find((t) => (t.tool as string).endsWith(label.toLowerCase()));
        expect(badge(li), `${label} badge`).toBe(model!.status);
      }
    }
  });

  it('offers nothing until the model has landed, and everything once it has', async () => {
    // The preflight rides a lazy chunk. Before it arrives the panel still shows
    // the product eligibility it already had, with no remediation — the first
    // paint may be less informed, never more permissive.
    const { shell } = fakeShell({ crs: null });
    const studio = createProcessStudioFromShell(shell);
    studio.refresh();
    const root = studio.panel.element as unknown as FakeEl;
    expect(root.collect('olv-ps-product').length).toBe(7);
    expect(root.collect('olv-ps-remedy')).toHaveLength(0);
    expect(root.collect('olv-ps-tool')).toHaveLength(0);
    await vi.waitFor(() => expect(root.collect('olv-ps-tool').length).toBe(4));
    expect(root.collect('olv-ps-remedy').length).toBeGreaterThan(0);
  });

  it('hides the tool section entirely when there is no scan to reason about', () => {
    const { shell } = fakeShell({ noScan: true });
    const studio = createProcessStudioFromShell(shell);
    studio.refresh();
    const root = studio.panel.element as unknown as FakeEl;
    expect(root.collect('olv-ps-tool')).toHaveLength(0);
    expect(root.querySelector('.olv-ps-tools-title')!.hidden).toBe(true);
  });
});
