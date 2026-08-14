/**
 * navPrefsWiring.ts
 *
 * Owns the live navigation-preference state and the persist/restore/callback
 * glue between the settings panel, the viewer, and localStorage — kept out of
 * the shell so main.ts stays a thin caller. The schema and pure helpers live in
 * navPrefs.ts. Handedness is not part of the session bundle, so restoring a
 * session never stomps it.
 */

import {
  DEFAULT_NAVIGATION_PREFERENCES,
  type NavigationPreferences,
} from './navPrefs';

interface NavPrefsViewer {
  setNavigationPreferences(prefs: NavigationPreferences): void;
}
interface NavPrefsInspector {
  syncNavigationPrefs(prefs: NavigationPreferences): void;
}

let current: NavigationPreferences = { ...DEFAULT_NAVIGATION_PREFERENCES };

/** The live prefs — the persist source of truth. */
export const navigationPrefs = (): NavigationPreferences => current;

/** Panel edited the prefs: store, apply to the viewer, persist. */
export function applyNavPrefsChange(
  prefs: NavigationPreferences,
  viewer: NavPrefsViewer,
  persist: () => void,
): void {
  current = prefs;
  viewer.setNavigationPreferences(prefs);
  persist();
}

/** Restore saved prefs on load: store, apply, re-sync the panel silently. */
export function restoreNavPrefs(
  prefs: NavigationPreferences,
  viewer: NavPrefsViewer,
  inspector: NavPrefsInspector,
): void {
  current = prefs;
  viewer.setNavigationPreferences(prefs);
  inspector.syncNavigationPrefs(prefs);
}

/**
 * Flip one orbit-invert axis from an external control (command palette, the
 * viewport nav control) and keep every surface in agreement: apply to the
 * viewer, re-sync the Inspector chips, and persist. Only the toggled axis
 * changes; `preset` is preserved because the flags are the source of truth (a
 * hand-toggle keeps whatever preset label was showing). Returns the new prefs so
 * a caller can reflect the resulting on/off state (e.g. a toast).
 */
export function toggleNavInvert(
  axis: 'x' | 'y',
  viewer: NavPrefsViewer,
  inspector: NavPrefsInspector,
  persist: () => void,
): NavigationPreferences {
  const next: NavigationPreferences = {
    invertOrbitX: axis === 'x' ? !current.invertOrbitX : current.invertOrbitX,
    invertOrbitY: axis === 'y' ? !current.invertOrbitY : current.invertOrbitY,
    preset: current.preset,
  };
  current = next;
  viewer.setNavigationPreferences(next);
  inspector.syncNavigationPrefs(next);
  persist();
  return next;
}

/** Return orbit navigation to the shipped defaults from an external control. */
export function resetNavPrefs(
  viewer: NavPrefsViewer,
  inspector: NavPrefsInspector,
  persist: () => void,
): NavigationPreferences {
  current = { ...DEFAULT_NAVIGATION_PREFERENCES };
  viewer.setNavigationPreferences(current);
  inspector.syncNavigationPrefs(current);
  persist();
  return current;
}
