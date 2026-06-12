/**
 * ShortcutSheet.ts
 *
 * The keyboard-shortcut reference sheet (open via `?`). Sibling to
 * `CommandPalette` but with a different purpose:
 *
 *   - Palette: "I know what I want — let me fuzzy-search to fire it".
 *   - Sheet:   "What CAN I do? Show me every binding, grouped, so I
 *              can discover features I didn't know existed."
 *
 * Both consume the SAME action registry — there is exactly one source
 * of truth for the app's actions, and adding a new action to that
 * registry surfaces it in both surfaces automatically.
 *
 * Layout:
 *   - Modal overlay with a backdrop.
 *   - Search input at the top — substring-filters action title +
 *     section + keys.
 *   - List grouped by section. Each row: action title, optional hint,
 *     and a key-chip on the right.
 *   - Clicking a row fires the action (same as the palette) so a user
 *     who finds it via discovery doesn't have to remember it
 *     immediately.
 *
 * The component is DOM-bound. Its pure-data dependency is the action
 * registry from `actionRegistry.ts` — the same module the palette
 * reads. Adding a new action surfaces it in both surfaces.
 */

import { el } from './dom';
import { groupBySection, rankActions, type Action } from './actionRegistry';

/**
 * Format a key string for display. Adds OS-appropriate symbols when
 * the action's `keys` field uses the canonical "Cmd-K" / "Cmd-Shift-U"
 * shape. Other key chips render verbatim ("?", "Esc", "L", "T").
 */
export function formatShortcutKeys(keys: string | undefined): string {
  if (!keys) return '';
  return (
    keys
      // Render the OS-appropriate primary modifier — ⌘ on macOS, Ctrl
      // elsewhere. We detect macOS via the userAgent because both
      // platforms commonly use the same binding semantically.
      .replace(
        /\bCmd\b/g,
        typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
          ? '⌘'
          : 'Ctrl',
      )
      .replace(/\bShift\b/g, '⇧')
      .replace(/\bAlt\b/g, '⌥')
      .replace(/-/g, ' ')
  );
}

export class ShortcutSheet {
  /** The overlay element — mount into the stage overlay. */
  readonly element: HTMLElement;
  private readonly _backdrop: HTMLElement;
  private readonly _card: HTMLElement;
  private readonly _input: HTMLInputElement;
  private readonly _list: HTMLElement;
  private readonly _empty: HTMLElement;

  private _actions: readonly Action[] = [];
  /** Whether the sheet is open. */
  private _open = false;

  constructor() {
    this._input = el('input', {
      className: 'olv-shortcuts-input',
      ariaLabel: 'Filter shortcuts',
    });
    this._input.type = 'text';
    this._input.placeholder = 'Filter shortcuts…';
    this._input.spellcheck = false;
    this._input.autocomplete = 'off';

    this._list = el('div', { className: 'olv-shortcuts-list' });
    this._empty = el('div', {
      className: 'olv-shortcuts-empty olv-hidden',
      text: 'No matching shortcuts.',
    });

    const hint = el('div', { className: 'olv-shortcuts-hint' }, [
      el('span', { className: 'olv-shortcuts-hint-key', text: '?' }),
      el('span', { text: 'open this sheet' }),
      el('span', { className: 'olv-shortcuts-hint-key', text: 'Esc' }),
      el('span', { text: 'close' }),
    ]);

    // v0.3.10 — Explicit X close. The Esc-to-close hint at the foot of
    // the sheet teaches the keyboard shortcut, but mouse users expect
    // a click target. The X sits at the top-right so the sheet reads
    // as a normal closable card.
    const dismiss = el('button', {
      className: 'olv-shortcuts-close',
      text: '×',
      title: 'Close (Esc)',
      ariaLabel: 'Close shortcuts',
    });
    dismiss.addEventListener('click', () => this.close());
    const headerTitles = el('div', { className: 'olv-shortcuts-header-titles' }, [
      el('div', { className: 'olv-shortcuts-title', text: 'Keyboard shortcuts' }),
      el('div', {
        className: 'olv-shortcuts-subtitle',
        text: 'Every action — search by name, section, or key.',
      }),
    ]);
    const header = el('div', { className: 'olv-shortcuts-header' }, [
      headerTitles,
      dismiss,
    ]);

    this._card = el('div', { className: 'olv-shortcuts-card' }, [
      header,
      this._input,
      this._list,
      this._empty,
      hint,
    ]);
    this._backdrop = el('div', { className: 'olv-shortcuts-backdrop' });
    this.element = el('div', { className: 'olv-shortcuts olv-hidden' }, [
      this._backdrop,
      this._card,
    ]);

    this._input.addEventListener('input', () => this._refresh());
    this._backdrop.addEventListener('click', () => this.close());
    this._card.addEventListener('click', (e) => e.stopPropagation());
    // The input field's Esc closes here rather than bubbling to the host
    // — otherwise a host Esc handler that expects "no overlay was open"
    // might also fire.
    this._input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });
  }

  /** Replace the action registry. Safe to call while closed. */
  setActions(actions: readonly Action[]): void {
    this._actions = actions;
    if (this._open) this._refresh();
  }

  /** Whether the sheet is currently visible. */
  get isOpen(): boolean {
    return this._open;
  }

  /** Open the sheet and focus the filter input. */
  open(): void {
    if (this._open) return;
    this._open = true;
    this.element.classList.remove('olv-hidden');
    this._input.value = '';
    this._refresh();
    queueMicrotask(() => this._input.focus());
  }

  /** Close the sheet. */
  close(): void {
    if (!this._open) return;
    this._open = false;
    this.element.classList.add('olv-hidden');
    this._input.blur();
  }

  /** Open if closed; close if open. */
  toggle(): void {
    if (this._open) this.close();
    else this.open();
  }

  // ── internals ───────────────────────────────────────────────────

  /** Re-rank against the current filter and re-render. */
  private _refresh(): void {
    const ranked = rankActions(this._input.value, this._actions);
    this._render(ranked);
  }

  /** Repaint the list from a ranked action list. */
  private _render(
    ranked: ReadonlyArray<{ action: Action; score: number }>,
  ): void {
    this._list.replaceChildren();
    if (ranked.length === 0) {
      this._empty.classList.remove('olv-hidden');
      return;
    }
    this._empty.classList.add('olv-hidden');
    const grouped = groupBySection(ranked);
    for (const { section, rows } of grouped) {
      const header = el('div', {
        className: 'olv-shortcuts-section',
        text: section,
      });
      this._list.append(header);
      for (const { action } of rows) {
        const row = el('button', {
          className: 'olv-shortcuts-row',
          ariaLabel: action.title,
        });
        const textChildren: Node[] = [
          el('div', {
            className: 'olv-shortcuts-row-title',
            text: action.title,
          }),
        ];
        if (action.hint) {
          textChildren.push(
            el('div', {
              className: 'olv-shortcuts-row-hint',
              text: action.hint,
            }),
          );
        }
        row.append(
          el('div', { className: 'olv-shortcuts-row-text' }, textChildren),
        );
        if (action.keys) {
          row.append(
            el('span', {
              className: 'olv-shortcuts-row-key',
              text: formatShortcutKeys(action.keys),
            }),
          );
        } else {
          // Empty slot keeps alignment consistent — actions without a
          // bound key still appear (they're discoverable, just via the
          // command palette / menu rather than a keystroke).
          row.append(el('span', { className: 'olv-shortcuts-row-key-empty' }));
        }
        row.addEventListener('click', () => {
          this.close();
          try {
            action.run();
          } catch {
            /* swallow — host actions are expected to be defensive */
          }
        });
        this._list.append(row);
      }
    }
  }
}
