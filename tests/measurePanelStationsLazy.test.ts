/**
 * measurePanelStationsLazy.test.ts
 *
 * The Measurements panel renders a per-profile station table inside a collapsed
 * `<details>`. A dense profile has one station row per sample, so building the
 * whole `<tbody>` up front (v0.5 behaviour) spent DOM work on a table most
 * measurements never open. v0.6 perf defers the row build to the first time the
 * disclosure opens (its `toggle` event), then caches it (build exactly once).
 *
 * These tests pin that contract at the DOM level: the `<tbody>` is EMPTY until
 * the `<details>` is opened and POPULATED (one row per sample) afterwards —
 * while the summary count, read from the eagerly-computed row MODEL, is correct
 * from the first render. Reopening never rebuilds or duplicates the rows.
 *
 * Runs in the node environment (the project keeps its unit tests DOM-free for
 * speed), so it drives the real MeasurePanel through a minimal recording DOM
 * stub — the same stub-the-slice approach the other panel tests use, extended
 * with the `<details>.open` / `toggle` / querySelector surface this panel touches.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { MeasurePanel, STATION_ROW_CAP } from '../src/ui/MeasurePanel';
import type { MeasurementSummary } from '../src/render/measure/MeasureController';
import type { ProfileChartSample } from '../src/render/measure/types';

import { FakeEl, installFakeDom } from './support/measurePanelDom';

beforeAll(() => {
  installFakeDom();
});

const SAMPLE_COUNT = 40;

/** A profile measurement with a dense, fully-covered station series. */
function profileSummary(): MeasurementSummary {
  const profileChart: ProfileChartSample[] = [];
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    profileChart.push({ distance: i * 5, height: 100 + Math.sin(i / 3) * 4, count: 12 });
  }
  return { id: 'p1', kind: 'profile', name: 'Section A', value: '250.00 m', profileChart };
}

interface StationBits {
  panel: MeasurePanel;
  details: FakeEl;
  tbody: FakeEl;
  summary: FakeEl;
}

/** Mount a panel showing a single profile row and return the station-table bits. */
function mountProfilePanel(): StationBits {
  const panel = new MeasurePanel({
    onDelete: () => {},
    onRename: () => {},
    onExport: () => {},
    onImport: () => {},
    getUnitSystem: () => 'metric',
  });
  panel.update([profileSummary()]);

  const root = panel.element as unknown as FakeEl;
  const details = root.querySelector('details.olv-mp-stations');
  expect(details).not.toBeNull();
  const tbody = details!.querySelector('tbody');
  const summary = details!.querySelector('summary');
  expect(tbody).not.toBeNull();
  expect(summary).not.toBeNull();
  return { panel, details: details!, tbody: tbody!, summary: summary! };
}

/** Open (or close) the disclosure exactly as a browser does: set state, fire toggle. */
function setOpen(details: FakeEl, open: boolean): void {
  details.open = open;
  details.dispatchEvent({ type: 'toggle' });
}

describe('MeasurePanel — station table rows build lazily on first open', () => {
  it('renders NO station rows until the <details> is opened', () => {
    const { tbody } = mountProfilePanel();
    expect(tbody.querySelectorAll('tr')).toHaveLength(0);
  });

  it('shows the correct row count in the summary while the body is still unbuilt', () => {
    const { tbody, summary } = mountProfilePanel();
    // The count comes from the eagerly-computed row MODEL, not from the DOM…
    expect(summary.textContent).toContain(`Station table (${SAMPLE_COUNT})`);
    // …while the DOM body is still empty.
    expect(tbody.querySelectorAll('tr')).toHaveLength(0);
  });

  it('builds one row per sample when the <details> is opened', () => {
    const { details, tbody } = mountProfilePanel();
    setOpen(details, true);
    expect(tbody.querySelectorAll('tr')).toHaveLength(SAMPLE_COUNT);
    // Each built row carries the five station columns.
    expect(tbody.querySelector('tr')!.querySelectorAll('td')).toHaveLength(5);
  });

  it('builds the rows exactly once — closing then reopening does not duplicate them', () => {
    const { details, tbody } = mountProfilePanel();
    setOpen(details, true);
    expect(tbody.querySelectorAll('tr')).toHaveLength(SAMPLE_COUNT);
    setOpen(details, false); // close — cached body stays
    expect(tbody.querySelectorAll('tr')).toHaveLength(SAMPLE_COUNT);
    setOpen(details, true); // reopen — no rebuild, no duplication
    expect(tbody.querySelectorAll('tr')).toHaveLength(SAMPLE_COUNT);
  });
});

describe('MeasurePanel — long station tables cap their rows instead of scrolling', () => {
  it('shows the first rows and a `Show all N` button that reveals the rest', () => {
    const { details, tbody } = mountProfilePanel();
    setOpen(details, true);
    const rows = tbody.querySelectorAll('tr');
    const shown = () => rows.filter((r) => !(r as unknown as { hidden?: boolean }).hidden);
    expect(shown()).toHaveLength(STATION_ROW_CAP);
    const more = details.querySelector('button.olv-mp-stations-more')!;
    expect(more).not.toBeNull();
    expect((more as unknown as { hidden: boolean }).hidden).toBe(false);
    expect(more.textContent).toContain(`Show all ${SAMPLE_COUNT}`);
    more.dispatchEvent({ type: 'click' });
    expect(shown()).toHaveLength(SAMPLE_COUNT);
    expect((more as unknown as { hidden: boolean }).hidden).toBe(true);
  });
});
