/**
 * exportActions.ts
 *
 * Snapshot, view link, the export health check and the integrity-report
 * verifier. The verifier chunk loads on demand.
 */
import type { Action } from '../../ui/actionRegistry';
import { buildExportHealth, type ScanStoryInputs } from '../../intelligence/scanStory';
import { renderExportHealthPanel } from '../../ui/scanStoryViews';
import { openModal } from '../../ui/Modal';
import { el } from '../../ui/dom';
import { loadReportVerifier } from '../../lazyChunks';
import { actionTitle } from '../../ui/actionDescriptors';
import { runWithRetry, type LazyLoadToast } from '../lazySurfaceLoad';

export interface ExportActionDeps {
  /**
   * Save the current view as a PNG, and copy a link back to it. The tool dock
   * is otherwise the ONLY route to either: neither carries a shortcut, so
   * without these the palette cannot reach them and demoting them out of the
   * dock would leave them unreachable.
   */
  saveSnapshot: () => void | Promise<void>;
  copyShareLink: () => void | Promise<void>;
  buildCurrentStoryInputs: () => ScanStoryInputs;
  /** Where a failed verifier load shows, with a Try again action. */
  showLassoToast: LazyLoadToast['show'];
}

export function contributeExportActions(deps: ExportActionDeps): Action[] {
  const actions: Action[] = [];
  actions.push(
    {
      id: 'tool.snapshot',
      title: actionTitle('tool.snapshot'),
      section: 'Export',
      hint: 'Write the current view to a PNG, with the scan and scale recorded on it.',
      keywords: ['snapshot', 'screenshot', 'png', 'image', 'capture', 'save view'],
      run: () => {
        void deps.saveSnapshot();
      },
    },
    {
      id: 'tool.share',
      title: actionTitle('tool.share'),
      section: 'Export',
      hint: 'Copy a link that reopens this camera position and appearance.',
      keywords: ['share', 'link', 'copy', 'url', 'view', 'permalink'],
      run: () => {
        void deps.copyShareLink();
      },
    },
    {
      id: 'export.health',
      title: 'Export health check',
      section: 'Export',
      hint: 'What is about to leave the app: scope, classification, CRS, datum, density, readiness.',
      keywords: ['export', 'health', 'check', 'hand-off', 'ready', 'before export'],
      run: () => {
        openModal({ title: 'Export health check', body: renderExportHealthPanel(buildExportHealth(deps.buildCurrentStoryInputs())) });
      },
    },
    {
      id: 'report.verify',
      title: 'Verify report with verification checksum…',
      section: 'Export',
      hint: 'Check a report JSON — confirm its digest still matches its contents.',
      keywords: ['integrity', 'digest', 'tamper', 'check', 'sha', 'validate', 'verify'],
      run: () => {
        const input = el('input', { className: 'olv-hidden' });
        input.type = 'file';
        input.accept = '.json,application/json';
        // A dismissed picker fires `cancel` and no `change`.
        input.addEventListener('cancel', () => input.remove());
        input.addEventListener('change', () => {
          const file = input.files?.[0];
          input.remove();
          if (!file) return;
          // A failed chunk reaches the shared lazy-load toast, whose Try again verifies the same file.
          runWithRetry({ show: deps.showLassoToast }, () => loadReportVerifier().then(({ verifyAndShow }) => verifyAndShow(file)), 'report verifier');
        });
        document.body.append(input);
        input.click();
      },
    },
  );
  return actions;
}
