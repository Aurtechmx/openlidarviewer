/**
 * findingsPanel.ts — the durable project findings ledger surface.
 *
 * Measurements and volume/change results are computed ad-hoc and shown in
 * toasts; the integrity report already assembles the LIVE measurements at export
 * time. This panel is the step between: a person collects the results worth
 * keeping into a {@link SessionFindings} ledger — each a number WITH its band and
 * caveats — reviews them, drops the ones they do not want, and exports the whole
 * ledger as the existing SHA-256 integrity report. No second report engine: the
 * host wires the export to `buildReportManifest`.
 *
 * Pure DOM (via {@link el}); the collection source and the export/download are
 * injected so the panel is host-agnostic and unit-testable against a fake DOM.
 * The ledger is session-scoped: it is not persisted across sessions here (a
 * durable project store is separate, larger work).
 */

import type { ReportFinding } from '../render/measure/reportManifest';
import type { ClearedFindings, SessionFindings } from '../render/measure/sessionFindings';
import { el } from './dom';

/**
 * What an export attempt did. `refused` means the host declined and has
 * already explained why in its own status, so the panel adds nothing.
 */
export type FindingsExportResult = 'downloaded' | 'refused' | 'failed';

export interface FindingsPanelDeps {
  /** The session ledger this panel renders and mutates. */
  readonly findings: SessionFindings;
  /**
   * The findings to append when the reviewer clicks "Add current measurements"
   * — the host converts the live measurements via `measurementsToFindings`.
   * Async because the converter lives in a lazily-loaded chunk. Returns an empty
   * array when there is nothing to add.
   */
  readonly collectMeasurements: () => Promise<readonly ReportFinding[]>;
  /**
   * Export the ledger as the integrity report. The host builds the manifest
   * (SHA-256) and triggers the download; the panel only decides WHEN and passes
   * the current ledger snapshot, and reports only what the host says happened.
   */
  readonly exportReport: (findings: readonly ReportFinding[]) => Promise<FindingsExportResult>;
}

export interface MountedFindingsPanel {
  readonly element: HTMLElement;
  /** Re-render from the current ledger (call after an external add). */
  readonly refresh: () => void;
}

/** Format a finding's value + unit, with its ± band when present. */
function formatValue(f: ReportFinding): string {
  const v = f.value !== null && Number.isFinite(f.value) ? f.value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—';
  const band = f.sigma != null && Number.isFinite(f.sigma) ? ` ± ${f.sigma.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '';
  return `${v}${band} ${f.unit}`.trim();
}

/**
 * Build the findings panel. Returns its root element and a `refresh` so a host
 * that mutates the ledger elsewhere can re-render it.
 */
export function buildFindingsPanel(deps: FindingsPanelDeps): MountedFindingsPanel {
  const { findings } = deps;
  const root = el('div', { className: 'olv-findings-panel' });
  const header = el('div', { className: 'olv-findings-head' });
  const list = el('div', { className: 'olv-findings-list' });
  const actions = el('div', { className: 'olv-findings-actions' });

  const addBtn = el('button', { className: 'olv-bc-pill olv-export-product-btn olv-findings-add', text: 'Add current measurements' });
  addBtn.type = 'button';
  addBtn.title = 'Append the placed measurements to the saved findings, each with its band and caveats.';
  const exportBtn = el('button', { className: 'olv-bc-pill olv-export-product-btn olv-findings-export', text: 'Export findings report' });
  exportBtn.type = 'button';
  exportBtn.title = 'Export the saved findings as the integrity report (JSON, SHA-256 content digest).';
  const clearBtn = el('button', { className: 'olv-bc-pill olv-export-product-btn olv-findings-clear', text: 'Clear all' });
  clearBtn.type = 'button';
  clearBtn.title = 'Empty the saved findings for this scan. Undo is offered afterwards. Exported reports are unaffected.';
  const status = el('div', { className: 'olv-findings-status', text: '' });
  // Every write below (add / nothing-to-add / remove / export / clear) lands
  // here, so assistive tech needs one live-region wiring for all of them.
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  actions.append(addBtn, exportBtn, clearBtn);

  let exporting = false;
  let undoOffer: ClearedFindings | null = null;
  const setStatus = (text: string): void => {
    undoOffer = null;
    status.replaceChildren();
    status.textContent = text;
  };

  const render = (): void => {
    const all = findings.all;
    header.textContent = `Findings — ${all.length}`;
    list.replaceChildren();
    if (all.length === 0) {
      list.append(el('p', { className: 'olv-findings-empty', text: 'No findings yet. Add current measurements to start the ledger.' }));
    } else {
      all.forEach((f, i) => {
        const row = el('div', { className: 'olv-findings-row' });
        row.append(el('div', { className: 'olv-findings-label', text: f.label }));
        row.append(el('div', { className: 'olv-findings-value', text: formatValue(f) }));
        if (f.confidence) {
          row.append(el('div', { className: 'olv-findings-confidence', text: `confidence: ${f.confidence}` }));
        }
        if (f.caveats && f.caveats.length > 0) {
          // Caveats are the honesty notes — kept inspectable, not dropped.
          row.append(el('div', { className: 'olv-findings-caveats', text: f.caveats.join(' ') }));
        }
        const remove = el('button', { className: 'olv-findings-remove', text: 'Remove' });
        remove.type = 'button';
        remove.setAttribute('aria-label', `Remove ${f.label}`);
        remove.addEventListener('click', () => {
          findings.remove(i);
          setStatus('');
          render();
        });
        row.append(remove);
        list.append(row);
      });
    }
    // Export only means something with at least one finding.
    exportBtn.disabled = exporting || all.length === 0;
    clearBtn.disabled = all.length === 0;
  };

  addBtn.addEventListener('click', () => {
    addBtn.disabled = true;
    void deps
      .collectMeasurements()
      .then((toAdd) => {
        if (toAdd.length === 0) {
          setStatus('No placed measurements to add.');
          return;
        }
        for (const f of toAdd) findings.add(f);
        setStatus(`Added ${toAdd.length} measurement finding(s).`);
        render();
      })
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error('OpenLiDARViewer: could not collect the current measurements.', err);
        setStatus('Could not read the current measurements. Try again.');
      })
      .finally(() => {
        addBtn.disabled = false;
      });
  });

  exportBtn.addEventListener('click', () => {
    if (exporting || findings.all.length === 0) return;
    exporting = true;
    exportBtn.disabled = true;
    setStatus('');
    const fail = (err?: unknown): void => {
      if (err !== undefined) {
        // eslint-disable-next-line no-console
        console.error('OpenLiDARViewer: could not export the findings report.', err);
      }
      setStatus('Could not export the findings report. Your findings are kept. Try again.');
    };
    // Called at once; an async wrapper turns a synchronous throw into a rejection.
    const runExport = async (): Promise<FindingsExportResult> => deps.exportReport(findings.all);
    void runExport()
      .then((r) => {
        if (r === 'downloaded') setStatus('Report download started.');
        else if (r === 'failed') fail();
        // 'refused': the host has already said why; say nothing contradictory.
      })
      .catch(fail)
      .finally(() => {
        exporting = false;
        render();
      });
  });

  clearBtn.addEventListener('click', () => {
    const cleared = findings.clear();
    render();
    if (cleared.findings.length === 0) return;
    setStatus(`Cleared ${cleared.findings.length} finding(s). `);
    const undo = el('button', { className: 'olv-findings-undo', text: 'Undo' });
    undo.type = 'button';
    undo.title = 'Restore the findings you just cleared.';
    undo.addEventListener('click', () => {
      if (undoOffer !== cleared) return;
      findings.restore(cleared);
      setStatus(`Restored ${cleared.findings.length} finding(s).`);
      render();
    });
    status.append(undo);
    undoOffer = cleared;
  });

  render();
  root.append(header, list, actions, status);
  return { element: root, refresh: render };
}
