import { el } from './dom';
import {
  groupBySection,
  rankActions,
  type Action,
  type RankedAction,
} from './actionRegistry';

/**
 * CommandPalette.ts
 *
 * The DOM overlay for the v0.3.9 command palette (Cmd-K / Ctrl-K).
 *
 *   - Opens on Cmd-K (macOS) / Ctrl-K (Windows + Linux), or via
 *     `palette.open()` from the host.
 *   - Closes on Esc or click outside.
 *   - Search input filters the action registry through the pure
 *     `rankActions` function from commandPalette.ts.
 *   - Arrow keys move the selection; Enter fires the active row's
 *     callback and closes the palette.
 *   - Mouse hover updates the selection so click-to-fire feels
 *     instant.
 *
 * The component owns:
 *   - its overlay DOM (a backdrop + a centred card)
 *   - the selected row index
 *   - the live search query
 *
 * It does NOT own:
 *   - the action registry itself (passed in via `setActions`)
 *   - the keystroke binding (the host wires `window.keydown` to
 *     `palette.toggle()` once at boot)
 */
export class CommandPalette {
  /** The overlay element — mount into the stage overlay. */
  readonly element: HTMLElement;

  private readonly _backdrop: HTMLElement;
  private readonly _card: HTMLElement;
  private readonly _input: HTMLInputElement;
  private readonly _list: HTMLElement;
  private readonly _empty: HTMLElement;

  private _actions: readonly Action[] = [];
  private _ranked: RankedAction[] = [];
  /** Index into `_ranked` of the currently-highlighted row, or -1. */
  private _selected = -1;
  /** Whether the palette is open. */
  private _open = false;

  constructor() {
    this._input = el('input', {
      className: 'olv-palette-input',
      ariaLabel: 'Search commands',
    });
    this._input.type = 'text';
    this._input.placeholder = 'Search commands…';
    this._input.spellcheck = false;
    this._input.autocomplete = 'off';

    this._list = el('div', { className: 'olv-palette-list' });
    this._empty = el('div', {
      className: 'olv-palette-empty olv-hidden',
      text: 'No matching commands.',
    });

    const hint = el('div', { className: 'olv-palette-hint' }, [
      el('span', { className: 'olv-palette-hint-key', text: '↑↓' }),
      el('span', { text: 'navigate' }),
      el('span', { className: 'olv-palette-hint-key', text: '↵' }),
      el('span', { text: 'run' }),
      el('span', { className: 'olv-palette-hint-key', text: 'Esc' }),
      el('span', { text: 'close' }),
    ]);

    this._card = el('div', { className: 'olv-palette-card' }, [
      this._input,
      this._list,
      this._empty,
      hint,
    ]);
    this._backdrop = el('div', { className: 'olv-palette-backdrop' });
    this.element = el('div', { className: 'olv-palette olv-hidden' }, [
      this._backdrop,
      this._card,
    ]);

    // ── interactions ──────────────────────────────────────────────
    this._input.addEventListener('input', () => this._refresh());
    this._input.addEventListener('keydown', (e) => this._handleKey(e));
    this._backdrop.addEventListener('click', () => this.close());
    // Clicks inside the card should not bubble to the backdrop.
    this._card.addEventListener('click', (e) => e.stopPropagation());
  }

  /** Replace the action registry. Safe to call while the palette is closed. */
  setActions(actions: readonly Action[]): void {
    this._actions = actions;
    if (this._open) this._refresh();
  }

  /** Whether the palette is currently visible. */
  get isOpen(): boolean {
    return this._open;
  }

  /** Open the palette and focus the search input. */
  open(): void {
    if (this._open) return;
    this._open = true;
    this.element.classList.remove('olv-hidden');
    this._input.value = '';
    this._refresh();
    // Defer focus to the next tick so the show transition starts
    // before the input demands attention.
    queueMicrotask(() => this._input.focus());
  }

  /** Close the palette without firing anything. */
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

  /** Re-rank the action list against the current input and re-render. */
  private _refresh(): void {
    const query = this._input.value;
    this._ranked = rankActions(query, this._actions);
    this._selected = this._ranked.length > 0 ? 0 : -1;
    this._render();
  }

  /** Repaint the list from `_ranked` + `_selected`. */
  private _render(): void {
    this._list.replaceChildren();
    if (this._ranked.length === 0) {
      this._empty.classList.remove('olv-hidden');
      return;
    }
    this._empty.classList.add('olv-hidden');
    const grouped = groupBySection(this._ranked);
    let absoluteRow = 0;
    for (const { section, rows } of grouped) {
      const header = el('div', {
        className: 'olv-palette-section',
        text: section,
      });
      this._list.append(header);
      for (const { action } of rows) {
        const row = el('button', {
          className: 'olv-palette-row',
          ariaLabel: action.title,
        });
        if (absoluteRow === this._selected) {
          row.classList.add('olv-palette-row-active');
        }
        const textChildren: Node[] = [
          el('div', { className: 'olv-palette-row-title', text: action.title }),
        ];
        if (action.hint) {
          textChildren.push(
            el('div', { className: 'olv-palette-row-hint', text: action.hint }),
          );
        }
        row.append(el('div', { className: 'olv-palette-row-text' }, textChildren));
        if (action.keys) {
          row.append(
            el('span', { className: 'olv-palette-row-key', text: action.keys }),
          );
        }
        const idxInRanked = absoluteRow;
        row.addEventListener('mouseenter', () => {
          this._selected = idxInRanked;
          this._paintSelection();
        });
        row.addEventListener('click', () => {
          this._fire(idxInRanked);
        });
        this._list.append(row);
        absoluteRow += 1;
      }
    }
  }

  /** Update only the active-row highlight without rebuilding the list. */
  private _paintSelection(): void {
    const rows = this._list.querySelectorAll<HTMLElement>('.olv-palette-row');
    rows.forEach((row, i) => {
      row.classList.toggle('olv-palette-row-active', i === this._selected);
    });
    // Scroll the active row into view if it's outside the viewport.
    const active = rows[this._selected];
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  /** Run the action at `idx`, then close. No-op if `idx` is out of range. */
  private _fire(idx: number): void {
    const row = this._ranked[idx];
    if (!row) return;
    // Close BEFORE firing so the action's own UI (toast, modal, etc.)
    // doesn't fight the palette overlay during the transition.
    this.close();
    try {
      row.action.run();
    } catch {
      // Swallow — the host's actions are expected to be defensive,
      // and a thrown action shouldn't bubble back into the palette
      // and leave the overlay in an undefined state.
    }
  }

  /** Keyboard handler for the search input. */
  private _handleKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (this._selected >= 0) this._fire(this._selected);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (this._ranked.length === 0) return;
      this._selected = Math.min(this._selected + 1, this._ranked.length - 1);
      this._paintSelection();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (this._ranked.length === 0) return;
      this._selected = Math.max(this._selected - 1, 0);
      this._paintSelection();
    }
  }
}
