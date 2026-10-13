/**
 * ThemeToggle.ts
 *
 * The header theme control. One press cycles the interface palette:
 *
 *     Blue → Field → High contrast → Blue
 *
 * It owns no theming logic: the body-class swap and persistence live in
 * `themes.ts` / `main.ts`. This control renders the current icon, announces
 * the current and next palette, and calls back `onChange` with the next one.
 * `setTheme(name)` keeps it in sync with an external change (command palette,
 * workflow replay, boot restore) without re-firing `onChange`. The button
 * keeps keyboard focus after a press.
 *
 * One inline-SVG icon per palette is stacked in the same box; only the active
 * one carries `olv-theme-icon-active` and CSS cross-fades it in. Icons use
 * `currentColor`, so they follow the header text colour in every palette.
 */

import { el } from './dom';
import { THEME_LABEL, THEME_ORDER, type ThemeName } from './themes';

export interface ThemeToggleOptions {
  /** The theme to render lit on first paint (usually the persisted one). */
  initial: ThemeName;
  /**
   * Fired with the NEXT theme when the user clicks. The host owns the
   * `applyTheme` + persistence — exactly the contract the old chip rail's
   * `onTheme` callback had. Optional so the control can be unit-tested
   * (and previewed) without a host wired in.
   */
  onChange?: (name: ThemeName) => void;
}

/** Inline-SVG bodies for each icon state, drawn in a shared 24×24 box. */
const ICON_SVG: Readonly<Record<ThemeName, string>> = {
  // Crescent moon — a disc with an offset disc punched out via even-odd.
  dark: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
<path fill="currentColor" fill-rule="evenodd" d="M14.8 3.2a9 9 0 1 0 6 16.4A7.4 7.4 0 0 1 14.8 3.2Z"/></svg>`,
  // Terrain-line glyph for the Field palette.
  field: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
<path d="M3 17 9 7l4 6 3-4 5 8M3 20h18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  // High contrast — a circle with the right half filled (the contrast glyph).
  'high-contrast': `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/>
<path fill="currentColor" d="M12 3a9 9 0 0 1 0 18Z"/></svg>`,
};

/** Build the rotating per-theme aria-label / tooltip text. */
function describeLabel(name: ThemeName): string {
  return `Theme: ${THEME_LABEL[name]} — switch to ${THEME_LABEL[nextTheme(name)]}`;
}

export class ThemeToggle {
  /** The button root — append into the top bar's right cluster. */
  readonly element: HTMLButtonElement;
  private _current: ThemeName;
  private readonly _onChange?: (name: ThemeName) => void;
  private readonly _icons = new Map<ThemeName, HTMLElement>();

  constructor(opts: ThemeToggleOptions) {
    this._current = opts.initial;
    this._onChange = opts.onChange;

    const button = el('button', {
      className: 'olv-theme-toggle',
      tip: 'Cycle the interface palette: Blue, Field, High contrast.',
    }) as HTMLButtonElement;
    button.type = 'button';

    // Stack one icon state per theme; CSS cross-fades the active one in.
    for (const name of THEME_ORDER) {
      const icon = el('span', {
        className: 'olv-theme-icon',
        unsafeHtml: ICON_SVG[name],
      });
      icon.setAttribute('data-theme', name);
      icon.setAttribute('aria-hidden', 'true');
      this._icons.set(name, icon);
      button.append(icon);
    }

    button.addEventListener('click', () => {
      const next = nextTheme(this._current);
      this._current = next;
      this._render();
      this._onChange?.(next);
    });

    this.element = button;
    this._render();
  }

  /**
   * Reflect an externally-driven theme change (boot restore, command
   * palette, workflow replay) — updates the lit icon + the label but does
   * NOT fire `onChange`, mirroring the old `Inspector.syncTheme`.
   */
  setTheme(name: ThemeName): void {
    this._current = name;
    this._render();
  }

  /** The currently-displayed theme. */
  get theme(): ThemeName {
    return this._current;
  }

  /** Light the matching icon and refresh the accessible label + tooltip. */
  private _render(): void {
    for (const [name, icon] of this._icons) {
      icon.classList.toggle('olv-theme-icon-active', name === this._current);
    }
    const label = describeLabel(this._current);
    this.element.setAttribute('aria-label', label);
    this.element.setAttribute('title', label);
  }
}

/** The next palette in the Blue → Field → High contrast → Blue cycle. */
function nextTheme(current: ThemeName): ThemeName {
  const i = THEME_ORDER.indexOf(current);
  // Unknown value (shouldn't happen) falls back to the start of the cycle.
  const at = Math.max(0, i);
  return THEME_ORDER[(at + 1) % THEME_ORDER.length];
}
