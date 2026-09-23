/**
 * exportDeliverables.test.ts
 *
 * `onExport`/`onExportReport` are fire-and-forget (`() => void`): the host's
 * real async work runs behind them with nothing this module can await. A
 * rapid double-click on a format button or the Report PDF button fired the
 * callback twice with the control never disabling (OUTPUT-F5). This locks
 * the duplicate-trigger guard: a second click while the first is still
 * guarded is dropped, and the control(s) re-enable once the guard elapses —
 * or immediately, when the callback does return a promise to await.
 */
import { describe, it, expect, vi } from 'vitest';
import { installFakeDom } from './support/measurePanelDom';
import { buildExportDeliverables } from '../src/ui/export/exportDeliverables';
import { DEFAULT_TEMPLATE_ID } from '../src/report/ReportTemplates';

installFakeDom();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const q = (root: any, sel: string): any => root.querySelector(sel);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const qAll = (root: any, sel: string): any[] => root.querySelectorAll(sel);

const noop = (): void => {};

describe('buildExportDeliverables — duplicate-click guard (OUTPUT-F5)', () => {
  it('disables the clicked format button immediately, drops a duplicate click, then releases', () => {
    vi.useFakeTimers();
    let calls = 0;
    const { element } = buildExportDeliverables({
      onExport: () => { calls++; },
      onExportImage: noop,
      onExportReport: noop,
    });
    const plyBtn = q(element, '.olv-export-btn'); // first format button
    expect(plyBtn.disabled).toBe(false);

    plyBtn.click();
    expect(calls).toBe(1);
    expect(plyBtn.disabled).toBe(true); // guards the literal rapid double-click

    plyBtn.click(); // duplicate click while still guarded
    expect(calls, 'a duplicate click must not fire a second, concurrent export').toBe(1);

    vi.runAllTimers();
    expect(plyBtn.disabled).toBe(false);

    plyBtn.click(); // a later, separate click still works
    expect(calls).toBe(2);
    vi.useRealTimers();
  });

  it('releases the guard as soon as a Promise-returning callback settles, not on the fixed timer', async () => {
    let resolveExport: () => void = () => {};
    const pending = new Promise<void>((resolve) => { resolveExport = resolve; });
    const { element } = buildExportDeliverables({
      onExport: () => pending as unknown as void,
      onExportImage: noop,
      onExportReport: noop,
    });
    const plyBtn = q(element, '.olv-export-btn');
    plyBtn.click();
    expect(plyBtn.disabled).toBe(true);
    await Promise.resolve();
    // Still disabled — the real async work has not resolved yet.
    expect(plyBtn.disabled).toBe(true);
    resolveExport();
    await Promise.resolve();
    await Promise.resolve();
    expect(plyBtn.disabled).toBe(false);
  });

  it('disables the Report PDF button AND the template select while a report runs, and drops a duplicate click', () => {
    vi.useFakeTimers();
    let calls = 0;
    const { element, setImageExportEnabled } = buildExportDeliverables({
      onExport: noop,
      onExportImage: noop,
      onExportReport: () => { calls++; },
    });
    setImageExportEnabled(true); // the report button + select start disabled
    const select = q(element, '.olv-report-select');
    select.value = DEFAULT_TEMPLATE_ID;
    const reportBtn = qAll(element, '.olv-export-btn').find((b) => b.textContent === 'Report PDF');
    expect(reportBtn.disabled).toBe(false);

    reportBtn.click();
    expect(calls).toBe(1);
    expect(reportBtn.disabled).toBe(true);
    expect(select.disabled, 'the shared template picker must guard too').toBe(true);

    reportBtn.click(); // duplicate click while the first report is still running
    expect(calls, 'a duplicate click must not start a second, concurrent report').toBe(1);

    vi.runAllTimers();
    expect(reportBtn.disabled).toBe(false);
    expect(select.disabled).toBe(false);
    vi.useRealTimers();
  });

  it('does not protect a void callback whose real async work outlives the fixed window', () => {
    // Reproduces main.ts's actual onExportReport shape: a void arrow function
    // that starts the real async work with `void ....then(...)` (main.ts:2651)
    // and returns nothing for guardDuplicateClicks to await, so the button
    // only ever guards for the fixed DUPLICATE_CLICK_GUARD_MS window, whatever
    // the real work's own duration turns out to be. A cold pdf-lib chunk load
    // plus multi-page render can outlast that window; this proves a click
    // after the window re-enables, but before the real work resolves, starts
    // a second, concurrent, genuine run.
    vi.useFakeTimers();
    let realRuns = 0;
    const startReal = (): void => {
      realRuns++;
      // Never resolves within this test — stands in for a report generation
      // still in flight when the fixed window elapses.
      void new Promise<void>(() => {}).then(() => {});
    };
    const { element, setImageExportEnabled } = buildExportDeliverables({
      onExport: noop,
      onExportImage: noop,
      onExportReport: () => { startReal(); }, // void: nothing returned
    });
    setImageExportEnabled(true);
    const select = q(element, '.olv-report-select');
    select.value = DEFAULT_TEMPLATE_ID;
    const reportBtn = qAll(element, '.olv-export-btn').find((b) => b.textContent === 'Report PDF');

    reportBtn.click();
    expect(realRuns).toBe(1);
    expect(reportBtn.disabled).toBe(true);

    vi.runAllTimers(); // the fixed window elapses; the real work is still running
    expect(reportBtn.disabled, 'the guard releases on its timer regardless of the real work').toBe(false);

    reportBtn.click(); // a second, genuine click while report #1 is still in flight
    expect(
      realRuns,
      'a void callback whose real work outlives the fixed window gets no duplicate-click protection once the window elapses',
    ).toBe(2);
    vi.useRealTimers();
  });
});
