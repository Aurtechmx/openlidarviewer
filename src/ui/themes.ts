/**
 * themes.ts
 *
 * Pure data layer for the v0.3.9 theme system. Three themes ship:
 *
 *   - dark            (default — the v0.3.x brand palette)
 *   - light           (inverted background, preserved cyan accent)
 *   - high-contrast   (WCAG AA on every text-on-background pair)
 *
 * Architecture: this module owns the THEME REGISTRY and the
 * persistence I/O. The actual colour overrides live in `style.css`
 * under `body.olv-theme-light` / `body.olv-theme-high-contrast`
 * selectors. `applyTheme(name)` is a pure body-class swap — no
 * inline styles, no CSS-variable poking from JS, so the theme can
 * also be tested without booting a JSDOM that renders styles.
 *
 * Why this split: it keeps the CSS authoritative (one place to edit
 * a colour) and the JS thin (one place to gate the theme), which
 * matches how every other tokenised system in the codebase is built
 * (`rgbAppearance`, `edlPresets`, sky presets).
 *
 * Persistence: the user's choice round-trips through
 * `localStorage.olv-theme` so a return visit lands in the same
 * theme. Read errors fall back to 'dark' silently — never throw on
 * a malformed value (the localStorage API is the user's surface,
 * not ours).
 */

/** Names a theme. Stable string — persisted in localStorage. */
export type ThemeName = 'dark' | 'light' | 'high-contrast';

/** Every theme name in stable display order (UI uses this for chips). */
export const THEME_ORDER: readonly ThemeName[] = [
  'dark',
  'light',
  'high-contrast',
] as const;

/** Short, user-visible label. */
export const THEME_LABEL: Readonly<Record<ThemeName, string>> = {
  dark: 'Dark',
  light: 'Light',
  'high-contrast': 'High contrast',
};

/** One-line hint shown in tooltips and the command palette. */
export const THEME_HINT: Readonly<Record<ThemeName, string>> = {
  dark: 'The default v0.3.x brand palette — deep navy panels, electric-blue accents.',
  light: 'Inverted background, preserved cyan accent. Good for office lighting.',
  'high-contrast': 'Maximum contrast for low-vision users — meets WCAG AA on every text-on-background pair.',
};

/**
 * The CSS class applied to `<body>` to select a theme. The dark
 * theme uses no class (it's the default `:root` palette), which
 * means the class string is intentionally empty.
 */
export const THEME_BODY_CLASS: Readonly<Record<ThemeName, string>> = {
  dark: '',
  light: 'olv-theme-light',
  'high-contrast': 'olv-theme-high-contrast',
};

/** The full set of body classes the theme system manages. */
const ALL_THEME_CLASSES: readonly string[] = [
  'olv-theme-light',
  'olv-theme-high-contrast',
] as const;

/** localStorage key for the persisted choice. */
export const THEME_STORAGE_KEY = 'olv-theme';

/**
 * Whether a value is one of the known theme names. Used to validate
 * persisted localStorage payloads + share-state restores.
 */
export function isThemeName(value: unknown): value is ThemeName {
  return value === 'dark' || value === 'light' || value === 'high-contrast';
}

/**
 * Apply a theme by swapping body classes. Takes the body element
 * directly (rather than a Document) so unit tests can drive it
 * against a minimal stub without a full DOM. Production callers
 * pass `document.body`.
 *
 * Idempotent — calling with the same name twice does no extra work.
 * Pure DOM mutation — no localStorage I/O.
 */
export function applyTheme(body: ThemeBody, name: ThemeName): void {
  // Remove any previously-applied theme class, then add the new one.
  // We do this in one pass so the class list never carries two
  // theme classes simultaneously (which would let the cascade pick
  // a winner unpredictably).
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
 * Read the persisted theme from localStorage. Returns 'dark' on a
 * missing or malformed value — never throws, even when localStorage
 * itself is unavailable (e.g. cross-origin iframes, privacy modes).
 */
export function readPersistedTheme(): ThemeName {
  try {
    if (typeof localStorage === 'undefined') return 'dark';
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeName(raw)) return raw;
    return 'dark';
  } catch {
    return 'dark';
  }
}

/**
 * Persist the user's theme choice. Best-effort — silently swallows
 * any storage error (quota, security, privacy mode). Never throws.
 */
export function writePersistedTheme(name: ThemeName): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(THEME_STORAGE_KEY, name);
  } catch {
    // Best-effort persistence; ignore quota / security failures.
  }
}
