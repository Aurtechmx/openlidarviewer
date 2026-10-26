/**
 * exportActions.ts
 *
 * Snapshot, view link, the session file, the PDF report, opening a scan, the
 * export health check and the integrity-report verifier. The verifier chunk
 * loads on demand.
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
  copyShareLink: () => void | Promise<unknown>;
  /** Write the .olvsession file, as the Measurements panel's Save session does. */
  exportSession: () => unknown;
  /** Open a picked file through the one file router, so a session or a scan lands the same way as a drop. */
  handleFile: (file: File) => unknown;
  /** Open the device file picker the empty state and "+ Add dataset" use. */
  openScan: () => void;
  /** The PDF report with the default template, as the Export panel runs it. */
  exportReport: () => void | Promise<void>;
  buildCurrentStoryInputs: () => ScanStoryInputs;
  /** Where a failed verifier load shows, with a Try again action. */
  showLassoToast: LazyLoadToast['show'];
}

/** A hidden file input for one pick; `cancel` and `change` both remove it. */
function pickFile(accept: string, onFile: (file: File) => void): void {
  const input = el('input', { className: 'olv-hidden' });
  input.type = 'file';
  input.accept = accept;
  // A dismissed picker fires `cancel` and no `change`.
  input.addEventListener('cancel', () => input.remove());
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.remove();
    if (file) onFile(file);
  });
  document.body.append(input);
  input.click();
}

export function contributeExportActions(deps: ExportActionDeps): Action[] {
  const actions: Action[] = [];
  actions.push(
    {
      id: 'scan.open',
      title: actionTitle('scan.open'),
      section: 'Data',
      hint: 'Open a point cloud from this device.',
      keywords: ['open', 'scan', 'file', 'load', 'import', 'las', 'laz', 'e57', 'ply', 'add dataset'],
      run: () => {
        deps.openScan();
      },
    },
    {
      id: 'session.open',
      title: actionTitle('session.open'),
      section: 'Data',
      hint: 'Open a saved .olvsession beside the same scan file.',
      keywords: ['open', 'session', 'olvsession', 'restore', 'load', 'import', 'measurements', 'annotations', 'views'],
      run: () => {
        pickFile('.olvsession,application/json', (file) => void deps.handleFile(file));
      },
    },
    {
      id: 'session.export',
      title: actionTitle('session.export'),
      section: 'Export',
      hint: 'Save measurements, annotations and views as an .olvsession file.',
      keywords: ['save', 'session', 'olvsession', 'export', 'measurements', 'annotations', 'views', 'json'],
      run: () => {
        void deps.exportSession();
      },
    },
    {
      id: 'report.pdf',
      title: actionTitle('report.pdf'),
      section: 'Export',
      hint: 'Write the scan report as a PDF with the default template.',
      keywords: ['report', 'pdf', 'export', 'document', 'summary', 'deliverable'],
      run: () => {
        void deps.exportReport();
      },
    },
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
      keywords: ['verify integrity report', 'integrity', 'digest', 'checksum', 'tamper', 'check', 'sha', 'validate', 'verify'],
      run: () => {
        // A failed chunk reaches the shared lazy-load toast, whose Try again verifies the same file.
        pickFile('.json,application/json', (file) =>
          runWithRetry({ show: deps.showLassoToast }, () => loadReportVerifier().then(({ verifyAndShow }) => verifyAndShow(file)), 'report verifier'));
      },
    },
  );
  return actions;
}
