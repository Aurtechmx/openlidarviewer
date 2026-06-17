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
 * moves to the Next button on every step change and Tab cycles within
 * the card's buttons (the Modal.ts trap pattern, specialised to the
 * card's three fixed buttons). The step text (progress + title + body)
 * is one polite, atomic live region so each step's copy is announced
 * even though focus stays parked on Next. Keyboard: → / Enter advance,
 * ← steps back, Esc skips — the same outcome the "Skip tour" button
 * persists, which is what the welcome copy ("Press Esc any time to
 * skip") promises. Key terms in step copy (`*term*`) render as themed
 * `<mark>` elements, not raw selection-blue text.
 */

import { clamp } from '../../numeric';
import { el } from '../dom';
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
  private _currentSnapshot: TourSnapshot | null = null;

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
    this._backBtn = el('button', { className: 'olv-tour-btn', text: 'Back' });
    this._nextBtn = el('button', {
      className: 'olv-tour-btn olv-tour-btn-primary',
      text: 'Next',
    });
    this._skipBtn = el('button', { className: 'olv-tour-skip', text: 'Skip tour' });
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
    // Focus trap — the Modal.ts pattern specialised to the card's three
    // fixed buttons (Back / Next / Skip; Back drops out while disabled).
    this._card.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const items = [this._backBtn, this._nextBtn, this._skipBtn].filter(
        (b) => !b.disabled,
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !this._card.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    });

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
      if (e.key === 'Escape') {
        // Esc SKIPS (persisting the seen-flag) — the welcome copy promises
        // "Press Esc any time to skip", and before v0.4.5 it silently
        // dismissed instead, re-showing the tour every session.
        e.preventDefault();
        this._session.skip();
        return;
      }
      // Keyboard stepping (v0.4.5): → advances, ← steps back. Enter also
      // advances, but ONLY when focus is not already on one of the card's
      // buttons — a focused button fires its own click on Enter, and a
      // second session call here would double-step.
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
    window.addEventListener('keydown', this._onKey);
    window.addEventListener('resize', this._onResize);
  }

  /** Unmount and tear down listeners. */
  unmount(): void {
    if (this._detach) {
      this._detach();
      this._detach = null;
    }
    if (this._onKey) {
      window.removeEventListener('keydown', this._onKey);
      this._onKey = null;
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
      return;
    }
    this.element.classList.remove('olv-hidden');
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
      this._card.style.left = `${Math.round((vw - 360) / 2)}px`;
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
    const cardW = 360;
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
