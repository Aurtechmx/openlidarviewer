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
import type { SessionFindings } from '../render/measure/sessionFindings';
import { el } from './dom';

export interface FindingsPanelDeps {
  /** The session ledger this panel renders and mutates. */
  readonly findings: SessionFindings;
  /**
   * The findings to append when the reviewer clicks "Add current measurements"
   * — the host converts the live measurements via `measurementsToFindings`.
   * Returns an empty array when there is nothing to add.
   */
  readonly collectMeasurements: () => readonly ReportFinding[];
  /**
   * Export the ledger as the integrity report. The host builds the manifest
   * (SHA-256) and triggers the download; the panel only decides WHEN and passes
   * the current ledger snapshot.
   */
  readonly exportReport: (findings: readonly ReportFinding[]) => void;
}

export interface MountedFindingsPanel {
  readonly element: HTMLElement;
  /** Re-render from the current ledger (call after an external add). */
  readonly refresh: () => void;
}

/** Format a finding's value + unit, with its ± band when present. */
function formatValue(f: ReportFinding): string {
  const v = Number.isFinite(f.value) ? f.value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—';
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

  const addBtn = el('button', { className: 'olv-findings-add', text: 'Add current measurements' });
  addBtn.type = 'button';
  addBtn.title = 'Append the placed measurements to the findings ledger, each with its band and caveats.';
  const exportBtn = el('button', { className: 'olv-findings-export', text: 'Export findings report' });
  exportBtn.type = 'button';
  exportBtn.title = 'Export the whole ledger as the tamper-evident integrity report (JSON, SHA-256 digest).';
  const clearBtn = el('button', { className: 'olv-findings-clear', text: 'Clear all' });
  clearBtn.type = 'button';
  const status = el('div', { className: 'olv-findings-status', text: '' });
  actions.append(addBtn, exportBtn, clearBtn);

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
          status.textContent = '';
          render();
        });
        row.append(remove);
        list.append(row);
      });
    }
    // Export only means something with at least one finding.
    exportBtn.disabled = all.length === 0;
    clearBtn.disabled = all.length === 0;
  };

  addBtn.addEventListener('click', () => {
    const toAdd = deps.collectMeasurements();
    if (toAdd.length === 0) {
      status.textContent = 'No placed measurements to add.';
      return;
    }
    for (const f of toAdd) findings.add(f);
    status.textContent = `Added ${toAdd.length} measurement finding(s).`;
    render();
  });

  exportBtn.addEventListener('click', () => {
    if (findings.all.length === 0) return;
    deps.exportReport(findings.all);
    status.textContent = `Exported a report of ${findings.all.length} finding(s).`;
  });

  clearBtn.addEventListener('click', () => {
    findings.clear();
    status.textContent = 'Cleared the findings ledger.';
    render();
  });

  render();
  root.append(header, list, actions, status);
  return { element: root, refresh: render };
}
