/**
 * helpActions.ts
 *
 * The onboarding tour replay, the keyboard shortcut sheet and Copy diagnostics.
 */
import type { Action } from '../../ui/actionRegistry';
import type { TourHandle } from '../../ui/onboarding/bootTour';
import type { ShortcutSheet } from '../../ui/ShortcutSheet';
import { keyDisplayFor } from '../../ui/keyBindings';
import { loadCopyDiagnostics } from '../../lazyChunks';
import type { DiagnosticsViewer } from '../diagnostics/copyDiagnostics';

export interface HelpActionDeps {
  getTour: () => TourHandle | null;
  ensureShortcutSheet: () => Promise<ShortcutSheet>;
  /** The live Viewer, or nothing before the first scan opens. */
  getViewer?: () => DiagnosticsViewer | null | undefined;
  /** Short status message to the user. */
  notify?: (message: string) => void;
}

export function contributeHelpActions(deps: HelpActionDeps): Action[] {
  const actions: Action[] = [];
  actions.push(
    {
      id: 'tour.replay',
      title: 'Replay onboarding tour',
      section: 'Help',
      hint: 'Walks through the main tools — about 30 seconds.',
      keywords: ['onboarding', 'tour', 'help', 'tutorial', 'guide', 'walkthrough'],
      run: () => deps.getTour()?.replay(),
    },
    {
      id: 'help.shortcuts',
      title: 'Show keyboard shortcuts',
      section: 'Help',
      keys: keyDisplayFor('shortcut-sheet'),
      hint: 'Every action and key, grouped by section.',
      keywords: ['shortcuts', 'keys', 'bindings', 'help', 'cheat', 'sheet'],
      // Failure is already reported through the shared toast/retry path inside
      // ensureShortcutSheet(); the .catch here only stops that rejection from
      // surfacing as an unhandled promise rejection.
      run: () => void deps.ensureShortcutSheet().then((sheet) => sheet.open()).catch(() => {}),
    },
    {
      id: 'help.copy-diagnostics',
      title: 'Copy diagnostics',
      section: 'Help',
      hint: 'Copies a technical report for a bug report: build, browser, graphics backend and recent errors. No file names, links or coordinates.',
      keywords: ['diagnostics', 'debug', 'bug', 'report', 'support', 'copy', 'errors', 'build'],
      run: () => {
        const notify = deps.notify ?? (() => {});
        void loadCopyDiagnostics()
          .then((m) => m.copyDiagnostics(deps.getViewer ?? (() => null), notify))
          .catch(() => notify('Could not load the diagnostics report. Nothing was changed. Reload the page and try again.'));
      },
    },
  );
  return actions;
}
