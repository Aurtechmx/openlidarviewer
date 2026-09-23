/**
 * HelpOverlay.ts
 *
 * The Help overlay: a centred card over a dimmed backdrop with a search box,
 * the topic list, and the topic bodies. Prose comes from the help catalogue;
 * every action row and every key comes from the action descriptors and the
 * key binding table handed in at construction, so this surface cannot state
 * a title, hint or key the palette and the sheet do not. Opened from the tool
 * dock (the `?` key belongs to the shortcut sheet), closed by the button, a
 * backdrop click, or Escape. Browser-bound (DOM); not imported in Node tests.
 * Search re-renders the topic list and the bodies from the same catalogue
 * ranking. A topic section carries its id in a data attribute, which is what
 * openTopic scrolls to.
 */

import { el } from './dom';
import { wireDialogA11y, type DialogA11yHandle } from './Modal';
import type { ActionDescriptor } from './actionRegistry';
import type { ShortcutDescriptor } from './keyBindings';
import { formatShortcutKeys } from './ShortcutSheet';
import { HELP_TOPICS, helpActionRows, helpKeyRows, searchHelp, type HelpTopic } from '../app/helpCatalog';

export interface HelpOverlayDeps {
  readonly actions: readonly ActionDescriptor[];
  readonly shortcuts: readonly ShortcutDescriptor[];
}

export class HelpOverlay {
  /** The backdrop element (contains the card); mount into the stage overlay. */
  readonly element: HTMLElement;

  private _open = false;
  private readonly _card: HTMLElement;
  private _a11y: DialogA11yHandle | null = null;
  private readonly _search: HTMLInputElement;
  private readonly _nav: HTMLElement;
  private readonly _body: HTMLElement;
  private readonly _deps: HelpOverlayDeps;

  constructor(deps: HelpOverlayDeps) {
    this._deps = deps;
    const closeBtn = el('button', { className: 'olv-help-close', text: 'Close', ariaLabel: 'Close help' });
    closeBtn.addEventListener('click', () => {
      closeBtn.blur();
      this.close();
    });
    this._search = el('input', { className: 'olv-palette-input olv-help-search', ariaLabel: 'Search help' });
    this._search.type = 'search';
    this._search.placeholder = 'Search help…';
    this._search.addEventListener('input', () => this._render(this._search.value));
    this._nav = el('nav', { className: 'olv-help-nav', ariaLabel: 'Help topics' });
    this._body = el('div', { className: 'olv-help-body' });

    const titleEl = el('span', { className: 'olv-help-title', text: 'OpenLiDARViewer Help' });
    titleEl.id = 'olv-help-title';
    this._card = el('div', { className: 'olv-help-card' }, [
      el('div', { className: 'olv-help-head' }, [titleEl, closeBtn]),
      this._search,
      this._nav,
      this._body,
    ]);
    this._card.setAttribute('role', 'dialog');
    this._card.setAttribute('aria-modal', 'true');
    this._card.setAttribute('aria-labelledby', titleEl.id);
    this.element = el('div', { className: 'olv-help-backdrop olv-hidden' }, [this._card]);
    this.element.addEventListener('click', (e) => {
      if (e.target === this.element) this.close();
    });
    this._render('');
  }

  private _render(query: string): void {
    const hits = searchHelp(query, this._deps.actions);
    this._nav.replaceChildren(
      ...hits.map(({ topic }) => {
        const b = el('button', { className: 'olv-help-nav-item', text: topic.title, type: 'button' });
        b.addEventListener('click', () => this._scrollTo(topic.id));
        return b;
      }),
    );
    this._body.replaceChildren(...hits.map(({ topic }) => this._section(topic)));
    if (hits.length === 0) {
      this._body.replaceChildren(el('p', { className: 'olv-help-empty', text: 'Nothing in Help matches that. The command palette lists every action by name.' }));
    }
  }

  private _section(topic: HelpTopic): HTMLElement {
    const children: HTMLElement[] = [
      el('h3', { className: 'olv-help-heading', text: topic.title }),
      el('p', { className: 'olv-help-summary', text: topic.summary }),
      ...topic.paragraphs.map((text) => el('p', { className: 'olv-help-desc', text })),
    ];
    const rows: HTMLElement[] = [];
    for (const [term, text] of topic.terms ?? []) rows.push(this._row(term, text));
    for (const a of helpActionRows(topic, this._deps.actions)) {
      const keys = a.keys ? formatShortcutKeys(a.keys) : '';
      const note = a.help?.scientificNote ? ` ${a.help.scientificNote}` : '';
      rows.push(this._row(a.title, `${a.hint}${note}`, keys, a.id));
    }
    if (topic.id === 'keyboard') {
      for (const k of helpKeyRows(this._deps.shortcuts, this._deps.actions)) rows.push(this._row(formatShortcutKeys(k.keys), k.text));
    }
    if (rows.length > 0) children.push(el('div', { className: 'olv-help-rows' }, rows));
    const section = el('section', { className: 'olv-help-section' }, children);
    section.dataset.helpTopic = topic.id;
    return section;
  }

  private _row(term: string, description: string, keys = '', actionId?: string): HTMLElement {
    const row = el('div', { className: 'olv-help-row' }, [
      el('span', { className: 'olv-help-term', text: term }),
      el('span', { className: 'olv-help-desc', text: description }),
      ...(keys ? [el('kbd', { className: 'olv-help-key', text: keys })] : []),
    ]);
    if (actionId) row.dataset.actionId = actionId;
    return row;
  }

  private _scrollTo(topicId: string): void {
    const target = this._body.querySelector<HTMLElement>(`[data-help-topic="${topicId}"]`);
    target?.scrollIntoView({ block: 'start' });
  }

  /** Whether the overlay is currently shown. */
  get isOpen(): boolean {
    return this._open;
  }

  /** Show the overlay. */
  open(): void {
    if (this._open) return;
    this._open = true;
    this.element.classList.remove('olv-hidden');
    // Wired before the focus move below, so it captures the trigger (not the
    // search input) as the element to restore focus to on close.
    this._a11y = wireDialogA11y(this._card, { onEscape: () => this.close() });
    this._search.focus();
  }

  /** Open on one topic: clears the search and scrolls the topic into view. */
  openTopic(topicId: string): void {
    this._search.value = '';
    this._render('');
    this.open();
    this._scrollTo(topicId);
  }

  /** Open on the topic that lists an action; falls back to a plain open. */
  openForAction(actionId: string): void {
    const topic = HELP_TOPICS.find((t) => (t.actionIds ?? []).includes(actionId));
    if (topic) this.openTopic(topic.id);
    else this.open();
  }

  /** Hide the overlay. */
  close(): void {
    if (!this._open) return;
    this._open = false;
    this.element.classList.add('olv-hidden');
    // Restores focus to whatever triggered the overlay (Tab-trap teardown).
    this._a11y?.teardown();
    this._a11y = null;
  }

  /** Toggle the overlay open or closed. */
  toggle(): void {
    if (this._open) this.close();
    else this.open();
  }

  /** Free DOM references and any live listener. */
  dispose(): void {
    this._a11y?.teardown();
    this._a11y = null;
    this.element.remove();
  }
}

export { shortcutDescriptors } from './keyBindings';
