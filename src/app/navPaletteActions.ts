/**
 * navPaletteActions.ts — the command-palette navigation handlers, lifted out of
 * main.ts so the shell stays thin.
 *
 * Toggling the orbit "gyroscope" (invert X / Y) or resetting navigation from the
 * palette must keep every surface in agreement — the viewer, the Inspector chips,
 * and localStorage — which is exactly what {@link toggleNavInvert} /
 * {@link resetNavPrefs} do. This wraps them with the user-facing toast so the
 * registry deps are two plain functions.
 */

import { toggleNavInvert, resetNavPrefs } from '../render/navPrefsWiring';
import type { NavigationPreferences } from '../render/navPrefs';

interface NavPrefsViewer {
  setNavigationPreferences(prefs: NavigationPreferences): void;
}
interface NavPrefsInspector {
  syncNavigationPrefs(prefs: NavigationPreferences): void;
}

export interface NavPaletteDeps {
  readonly viewer: NavPrefsViewer;
  readonly inspector: NavPrefsInspector;
  readonly persist: () => void;
  readonly toast: (message: string) => void;
}

export interface NavPaletteActions {
  toggleOrbitInvert: (axis: 'x' | 'y') => void;
  resetNavigation: () => void;
}

/** Build the two nav command-palette handlers bound to the live shell objects. */
export function makeNavPaletteActions(deps: NavPaletteDeps): NavPaletteActions {
  return {
    toggleOrbitInvert: (axis) => {
      const next = toggleNavInvert(axis, deps.viewer, deps.inspector, deps.persist);
      const on = axis === 'y' ? next.invertOrbitY : next.invertOrbitX;
      deps.toast(`${axis === 'y' ? 'Vertical' : 'Horizontal'} orbit invert ${on ? 'on' : 'off'}.`);
    },
    resetNavigation: () => {
      resetNavPrefs(deps.viewer, deps.inspector, deps.persist);
      deps.toast('Navigation reset to defaults.');
    },
  };
}
