/**
 * navPrefs.ts
 *
 * The user's navigation-handedness preferences, plus the pure helpers the
 * settings panel, the persistence layer, and the custom orbit handler share.
 *
 * WHY this is its own module: OLV's primary orbit gesture (mouse-drag / one
 * finger) is handled entirely inside three.js `OrbitControls`, which OLV never
 * sees the delta from and whose `rotateSpeed` is a single scalar — it cannot
 * invert X and Y independently. Independent invert-X / invert-Y therefore needs
 * a small custom orbit handler in `NavController` (it takes the drag away from
 * OrbitControls, the same way the hand tool does). This module holds only the
 * pure, unit-tested parts: the preference schema, its validating parser, and
 * the preset → sign mapping. The delta → signed-angle math lives beside the
 * rest of the camera maths in `navMath.ts` (`orbitDragAngles`).
 *
 * Pure — no DOM, no three.js — so it is testable in Node and safe for the
 * shell chunk to import (mirrors how `prefs.ts` imports `parseWorkflowConfig`).
 */

/**
 * A named starting point for the invert signs. The invert flags are the source
 * of truth for behaviour; a preset is just a convenience that sets them.
 *
 *  - **default** — OLV's shipped convention (no inversion).
 *  - **recap** — Autodesk ReCap-style: vertical orbit inverted. This is the
 *    common "feels inverted vs CAD" case a validator hits.
 *  - **nira** — Nira is a browser point-cloud viewer whose orbit already
 *    matches OLV's convention, so it maps to no inversion too.
 */
export type NavigationPreset = 'default' | 'recap' | 'nira';

/** The persisted navigation-handedness preferences. */
export interface NavigationPreferences {
  /** Invert the horizontal (yaw) orbit direction. */
  invertOrbitX: boolean;
  /** Invert the vertical (pitch) orbit direction. */
  invertOrbitY: boolean;
  /** The last-selected preset. A convenience label; the flags above win. */
  preset: NavigationPreset;
}

/** The shipped defaults — no inversion, default preset. */
export const DEFAULT_NAVIGATION_PREFERENCES: NavigationPreferences = {
  invertOrbitX: false,
  invertOrbitY: false,
  preset: 'default',
};

/** The presets the panel offers (kept in sync with {@link NavigationPreset}). */
const NAV_PRESETS: ReadonlySet<NavigationPreset> = new Set(['default', 'recap', 'nira']);

/**
 * The invert signs each preset selects. These sign combos are the ADJUSTABLE
 * product choice — the one place to retune what "ReCap" or "Nira" should feel
 * like without touching the handler. `recap` inverts the vertical axis only;
 * `default` and `nira` match OLV's current convention.
 */
export function navPresetSigns(
  preset: NavigationPreset,
): { invertOrbitX: boolean; invertOrbitY: boolean } {
  switch (preset) {
    case 'recap':
      return { invertOrbitX: false, invertOrbitY: true };
    case 'nira':
      return { invertOrbitX: false, invertOrbitY: false };
    case 'default':
    default:
      return { invertOrbitX: false, invertOrbitY: false };
  }
}

/**
 * Validate a raw persisted value into a complete {@link NavigationPreferences},
 * defaulting every field independently so a partial or corrupt record degrades
 * gracefully rather than throwing. A malformed boolean becomes `false`; an
 * unknown preset becomes `'default'`. Never throws.
 */
export function parseNavigationPreferences(raw: unknown): NavigationPreferences {
  const d = DEFAULT_NAVIGATION_PREFERENCES;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...d };
  const o = raw as Record<string, unknown>;
  return {
    invertOrbitX: typeof o.invertOrbitX === 'boolean' ? o.invertOrbitX : d.invertOrbitX,
    invertOrbitY: typeof o.invertOrbitY === 'boolean' ? o.invertOrbitY : d.invertOrbitY,
    preset: NAV_PRESETS.has(o.preset as NavigationPreset)
      ? (o.preset as NavigationPreset)
      : d.preset,
  };
}
