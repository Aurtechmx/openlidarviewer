import { el } from './dom';

/** A built-in sample scan offered on the empty state. */
export interface Sample {
  /** Stable short id — the `?autoload=sample:<id>` embed target. */
  id: string;
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
  /**
   * Called when the user picks a file via the "Open scan from device"
   * button — the touch-friendly path for phones, where drag-and-drop is
   * unavailable.
   */
  onOpenFile?: (file: File) => void;
}

/**
 * The OpenLiDARViewer brand mark — a glowing central sphere ringed by two
 * dotted orbital bands with a vertical axis of dots, drawn as a crisp SVG so
 * it stays sharp at the 18 px top-bar size.
 */
const MARK = `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
<defs><radialGradient id="olvLogoCore" cx="42%" cy="38%" r="70%">
<stop offset="0%" stop-color="#eafdff"/><stop offset="46%" stop-color="#22dcff"/>
<stop offset="100%" stop-color="#0083dc"/></radialGradient></defs>
<ellipse cx="12" cy="9.8" rx="9" ry="2.5" fill="none" stroke="#00b2ff" stroke-width="1.15"
 stroke-linecap="round" stroke-dasharray="0 2.1"/>
<ellipse cx="12" cy="14.2" rx="9" ry="2.5" fill="none" stroke="#00b2ff" stroke-width="1.15"
 stroke-linecap="round" stroke-dasharray="0 2.1"/>
<circle cx="12" cy="7" r="1.3" fill="#36d9ff"/><circle cx="12" cy="3.9" r="0.8" fill="#2bb6ef"/>
<circle cx="12" cy="17" r="1.3" fill="#36d9ff"/><circle cx="12" cy="20.1" r="0.8" fill="#2bb6ef"/>
<circle cx="12" cy="12" r="3.2" fill="url(#olvLogoCore)"/></svg>`;

/**
 * The app shell — the full-bleed canvas (the "stage"), the transparent top
 * bar, the empty state, and a small version badge. Floating panels mount
 * into `overlay`.
 */
export class Stage {
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly overlay: HTMLElement;
  private readonly _empty: HTMLElement;
  private readonly _version: HTMLElement;

  constructor(mount: HTMLElement, options: StageOptions = {}) {
    this.canvas = el('canvas', { className: 'olv-canvas' });
    this.overlay = el('div', { className: 'olv-overlay' });
    this.root = el('div', { className: 'olv-stage' }, [this.canvas, this.overlay]);

    if (!options.embed) this.overlay.append(this._buildTopBar());
    this._empty = this._buildEmptyState(options);
    this.overlay.append(this._empty);

    // A quiet version mark in the bottom-right corner, revealed with the
    // first scan so the empty state stays uncluttered.
    this._version = el('div', {
      className: 'olv-version',
      text: `v${__APP_VERSION__}`,
      title: `OpenLiDARViewer ${__APP_VERSION__}`,
    });
    this._version.style.display = 'none';
    this.overlay.append(this._version);

    mount.append(this.root);
  }

  /** Hide the empty state once the first cloud loads; reveal the version. */
  hideEmptyState(): void {
    this._empty.style.display = 'none';
    this._version.style.display = 'block';
  }

  /** Show the empty state again (e.g. after the last cloud is removed). */
  showEmptyState(): void {
    this._empty.style.display = 'flex';
    this._version.style.display = 'none';
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
      href: 'https://github.com/aurtechmx/openlidarviewer',
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

    // "Open scan from device" — a native file picker so a phone, which has no
    // drag-and-drop, can open a scan too. The picker accepts any file; the
    // format is sniffed and validated on load. (No `accept` filter: iOS greys
    // out files with point-cloud extensions it does not recognise.)
    const fileInput = el('input', { className: 'olv-file-input', type: 'file' });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) options.onOpenFile?.(file);
      fileInput.value = ''; // let the same file be re-picked
    });
    const openButton = el('button', {
      className: 'olv-open-btn',
      type: 'button',
      text: 'Open scan from device',
      title: 'Choose a point-cloud file from your device — or drag one onto the page',
    });
    openButton.addEventListener('click', () => fileInput.click());

    const samples = el('div', { className: 'olv-samples' });
    for (const s of options.samples ?? []) {
      const btn = el('button', {
        className: 'olv-sample',
        type: 'button',
        title: `Load the bundled ${s.label.toLowerCase()} sample — no file needed`,
      }, [
        el('span', { className: 'olv-sample-label', text: s.label }),
        el('span', { className: 'olv-sample-detail', text: s.detail }),
      ]);
      btn.addEventListener('click', () => options.onSample?.(s.url, s.name));
      samples.append(btn);
    }

    return el('div', { className: 'olv-empty' }, [title, sub, openButton, fileInput, samples]);
  }
}
