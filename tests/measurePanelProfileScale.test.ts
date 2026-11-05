import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { MeasurePanel } from '../src/ui/MeasurePanel';
import type { MeasurementSummary } from '../src/render/measure/MeasureController';
import type { ProfileChartSample } from '../src/render/measure/types';
import { FakeEl, installFakeDom } from './support/measurePanelDom';

beforeAll(() => {
  installFakeDom();
  // The x-label refit that follows a redraw looks for its overlay as an HTMLElement.
  (globalThis as { HTMLElement?: unknown }).HTMLElement = FakeEl;
});
afterEach(() => { delete (globalThis as { localStorage?: unknown }).localStorage; });

/** 90 m of profile with 3.5 m of relief: flat ground. */
function profile(extra: Partial<MeasurementSummary> = {}): MeasurementSummary {
  const profileChart: ProfileChartSample[] = [];
  for (let i = 0; i < 10; i++) profileChart.push({ distance: i * 10, height: 100 + i * 0.35, count: 12 });
  return { id: 'p1', kind: 'profile', name: 'Section A', value: '90.00 m', profileChart, ...extra };
}

function mount(summary = profile()): FakeEl {
  const panel = new MeasurePanel({ onDelete: () => {}, onRename: () => {}, onExport: () => {}, onImport: () => {}, getUnitSystem: () => 'metric' });
  panel.update([summary]);
  return panel.element as unknown as FakeEl;
}

/** The chart's markup is assigned as a string; the fake DOM keeps it as one. */
const chartHtml = (root: FakeEl): string => root.querySelector('.olv-mp-chart')!.innerHTML;
const yLabels = (root: FakeEl): number[] =>
  [...chartHtml(root).matchAll(/olv-mp-axis-y"[^>]*>([-\d.]+) m</g)].map((m) => Number.parseFloat(m[1]!));
const badge = (root: FakeEl): string => /olv-mp-vex-badge">([^<]*)</.exec(chartHtml(root))?.[1] ?? '';

describe('the first profile chart is drawn at true scale', () => {
  it('maps height and distance at the same scale by default, and says 1:1', () => {
    const root = mount();
    const chart = root.querySelector('.olv-mp-chart')!;
    // No box has been measured in this DOM, so the ratio is stated as approximate.
    expect(chart.title).toMatch(/vertical ≈1:1/);
    expect(badge(root)).toBe('≈1:1');
    const ys = yLabels(root);
    // The visible band is the chart's own height in metres at 1:1, far wider
    // than the 3.5 m of relief; flat ground reads flat.
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(30);
    expect(root.querySelectorAll('.olv-mp-vex-chip').map((c) => c.textContent)).toEqual(['1:1', '5×', '10×', '20×', 'Fit']);
  });

  it('Fit fills the height with the relief and states the exaggeration that takes', () => {
    const store = new Map<string, string>([['olv:measure:profile:vex:v2', '0']]);
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); },
    };
    const root = mount();
    const chart = root.querySelector('.olv-mp-chart')!;
    expect(badge(root)).toMatch(/^Fit · ≈[\d.]+× vertical$/);
    expect(chart.title).toMatch(/vertical Fit · ≈[\d.]+× vertical/);
    const ys = yLabels(root);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(5);
  });


  it('keeps the whole relief on the chart at 1:1, and states the stretch it drew instead', () => {
    const steep: ProfileChartSample[] = [];
    for (let i = 0; i < 10; i++) steep.push({ distance: i * 3, height: 100 + i * 5, count: 12 });
    const root = mount(profile({ profileChart: steep }));
    expect(badge(root)).toMatch(/^≈[\d.]+× vertical$/);
    expect(badge(root)).not.toMatch(/1:1/);
    const ys = yLabels(root);
    expect(Math.max(...ys)).toBeGreaterThanOrEqual(135);
    expect(Math.min(...ys)).toBeLessThanOrEqual(105);
  });

  it('fits the relief, and offers no ratio, where the frame has no known height or distance unit', () => {
    for (const frame of [{ geographic: true, verticalRefused: false }, { geographic: false, verticalRefused: true }]) {
      const panel = new MeasurePanel({ onDelete: () => {}, onRename: () => {}, onExport: () => {}, onImport: () => {}, getUnitSystem: () => 'metric', getProfileExportFrame: () => frame } as never);
      panel.update([profile()]);
      const root = panel.element as unknown as FakeEl;
      expect(badge(root)).toBe('Fit');
      const chips = root.querySelectorAll('.olv-mp-vex-chip');
      expect(chips.filter((c) => c.disabled).map((c) => c.textContent)).toEqual(['1:1', '5×', '10×', '20×']);
    }
  });

  it('states no stretch for a line with no relief', () => {
    const store = new Map<string, string>([['olv:measure:profile:vex:v2', '0']]);
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); },
    };
    const flat: ProfileChartSample[] = [];
    for (let i = 0; i < 10; i++) flat.push({ distance: i * 10, height: 100, count: 12 });
    expect(badge(mount(profile({ profileChart: flat })))).toBe('Fit');
  });

  it('reads a blank stored stretch as the default, not as Fit', () => {
    const store = new Map<string, string>([['olv:measure:profile:vex:v2', ' ']]);
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); },
    };
    expect(badge(mount())).toBe('≈1:1');
  });
});

type ChartEl = FakeEl & { _olvRelayout?: () => void; _olvRefitXLabels?: () => void };

/** Give the chart's svg a real box, as a browser would measure it. */
function measure(chart: FakeEl, width: number, height: number): void {
  const svg = new FakeEl('svg');
  (svg as unknown as { getBoundingClientRect: () => { width: number; height: number } }).getBoundingClientRect = () => ({ width, height });
  chart.append(svg);
}
const span = (v: number[]): number => Math.max(...v) - Math.min(...v);
const stretchOf = (b: string): number => Number.parseFloat(/([\d.]+)× vertical/.exec(b)?.[1] ?? 'NaN');

describe('the chart is drawn again at its real box', () => {
  it('draws 1:1 for the box it measured, and says so without the ≈', () => {
    const root = mount();
    const chart = root.querySelector('.olv-mp-chart') as ChartEl;
    const assumed = yLabels(root);
    measure(chart, 520, 280);
    chart._olvRelayout!();
    expect(badge(root)).toBe('1:1');
    expect(chart.title).toMatch(/vertical 1:1 ·/);
    // Twice the width at the same height leaves half the band in metres.
    const ys = yLabels(root);
    expect(span(ys)).toBeLessThan(span(assumed));
    expect(span(ys)).toBeGreaterThan(0);
  });

  it('states the stretch a steep line needs at the measured box', () => {
    const steep: ProfileChartSample[] = [];
    for (let i = 0; i < 10; i++) steep.push({ distance: i * 3, height: 100 + i * 5, count: 12 });
    const root = mount(profile({ profileChart: steep }));
    const chart = root.querySelector('.olv-mp-chart') as ChartEl;
    const assumed = stretchOf(badge(root));
    measure(chart, 520, 280);
    chart._olvRelayout!();
    // The relief still fills the height while the line takes twice the pixels,
    // so the stretch that fits is about half what the assumed box needed.
    expect(stretchOf(badge(root))).toBeLessThan(assumed * 0.7);
    expect(stretchOf(badge(root))).toBeGreaterThan(assumed * 0.3);
  });

  it('fits the x labels to the box again after the redraw', () => {
    const root = mount();
    const chart = root.querySelector('.olv-mp-chart') as ChartEl;
    let refits = 0;
    chart._olvRefitXLabels = () => { refits++; };
    measure(chart, 520, 280);
    chart._olvRelayout!();
    expect(refits).toBe(1);
  });

  it('does not draw the same box twice', () => {
    const root = mount();
    const chart = root.querySelector('.olv-mp-chart') as ChartEl;
    let refits = 0;
    chart._olvRefitXLabels = () => { refits++; };
    measure(chart, 520, 280);
    chart._olvRelayout!();
    measure(chart, 520, 280);
    chart._olvRelayout!();
    expect(refits).toBe(1);
  });
});

describe('the stored stretch', () => {
  it('reads a blank stored stretch as the default, not as Fit', () => {
    const store = new Map<string, string>([['olv:measure:profile:vex:v2', ' ']]);
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); },
    };
    expect(badge(mount())).toBe('≈1:1');
  });
});
