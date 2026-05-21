import { el } from './dom';

/** A built-in sample scan offered on the empty state. */
export interface Sample {
  label: string;
  detail: string;
  url: string;
  name: string;
}

export interface StageOptions {
  /** Embed mode (`?embed=1`) strips the top bar and dock. */
  embed?: boolean;
  /** Built-in sample scans for the empty state. */
  samples?: Sample[];
  /** Called when a sample is chosen. */
  onSample?: (url: string, name: string) => void;
}

const MARK = `<svg width="18" height="18" viewBox="0 0 17 17" aria-hidden="true">
<circle cx="4" cy="5" r="1.7" fill="#34d3bd"/><circle cx="9" cy="3.4" r="1.7" fill="#5dcaa5"/>
<circle cx="13.4" cy="6" r="1.7" fill="#34d3bd"/><circle cx="6.2" cy="10.5" r="1.7" fill="#9fe1cb"/>
<circle cx="11.6" cy="11.8" r="1.7" fill="#34d3bd"/><circle cx="3.4" cy="14" r="1.5" fill="#5dcaa5"/></svg>`;

/**
 * The app shell — the full-bleed canvas (the "stage"), the transparent top
 * bar, and the empty state. Floating panels mount into `overlay`.
 */
export class Stage {
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly overlay: HTMLElement;
  private readonly _empty: HTMLElement;

  constructor(mount: HTMLElement, options: StageOptions = {}) {
    this.canvas = el('canvas', { className: 'olv-canvas' });
    this.overlay = el('div', { className: 'olv-overlay' });
    this.root = el('div', { className: 'olv-stage' }, [this.canvas, this.overlay]);

    if (!options.embed) this.overlay.append(this._buildTopBar());
    this._empty = this._buildEmptyState(options);
    this.overlay.append(this._empty);
    mount.append(this.root);
  }

  /** Hide the empty state once the first cloud loads. */
  hideEmptyState(): void {
    this._empty.style.display = 'none';
  }

  /** Show the empty state again (e.g. after the last cloud is removed). */
  showEmptyState(): void {
    this._empty.style.display = 'flex';
  }

  private _buildTopBar(): HTMLElement {
    const wordmark = el('div', { className: 'olv-wordmark', html: MARK });
    wordmark.append(el('span', { text: 'OpenLiDARViewer' }));

    const privacy = el('div', {
      className: 'olv-badge',
      text: 'Private · on your device',
      title: 'Your scan is read and rendered locally. Nothing is uploaded.',
    });
    const github = el('a', {
      className: 'olv-github',
      text: 'GitHub',
      href: 'https://github.com/your-org/openlidarviewer',
      ariaLabel: 'OpenLiDARViewer on GitHub',
    });
    github.target = '_blank';
    github.rel = 'noreferrer';

    const right = el('div', { className: 'olv-topbar-right' }, [privacy, github]);
    return el('header', { className: 'olv-topbar' }, [wordmark, right]);
  }

  private _buildEmptyState(options: StageOptions): HTMLElement {
    const title = el('h1', { className: 'olv-empty-title', text: 'Drop a scan to open it' });
    const sub = el('p', {
      className: 'olv-empty-sub',
      text: 'Drone LiDAR (.las / .laz) or a phone scan (.ply / .obj / .glb / .gltf). Nothing leaves your device.',
    });

    const samples = el('div', { className: 'olv-samples' });
    for (const s of options.samples ?? []) {
      const btn = el('button', { className: 'olv-sample', type: 'button' }, [
        el('span', { className: 'olv-sample-label', text: s.label }),
        el('span', { className: 'olv-sample-detail', text: s.detail }),
      ]);
      btn.addEventListener('click', () => options.onSample?.(s.url, s.name));
      samples.append(btn);
    }

    return el('div', { className: 'olv-empty' }, [title, sub, samples]);
  }
}
