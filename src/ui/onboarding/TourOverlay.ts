/**
 * TourOverlay.ts
 *
 * DOM overlay for the onboarding tour — a semi-opaque backdrop, an
 * SVG spotlight cut over the active step's target element, and a
 * tooltip card with title / body / Back / Next / Skip buttons.
 *
 * The overlay is a dumb view: it subscribes to a `TourSession`,
 * paints whatever `snapshot.step` it sees, and dispatches user
 * intents back through the session. The session owns the state
 * machine; this file owns the pixels.
 *
 * The overlay is `position: fixed` so it floats above every panel
 * and updates on window resize.
 *
 * Accessibility (v0.4.5): the card is a `role="dialog"` with
 * `aria-modal`, labelled by its title and described by its body; focus
 * moves to the Next button on every step change. While a step shows, the
 * card sits on the shared dialog stack (Modal.ts): Tab cycles within its
 * buttons and comes back in from outside. Cmd-K / Ctrl-K and ? end the tour
 * and open the palette or the shortcut sheet. The step text (progress + title +
 * body) is one polite, atomic live region so each step's copy is announced
 * even though focus stays parked on Next. Keyboard: → / Enter advance,
 * ← steps back, Esc skips — the same outcome the "Skip tour" button
 * persists, which is what the welcome copy ("Press Esc any time to
 * skip") promises. Key terms in step copy (`*term*`) render as themed
 * `<mark>` elements, not raw selection-blue text.
 */

import { clamp } from '../../numeric';
import { el } from '../dom';
import { wireDialogA11y, type DialogA11yHandle } from '../Modal';
import {
  TourSession,
  splitEmphasis,
  type TourSnapshot,
  type TourStep,
} from './tourSteps';

const SVG_NS = 'http://www.w3.org/2000/svg';

export class TourOverlay {
  /** The overlay root element — mount on document.body. */
  readonly element: HTMLElement;
  private readonly _session: TourSession;
  private readonly _backdrop: SVGSVGElement;
  private readonly _spotlight: SVGRectElement;
  private readonly _card: HTMLElement;
  private readonly _title: HTMLElement;
  private readonly _body: HTMLElement;
  private readonly _progress: HTMLElement;
  private readonly _backBtn: HTMLButtonElement;
  private readonly _nextBtn: HTMLButtonElement;
  private readonly _skipBtn: HTMLButtonElement;
  private _detach: (() => void) | null = null;
  private _onKey: ((e: KeyboardEvent) => void) | null = null;
  private _onResize: (() => void) | null = null;
  private _onPaletteKey: ((e: KeyboardEvent) => void) | null = null;
  private _currentSnapshot: TourSnapshot | null = null;
  /** The card's place on the dialog stack while a step shows. */
  private _a11y: DialogA11yHandle | null = null;

  constructor(session: TourSession) {
    this._session = session;

    // Build the SVG backdrop with a "hole" the spotlight will define.
    this._backdrop = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
    this._backdrop.setAttribute('class', 'olv-tour-backdrop');
    const defs = document.createElementNS(SVG_NS, 'defs');
    const mask = document.createElementNS(SVG_NS, 'mask');
    mask.setAttribute('id', 'olv-tour-mask');
    const maskFull = document.createElementNS(SVG_NS, 'rect');
    maskFull.setAttribute('x', '0');
    maskFull.setAttribute('y', '0');
    maskFull.setAttribute('width', '100%');
    maskFull.setAttribute('height', '100%');
    maskFull.setAttribute('fill', 'white');
    this._spotlight = document.createElementNS(SVG_NS, 'rect') as SVGRectElement;
    this._spotlight.setAttribute('fill', 'black');
    this._spotlight.setAttribute('rx', '10');
    this._spotlight.setAttribute('ry', '10');
    mask.append(maskFull, this._spotlight);
    defs.append(mask);
    const dim = document.createElementNS(SVG_NS, 'rect');
    dim.setAttribute('x', '0');
    dim.setAttribute('y', '0');
    dim.setAttribute('width', '100%');
    dim.setAttribute('height', '100%');
    dim.setAttribute('fill', 'rgba(0,0,0,0.55)');
    dim.setAttribute('mask', 'url(#olv-tour-mask)');
    this._backdrop.append(defs, dim);

    // Tooltip card.
    this._title = el('div', { className: 'olv-tour-title' });
    this._body = el('div', { className: 'olv-tour-body' });
    this._progress = el('div', { className: 'olv-tour-progress' });
    this._backBtn = el('button', {
      className: 'olv-tour-btn',
      text: 'Back',
      tip: 'Go to the previous tour step.',
    });
    this._nextBtn = el('button', {
      className: 'olv-tour-btn olv-tour-btn-primary',
      text: 'Next',
      tip: 'Go to the next tour step.',
    });
    this._skipBtn = el('button', {
      className: 'olv-tour-skip',
      text: 'Skip tour',
      tip: 'Close the guided tour and return to the viewer.',
    });
    this._backBtn.addEventListener('click', () => session.back());
    this._nextBtn.addEventListener('click', () => session.next());
    this._skipBtn.addEventListener('click', () => session.skip());

    const actions = el('div', { className: 'olv-tour-actions' }, [
      this._backBtn,
      this._nextBtn,
    ]);
    // The step text (progress + title + body) lives in ONE polite live
    // region: focus stays parked on the Next button across steps, so without
    // a live region a screen-reader user pressing Next hears only "Next,
    // button" again and never the new step's copy. aria-atomic makes each
    // step announce as a whole (the three children are replaced together).
    const live = el('div', { className: 'olv-tour-live' }, [
      this._progress,
      this._title,
      this._body,
    ]);
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('aria-atomic', 'true');
    this._card = el('div', { className: 'olv-tour-card olv-hidden' }, [
      live,
      actions,
      this._skipBtn,
    ]);
    // Dialog semantics (v0.4.5): without these, a screen reader read the
    // card as loose page text and never announced it as a modal step.
    this._title.id = 'olv-tour-title';
    this._body.id = 'olv-tour-body';
    this._card.setAttribute('role', 'dialog');
    this._card.setAttribute('aria-modal', 'true');
    this._card.setAttribute('aria-labelledby', this._title.id);
    this._card.setAttribute('aria-describedby', this._body.id);

    this.element = el('div', { className: 'olv-tour-root olv-hidden' }, [
      this._backdrop as unknown as HTMLElement,
      this._card,
    ]);
  }

  /** Mount the overlay to the body and subscribe to the session. */
  mount(): void {
    if (this._detach) return;
    document.body.append(this.element);
    this._detach = this._session.subscribe((snap) => this._render(snap));
    this._onKey = (e) => {
      if (this._session.state !== 'running') return;
      // Esc belongs to the dialog stack (see _render). Keyboard stepping
      // (v0.4.5): → advances, ← steps back. Enter also advances, but ONLY
      // when focus is not already on one of the card's buttons: a focused
      // button fires its own click on Enter, and a second session call here
      // would double-step.
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        this._session.next();
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        this._session.back();
        return;
      }
      if (e.key === 'Enter') {
        const a = document.activeElement;
        if (a === this._backBtn || a === this._nextBtn || a === this._skipBtn) return;
        e.preventDefault();
        this._session.next();
      }
    };
    this._onResize = () => {
      if (this._currentSnapshot) this._render(this._currentSnapshot);
    };
    // Cmd-K / Ctrl-K and ? end the tour before the shortcut dispatcher sees
    // the key, so the palette or the shortcut sheet opens where the last step
    // tells the user to press it. Capture phase runs ahead of the dispatcher.
    this._onPaletteKey = (e) => {
      if (this._session.state !== 'running') return;
      const palette = (e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K');
      if (palette || (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey)) this._session.skip();
    };
    window.addEventListener('keydown', this._onKey);
    window.addEventListener('keydown', this._onPaletteKey, true);
    window.addEventListener('resize', this._onResize);
  }

  /** Unmount and tear down listeners. */
  unmount(): void {
    this._a11y?.teardown();
    this._a11y = null;
    if (this._detach) {
      this._detach();
      this._detach = null;
    }
    if (this._onKey) {
      window.removeEventListener('keydown', this._onKey);
      this._onKey = null;
    }
    if (this._onPaletteKey) {
      window.removeEventListener('keydown', this._onPaletteKey, true);
      this._onPaletteKey = null;
    }
    if (this._onResize) {
      window.removeEventListener('resize', this._onResize);
      this._onResize = null;
    }
    this.element.remove();
  }

  /** Re-render against a snapshot — called on subscribe + resize. */
  private _render(snap: TourSnapshot): void {
    // A resize re-render of the SAME step must not steal focus from a
    // button the user tabbed to — only a step change moves focus.
    const stepChanged = this._currentSnapshot?.step?.id !== snap.step?.id;
    this._currentSnapshot = snap;
    if (snap.state !== 'running' || !snap.step) {
      this.element.classList.add('olv-hidden');
      this._a11y?.teardown();
      this._a11y = null;
      return;
    }
    this.element.classList.remove('olv-hidden');
    // On the stack before Next takes focus, so the teardown hands focus back
    // to where it was. Esc SKIPS and persists the seen flag, which is what the
    // welcome copy's "Press Esc any time to skip" promises.
    this._a11y ??= wireDialogA11y(this._card, { onEscape: () => this._session.skip() });
    this._title.textContent = snap.step.title;
    // Body copy renders `*key terms*` as themed <mark> elements. Built as
    // real DOM nodes from the pure splitter — copy can never inject HTML.
    this._body.replaceChildren(
      ...splitEmphasis(snap.step.body).map((seg) =>
        seg.mark
          ? el('mark', { className: 'olv-tour-mark', text: seg.text })
          : document.createTextNode(seg.text),
      ),
    );
    this._progress.textContent = `Step ${snap.index + 1} of ${snap.total}`;
    this._backBtn.disabled = snap.index === 0;
    this._nextBtn.textContent =
      snap.index === snap.total - 1 ? 'Done' : 'Next';

    this._positionSpotlightAndCard(snap.step);

    // Move focus to the primary action on every step change so keyboard +
    // screen-reader users land on "what do I do next" without hunting.
    if (stepChanged) this._nextBtn.focus();
  }

  /** Position the spotlight + tooltip card relative to the step target. */
  private _positionSpotlightAndCard(step: TourStep): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Mirrors the CSS `width: min(360px, calc(100vw - 32px))` on
    // .olv-tour-card, so the JS placement math never disagrees with the
    // rendered width on a narrow (320-375px) phone viewport.
    const cardW = Math.min(360, vw - 32);
    let target: DOMRect | null = null;
    if (step.target) {
      const node = document.querySelector<HTMLElement>(step.target);
      if (node) {
        const rect = node.getBoundingClientRect();
        // A matched-but-HIDDEN target (e.g. the tool dock, which collapses
        // on the empty state) measures 0×0 at the viewport origin. Treating
        // that as a real target used to pin a 16 px spotlight + the card to
        // the top-left corner — read it as "no target" so the card centres.
        if (rect.width > 1 && rect.height > 1) target = rect;
      }
    }

    if (!target) {
      // No target — hide the spotlight rectangle and centre the card.
      this._spotlight.setAttribute('x', '0');
      this._spotlight.setAttribute('y', '0');
      this._spotlight.setAttribute('width', '0');
      this._spotlight.setAttribute('height', '0');
      this._card.style.left = `${Math.round((vw - cardW) / 2)}px`;
      this._card.style.top = `${Math.round((vh - 200) / 2)}px`;
      this._card.classList.remove('olv-hidden');
      return;
    }

    // Inflate the target rect a little so the spotlight has breathing room.
    const pad = 8;
    const sx = Math.max(0, target.left - pad);
    const sy = Math.max(0, target.top - pad);
    const sw = Math.min(vw - sx, target.width + pad * 2);
    const sh = Math.min(vh - sy, target.height + pad * 2);
    this._spotlight.setAttribute('x', `${sx}`);
    this._spotlight.setAttribute('y', `${sy}`);
    this._spotlight.setAttribute('width', `${sw}`);
    this._spotlight.setAttribute('height', `${sh}`);

    // Card placement — keep it inside the viewport, prefer the
    // requested side, fall back to the opposite when there isn't
    // room.
    const cardH = 200;
    const gap = 16;
    let cx = sx + sw / 2 - cardW / 2;
    let cy = sy + sh + gap;
    switch (step.placement) {
      case 'top':
        cy = sy - cardH - gap;
        break;
      case 'bottom':
        cy = sy + sh + gap;
        break;
      case 'left':
        cx = sx - cardW - gap;
        cy = sy + sh / 2 - cardH / 2;
        break;
      case 'right':
        cx = sx + sw + gap;
        cy = sy + sh / 2 - cardH / 2;
        break;
      case 'center':
        cx = (vw - cardW) / 2;
        cy = (vh - cardH) / 2;
        break;
    }
    // Clamp into the viewport.
    cx = clamp(cx, 8, vw - cardW - 8);
    cy = clamp(cy, 8, vh - cardH - 8);
    this._card.style.left = `${cx}px`;
    this._card.style.top = `${cy}px`;
    this._card.classList.remove('olv-hidden');
  }
}
