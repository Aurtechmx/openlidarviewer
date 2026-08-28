/**
 * processStudioProfileCloseRepro.test.ts
 *
 * The user-reported invariant: opening the Profile workbench on a profile row
 * and then CLOSING it must not change which products the Process Studio shows
 * or their produced state. After an analysis run the shell marks DTM + Contours
 * produced; a profile Expand → Close cycle must leave both produced.
 *
 * This wires the REAL studio mount (createProcessStudioFromShell), the REAL
 * Measurements-panel workbench dock (createMeasurePanelMount, which mounts the
 * real ProfileWorkbench and its launcher), and the shell's crsService-driven
 * reveal/reset handler, all over ONE shared fake viewer — then drives the real
 * Expand and the real Close button.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMeasurePanelMount } from '../src/app/measurePanelMount';
import { createAnalyseProfileVisibility } from '../src/app/analyseProfileVisibility';
import { createProcessStudioFromShell } from '../src/app/processStudioMount';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import type { CrsInfo } from '../src/io/crs';
import type { MeasurementSummary } from '../src/render/measure/MeasureController';
import type { ProfileChartSample } from '../src/render/measure/types';
import type { ProfileSectionResult } from '../src/render/measure/profileSectionSeam';

type Handler = (e: unknown) => void;

class FakeEl {
  readonly tagName: string;
  private _classes = new Set<string>();
  textContent = '';
  title = '';
  value = '';
  hidden = false;
  type = '';
  open = false;
  tabIndex = 0;
  width = 0;
  height = 0;
  clientWidth = 0;
  clientHeight = 0;
  checked = false;
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> & { height: string } = { height: '' };
  readonly children: FakeEl[] = [];
  parent: FakeEl | null = null;
  private readonly handlers = new Map<string, Handler[]>();

  constructor(tag: string) { this.tagName = tag.toLowerCase(); }
  get parentElement(): FakeEl | null { return this.parent; }
  set className(v: string) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className(): string { return [...this._classes].join(' '); }
  get classList() {
    const c = this._classes;
    return {
      add: (...n: string[]) => void n.forEach((x) => c.add(x)),
      remove: (...n: string[]) => void n.forEach((x) => c.delete(x)),
      contains: (x: string) => c.has(x),
      toggle: (x: string, f?: boolean) => { const w = f === undefined ? !c.has(x) : f; if (w) c.add(x); else c.delete(x); return w; },
    };
  }
  private _adopt(kid: unknown): FakeEl {
    if (kid instanceof FakeEl) { kid.parent = this; return kid; }
    const t = new FakeEl('#text'); t.textContent = String(kid); t.parent = this; return t;
  }
  append(...kids: unknown[]): void { for (const k of kids) if (k != null) this.children.push(this._adopt(k)); }
  replaceChildren(...kids: unknown[]): void { this.children.length = 0; for (const k of kids) if (k != null) this.children.push(this._adopt(k)); }
  remove(): void { if (!this.parent) return; const at = this.parent.children.indexOf(this); if (at >= 0) this.parent.children.splice(at, 1); this.parent = null; }
  contains(n: FakeEl | null): boolean { if (!n) return false; if (n === this) return true; return this.children.some((c) => c.contains(n)); }
  get lastElementChild(): FakeEl | null { for (let i = this.children.length - 1; i >= 0; i--) if (this.children[i]!.tagName !== '#text') return this.children[i]!; return null; }
  get firstChild(): FakeEl | null { return this.children[0] ?? null; }
  insertBefore(node: FakeEl, ref: FakeEl | null): FakeEl { const at = ref ? this.children.indexOf(ref) : -1; if (at >= 0) this.children.splice(at, 0, this._adopt(node)); else this.children.push(this._adopt(node)); return node; }
  setAttribute(): void {}
  removeAttribute(): void {}
  getAttribute(): string | null { return null; }
  addEventListener(t: string, fn: Handler): void { const a = this.handlers.get(t) ?? []; a.push(fn); this.handlers.set(t, a); }
  removeEventListener(t: string, fn: Handler): void { const a = this.handlers.get(t) ?? []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
  dispatchEvent(evt: { type: string; stopPropagation?: () => void }): boolean { for (const fn of [...(this.handlers.get(evt.type) ?? [])]) fn(evt); return true; }
  focus(): void {}
  blur(): void {}
  setPointerCapture(): void {}
  releasePointerCapture(): void {}
  getContext(): null { return null; }
  private _matches(sel: string): boolean {
    const parts = sel.split('.'); const tag = parts[0];
    if (tag && this.tagName !== tag.toLowerCase()) return false;
    for (const c of parts.slice(1)) if (!this._classes.has(c)) return false;
    return true;
  }
  querySelector(sel: string): FakeEl | null {
    for (const c of this.children) { if (c._matches(sel)) return c; const d = c.querySelector(sel); if (d) return d; }
    return null;
  }
  querySelectorAll(sel: string): FakeEl[] {
    const out: FakeEl[] = [];
    const walk = (n: FakeEl) => { for (const c of n.children) { if (c._matches(sel)) out.push(c); walk(c); } };
    walk(this); return out;
  }
  collect(cls: string, out: FakeEl[] = []): FakeEl[] {
    for (const c of this.children) { if (c._classes.has(cls)) out.push(c); c.collect(cls, out); }
    return out;
  }
}

let frames: (() => void)[] = [];

beforeEach(() => {
  frames = [];
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    createElement: (t: string) => new FakeEl(t),
    createElementNS: (_ns: string, t: string) => new FakeEl(t),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  g.HTMLInputElement = class {};
  g.HTMLAnchorElement = class {};
  g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  g.requestAnimationFrame = (fn: () => void): number => frames.push(fn);
  g.window = { innerWidth: 1440, innerHeight: 900, devicePixelRatio: 1, matchMedia: () => ({ matches: false }) };
});

afterEach(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  for (const k of ['document', 'HTMLInputElement', 'HTMLAnchorElement', 'ResizeObserver', 'requestAnimationFrame', 'window']) delete g[k];
});

const metreCrs = {
  source: 'epsg', name: 'WGS 84 / UTM zone 12N', epsg: 32612,
  linearUnit: 'metre', linearUnitToMetres: 1, isGeographic: false,
  verticalEpsg: 5703, verticalDatum: 'NAVD88', verticalUnitToMetres: 1,
} as unknown as CrsInfo;

function tinySection(count = 32): ProfileSectionResult {
  const chainage = new Float32Array(count);
  const height = new Float64Array(count);
  for (let i = 0; i < count; i++) { chainage[i] = i; height[i] = i * 0.25; }
  return {
    points: { count, chainage, height, lateralOffset: new Float32Array(count), sourceSlot: new Uint16Array(count), pointIndex: new Uint32Array(count), channelPresence: new Uint8Array(count) },
    frame: null as never, band: 1.5, scope: 'static' as never, scopeLabel: 'One loaded layer.',
    classificationOnEverySource: true, streamingComplete: null, sources: [], generation: 1, aborted: false, skippedSlots: [], examined: count,
  };
}

function profileSummary(id = 'p1', name = 'Section A'): MeasurementSummary {
  const profileChart: ProfileChartSample[] = [];
  for (let i = 0; i < 8; i++) profileChart.push({ distance: i * 10, height: 100 + i * 0.5, count: 12 });
  return { id, kind: 'profile', name, value: '70.00 m', profileChart };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
async function settleUntil(done: () => boolean, ticks = 500): Promise<void> {
  for (let i = 0; i < ticks && !done(); i++) await new Promise((r) => setTimeout(r, 0));
}

function buildRig() {
  const appRoot = new FakeEl('div');
  appRoot.clientHeight = 900;
  const stageEl = new FakeEl('div');
  appRoot.append(stageEl);

  const measurements = [{ id: 'p1', kind: 'profile', name: 'Section A', points: [[0, 0, 0], [70, 0, 0]], profileCorridorWidth: 2 }];
  let datumResolved = false;
  const viewer = {
    streamingCloud: null,
    clouds: () => ['scan1'],
    getCloud: (id: string) => (id === 'scan1' ? { name: 'scan1.laz', pointCount: 1_000_000, sourceFormat: 'laz', metadata: { crs: metreCrs } } : undefined),
    measure: {
      get datumResolved() { return datumResolved; },
      setKind: () => {},
      worldUp: [0, 0, 1], unitToMetres: 1, verticalUnitToMetres: 1, unitSystem: 'metric',
      getMeasurements: () => measurements,
      getSummaries: () => [profileSummary()],
      removeMeasurement: () => {}, renameMeasurement: () => {}, resampleProfile: () => {}, setHoveredStation: () => false,
    },
    measureMode: false,
    setMeasureMode: () => {},
    profileSeam: { sectionChunks: function* () { return tinySection(); }, locateReturn: () => null },
    derivedLayerHost: () => ({ add: () => {}, remove: () => {}, requestFrame: () => {} }),
    getCameraPose: () => ({}), applyCameraPose: () => {},
    requestFrame: () => {},
  };

  const crsSubs: ((r: unknown) => void)[] = [];
  const crsService = {
    current: () => metreCrs,
    context: () => spatialContextFrom(metreCrs),
    subscribe: (fn: (r: unknown) => void) => { crsSubs.push(fn); return () => {}; },
    emit: (r: unknown) => { for (const fn of crsSubs) fn(r); },
    resolveFor: (_i: { name: string; detected?: unknown }) => metreCrs,
  };

  const studio = createProcessStudioFromShell({
    getViewer: () => viewer as never,
    getActiveCloud: () => ({ pointCount: 1_000_000 }),
    getActiveLayerId: () => 'scan1',
    crsService: crsService as never,
    classLegend: { presentCodes: () => [2], classificationIsDerived: () => false },
    resolveLayerCrs: () => metreCrs,
    soloLayer: () => {}, classifyScan: () => {}, focusCrs: () => {}, focusLayers: () => {},
  });

  // The shell's reveal/reset handler (main.ts): resolved → refresh+show; null → clearProduced+hide.
  crsService.subscribe((resolved) => {
    if (resolved) { studio.refresh(); studio.panel.show(); }
    else { studio.clearProduced(); studio.panel.hide(); }
  });

  // Mirror main.ts's AnalysePanel save/restore wiring over a tiny fake shell:
  // the AnalysePanel (which hosts the "Contours in 3D" controls group) is
  // visible before the profile opens. hideForProfile hides it; the workbench
  // close must restore it via the mount's onWorkbenchClose.
  const shell = { analyseDesiredVisible: true, analysePanelVisible: true, dockActive: true };
  const analyseProfileVisibility = createAnalyseProfileVisibility({
    getDesired: () => shell.analyseDesiredVisible,
    setDesired: (v) => { shell.analyseDesiredVisible = v; },
    setPanelVisible: (v) => { shell.analysePanelVisible = v; },
    setDockActive: (v) => { shell.dockActive = v; },
  });

  const mount = createMeasurePanelMount({
    getViewer: () => viewer as never,
    crsService: crsService as never,
    getExportPanel: () => ({ refresh: () => {} }),
    exportSession: () => {}, handleFile: () => {}, recordUsage: () => {},
    workbenchStage: { root: stageEl as unknown as HTMLElement },
    onWorkbenchClose: () => analyseProfileVisibility.restore(),
  });

  return {
    appRoot, stageEl, studio, mount, crsService, shell, analyseProfileVisibility,
    setDatum: (v: boolean) => { datumResolved = v; },
  };
}

type Rig = ReturnType<typeof buildRig>;

const dockOf = (r: Rig): FakeEl | null => r.appRoot.querySelector('section.olv-workbench');
function studioRow(r: Rig, label: string): FakeEl | undefined {
  const root = r.studio.panel.element as unknown as FakeEl;
  return root.collect('olv-ps-product').find((li) => li.collect('olv-ps-name').some((s) => s.textContent === label));
}
const badge = (row: FakeEl | undefined): string => row?.collect('olv-ps-badge')[0]?.textContent ?? '(no row)';

describe('profile Expand → Close must not disturb the Process Studio', () => {
  it('keeps Contours (and DTM) produced across a real open/close of the workbench', async () => {
    const r = buildRig();
    // Scan load: the shell reveals the studio and paints it.
    r.crsService.emit(metreCrs);
    for (let i = 0; i < 50; i++) await settle(); // let the lazy preflight land

    // Analysis run: DTM + Contours produced.
    r.studio.markProduced(['dtm', 'contours']);
    expect(badge(studioRow(r, 'Contours'))).toBe('produced');
    expect(badge(studioRow(r, 'DTM'))).toBe('produced');

    // Open the Profile workbench through the real Measurements panel Expand.
    await r.mount.ensure();
    const panel = r.mount.panel!;
    const expand = (panel.element as unknown as FakeEl).querySelector('button.olv-mp-chart-expand');
    expect(expand).not.toBeNull();
    expand!.dispatchEvent({ type: 'click', stopPropagation: () => {} });
    await settleUntil(() => dockOf(r) !== null);
    expect(dockOf(r)).not.toBeNull();
    while (frames.length > 0) frames.shift()!();
    // Opening a profile resolves the shared datum, as it does in the app.
    r.setDatum(true);

    // Close it via the real Close button.
    const close = dockOf(r)!.querySelector('button.olv-workbench-close');
    expect(close).not.toBeNull();
    close!.dispatchEvent({ type: 'click', stopPropagation: () => {} });
    await settleUntil(() => dockOf(r) === null);
    expect(dockOf(r)).toBeNull();
    for (let i = 0; i < 20; i++) await settle();

    // The invariant.
    expect(badge(studioRow(r, 'Contours'))).toBe('produced');
    expect(badge(studioRow(r, 'DTM'))).toBe('produced');
  });
});

describe('profile Expand → Close restores the AnalysePanel it hid', () => {
  it('re-shows the AnalysePanel (and its contour-layer controls) after the workbench closes', async () => {
    const r = buildRig();
    r.crsService.emit(metreCrs);
    for (let i = 0; i < 50; i++) await settle();

    // Selecting the Profile kind hides the AnalysePanel, as main.ts does.
    r.analyseProfileVisibility.hideForProfile();
    expect(r.shell.analysePanelVisible).toBe(false);

    // Open the real workbench via the Measurements panel Expand.
    await r.mount.ensure();
    const panel = r.mount.panel!;
    const expand = (panel.element as unknown as FakeEl).querySelector('button.olv-mp-chart-expand');
    expand!.dispatchEvent({ type: 'click', stopPropagation: () => {} });
    await settleUntil(() => dockOf(r) !== null);
    while (frames.length > 0) frames.shift()!();

    // Close it via the real Close button — the panel comes back.
    const close = dockOf(r)!.querySelector('button.olv-workbench-close');
    close!.dispatchEvent({ type: 'click', stopPropagation: () => {} });
    await settleUntil(() => dockOf(r) === null);
    for (let i = 0; i < 20; i++) await settle();

    // The AnalysePanel (host of the "Contours in 3D" controls) is visible again.
    expect(r.shell.analysePanelVisible).toBe(true);
    expect(r.shell.analyseDesiredVisible).toBe(true);
    expect(r.shell.dockActive).toBe(true);
  });

  it('leaves the AnalysePanel HIDDEN on scan close (the ordering hazard)', async () => {
    const r = buildRig();
    r.crsService.emit(metreCrs);
    for (let i = 0; i < 50; i++) await settle();

    r.analyseProfileVisibility.hideForProfile();
    await r.mount.ensure();
    const panel = r.mount.panel!;
    const expand = (panel.element as unknown as FakeEl).querySelector('button.olv-mp-chart-expand');
    expand!.dispatchEvent({ type: 'click', stopPropagation: () => {} });
    await settleUntil(() => dockOf(r) !== null);
    while (frames.length > 0) frames.shift()!();

    // resetToEmptyState ordering: hide the panel + clear the mark BEFORE
    // measureMount.hide() closes the workbench (which fires onWorkbenchClose).
    r.shell.analyseDesiredVisible = false;
    r.shell.analysePanelVisible = false;
    r.analyseProfileVisibility.clear();
    r.mount.hide();
    await settleUntil(() => dockOf(r) === null);
    for (let i = 0; i < 20; i++) await settle();

    // The close-triggered restore was a no-op: the panel stays hidden.
    expect(r.shell.analysePanelVisible).toBe(false);
    expect(r.shell.analyseDesiredVisible).toBe(false);
  });
});

describe('createAnalyseProfileVisibility save/restore/clear', () => {
  function harness(initialDesired: boolean) {
    const s = { desired: initialDesired, panel: initialDesired, dock: initialDesired };
    const v = createAnalyseProfileVisibility({
      getDesired: () => s.desired,
      setDesired: (x) => { s.desired = x; },
      setPanelVisible: (x) => { s.panel = x; },
      setDockActive: (x) => { s.dock = x; },
    });
    return { s, v };
  }

  it('restores the visible state that was saved before the profile hid it', () => {
    const { s, v } = harness(true);
    v.hideForProfile();
    expect(s).toEqual({ desired: false, panel: false, dock: false });
    v.restore();
    expect(s).toEqual({ desired: true, panel: true, dock: true });
  });

  it('restores a hidden pre-profile state without forcing the panel visible', () => {
    const { s, v } = harness(false);
    v.hideForProfile();
    v.restore();
    expect(s.desired).toBe(false);
    expect(s.panel).toBe(false);
  });

  it('saves only the FIRST pre-profile state across repeated hides', () => {
    const { s, v } = harness(true);
    v.hideForProfile();
    v.hideForProfile(); // a second hide must not overwrite the saved `true`
    v.restore();
    expect(s.desired).toBe(true);
  });

  it('clear() makes a following restore a no-op', () => {
    const { s, v } = harness(true);
    v.hideForProfile();
    v.clear();
    v.restore();
    expect(s.panel).toBe(false); // stayed hidden
  });

  it('restore() with nothing saved is a no-op', () => {
    const { s, v } = harness(false);
    s.panel = true; s.desired = true; s.dock = true; // an unrelated later show
    v.restore();
    expect(s).toEqual({ desired: true, panel: true, dock: true });
  });
});
