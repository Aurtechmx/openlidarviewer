/**
 * measurePanelStationHover.test.ts
 *
 * The profile panel couples its station-table rows to the scene's profile-
 * station dots: hovering a row asks the host to brighten the dot at the nearest
 * chainage (`onStationHover(id, index)`), and leaving the row clears it
 * (`onStationHover(id, null)`). The coupling is a PURE INDEX — the panel never
 * touches the scene; it only reports which dot index the reader is pointing at.
 *
 * These tests pin, at the DOM level via the same recording stub the other panel
 * tests use:
 *   - a table row reports the dot whose chainage is nearest the row's sample,
 *     and tags itself with that index (`data-si`);
 *   - enter/leave are symmetric (leave always reports null);
 *   - the highlight can't leak: a list re-render OR hiding the panel clears it,
 *     because a detached/hidden row's `mouseleave` never fires;
 *   - with no `onStationHover` wired (or no station dots) the rows stay inert.
 *
 * The profile CHART's hover zones live in `innerHTML` markup the node stub does
 * not parse, so they are verified in the browser, not here.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { MeasurePanel } from '../src/ui/MeasurePanel';
import type { MeasurementSummary } from '../src/render/measure/MeasureController';
import type { ProfileChartSample } from '../src/render/measure/types';

import { FakeEl, installFakeDom } from './support/measurePanelDom';

beforeAll(() => {
  installFakeDom();
});

const SAMPLE_COUNT = 10;
/** Three scene dots at these chainages (metres), in dot order. */
const STATION_CHAINAGES = [30, 60, 90];

/** A profile summary with a dense sample series and a fixed station-dot set. */
function profileSummary(withChainages = true): MeasurementSummary {
  const profileChart: ProfileChartSample[] = [];
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    // distances 0,10,20,…,90 — one lands exactly on each station chainage.
    profileChart.push({ distance: i * 10, height: 100 + Math.sin(i / 3) * 4, count: 12 });
  }
  return {
    id: 'p1',
    kind: 'profile',
    name: 'Section A',
    value: '250.00 m',
    profileChart,
    profileStationChainages: withChainages ? [...STATION_CHAINAGES] : [],
  };
}

interface Mounted {
  panel: MeasurePanel;
  onStationHover: ReturnType<typeof vi.fn>;
  rows: () => FakeEl[];
}

/** Mount a profile panel and open the station table so its rows exist. */
function mountOpened(withChainages = true, withCallback = true): Mounted {
  const onStationHover = vi.fn();
  const panel = new MeasurePanel({
    onDelete: () => {},
    onRename: () => {},
    onExport: () => {},
    onImport: () => {},
    getUnitSystem: () => 'metric',
    ...(withCallback ? { onStationHover } : {}),
  });
  panel.update([profileSummary(withChainages)]);
  const root = panel.element as unknown as FakeEl;
  const details = root.querySelector('details.olv-mp-stations')!;
  details.open = true;
  details.dispatchEvent({ type: 'toggle' }); // builds the rows
  const tbody = details.querySelector('tbody')!;
  return { panel, onStationHover, rows: () => tbody.querySelectorAll('tr') };
}

describe('MeasurePanel — station-table rows couple to scene dots by nearest chainage', () => {
  it('tags each row with the nearest dot index', () => {
    const { rows } = mountOpened();
    // distance = i*10; nearest of [30,60,90].
    const expected = [0, 0, 0, 0, 0, 1, 1, 1, 2, 2]; // i=0..9
    const got = rows().map((r) => Number(r.dataset.si));
    expect(got).toEqual(expected);
  });

  it('reports the dot index on enter and clears it on leave (symmetric)', () => {
    const { rows, onStationHover } = mountOpened();
    const row60 = rows()[6]; // distance 60 → dot index 1
    onStationHover.mockClear();
    row60.dispatchEvent({ type: 'mouseenter' });
    expect(onStationHover).toHaveBeenLastCalledWith('p1', 1);
    row60.dispatchEvent({ type: 'mouseleave' });
    expect(onStationHover).toHaveBeenLastCalledWith('p1', null);
  });

  it('clears a live highlight when the list re-renders (detached row never leaves)', () => {
    const { panel, rows, onStationHover } = mountOpened();
    rows()[3].dispatchEvent({ type: 'mouseenter' }); // highlight is live
    onStationHover.mockClear();
    panel.update([profileSummary()]); // rebuild drops the hovered row
    expect(onStationHover).toHaveBeenCalledWith(null, null);
  });

  it('clears a live highlight when the panel is hidden', () => {
    const { panel, rows, onStationHover } = mountOpened();
    rows()[8].dispatchEvent({ type: 'mouseenter' });
    onStationHover.mockClear();
    panel.setVisible(false);
    expect(onStationHover).toHaveBeenCalledWith(null, null);
  });

  it('stays inert when the host wired no onStationHover', () => {
    const { rows } = mountOpened(true, false);
    // No coupling → no data-si tags at all.
    expect(rows().every((r) => r.dataset.si === undefined)).toBe(true);
  });

  it('stays inert when the profile has no station dots', () => {
    const { rows, onStationHover } = mountOpened(false, true);
    expect(rows().every((r) => r.dataset.si === undefined)).toBe(true);
    onStationHover.mockClear();
    rows()[4].dispatchEvent({ type: 'mouseenter' });
    expect(onStationHover).not.toHaveBeenCalled();
  });
});
