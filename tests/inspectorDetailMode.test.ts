/**
 * The View Inspector's Basic / Advanced detail switch
 * (src/ui/inspector/detailMode.ts, wired in src/ui/Inspector.ts).
 *
 * Basic is the default; Advanced shows every section again. The switch only
 * toggles classes: controls are never rebuilt, so values set while a section
 * is hidden are there when it shows. Hidden sections that need attention raise
 * a notice, and a deep link into a hidden section reveals it.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { Inspector, type InspectorCallbacks } from '../src/ui/Inspector';
import { FakeEl, byClass } from './support/measurePanelDom';
import { installInspectorFakeDom, fakeCallbacks } from './helpers/inspectorLazyHarness';
import { DETAIL_MODE_PREF } from '../src/ui/inspector/detailMode';

vi.mock('../src/lazyChunks', () => ({
  loadLayerHealthCard: vi.fn(() => new Promise(() => {})),
  loadLayerGroupsPanel: vi.fn(() => new Promise(() => {})),
  loadRenderProvenance: vi.fn(() => new Promise(() => {})),
  loadRenderReport: vi.fn(() => new Promise(() => {})),
  loadRenderCrs: vi.fn(() => new Promise(() => {})),
}));

const store = new Map<string, string>();

beforeAll(() => {
  installInspectorFakeDom();
  (globalThis as unknown as { window: Record<string, unknown> }).window.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});
beforeEach(() => store.clear());

const root = (ins: Inspector): FakeEl => ins.element as unknown as FakeEl;
const button = (ins: Inspector, text: string): FakeEl => {
  const control = byClass(root(ins), 'olv-detail-mode')!;
  return control.children.find((c) => c.textContent === text)!;
};
/** The nearest node carrying a CSS class that Basic hides, if any. */
function tierHidden(ins: Inspector, node: FakeEl): boolean {
  if (!root(ins).classList.contains('olv-detail-basic')) return false;
  for (let n: FakeEl | null = node; n && n !== root(ins); n = n.parent) {
    if (n.classList.contains('olv-tier-advanced') && !n.classList.contains('olv-tier-revealed')) return true;
  }
  return false;
}
const summary = (ins: Inspector, label: string): FakeEl =>
  root(ins).querySelectorAll('summary').find((s) => s.textContent === label)!;
const notices = (ins: Inspector): FakeEl => byClass(root(ins), 'olv-detail-notices')!;

function withExtent(cb: Partial<InspectorCallbacks> = {}): Inspector {
  const ins = new Inspector({ ...fakeCallbacks(), ...cb });
  ins.setElevationExtent({ min: 0, max: 100 });
  return ins;
}

describe('Inspector Basic / Advanced', () => {
  it('starts in Basic for a new user, with the switch at the top', () => {
    const ins = new Inspector(fakeCallbacks());
    expect(ins.detailMode()).toBe('basic');
    expect(root(ins).classList.contains('olv-detail-basic')).toBe(true);
    expect(button(ins, 'Basic').getAttribute('aria-pressed')).toBe('true');
    expect(button(ins, 'Advanced').getAttribute('aria-pressed')).toBe('false');
    expect(byClass(root(ins), 'olv-detail-mode')!.getAttribute('role')).toBe('group');
    // Head, then the switch.
    expect(root(ins).children[1].className).toContain('olv-detail-mode');
  });

  it('Basic keeps the everyday sections and hides the technician ones', () => {
    const ins = new Inspector(fakeCallbacks());
    for (const label of ['Visuals Studio', 'Workflow', 'Rendering', 'Saved views', 'Coordinate system']) {
      expect(tierHidden(ins, summary(ins, label)), label).toBe(false);
    }
    for (const label of ['RGB', 'Background', 'Detail', 'Provenance', 'Scan report', 'Session stats']) {
      expect(tierHidden(ins, summary(ins, label)), label).toBe(true);
    }
    expect(tierHidden(ins, deepest(root(ins), 'Invert vertical orbit')!)).toBe(true);
    expect(tierHidden(ins, deepest(root(ins), 'Elevation filter')!)).toBe(true);
    // Point size stays in Basic.
    expect(tierHidden(ins, deepest(root(ins), 'Point size')!)).toBe(false);
  });

  it('Advanced restores every section, persists, and a new panel restores it', () => {
    const ins = new Inspector(fakeCallbacks());
    button(ins, 'Advanced').click();
    expect(ins.detailMode()).toBe('advanced');
    expect(root(ins).classList.contains('olv-detail-basic')).toBe(false);
    for (const label of ['RGB', 'Detail', 'Provenance', 'Scan report', 'Session stats']) {
      expect(tierHidden(ins, summary(ins, label)), label).toBe(false);
    }
    const saved = JSON.parse(store.get('openlidarviewer.prefs.v1')!);
    expect(saved.inspectorSections[DETAIL_MODE_PREF]).toBe(true);
    expect(new Inspector(fakeCallbacks()).detailMode()).toBe('advanced');
  });

  it('switching keeps the same nodes, their values and their open state', () => {
    const ins = new Inspector(fakeCallbacks());
    ins.setDetailMode('advanced');
    const prov = summary(ins, 'Provenance').parent!;
    prov.open = true;
    const inputs = withInputs(ins);
    inputs.min.value = '12';
    ins.setDetailMode('basic');
    ins.setDetailMode('advanced');
    expect(summary(ins, 'Provenance').parent).toBe(prov);
    expect(prov.open).toBe(true);
    expect(withInputs(ins).min).toBe(inputs.min);
    expect(inputs.min.value).toBe('12');
  });

  it('renderer sync reaches hidden controls, so Advanced shows the live state', () => {
    const onNav = vi.fn();
    const ins = new Inspector({ ...fakeCallbacks(), onNavigationPrefsChange: onNav });
    const chip = deepest(root(ins), 'Invert vertical orbit')!;
    ins.syncNavigationPrefs({ invertOrbitX: false, invertOrbitY: true, preset: 'invert-vertical' });
    expect(tierHidden(ins, chip)).toBe(true);
    ins.setDetailMode('advanced');
    expect(deepest(root(ins), 'Invert vertical orbit')).toBe(chip);
    expect(chip.classList.contains('olv-chip-active')).toBe(true);
    // One control per state: a single invert chip in the whole panel.
    expect(root(ins).querySelectorAll('button').filter((b) => b.textContent === 'Invert vertical orbit')).toHaveLength(1);
    expect(onNav).not.toHaveBeenCalled();
  });

  it('an active filter hidden by Basic shows a notice that reveals it in one click', () => {
    const ins = withExtent();
    expect(notices(ins).classList.contains('olv-hidden')).toBe(true);
    ins.restoreElevationFilter([10, 20]);
    expect(notices(ins).classList.contains('olv-hidden')).toBe(false);
    const notice = notices(ins).children[0];
    expect(notice.textContent).toContain('Elevation filter active');
    notice.click();
    const filter = deepest(root(ins), 'Elevation filter')!;
    expect(tierHidden(ins, filter)).toBe(false);
    expect(ins.detailMode()).toBe('basic');
    expect(notices(ins).classList.contains('olv-hidden')).toBe(true);
    // Clearing the filter drops the notice for good.
    ins.setDetailMode('advanced');
    ins.setDetailMode('basic');
    ins.restoreElevationFilter(null);
    expect(notices(ins).children).toHaveLength(0);
  });

  it('no notice in Advanced, where the filter is in view', () => {
    const ins = withExtent();
    ins.setDetailMode('advanced');
    ins.restoreElevationFilter([10, 20]);
    expect(notices(ins).classList.contains('olv-hidden')).toBe(true);
  });

  it('deep links reveal their section in Basic without changing the mode', () => {
    const ins = new Inspector(fakeCallbacks());
    // The CRS section (units and CRS status) is never hidden.
    expect(tierHidden(ins, summary(ins, 'Coordinate system'))).toBe(false);
    expect(ins.focusSource()).toBe(true);
    expect(ins.focusCrsOverride()).toBe(true);
    expect(ins.focusLayers()).toBe(true);
    expect(ins.detailMode()).toBe('basic');
    // A notice target is revealed the same way.
    ins.setReport([{ label: 'Density', value: 'low', status: 'warn' }]);
    notices(ins).children[0].click();
    expect(tierHidden(ins, summary(ins, 'Scan report'))).toBe(false);
    expect(summary(ins, 'Scan report').parent!.open).toBe(true);
    // Returning to Basic ends the one-off reveal.
    ins.setDetailMode('advanced');
    ins.setDetailMode('basic');
    expect(tierHidden(ins, summary(ins, 'Scan report'))).toBe(true);
  });

  it('warnings and limitations in hidden sections stay visible in Basic', () => {
    const ins = new Inspector(fakeCallbacks());
    ins.setReport([
      { label: 'A', value: 'x', status: 'fail' },
      { label: 'B', value: 'y', status: 'warn' },
      { label: 'C', value: 'z', status: 'pass' },
    ]);
    ins.setDeclaredProvenance({
      headline: 'Survey',
      declaredRows: [],
      referenceGrade: false,
      limitations: 'Not for engineering use.',
    } as never);
    const text = notices(ins).textContent;
    expect(text).toContain('Scan report: 2 warnings');
    expect(text).toContain('Declared limitations');
    ins.setDeclaredProvenance(null);
    ins.clear();
    expect(notices(ins).children).toHaveLength(0);
  });

  it('reparenting the panel adds no listeners: one click, one switch', () => {
    const ins = new Inspector(fakeCallbacks());
    const rail = new FakeEl('div');
    const sheet = new FakeEl('div');
    rail.append(ins.element);
    sheet.append(ins.element);
    rail.append(ins.element);
    button(ins, 'Advanced').click();
    expect(ins.detailMode()).toBe('advanced');
    button(ins, 'Basic').click();
    expect(ins.detailMode()).toBe('basic');
    expect(root(ins).querySelectorAll('div.olv-detail-mode')).toHaveLength(1);
  });

  it('session restore is unaffected by the mode', () => {
    const onElev = vi.fn();
    const onInten = vi.fn();
    const ins = new Inspector({ ...fakeCallbacks(), onElevationFilter: onElev, onIntensityFilter: onInten });
    ins.setElevationExtent({ min: 0, max: 100 });
    ins.setIntensityExtent({ min: 0, max: 255 });
    ins.restoreElevationFilter([5, 50]);
    ins.restoreIntensityFilter([1, 200]);
    expect(onElev).toHaveBeenLastCalledWith([5, 50]);
    expect(onInten).toHaveBeenLastCalledWith([1, 200]);
    expect(ins.detailMode()).toBe('basic');
    expect(ins.layerGroupsForSession()).toEqual([]);
    // The mode lives in UI preferences only, never in the stored session shape.
    expect(store.get('openlidarviewer.prefs.v1') ?? '').not.toContain(DETAIL_MODE_PREF);
  });

  it('Basic offers quick appearance shortcuts through the existing preset callbacks', () => {
    const onRgb = vi.fn();
    const onEdl = vi.fn();
    const ins = new Inspector({ ...fakeCallbacks(), onRgbAppearancePreset: onRgb, onEdlPreset: onEdl });
    const quick = byClass(root(ins), 'olv-quick-appearance')!;
    expect(quick.classList.contains('olv-tier-basic')).toBe(true);
    const [rgbRail, edlRail] = quick.children.slice(1);
    // RGB looks appear only when the scan carries colour.
    ins.setColorModes(['elevation'], 'elevation');
    expect(rgbRail.classList.contains('olv-hidden')).toBe(true);
    ins.setColorModes(['rgb', 'elevation'], 'rgb');
    expect(rgbRail.classList.contains('olv-hidden')).toBe(false);
    expect(rgbRail.children.map((c) => c.textContent)).toEqual(['Natural', 'Photoreal', 'Survey', 'High Contrast']);
    rgbRail.children[1].click();
    expect(onRgb).toHaveBeenCalledWith('photoreal-rgb');
    edlRail.children[0].click();
    expect(onEdl).toHaveBeenCalledWith(null);
    // Renderer sync lights the shortcut too.
    ins.syncVisuals({ rgbAppearancePresetId: 'survey', edlPresetId: null, skyPresetId: 'black', temperature: 0, tint: 0 } as never);
    expect(rgbRail.children[2].classList.contains('olv-chip-active')).toBe(true);
    expect(edlRail.children[0].classList.contains('olv-chip-active')).toBe(true);
  });

  it('the Layers section reparented into the Data workspace is never hidden by the mode', () => {
    const ins = new Inspector(fakeCallbacks());
    const { layers } = ins.workspaceDataElements();
    const data = new FakeEl('div');
    data.append(layers);
    for (const mode of ['basic', 'advanced'] as const) {
      ins.setDetailMode(mode);
      for (let n: FakeEl | null = layers as unknown as FakeEl; n; n = n.parent) {
        expect(n.classList.contains('olv-tier-advanced')).toBe(false);
        expect(n.classList.contains('olv-tier-basic')).toBe(false);
        expect(n.classList.contains('olv-detail-basic')).toBe(false);
      }
    }
    expect(ins.focusLayers()).toBe(true);
  });
});

function withInputs(ins: Inspector): { min: FakeEl } {
  const filter = deepest(root(ins), 'Elevation filter')!;
  let n: FakeEl | null = filter;
  while (n && !n.classList.contains('olv-section')) n = n.parent;
  return { min: n!.querySelector('input')! };
}

/** The innermost node whose text contains `text`. */
function deepest(node: FakeEl, text: string): FakeEl | undefined {
  if (!node.textContent.includes(text)) return undefined;
  for (const c of node.children) {
    const hit = deepest(c, text);
    if (hit) return hit;
  }
  return node;
}
