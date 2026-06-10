/**
 * ThemeToggle.ts
 *
 * The v0.4.3 header theme control — a single, creative shape-morphing
 * button that lives in the top bar (relocated from the Inspector's
 * "Scan Intelligence" chip rail). One tap cycles the palette:
 *
 *     Dark → Light → High-contrast → Dark
 *
 * It owns NO theming logic. The actual body-class swap + localStorage
 * persistence live in `themes.ts` / `main.ts`; this control just renders
 * the right icon, announces the current theme, and calls back `onChange`
 * with the NEXT theme when clicked. `setTheme(name)` lets an external
 * change (command palette, workflow replay, boot-time restore) keep the
 * button in sync WITHOUT re-firing `onChange` — same separation the old
 * chip rail used (`syncTheme` vs the click handler).
 *
 * The morph: three inline-SVG icon states are stacked in the same box —
 *   • dark           → a crescent moon,
 *   • light          → a sun (filled disc + rays),
 *   • high-contrast  → a split / half-filled circle (the classic
 *                      contrast glyph).
 * Only one carries `olv-theme-icon-active` at a time; CSS cross-fades the
 * incoming one in (opacity + a small scale/rotate) over `--dur-base`. A
 * clean cross-fade rather than a single morphing path keeps each glyph
 * crisp at ~18 px and avoids a brittle path-interpolation animation; the
 * `prefers-reduced-motion` guard in CSS drops the transition entirely.
 * Everything is drawn with `currentColor` so the icon inherits the header
 * text colour and stays visible in all three themes.
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
  // Sun — a filled core disc ringed by eight rays.
  light: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
<circle cx="12" cy="12" r="4.6" fill="currentColor"/>
<g stroke="currentColor" stroke-width="2" stroke-linecap="round">
<line x1="12" y1="1.6" x2="12" y2="4.2"/><line x1="12" y1="19.8" x2="12" y2="22.4"/>
<line x1="1.6" y1="12" x2="4.2" y2="12"/><line x1="19.8" y1="12" x2="22.4" y2="12"/>
<line x1="4.6" y1="4.6" x2="6.4" y2="6.4"/><line x1="17.6" y1="17.6" x2="19.4" y2="19.4"/>
<line x1="4.6" y1="19.4" x2="6.4" y2="17.6"/><line x1="17.6" y1="6.4" x2="19.4" y2="4.6"/></g></svg>`,
  // High-contrast — a circle with the right half filled (classic glyph).
  'high-contrast': `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/>
<path fill="currentColor" d="M12 3a9 9 0 0 1 0 18Z"/></svg>`,
};

/** Build the rotating per-theme aria-label / tooltip text. */
function describeLabel(name: ThemeName): string {
  return `Theme: ${THEME_LABEL[name]} — click to change`;
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
      button.blur();
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

/** The next theme in the Dark → Light → High-contrast → Dark cycle. */
function nextTheme(current: ThemeName): ThemeName {
  const i = THEME_ORDER.indexOf(current);
  // Unknown value (shouldn't happen) falls back to the start of the cycle.
  const at = i < 0 ? 0 : i;
  return THEME_ORDER[(at + 1) % THEME_ORDER.length];
}
