/**
 * viewActions.ts
 *
 * Theme, the compass, orbit handedness, and named view states. The theme
 * setter, the compass controller, the bookmarks and the shell's save/apply
 * are its whole surface.
 */
import type { Action } from '../../ui/actionRegistry';
import type { WorkflowController } from '../../ui/WorkflowController';
import type { CompassController } from '../../ui/compassController';
import type { ViewBookmarksService } from '../viewBookmarks';
import { THEME_LABEL, THEME_ORDER, type ThemeName } from '../../ui/themes';
import { keyDisplayFor } from '../../ui/keyBindings';

export interface ViewActionDeps {
  setTheme: (name: ThemeName) => void;
  capture: WorkflowController['capture'];
  compass: CompassController;
  bookmarks: ViewBookmarksService;
  /** Flip one mouse-orbit invert axis (the "gyroscope" handedness). Persists. */
  toggleOrbitInvert: (axis: 'x' | 'y') => void;
  /** Return orbit navigation to the shipped defaults. */
  resetNavigation: () => void;
  hasScan: () => boolean;
  saveCurrentView: () => void;
  applyView: (index: number) => void;
  showLassoToast: (message: string) => void;
}

export function contributeViewActions(deps: ViewActionDeps): Action[] {
  const actions: Action[] = [];
  // Theme, same handler as the header theme toggle. `setTheme` keeps the
  // toggle's icon in sync.
  for (const name of THEME_ORDER) {
    actions.push({
      id: `theme.${name}`,
      title: `${THEME_LABEL[name]} theme`,
      section: 'Theme',
      hint: 'Switch the palette of the whole interface.',
      keywords: ['appearance', 'colours', 'colors', 'accessibility'],
      run: () => {
        deps.setTheme(name);
        deps.capture({ type: 'theme', name });
      },
    });
  }
  actions.push(
    {
      id: 'view.compass',
      title: 'Toggle compass',
      section: 'View',
      hint: 'Show or hide the on-canvas compass — north plus the standard-view snaps.',
      keywords: ['compass', 'viewcube', 'north', 'rose', 'orientation', 'heading', 'gizmo'],
      run: () => deps.compass.setEnabled(!deps.compass.isEnabled()),
    },
    {
      id: 'nav.invert-vertical',
      title: 'Invert vertical orbit',
      section: 'View',
      hint: 'Flip the up / down mouse-orbit direction — the common "feels inverted vs CAD" fix. Persists.',
      keywords: ['invert', 'vertical', 'pitch', 'orbit', 'mouse', 'gyroscope', 'handedness', 'camera', 'navigation'],
      run: () => deps.toggleOrbitInvert('y'),
    },
    {
      id: 'nav.invert-horizontal',
      title: 'Invert horizontal orbit',
      section: 'View',
      hint: 'Flip the left / right mouse-orbit direction. Persists.',
      keywords: ['invert', 'horizontal', 'yaw', 'orbit', 'mouse', 'gyroscope', 'handedness', 'camera', 'navigation'],
      run: () => deps.toggleOrbitInvert('x'),
    },
    {
      id: 'nav.reset',
      title: 'Reset navigation to defaults',
      section: 'View',
      hint: 'Return orbit handedness to the shipped defaults.',
      keywords: ['reset', 'navigation', 'orbit', 'invert', 'defaults', 'handedness', 'gyroscope'],
      run: () => deps.resetNavigation(),
    },
    {
      id: 'view.save-state',
      title: 'Save view state',
      section: 'View',
      keys: keyDisplayFor('save-view'),
      hint: 'Bookmark the camera plus clip box, colour mode, class filter, point filters, and render settings as a named, restorable state.',
      keywords: ['bookmark', 'viewpoint', 'saved view', 'figure', 'state', 'capture'],
      run: () => {
        if (!deps.hasScan()) {
          deps.showLassoToast('Load a scan first — a view state captures the open scan.');
          return;
        }
        deps.saveCurrentView();
        const name = deps.bookmarks.get(deps.bookmarks.count() - 1)?.name ?? 'View';
        deps.showLassoToast(`View state saved — “${name}” (rename it in the panel list).`);
      },
    },
    {
      id: 'view.restore-state',
      title: 'Restore view state',
      section: 'View',
      hint: 'Reapply the most recently saved view state — the panel list restores any of them by name.',
      keywords: ['bookmark', 'viewpoint', 'saved view', 'figure', 'state', 'apply', 'go to'],
      run: () => {
        if (deps.bookmarks.count() === 0) {
          deps.showLassoToast('No saved view states yet — save one first (V).');
          return;
        }
        deps.applyView(deps.bookmarks.count() - 1);
      },
    },
  );
  return actions;
}
