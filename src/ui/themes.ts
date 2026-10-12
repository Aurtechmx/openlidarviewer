/**
 * themes.ts
 *
 * Pure data layer for the interface palettes. Three are active:
 *
 *   - dark            labelled Blue: the default root palette, no body class
 *   - field           graphite surfaces and teal accents (`olv-theme-field`)
 *   - high-contrast   pure black, opaque surfaces, solid borders
 *                     (`olv-theme-high-contrast`)
 *
 * The retired `light` identifier is still read so a saved preference or a
 * recorded workflow keeps working: it normalises to `field`.
 *
 * This module owns the registry and the persistence I/O. The colour overrides
 * live in `src/styles/03-theme-rails.css`, keyed on the body classes below.
 * `applyTheme(name)` is a pure body-class swap: no inline styles and no
 * CSS-variable writes from JS. Interface palettes are separate from the point
 * cloud's RGB appearance presets, data colormaps and report themes.
 *
 * Persistence: the choice round-trips through `localStorage.olv-theme`. A
 * missing or malformed value, or storage that throws, falls back to Blue.
 */

import { storageGet, storageSet } from './safeStorage';

/** Names a theme. Stable string — persisted in localStorage. */
export type ThemeName = 'dark' | 'field' | 'high-contrast';

/** Every theme name in stable display order (toggle cycle and palette entries). */
export const THEME_ORDER: readonly ThemeName[] = [
  'dark',
  'field',
  'high-contrast',
] as const;

/** Short, user-visible label. */
export const THEME_LABEL: Readonly<Record<ThemeName, string>> = {
  dark: 'Blue',
  field: 'Field',
  'high-contrast': 'High contrast',
};

/** One-line hint shown in tooltips and the command palette. */
export const THEME_HINT: Readonly<Record<ThemeName, string>> = {
  dark: 'The original blue palette — deep navy panels, electric-blue accents.',
  field: 'Graphite surfaces and restrained teal accents for field work.',
  'high-contrast': 'Pure black, opaque panels, solid borders and a thick focus ring.',
};

/**
 * The CSS class applied to `<body>` to select a theme. Blue uses no class
 * (it's the default `:root` palette), so its class string is empty.
 */
export const THEME_BODY_CLASS: Readonly<Record<ThemeName, string>> = {
  dark: '',
  field: 'olv-theme-field',
  'high-contrast': 'olv-theme-high-contrast',
};

/** Every body class the theme system manages, including the retired one. */
const ALL_THEME_CLASSES: readonly string[] = [
  'olv-theme-field',
  'olv-theme-high-contrast',
  'olv-theme-light',
] as const;

/** Retired identifiers and the active theme each one now opens. */
const RETIRED_THEMES: Readonly<Record<string, ThemeName>> = {
  light: 'field',
};

/** localStorage key for the persisted choice. */
export const THEME_STORAGE_KEY = 'olv-theme';

/**
 * Whether a value is one of the active theme names. Used to validate
 * persisted localStorage payloads + share-state restores.
 */
export function isThemeName(value: unknown): value is ThemeName {
  return value === 'dark' || value === 'field' || value === 'high-contrast';
}

/** Whether a value is an active or retired theme name (workflow replay accepts both). */
export function isKnownThemeName(value: unknown): value is string {
  return isThemeName(value) || (typeof value === 'string' && Object.hasOwn(RETIRED_THEMES, value));
}

/** Map an active or retired identifier to an active theme; anything else is Blue. */
export function normalizeThemeName(value: unknown): ThemeName {
  if (isThemeName(value)) return value;
  if (typeof value === 'string' && Object.hasOwn(RETIRED_THEMES, value)) return RETIRED_THEMES[value];
  return 'dark';
}

/**
 * Apply a theme by swapping body classes. Takes the body element
 * directly (rather than a Document) so unit tests can drive it
 * against a minimal stub without a full DOM. Production callers
 * pass `document.body`.
 *
 * Idempotent — calling with the same name twice leaves the same classes.
 * Pure DOM mutation — no localStorage I/O.
 */
export function applyTheme(body: ThemeBody, name: ThemeName): void {
  // Remove any previously-applied theme class, then add the new one, so the
  // class list never carries two theme classes at once.
  for (const cls of ALL_THEME_CLASSES) body.classList.remove(cls);
  const target = THEME_BODY_CLASS[name];
  if (target) body.classList.add(target);
}

/**
 * Minimal body-element contract `applyTheme` needs. Matches what
 * `HTMLElement` exposes, so production code can pass `document.body`
 * directly — but small enough to stub in a node-only test.
 */
export interface ThemeBody {
  readonly classList: {
    add(...tokens: string[]): void;
    remove(...tokens: string[]): void;
  };
}

/**
 * Read the persisted theme from localStorage. Returns 'dark' on a missing or
 * malformed value and never throws, even when localStorage itself is
 * unavailable (the guarded access lives in `safeStorage.ts`). A retired value
 * is rewritten once, best-effort, as the theme it now opens.
 */
export function readPersistedTheme(): ThemeName {
  const raw = storageGet(THEME_STORAGE_KEY);
  const name = normalizeThemeName(raw);
  if (raw !== null && !isThemeName(raw) && isKnownThemeName(raw)) storageSet(THEME_STORAGE_KEY, name);
  return name;
}

/**
 * Persist the user's theme choice. Best-effort — silently swallows
 * any storage error (quota, security, privacy mode). Never throws.
 */
export function writePersistedTheme(name: ThemeName): void {
  storageSet(THEME_STORAGE_KEY, name);
}
