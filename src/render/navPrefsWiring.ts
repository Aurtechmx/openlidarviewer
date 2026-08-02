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
