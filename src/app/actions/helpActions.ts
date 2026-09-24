/**
 * helpActions.ts
 *
 * The onboarding tour replay and the keyboard shortcut sheet.
 */
import type { Action } from '../../ui/actionRegistry';
import type { TourHandle } from '../../ui/onboarding/bootTour';
import type { ShortcutSheet } from '../../ui/ShortcutSheet';
import { keyDisplayFor } from '../../ui/keyBindings';

export interface HelpActionDeps {
  getTour: () => TourHandle | null;
  ensureShortcutSheet: () => Promise<ShortcutSheet>;
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
  );
  return actions;
}
