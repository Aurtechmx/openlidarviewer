import { el, formatCount } from './dom';

/** The facts a freshly-opened scan presents in its summary card. */
export interface ProjectInfo {
  name: string;
  format: string;
  /** Points shown after downsampling. */
  shownCount: number;
  /** Points decoded from the file (before downsampling). */
  totalCount: number;
  /** Bounding-box extents in metres. */
  width: number;
  depth: number;
  height: number;
  hasRgb: boolean;
  hasIntensity: boolean;
  hasClassification: boolean;
}

/** How long the card lingers before fading out on its own. */
const DISMISS_MS = 7000;

/** A suggested navigation mode, derived from the scan's physical size. */
function suggestMode(info: ProjectInfo): string {
  const maxDim = Math.max(info.width, info.depth, info.height);
  if (maxDim > 150) return 'Fly — large outdoor scan';
  if (maxDim > 15) return 'Walk — building / interior scale';
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
    });
    dismiss.addEventListener('click', () => this.hide());

    this.element.replaceChildren(
      el('div', { className: 'olv-pc-head' }, [
        el('span', { className: 'olv-pc-title', text: 'Project ready' }),
        dismiss,
      ]),
      el('div', { className: 'olv-pc-name', text: info.name }),
      el('div', { className: 'olv-pc-grid' }, [
        row('Format', info.format.toUpperCase()),
        row('Points', points),
        row('Size', `${info.width.toFixed(1)} × ${info.depth.toFixed(1)} × ${info.height.toFixed(1)} m`),
        row('Attributes', attrs.length ? attrs.join(', ') : 'positions only'),
        row('Suggested', suggestMode(info)),
        row('Performance', performance(info.totalCount)),
      ]),
      el('div', { className: 'olv-pc-countdown' }),
    );

    this.element.classList.add('olv-visible');
    if (this._timer !== null) clearTimeout(this._timer);
    this._timer = window.setTimeout(() => this.hide(), DISMISS_MS);
  }

  /** Fade the card out. */
  hide(): void {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this.element.classList.remove('olv-visible');
  }
}
