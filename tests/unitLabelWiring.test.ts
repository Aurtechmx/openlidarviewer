/**
 * unitLabelWiring.test.ts: the call sites use the unit helpers.
 *
 * The live probe readout prints the CRS's own axis units, and both profile CSV
 * buttons in the Measurements panel are disabled on a geographic CRS. Each case
 * drives the real component through the recording DOM stub, so a call site
 * that stops using the helper fails here.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';

const openResultFocus = vi.fn();
vi.mock('../src/ui/ResultFocus', () => ({
  openResultFocus: (...args: unknown[]) => openResultFocus(...args),
}));

import { LiveProbe } from '../src/render/LiveProbe';
import { MeasurePanel } from '../src/ui/MeasurePanel';
import { GEOGRAPHIC_CRS_MEASURE_NOTICE } from '../src/render/measure/format';
import type { MeasurementSummary } from '../src/render/measure/MeasureController';
import type { PointInfo } from '../src/render/pointInfo';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';
import { FakeEl, installFakeDom } from './support/measurePanelDom';

beforeAll(() => {
  installFakeDom();
  const g = globalThis as unknown as { window?: { innerWidth: number; innerHeight: number } };
  g.window ??= { innerWidth: 1280, innerHeight: 800 };
});

const geographic = ({ kind: 'geographic', name: 'EPSG:4326', linearUnit: 'unknown', linearUnitToMetres: 1 }) as unknown as ResolvedCrs;

describe('LiveProbe readout units', () => {
  it('prints degrees for X and Y and metres only for Z on a geographic CRS', () => {
    const probe = new LiveProbe(() => geographic);
    probe.setActive(true);
    const info = { x: -105.1234567, y: 40.1234567, z: 1601.25, classification: null, intensity: null } as unknown as PointInfo;
    probe.update(info, 100, 100);
    const text = (probe.element as unknown as FakeEl).textContent;
    expect(text).toContain('-105.1234567°, 40.1234567°, 1601.25 m');
    expect(text).not.toMatch(/-105\.1234567 m|40\.1234567 m/);
  });
});

const CHART = [
  { distance: 0, height: 10, count: 5 },
  { distance: 10, height: 12, count: 8 },
];

function summary(over: Partial<MeasurementSummary> = {}): MeasurementSummary {
  return { id: 'p1', kind: 'profile', name: 'Section A', value: '0.01°', profileChart: CHART, profileDatumKnown: true, ...over } as MeasurementSummary;
}

function panel(): MeasurePanel {
  return new MeasurePanel({
    onDelete: () => {},
    onRename: () => {},
    onExport: () => {},
    onImport: () => {},
    getUnitSystem: () => 'metric',
    getProfileExportContext: () => ({ crs: 'EPSG:4326', verticalDatum: null }),
  });
}

function csvButtons(scope: FakeEl): FakeEl[] {
  return scope.querySelectorAll('button').filter((b) => (b.getAttribute('aria-label') ?? '').includes('station data as CSV'));
}

describe('MeasurePanel profile CSV buttons on a geographic CRS', () => {
  it('disables the row button with the geographic notice, even when the summary carries no trust', () => {
    const p = panel();
    p.setGeographicNotice(true);
    p.update([summary()]);
    const buttons = csvButtons(p.element as unknown as FakeEl);
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      expect(b.disabled).toBe(true);
      expect(b.title).toBe(GEOGRAPHIC_CRS_MEASURE_NOTICE);
    }
  });

  it('disables the focus-view button too', () => {
    openResultFocus.mockClear();
    const p = panel();
    p.setGeographicNotice(true);
    p.update([summary()]);
    const expand = (p.element as unknown as FakeEl)
      .querySelectorAll('button')
      .find((b) => (b.getAttribute('aria-label') ?? '').includes('Expand'));
    expand!.dispatchEvent({ type: 'click', stopPropagation: () => {} });
    const opts = openResultFocus.mock.calls[0]![0] as { render: (c: unknown) => void };
    const container = new FakeEl('div');
    opts.render(container);
    const buttons = csvButtons(container);
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect(b.disabled).toBe(true);
  });

  it('leaves the buttons enabled on a projected CRS', () => {
    const p = panel();
    p.update([summary()]);
    for (const b of csvButtons(p.element as unknown as FakeEl)) expect(b.disabled).toBe(false);
  });
});
