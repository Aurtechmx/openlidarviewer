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
}

export function contributeExportActions(deps: ExportActionDeps): Action[] {
  const actions: Action[] = [];
  actions.push(
    {
      id: 'tool.snapshot',
      title: 'Save a snapshot',
      section: 'Export',
      hint: 'Write the current view to a PNG, with the scan and scale recorded on it.',
      keywords: ['snapshot', 'screenshot', 'png', 'image', 'capture', 'save view'],
      run: () => {
        void deps.saveSnapshot();
      },
    },
    {
      id: 'tool.share',
      title: 'Copy view link',
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
      title: 'Verify integrity report…',
      section: 'Export',
      hint: 'Check a report JSON — confirm its digest still matches its contents.',
      keywords: ['integrity', 'digest', 'tamper', 'check', 'sha', 'validate', 'verify'],
      run: () => {
        const input = el('input', { className: 'olv-hidden' });
        input.type = 'file';
        input.accept = '.json,application/json';
        input.addEventListener('change', () => {
          const file = input.files?.[0];
          input.remove();
          if (!file) return;
          void loadReportVerifier()
            .then(({ verifyAndShow }) => verifyAndShow(file))
            // A chunk-load failure must not surface as an unhandled rejection.
            .catch((err) => console.warn('[verify] report-verifier chunk failed to load', err));
        });
        document.body.append(input);
        input.click();
      },
    },
  );
  return actions;
}
