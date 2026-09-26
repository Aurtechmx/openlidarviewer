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
 *  - **default**: OLV's shipped convention, vertical orbit inverted and
 *    horizontal not. Dragging down raises the viewpoint.
 *  - **invert-vertical**: the same signs as `default`, named for what it does
 *    so it stays meaningful if the shipped default ever changes.
 *  - **no-invert**: neither axis inverted.
 *
 * Earlier builds stored the ids `recap` and `nira` for the last two;
 * {@link parseNavigationPreferences} maps them through {@link LEGACY_NAV_PRESETS}.
 */
export type NavigationPreset = 'default' | 'invert-vertical' | 'no-invert';

/** Preset ids written by earlier builds, and the preset each now means. */
export const LEGACY_NAV_PRESETS: Readonly<Record<string, NavigationPreset>> = {
  recap: 'invert-vertical',
  nira: 'no-invert',
};

/** The persisted navigation-handedness preferences. */
export interface NavigationPreferences {
  /** Invert the horizontal (yaw) orbit direction. */
  invertOrbitX: boolean;
  /** Invert the vertical (pitch) orbit direction. */
  invertOrbitY: boolean;
  /** The last-selected preset. A convenience label; the flags above win. */
  preset: NavigationPreset;
}

/**
 * The shipped defaults: vertical orbit inverted, horizontal not.
 *
 * `parseNavigationPreferences` falls back to these field by field, so a user
 * who has never touched the setting gets the inverted vertical axis, while a
 * stored preference of either sign is preserved exactly as written.
 */
export const DEFAULT_NAVIGATION_PREFERENCES: NavigationPreferences = {
  invertOrbitX: false,
  invertOrbitY: true,
  preset: 'default',
};

/** The presets the panel offers (kept in sync with {@link NavigationPreset}). */
const NAV_PRESETS: ReadonlySet<NavigationPreset> = new Set(['default', 'invert-vertical', 'no-invert']);

/**
 * The invert signs each preset selects. These sign combos are the ADJUSTABLE
 * product choice, the one place to retune a preset without touching the
 * handler. `default` and `invert-vertical` both invert the vertical axis only;
 * `no-invert` inverts neither.
 */
export function navPresetSigns(
  preset: NavigationPreset,
): { invertOrbitX: boolean; invertOrbitY: boolean } {
  switch (preset) {
    case 'invert-vertical':
      return { invertOrbitX: false, invertOrbitY: true };
    case 'no-invert':
      return { invertOrbitX: false, invertOrbitY: false };
    case 'default':
    default:
      return { invertOrbitX: false, invertOrbitY: true };
  }
}

/**
 * Validate a raw persisted value into a complete {@link NavigationPreferences},
 * defaulting every field independently so a partial or corrupt record degrades
 * gracefully rather than throwing. A malformed boolean becomes `false`; a
 * legacy preset id is mapped to its current name; an unknown preset becomes
 * `'default'`. Never throws.
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
      : typeof o.preset === 'string' && Object.hasOwn(LEGACY_NAV_PRESETS, o.preset)
        ? LEGACY_NAV_PRESETS[o.preset]
        : d.preset,
  };
}
