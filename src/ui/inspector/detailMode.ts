/**
 * src/ui/inspector/detailMode.ts
 *
 * The View Inspector's Basic / Advanced detail switch.
 *
 * Basic shows the everyday controls; Advanced adds the technician sections.
 * Nothing is rebuilt when the mode changes: every section stays mounted with
 * its own open state, and the switch only toggles a class on the panel root
 * that styles tier-marked nodes out of view. A section can be revealed on its
 * own (a command that links to it) without changing the user's mode.
 *
 * Hidden is never silent. While Basic hides a section that holds something the
 * user must not miss (an active filter, declared limitations, report warnings),
 * a notice strip under the switch names it and reveals it in one click.
 *
 * The choice is a UI preference, stored with the section disclosure states
 * under `DETAIL_MODE_PREF`. It carries no scan or session state.
 */

import { el } from '../dom';

export type DetailMode = 'basic' | 'advanced';

/** Key in the stored Inspector section states; true means Advanced. */
export const DETAIL_MODE_PREF = 'mode.advanced';

const TIER = 'olv-tier-advanced';
const REVEALED = 'olv-tier-revealed';
const BASIC = 'olv-detail-basic';

interface Notice {
  readonly text: string;
  readonly target: HTMLElement;
}

export class DetailModeController {
  /** The segmented control, mounted at the top of the Inspector. */
  readonly control: HTMLElement;
  /** Notices for hidden sections that need attention; empty in Advanced. */
  readonly notices: HTMLElement;
  private _mode: DetailMode;
  private _root: HTMLElement | null = null;
  private readonly _buttons: Record<DetailMode, HTMLButtonElement>;
  private readonly _tiered = new Set<HTMLElement>();
  private readonly _notices = new Map<string, Notice>();
  private readonly _onPersist: (advanced: boolean) => void;
  private readonly _onReveal: (target: HTMLElement) => void;

  constructor(
    advanced: boolean,
    onPersist: (advanced: boolean) => void,
    onReveal: (target: HTMLElement) => void,
  ) {
    this._onPersist = onPersist;
    this._onReveal = onReveal;
    this._mode = advanced ? 'advanced' : 'basic';
    const make = (mode: DetailMode, text: string, tip: string): HTMLButtonElement => {
      const b = el('button', { className: 'olv-detail-mode-btn', type: 'button', text, tip });
      b.addEventListener('click', () => this.setMode(mode));
      return b;
    };
    this._buttons = {
      basic: make('basic', 'Basic', 'Show the everyday view controls.'),
      advanced: make('advanced', 'Advanced', 'Also show detailed rendering, filters, provenance and reports.'),
    };
    this.control = el('div', { className: 'olv-detail-mode', ariaLabel: 'Inspector detail' }, [
      this._buttons.basic,
      this._buttons.advanced,
    ]);
    this.control.setAttribute('role', 'group');
    this.notices = el('div', { className: 'olv-detail-notices olv-hidden' });
  }

  /** Attach to the panel root, whose class carries the mode to the styles. */
  bind(root: HTMLElement): void {
    this._root = root;
    this._apply();
  }

  mode(): DetailMode {
    return this._mode;
  }

  /** Mark a node as Advanced-only and return it, for inline use in a layout. */
  advanced<T extends HTMLElement>(node: T): T {
    node.classList.add(TIER);
    this._tiered.add(node);
    return node;
  }

  /** Mark a node as Basic-only (a shortcut the full Advanced rails supersede). */
  basicOnly<T extends HTMLElement>(node: T): T {
    node.classList.add('olv-tier-basic');
    return node;
  }

  /** Switch mode. Persists, keeps every control mounted, keeps focus visible. */
  setMode(mode: DetailMode): void {
    if (mode === this._mode) return;
    this._mode = mode;
    // Returning to Basic starts clean: one-off reveals end with it.
    if (mode === 'basic') for (const n of this._tiered) n.classList.remove(REVEALED);
    this._apply();
    this._onPersist(mode === 'advanced');
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    if (active && this.isHidden(active as HTMLElement)) this._buttons[mode].focus();
  }

  /** True when Basic is styling `node` (or a tier-marked ancestor) out of view. */
  isHidden(node: HTMLElement): boolean {
    if (this._mode === 'advanced') return false;
    for (let n: HTMLElement | null = node; n && n !== this._root; n = n.parentElement) {
      if (this._tiered.has(n) && !n.classList.contains(REVEALED)) return true;
    }
    return false;
  }

  /** Make `node` visible in Basic without changing the mode. */
  reveal(node: HTMLElement): void {
    for (let n: HTMLElement | null = node; n && n !== this._root; n = n.parentElement) {
      if (this._tiered.has(n)) n.classList.add(REVEALED);
    }
    this._renderNotices();
  }

  /** Raise or clear one notice. It shows only while its target is hidden. */
  setNotice(id: string, text: string | null, target: HTMLElement): void {
    if (text) this._notices.set(id, { text, target });
    else this._notices.delete(id);
    this._renderNotices();
  }

  private _apply(): void {
    this._root?.classList.toggle(BASIC, this._mode === 'basic');
    for (const mode of ['basic', 'advanced'] as const) {
      const on = mode === this._mode;
      this._buttons[mode].setAttribute('aria-pressed', String(on));
      this._buttons[mode].classList.toggle('olv-detail-mode-active', on);
    }
    this._renderNotices();
  }

  private _renderNotices(): void {
    const items: HTMLElement[] = [];
    for (const { text, target } of this._notices.values()) {
      if (!this.isHidden(target)) continue;
      const b = el('button', {
        className: 'olv-detail-notice',
        type: 'button',
        text: `${text} · Show`,
        tip: 'Show the section this refers to.',
      });
      b.addEventListener('click', () => this._onReveal(target));
      items.push(b);
    }
    this.notices.replaceChildren(...items);
    this.notices.classList.toggle('olv-hidden', items.length === 0);
  }
}
