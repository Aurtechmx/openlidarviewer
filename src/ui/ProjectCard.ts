import { el, formatCount } from './dom';
import { announcePolite } from './politeAnnounce';

/**
 * Route a message to the app's single polite live region (see
 * politeAnnounce.ts). A no-op where `document.querySelector` doesn't
 * exist, which the DOM stub `tests/projectCardLane.test.ts` builds does
 * not provide.
 */
function announce(message: string): void {
  if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
    announcePolite(message);
  }
}

/** The facts a freshly-opened scan presents in its summary card. */
export interface ProjectInfo {
  name: string;
  format: string;
  /** Points shown after downsampling. */
  shownCount: number;
  /** Points decoded from the file (before downsampling). */
  totalCount: number;
  /** Bounding-box extents in {@link sizeUnit}, ordered width, depth, height. */
  width: number;
  depth: number;
  height: number;
  /** 'm' when the CRS resolves a linear unit, else 'source units'. */
  sizeUnit: 'm' | 'source units';
  /** Largest extent in physical metres, or null when the scale is unresolved. */
  maxPhysicalDimM: number | null;
  hasRgb: boolean;
  hasIntensity: boolean;
  hasClassification: boolean;
  /**
   * Fired once when the card gives the top-centre lane back: its own timer
   * expiring, or the user pressing ×. NOT fired when something else takes the
   * lane by calling {@link ProjectCard.hide} (arming a measurement, closing the
   * scan): there the lane is wanted for that, not for a successor.
   *
   * The lane holds one surface at a time. The recommended-view chip is the
   * successor this exists for: it used to be shown in the same breath as the
   * card and covered it for the card's whole seven seconds.
   */
  onDismiss?: () => void;
}

/** How long the card lingers before fading out on its own. */
const DISMISS_MS = 7000;
/** Upper bound on the fade before the lane is handed on regardless. */
const FADE_WAIT_FALLBACK_MS = 400;
/** Opacity at or above which the card still counts as painted over the lane. */
const FADED_OPACITY = 0.05;
/** Gap between fade checks once the fallback has fired. */
const FADE_WAIT_POLL_MS = 60;
/** Longest the successor waits for a fade before taking the lane regardless. */
const FADE_WAIT_CEILING_MS = 2000;

/**
 * A suggested navigation mode from the scan's PHYSICAL size (metres). Only shown
 * when the size is physical: an unknown-unit scan cannot be mapped onto these
 * metre thresholds without risking a wrong recommendation, so the caller omits
 * the row in that case.
 */
function suggestMode(maxDimM: number): string {
  if (maxDimM > 150) return 'Fly — large outdoor scan';
  if (maxDimM > 15) return 'Walk — building / interior scale';
  return 'Orbit — object scale';
}

/** A rough performance class from the decoded point count. */
function performance(total: number): string {
  if (total < 1_000_000) return 'Light';
  if (total < 6_000_000) return 'Balanced';
  return 'Heavy';
}

/** A label/value row in the card grid. */
function row(label: string, value: string): HTMLElement {
  return el('div', { className: 'olv-pc-row' }, [
    el('span', { className: 'olv-pc-label', text: label }),
    el('span', { className: 'olv-pc-value', text: value }),
  ]);
}

/**
 * The "Project ready" card — a brief summary of a freshly opened
 * scan. It overlays the viewer (so the scan is visible underneath at once)
 * and fades out on its own after a few seconds, or when dismissed.
 */
export class ProjectCard {
  readonly element: HTMLElement;
  private _timer: number | null = null;
  /** The pending lane successor, dropped by `hide()` and consumed by `_dismiss()`. */
  private _onDismiss: (() => void) | null = null;

  constructor() {
    this.element = el('div', { className: 'olv-project-card' });
  }

  /** Populate and reveal the card for a freshly opened scan. */
  show(info: ProjectInfo): void {
    const attrs = [
      info.hasRgb && 'RGB',
      info.hasIntensity && 'Intensity',
      info.hasClassification && 'Classification',
    ].filter(Boolean) as string[];

    const points = info.shownCount === info.totalCount
      ? formatCount(info.totalCount)
      : `${formatCount(info.shownCount)} / ${formatCount(info.totalCount)}`;

    const dismiss = el('button', {
      className: 'olv-pc-dismiss',
      text: '×',
      ariaLabel: 'Dismiss',
      tip: 'Dismiss this project card.',
    });
    dismiss.addEventListener('click', () => this._dismiss());

    this.element.replaceChildren(
      el('div', { className: 'olv-pc-head' }, [
        el('span', { className: 'olv-pc-title', text: 'Project ready' }),
        dismiss,
      ]),
      el('div', { className: 'olv-pc-name', text: info.name }),
      el('div', { className: 'olv-pc-grid' }, [
        row('Format', info.format.toUpperCase()),
        row('Points', points),
        row('Size', `${info.width.toFixed(1)} × ${info.depth.toFixed(1)} × ${info.height.toFixed(1)} ${info.sizeUnit}`),
        row('Attributes', attrs.length ? attrs.join(', ') : 'positions only'),
        ...(info.maxPhysicalDimM != null ? [row('Suggested', suggestMode(info.maxPhysicalDimM))] : []),
        row('Performance', performance(info.totalCount)),
      ]),
      el('div', { className: 'olv-pc-countdown' }),
    );

    this.element.classList.add('olv-visible');
    // The card is the only place this summary appears, and it self-dismisses
    // in a few seconds — a screen-reader user gets one chance to hear it, so
    // announce it through the app's shared live region (see politeAnnounce.ts)
    // rather than minting a second one on the card root.
    announce(`Project ready: ${info.name}, ${points} points.`);
    if (this._timer !== null) clearTimeout(this._timer);
    this._onDismiss = info.onDismiss ?? null;
    this._timer = window.setTimeout(() => this._dismiss(), DISMISS_MS);
  }

  /** Fade the card out and drop any pending lane successor. */
  hide(): void {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._onDismiss = null;
    this.element.classList.remove('olv-visible');
  }

  /**
   * Hide, then hand the lane to the successor `show` registered, once the
   * card's fade has ended: a successor painted during the fade shares the lane
   * with a card that is still visible. The timer is the fallback for a card
   * whose transition never reports an end (reduced motion, a detached node).
   */
  private _dismiss(): void {
    const next = this._onDismiss;
    this.hide();
    if (!next) return;
    let handed = false;
    const hand = (): void => {
      if (handed) return;
      handed = true;
      this.element.removeEventListener('transitionend', onEnd);
      next();
    };
    const onEnd = (e: Event): void => {
      if ((e as TransitionEvent).propertyName === 'opacity') hand();
    };
    this.element.addEventListener('transitionend', onEnd);
    // The fallback exists for a browser that reports no transitionend. It used
    // to hand the lane on as soon as it fired, which on a loaded runner arrived
    // while the fade had barely started: the style recalc that begins the
    // transition can land hundreds of milliseconds after the class is set, so
    // the successor was painted over a card still at full opacity. The fallback
    // now checks what the card actually looks like and waits for it to fade,
    // up to a ceiling so a card that never transitions still yields the lane.
    let waited = 0;
    const faded = (): boolean => {
      const view = (this.element.ownerDocument as Document | null)?.defaultView;
      if (!view?.getComputedStyle) return true; // no style engine: nothing to wait for
      return Number(view.getComputedStyle(this.element).opacity) < FADED_OPACITY;
    };
    const check = (): void => {
      if (handed) return;
      if (faded() || waited >= FADE_WAIT_CEILING_MS) {
        hand();
        return;
      }
      waited += FADE_WAIT_POLL_MS;
      window.setTimeout(check, FADE_WAIT_POLL_MS);
    };
    window.setTimeout(check, FADE_WAIT_FALLBACK_MS);
  }
}
