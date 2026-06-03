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
 * and updates on window resize. Esc dismisses (no persist) and
 * "Skip tour" persists.
 */

import { el } from '../dom';
import { TourSession, type TourSnapshot, type TourStep } from './tourSteps';

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
    this._card = el('div', { className: 'olv-tour-card olv-hidden' }, [
      this._progress,
      this._title,
      this._body,
      actions,
      this._skipBtn,
    ]);

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
      if (e.key === 'Escape' && this._session.state === 'running') {
        // Esc dismisses without persisting — the tour re-shows next session.
        this._session.dismiss();
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
    this._currentSnapshot = snap;
    if (snap.state !== 'running' || !snap.step) {
      this.element.classList.add('olv-hidden');
      return;
    }
    this.element.classList.remove('olv-hidden');
    this._title.textContent = snap.step.title;
    this._body.textContent = snap.step.body;
    this._progress.textContent = `Step ${snap.index + 1} of ${snap.total}`;
    this._backBtn.disabled = snap.index === 0;
    this._nextBtn.textContent =
      snap.index === snap.total - 1 ? 'Done' : 'Next';

    this._positionSpotlightAndCard(snap.step);
  }

  /** Position the spotlight + tooltip card relative to the step target. */
  private _positionSpotlightAndCard(step: TourStep): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let target: DOMRect | null = null;
    if (step.target) {
      const node = document.querySelector<HTMLElement>(step.target);
      if (node) target = node.getBoundingClientRect();
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
    cx = Math.max(8, Math.min(vw - cardW - 8, cx));
    cy = Math.max(8, Math.min(vh - cardH - 8, cy));
    this._card.style.left = `${cx}px`;
    this._card.style.top = `${cy}px`;
    this._card.classList.remove('olv-hidden');
  }
}
