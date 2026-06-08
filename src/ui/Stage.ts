import { el } from './dom';

/** A built-in sample scan offered on the empty state. */
export interface Sample {
  /** Stable short id — the `?autoload=sample:<id>` embed target. */
  id: string;
  label: string;
  detail: string;
  url: string;
  name: string;
  /**
   * Approximate size on disk, bytes. Used by the cellular-data confirmation
   * gate — a sample without a `sizeBytes` field is treated as "small enough
   * to download anywhere" and no confirmation is shown.
   */
  sizeBytes?: number;
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
  /**
   * Called with a URL when the user submits the "open from URL" field — the
   * entry point for streaming a remote COPC scan. Returning a Promise lets
   * the field manage its own loading + error UI; resolve = clear, reject
   * with an Error = inline error message, AbortError = user cancelled.
   */
  onOpenUrl?: (url: string) => void | Promise<void>;
  /**
   * Called when the user chooses "Batch convert files" on the empty state —
   * opens the format converter without loading a scan into the 3D view.
   */
  onBatchConvert?: () => void;
  /**
   * Optional ready-made DOM node that the empty state mounts as the
   * verified-public-LiDAR-dataset picker. Built by main.ts so the
   * catalog module — including its dataset list — never enters this
   * UI file. When omitted the empty state simply skips the section.
   */
  catalogPanel?: HTMLElement;
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
 * The hero version of the brand mark — same DNA as `MARK` (orbital rings,
 * glowing core, vertical axis dots) at a larger canvas with extra detail:
 *   • Three concentric dotted orbital ellipses with subtle inner/outer
 *     opacity falloff so the rings read as 3D depth rather than flat.
 *   • A horizontal lens-flare ridge across the core for a "ping" feel.
 *   • Soft outer halo around the core so the cyan reads as emissive even
 *     against the dark-navy stage background.
 *   • A six-dot vertical axis above + below the core (two large near
 *     the equator, mid + pole on each side) — the same axis as MARK
 *     extended into the larger canvas.
 *
 * Pure inline SVG — ~1.4 KB, no raster. The square + wordmark variant
 * (public/olv-hero.{webp,png}) is the asset for marketing surfaces; the
 * icon-only SVG below is what reads cleanly above the "Open a scan"
 * title without doubling the wordmark already in the top bar.
 */
const HERO_MARK = `<svg viewBox="0 0 200 200" aria-hidden="true" class="olv-hero-mark-svg" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <!-- Core: bright white-cyan inner → cyan mid → brand blue at edge. -->
    <radialGradient id="olvHeroCore" cx="42%" cy="36%" r="64%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="32%" stop-color="#a8f1ff"/>
      <stop offset="68%" stop-color="#22dcff"/>
      <stop offset="100%" stop-color="#0083dc"/>
    </radialGradient>
    <!-- Subtle emissive halo around the core, restrained so it doesn't
         flood the orbital rings. -->
    <radialGradient id="olvHeroHalo" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="rgba(60,225,255,0.35)"/>
      <stop offset="55%" stop-color="rgba(0,178,255,0.10)"/>
      <stop offset="100%" stop-color="rgba(0,178,255,0)"/>
    </radialGradient>
    <!-- Horizontal lens-flare ridge — centred, fades out before the
         canvas edge so it reads as a "ping" not a full crossbar. -->
    <linearGradient id="olvHeroFlare" x1="0%" y1="50%" x2="100%" y2="50%">
      <stop offset="0%" stop-color="rgba(34,220,255,0)"/>
      <stop offset="35%" stop-color="rgba(168,241,255,0.85)"/>
      <stop offset="50%" stop-color="#ffffff"/>
      <stop offset="65%" stop-color="rgba(168,241,255,0.85)"/>
      <stop offset="100%" stop-color="rgba(34,220,255,0)"/>
    </linearGradient>
  </defs>

  <!-- Back orbital ring — slightly above centre, wider + fainter so the
       cluster reads as 3D depth. Round-cap stroke-dasharray draws the
       ring as a sequence of round dots at the cap radius. -->
  <ellipse cx="100" cy="86" rx="66" ry="17" fill="none" stroke="#22d4ff" stroke-width="2"
    stroke-linecap="round" stroke-dasharray="0 4" opacity="0.75"/>

  <!-- Front orbital ring — slightly below centre, narrower + brighter. -->
  <ellipse cx="100" cy="114" rx="66" ry="17" fill="none" stroke="#3cdfff" stroke-width="2.2"
    stroke-linecap="round" stroke-dasharray="0 3.8" opacity="0.98"/>

  <!-- Vertical axis dots — four above, four below. Sized small → large
       as they approach the equator; the dot adjacent to each ring is
       the most prominent (they read as the "poles" of the torus).
       Spacing kept tight so the axis doesn't outreach the rings. -->
  <circle cx="100" cy="34" r="1.8" fill="#2bb6ef"/>
  <circle cx="100" cy="48" r="3" fill="#36d9ff"/>
  <circle cx="100" cy="62" r="4.2" fill="#3ce0ff"/>
  <circle cx="100" cy="76" r="5.4" fill="#3ce0ff"/>
  <circle cx="100" cy="124" r="5.4" fill="#3ce0ff"/>
  <circle cx="100" cy="138" r="4.2" fill="#3ce0ff"/>
  <circle cx="100" cy="152" r="3" fill="#36d9ff"/>
  <circle cx="100" cy="166" r="1.8" fill="#2bb6ef"/>

  <!-- Soft outer halo so the core reads as emissive. -->
  <circle cx="100" cy="100" r="28" fill="url(#olvHeroHalo)"/>

  <!-- Horizontal lens-flare ridge crossing the equator. -->
  <rect x="18" y="98.2" width="164" height="3.2" fill="url(#olvHeroFlare)"/>

  <!-- The glowing core. -->
  <circle cx="100" cy="100" r="11" fill="url(#olvHeroCore)"/>
</svg>`;

/**
 * iPhone-Safari single-tab memory cap is empirically around 350-500 MB; LAS
 * captures above ~1.2 GB on disk routinely crash. Threshold deliberately
 * generous — we'd rather a borderline file pass than a real one block.
 */
const MOBILE_MEMORY_WARN_BYTES = 1_200_000_000;
/**
 * iPhone-Safari cellular streaming threshold. Above ~250 MB the user is
 * almost certainly going to want the warning; below it, the request is
 * cheaper than a typical app update.
 */
const CELLULAR_WARN_BYTES = 250_000_000;

/** Coarse mobile detection — matches Stage's mobile copy + size breakpoints. */
function isMobileViewport(): boolean {
  return typeof window !== 'undefined'
    && window.matchMedia('(max-width: 767px)').matches;
}

/**
 * Best-effort cellular detection. The Network Information API ships on
 * Chrome / Edge / Samsung — Safari and Firefox don't expose it, so this
 * returns null when the API is missing (caller should treat null as "can't
 * tell — fall open"). Wraps the check in try/catch because some embedded
 * webviews throw on access.
 */
function isCellularConnection(): boolean | null {
  try {
    const nav = navigator as Navigator & {
      connection?: { type?: string; effectiveType?: string };
    };
    const conn = nav.connection;
    if (!conn) return null;
    if (conn.type === 'cellular') return true;
    // Some browsers don't fill `type`; treat any `effectiveType` that maps
    // to 2G/3G as cellular for the purposes of the data-charge gate.
    if (conn.effectiveType === '2g' || conn.effectiveType === '3g') return true;
    return false;
  } catch {
    return null;
  }
}

/** Format a byte count as the largest sensible unit (MB / GB), one decimal. */
function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  return `${(bytes / 1000).toFixed(0)} KB`;
}

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
  /** Inline status banner above the URL field. */
  private _urlError: HTMLElement | null = null;
  /** Inline status banner at the top of the empty state for global warnings. */
  private _statusBanner: HTMLElement | null = null;
  /** The Open button — flips into a spinner/cancel state during URL loading. */
  private _urlSubmit: HTMLButtonElement | null = null;
  /** The URL input itself — preserved on error so the user can edit + retry. */
  private _urlInput: HTMLInputElement | null = null;
  /** The currently-streaming URL request's abort controller, if any. */
  private _urlAbortController: AbortController | null = null;
  /** Bound handlers kept so dispose can detach them. */
  private readonly _onOnline: () => void;
  private readonly _onOffline: () => void;
  /**
   * The top bar's right-hand cluster ("Private · on your device" + GitHub).
   * Held so main.ts can mount the header theme toggle into it. Null in
   * embed mode, where the top bar is stripped entirely.
   */
  private _topBarRight: HTMLElement | null = null;
  /** The GitHub link — the theme toggle inserts itself just before it. */
  private _githubLink: HTMLElement | null = null;

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
      className: 'olv-version olv-hidden',
      text: `v${__APP_VERSION__}`,
      title: `OpenLiDARViewer ${__APP_VERSION__}`,
    });
    this.overlay.append(this._version);

    // Online/offline awareness — set initial state and react to changes.
    // Error-handling-UX item E4: warn the user they can't stream when offline
    // so they don't sit waiting for a request that will never resolve.
    this._onOnline = () => this._setOfflineState(false);
    this._onOffline = () => this._setOfflineState(true);
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this._onOnline);
      window.addEventListener('offline', this._onOffline);
      // Initial state — `navigator.onLine` is true on every browser at
      // start of session even when offline; the offline event will
      // correct it.
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        this._setOfflineState(true);
      }
    }

    mount.append(this.root);
  }

  /** Hide the empty state once the first cloud loads; reveal the version. */
  hideEmptyState(): void {
    this._empty.classList.add('olv-hidden');
    this._version.classList.remove('olv-hidden');
    this._cancelUrlLoad();
  }

  /** Show the empty state again (e.g. after the last cloud is removed). */
  showEmptyState(): void {
    this._empty.classList.remove('olv-hidden');
    this._version.classList.add('olv-hidden');
  }

  /** Remove window-level listeners. Pair with viewer.dispose(). */
  dispose(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this._onOnline);
      window.removeEventListener('offline', this._onOffline);
    }
  }

  private _buildTopBar(): HTMLElement {
    const wordmark = el('div', { className: 'olv-wordmark', unsafeHtml: MARK });
    wordmark.append(el('span', { text: 'OpenLiDARViewer' }));

    const privacy = el('div', {
      className: 'olv-badge',
      text: 'Private · on your device',
      title: 'Your scan is read and rendered locally. Nothing is uploaded.',
    });
    // GitHub link demoted to a ghost link (item 9) — text + arrow, no pill
    // background — so the "Private · on your device" trust signal stays the
    // dominant header element on mobile.
    const github = el('a', {
      className: 'olv-github',
      text: 'GitHub',
      href: 'https://github.com/aurtechmx/openlidarviewer',
      ariaLabel: 'OpenLiDARViewer on GitHub',
    });
    github.target = '_blank';
    github.rel = 'noreferrer';

    const right = el('div', { className: 'olv-topbar-right' }, [privacy, github]);
    this._topBarRight = right;
    this._githubLink = github;
    return el('header', { className: 'olv-topbar' }, [wordmark, right]);
  }

  /**
   * Mount the v0.4.3 header theme toggle into the top bar's right cluster,
   * positioned just left of the GitHub link so the "Private · on your
   * device" trust signal keeps its place. No-op in embed mode (no top
   * bar). Returns true when mounted so callers can branch on it.
   */
  mountThemeToggle(element: HTMLElement): boolean {
    if (!this._topBarRight) return false;
    if (this._githubLink) {
      this._topBarRight.insertBefore(element, this._githubLink);
    } else {
      this._topBarRight.append(element);
    }
    return true;
  }

  private _buildEmptyState(options: StageOptions): HTMLElement {
    // Item 7: copy is mobile-aware. On phones the "drag onto the page"
    // instruction is meaningless (iOS Safari has no drag-and-drop), so the
    // mobile variant leads with the pick-from-device action.
    const mobile = isMobileViewport();
    // Hero brand mark sits above the title — same design DNA as the
    // top-bar wordmark, scaled up. Pure inline SVG (no raster, no
    // request) so it appears in the same paint as the title.
    const heroMark = el('div', {
      className: 'olv-empty-hero',
      unsafeHtml: HERO_MARK,
      ariaLabel: 'OpenLiDARViewer',
    });
    const title = el('h1', { className: 'olv-empty-title', text: 'Open a scan' });
    // v0.3.6 desktop-audit fix: one consolidated trust line. Replaces three
    // separate "verified at release time" / "verified at build time" / CORS
    // helper paragraphs that previously stacked across the empty state. The
    // privacy posture is the single most important first-paint signal — give
    // it one home, then let the actions speak for themselves.
    const sub = el('p', {
      className: 'olv-empty-sub',
      text: mobile
        ? 'Pick a file. Nothing leaves your device.'
        : 'Drag a file onto the page, or pick one below. Nothing leaves your device.',
    });

    // Top-of-empty-state status banner — used for offline (E4) and for the
    // retry-last-URL affordance (E9). Renders nothing by default.
    //
    // v0.3.10 a11y patch #377 — the banner is populated asynchronously
    // (offline detector flips it, retry-last-URL flow flips it on
    // failure). Screen readers don't auto-announce silent DOM mutations,
    // so we mark the banner as an ARIA live region: `role="status"` is
    // the canonical role for non-critical status updates, and
    // `aria-live="polite"` tells assistive tech to wait for the next
    // natural pause before reading the new content (the alternative
    // `assertive` would interrupt whatever the user is doing — overkill
    // for offline/retry messages). `aria-atomic="true"` makes the
    // banner read as a whole instead of just the changed bits, which
    // matches how the children are replaced wholesale in `_showStatus`.
    this._statusBanner = el('div', { className: 'olv-empty-status olv-hidden' });
    this._statusBanner.setAttribute('role', 'status');
    this._statusBanner.setAttribute('aria-live', 'polite');
    this._statusBanner.setAttribute('aria-atomic', 'true');

    // "Open scan from device" — a native file picker so a phone, which has no
    // drag-and-drop, can open a scan too. The picker accepts any file; the
    // format is sniffed and validated on load. (No `accept` filter: iOS greys
    // out files with point-cloud extensions it does not recognise.)
    const fileInput = el('input', { className: 'olv-file-input', type: 'file' });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file && this._approveFile(file)) options.onOpenFile?.(file);
      fileInput.value = ''; // let the same file be re-picked
    });
    // Item 12: idle CTA pulse — a CSS-only animation class kicks in 4 s
    // after the empty state mounts and fades out as soon as the user hovers
    // / focuses / scrolls the page. The class is only ever added once.
    const openButton = el('button', {
      className: 'olv-open-btn olv-cta-pulse',
      type: 'button',
      text: 'Open scan from device',
      title: 'Choose a point-cloud file from your device — or drag one onto the page',
    });
    openButton.addEventListener('click', () => fileInput.click());
    // Suppress the pulse on first interaction anywhere — the affordance
    // has done its job once the user touches the page.
    const stopPulse = () => openButton.classList.remove('olv-cta-pulse');
    openButton.addEventListener('pointerdown', stopPulse, { once: true });
    if (typeof window !== 'undefined') {
      window.addEventListener('scroll', stopPulse, { once: true, passive: true });
    }

    // Item 5: format list collapses to a one-line summary with a tap-to-
    // expand. Reads cleanly on mobile instead of a wall of 10 extensions.
    const formats = el('details', { className: 'olv-empty-formats' });
    const formatsSummary = el('summary', {
      className: 'olv-empty-formats-summary',
      text: 'Supports 10 formats including .las, .laz, .ply',
    });
    const formatsFull = el('p', {
      className: 'olv-empty-formats-full',
      text: '.las · .laz · .ply · .obj · .glb · .gltf · .pcd · .pts · .ptx · .e57',
    });
    formats.append(formatsSummary, formatsFull);
    // Three capture-type chips with monoline icons. Visual-hierarchy
    // upgrade: the previous version was a 11 px faint period-separated
    // sentence that read as quaternary fine-print despite carrying
    // tertiary-level semantic information (what kinds of scans this
    // viewer accepts). Icon chips make the meaning instant — a user
    // looking for "does this work with my iPhone scan?" sees the answer
    // without parsing prose.
    const captureKinds = el('div', { className: 'olv-empty-capture-kinds' });
    const KINDS: ReadonlyArray<{ icon: string; label: string }> = [
      {
        // Drone (top-down): four rotor circles, X cross-arms, central body.
        icon: `<svg viewBox="0 0 16 16" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
<circle cx="3" cy="3" r="2" fill="none" stroke="currentColor" stroke-width="1.3"/>
<circle cx="13" cy="3" r="2" fill="none" stroke="currentColor" stroke-width="1.3"/>
<circle cx="3" cy="13" r="2" fill="none" stroke="currentColor" stroke-width="1.3"/>
<circle cx="13" cy="13" r="2" fill="none" stroke="currentColor" stroke-width="1.3"/>
<line x1="4.5" y1="4.5" x2="11.5" y2="11.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
<line x1="11.5" y1="4.5" x2="4.5" y2="11.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
<circle cx="8" cy="8" r="1.6" fill="currentColor"/></svg>`,
        label: 'Drone LiDAR',
      },
      {
        // iPhone: rounded body, screen rim, speaker slit + home indicator.
        icon: `<svg viewBox="0 0 16 16" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
<rect x="4" y="1" width="8" height="14" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/>
<rect x="6.6" y="2.4" width="2.8" height="0.7" rx="0.35" fill="currentColor"/>
<rect x="6" y="12.6" width="4" height="0.6" rx="0.3" fill="currentColor" opacity="0.55"/></svg>`,
        label: 'iPhone scans',
      },
      {
        // Terrestrial laser scanner on tripod: scanner body + 3-leg tripod.
        icon: `<svg viewBox="0 0 16 16" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
<rect x="5" y="2" width="6" height="4" rx="0.7" fill="none" stroke="currentColor" stroke-width="1.3"/>
<circle cx="8" cy="4" r="0.9" fill="currentColor"/>
<line x1="8" y1="6" x2="8" y2="8.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
<line x1="8" y1="8.6" x2="4" y2="14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
<line x1="8" y1="8.6" x2="12" y2="14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
<line x1="8" y1="8.6" x2="8" y2="14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
        label: 'Terrestrial laser',
      },
    ];
    for (const k of KINDS) {
      const chip = el('span', {
        className: 'olv-capture-chip',
        title: `Open a scan from a ${k.label.toLowerCase()} capture`,
      });
      // Wrap the inline SVG in its own span so we can target it
      // independently in CSS without parsing the SVG namespace.
      const iconWrap = el('span', { className: 'olv-capture-chip-icon', unsafeHtml: k.icon });
      chip.append(iconWrap, el('span', { text: k.label }));
      captureKinds.append(chip);
    }

    // ── "Explore public LiDAR" — one bounded card grouping the location
    // dropdown, the location search (inside the catalog panel), and the
    // streaming demo: all paths to "open a known public dataset". Gestalt
    // common region — one card, one heading — so the three read as siblings.
    const samples = el('div', { className: 'olv-samples' });
    for (const s of options.samples ?? []) {
      // De-jargoned detail line — readable to first-time users without
      // requiring knowledge of "COPC" or "streamed".
      const detail = s.detail;
      const btn = el('button', {
        className: 'olv-sample',
        type: 'button',
        title:
          s.url.startsWith('http')
            ? `Open ${s.label.toLowerCase()} — streams over your network, nothing uploaded`
            : `Open ${s.label.toLowerCase()} — bundled fixture`,
      }, [
        el('span', { className: 'olv-sample-label', text: s.label }),
        el('span', { className: 'olv-sample-detail', text: detail }),
      ]);
      btn.addEventListener('click', () => {
        if (this._approveSample(s)) options.onSample?.(s.url, s.name);
      });
      samples.append(btn);
    }

    // ── Section: Open from URL (visible, the second real entry path) ─────
    // After merging the catalog into Quick demos, URL is the only
    // remaining secondary path — no need to hide it behind a disclosure.
    // The PC STAC "Search by location" lives inside the catalog panel
    // so it clusters with the curated dropdown.
    const urlRow = this._buildUrlRow(options);

    // ── Get-Started workflow stepper ─────────────────────────────────────
    // A four-step vertical timeline that previews the workflow before the
    // user opens a scan. The active step pulses ("you are here"); the
    // others read as muted previews of what comes next. Pattern lifted
    // from an instrument-style screening tool and adapted to the existing
    // calibrated palette. Listed BEFORE the open button so the first
    // signal a visitor reads is "here's the shape of the work you're
    // about to do", not "click this button".
    const stepsEyebrow = el('div', {
      className: 'olv-getstarted-eyebrow',
      text: 'Get started',
    });
    type GsStep = { id: string; title: string; sub: string };
    const GS_STEPS: ReadonlyArray<GsStep> = [
      { id: 'open', title: 'Open a scan', sub: 'Drag a file in or pick one below' },
      { id: 'move', title: 'Move around', sub: 'Orbit, walk, or fly through the cloud' },
      { id: 'inspect', title: 'Inspect or measure', sub: 'Coordinates, distance, area, volume' },
      { id: 'export', title: 'Export or share', sub: 'Image, PDF report, or share link' },
    ];
    const stepsList = el('ol', { className: 'olv-getstarted-steps' });
    for (let i = 0; i < GS_STEPS.length; i++) {
      const s = GS_STEPS[i];
      const li = el('li', { className: 'olv-getstarted-step' });
      li.dataset.step = s.id;
      // First step is the active "you are here" — others are muted previews.
      // `aria-current="step"` lets screen readers announce it as the current
      // step in the workflow instead of just another list item.
      //
      // v0.3.10 — the active step pulses (`olv-getstarted-pulse`
      // animation) and is announced as "current step" by screen readers,
      // which sets an expectation of interactivity. Wiring step 1 to focus
      // the URL-open input + adding `role="button"` and a keyboard handler
      // turns that visual promise into a real affordance. Steps 2-4 stay
      // non-interactive on purpose — they are a journey preview that only
      // becomes possible after a scan loads, so they correctly read as
      // muted descriptive list items with no `cursor: pointer` and no
      // hover state in CSS.
      if (i === 0) {
        li.classList.add('olv-getstarted-step-active');
        li.setAttribute('aria-current', 'step');
        li.setAttribute('role', 'button');
        li.tabIndex = 0;
        li.setAttribute(
          'aria-label',
          `${s.title}. ${s.sub}. Activate to focus the open-from-URL input.`,
        );
        const focusOpen = (): void => {
          // Prefer the URL input if it's available (rendered). Otherwise
          // fall back to the file picker — both fulfil "Open a scan".
          const target =
            this._urlInput ??
            (this.root.querySelector('.olv-open-btn') as
              | HTMLButtonElement
              | null);
          if (target) {
            target.focus({ preventScroll: false });
            // The URL input is hidden behind a section label on mobile;
            // bring it into view so the focus actually shows.
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        };
        li.addEventListener('click', focusOpen);
        li.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            focusOpen();
          }
        });
      }
      const dot = el('span', { className: 'olv-getstarted-dot', text: String(i + 1) });
      const body = el('div', { className: 'olv-getstarted-body' }, [
        el('b', { className: 'olv-getstarted-title', text: s.title }),
        el('em', { className: 'olv-getstarted-sub', text: s.sub }),
      ]);
      li.append(dot, body);
      stepsList.append(li);
    }
    const getStarted = el('section', {
      className: 'olv-getstarted',
      ariaLabel: 'Get started — workflow steps',
    }, [stepsEyebrow, stepsList]);

    // Convert: a small peer chip beside the primary "Open scan from device"
    // button (promoted from a buried text link). Clicking it opens the batch
    // converter directly — it is inherently batch, no scan needs to load.
    const convertChip = el('button', {
      className: 'olv-convert-chip',
      type: 'button',
      text: 'Convert file formats',
      title: 'Convert LAS / LAZ / XYZ / ASC files between formats — batch, no scan needs to load',
    });
    convertChip.addEventListener('click', () => options.onBatchConvert?.());

    // The consolidated "Explore public LiDAR" card (one common region).
    const exploreCard = el('section', {
      className: 'olv-explore-card',
      ariaLabel: 'Explore public LiDAR',
    }, [
      el('div', { className: 'olv-empty-section-label', text: 'Explore public LiDAR' }),
    ]);
    if (options.catalogPanel) exploreCard.append(options.catalogPanel);
    exploreCard.append(samples);

    const children: (Node | string)[] = [
      this._statusBanner,
      heroMark,
      title,
      sub,
      getStarted,
      openButton,
      fileInput,
      formats,
      captureKinds,
    ];
    // Convert sits with the capture-type chips — it's the "or work with files"
    // companion to "what kinds of scans this opens".
    if (options.onBatchConvert) children.push(convertChip);
    children.push(
      exploreCard,
      // Open-from-URL stays at the bottom as its own distinct entry path.
      urlRow,
    );

    return el('div', { className: 'olv-empty' }, children);
  }

  /**
   * The "open from URL" field — the entry point for streaming a remote COPC
   * (`.copc.laz`) scan. Item 10 replaces the quiet helper text with two
   * brighter constraint bullets above the input so the COPC + CORS
   * requirements aren't missed. The form orchestrates its own loading,
   * validation, error, and cancel UI; the parent only supplies `onOpenUrl`.
   */
  private _buildUrlRow(options: StageOptions): HTMLElement {
    const label = el('label', {
      className: 'olv-url-label olv-empty-section-label',
      text: 'Open from URL',
    });
    const bullets = el('ul', { className: 'olv-url-rules' }, [
      el('li', { text: 'File must be in COPC format (.copc.laz)' }),
      el('li', { text: 'Server must allow CORS range requests' }),
    ]);

    const input = el('input', {
      className: 'olv-url-input',
      type: 'url',
      ariaLabel: 'COPC file URL',
    });
    input.placeholder = 'https://host/scan.copc.laz';
    this._urlInput = input;

    // Inline validation on blur (E3) — soft warning, not a blocker.
    input.addEventListener('blur', () => {
      const url = input.value.trim();
      if (!url) {
        this._clearUrlError();
        return;
      }
      if (!this._looksLikeCopc(url)) {
        this._showUrlError(
          'This URL doesn\'t look like a COPC file. You can still try to open it.',
          'warning',
        );
      } else {
        this._clearUrlError();
      }
    });
    input.addEventListener('input', () => {
      // Typing clears any prior error so the field doesn't feel "stuck".
      this._clearUrlError();
    });

    const submit = el('button', {
      className: 'olv-url-btn',
      text: 'Open',
      title: 'Stream a Cloud Optimized Point Cloud from this URL',
    });
    submit.type = 'submit';
    this._urlSubmit = submit;

    // Inline error/warning slot — sits between the input and the bullets so
    // any message lives close to its cause.
    this._urlError = el('div', { className: 'olv-url-message olv-hidden' });

    const form = el('form', { className: 'olv-empty-url' }, [
      label,
      bullets,
      el('div', { className: 'olv-url-controls' }, [input, submit]),
      this._urlError,
    ]);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this._handleUrlSubmit(input.value.trim(), options);
    });
    return form;
  }

  /**
   * Empty-state file pick gate. On mobile, files above the soft memory
   * threshold show a confirmation so the user isn't surprised by a tab
   * crash mid-load. Returns true if the load should proceed.
   * Error-handling-UX item E2.
   */
  private _approveFile(file: File): boolean {
    if (!isMobileViewport()) return true;
    if (file.size < MOBILE_MEMORY_WARN_BYTES) return true;
    const message =
      `This file is ${formatBytes(file.size)}. On phones it may exceed the ` +
      `tab's memory and crash. Open anyway?`;
    return window.confirm(message);
  }

  /**
   * Sample-button gate. Items E1 (cellular warning) and E2 (mobile memory
   * warning) layer onto the same confirmation prompt so the user sees a
   * single, focused decision before a large download begins.
   */
  private _approveSample(sample: Sample): boolean {
    const size = sample.sizeBytes ?? 0;
    if (size === 0) return true;

    const reasons: string[] = [];
    const cellular = isCellularConnection();
    if (cellular && size >= CELLULAR_WARN_BYTES) {
      reasons.push(
        `You're on a cellular connection — ${formatBytes(size)} of data ` +
        `may use your mobile-data quota.`,
      );
    }
    if (isMobileViewport() && size >= MOBILE_MEMORY_WARN_BYTES) {
      reasons.push(
        `This sample is ${formatBytes(size)} — on phones it may exceed the ` +
        `tab's memory.`,
      );
    }
    if (reasons.length === 0) return true;
    return window.confirm(`${reasons.join('\n\n')}\n\nContinue?`);
  }

  /**
   * Submit handler for the URL field. Walks the prevent → detect →
   * communicate → recover error hierarchy:
   *   • Empty input: do nothing (no nag).
   *   • Offline: refuse with a message; preserve input.
   *   • Otherwise: call `onOpenUrl`, flip the button to a Cancel control
   *     while the promise is pending, surface any error inline, and on
   *     failure preserve the URL + show a Retry banner so recovery is one
   *     tap away.
   */
  private async _handleUrlSubmit(url: string, options: StageOptions): Promise<void> {
    if (!url) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this._showUrlError(
        'You\'re offline. Connect to the internet to stream a remote scan, ' +
        'or open a file from your device.',
        'error',
      );
      return;
    }
    if (!this._urlSubmit) return;

    this._clearUrlError();
    this._hideStatusBanner();
    this._setUrlLoading(true);

    const controller = new AbortController();
    this._urlAbortController = controller;

    try {
      const result = options.onOpenUrl?.(url);
      if (result instanceof Promise) {
        await result;
      }
      // Success — the host page typically calls hideEmptyState which already
      // resets this state, but clear just in case.
      this._setUrlLoading(false);
      this._urlAbortController = null;
    } catch (err) {
      this._urlAbortController = null;
      this._setUrlLoading(false);
      if ((err as { name?: string })?.name === 'AbortError') {
        // User-initiated cancel — no error noise, just restore.
        return;
      }
      const friendly = this._friendlyUrlError(err);
      this._showUrlError(friendly, 'error');
      // E8: input is preserved (we never cleared it), so the user can
      // tweak and resubmit. Plus a retry banner up top (E9).
      this._showRetryBanner(url, options);
    }
  }

  /** Map raw fetch / range-source errors to plain-English guidance (E6). */
  private _friendlyUrlError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err ?? '');
    const lower = raw.toLowerCase();
    if (lower.includes('cors') || lower.includes('cross-origin')) {
      return (
        'This file\'s host blocks browser access. Try downloading the file ' +
        'and using Open scan from device, or ask the host to allow CORS.'
      );
    }
    if (lower.includes('failed to fetch') || lower.includes('networkerror')) {
      return (
        'Couldn\'t reach this URL. Check the link, your connection, and ' +
        'whether the host is online.'
      );
    }
    if (lower.includes('range') || lower.includes('416')) {
      return (
        'The host returned an unexpected range response. The file may be ' +
        'corrupted or not a valid COPC.'
      );
    }
    if (lower.includes('404') || lower.includes('not found')) {
      return 'No file found at this URL. Check the path and try again.';
    }
    if (lower.includes('403') || lower.includes('forbidden')) {
      return 'The host refused access. Check the link or use Open scan from device.';
    }
    if (lower.includes('aborted')) {
      return 'Cancelled.';
    }
    return raw || 'Couldn\'t open this URL. Try downloading the file and opening it from your device.';
  }

  /** Cosmetic heuristic — true for things that look like a COPC URL. */
  private _looksLikeCopc(url: string): boolean {
    const lower = url.toLowerCase();
    return (
      lower.includes('.copc.laz') ||
      lower.includes('.copc.las') ||
      lower.endsWith('/ept.json') ||
      lower.includes('/ept.json?')
    );
  }

  /**
   * Toggle the Open button into / out of its loading state. While loading,
   * the button shows a spinner and the label flips to "Cancel" so item E10
   * gives the user an explicit escape from an in-flight stream.
   */
  private _setUrlLoading(loading: boolean): void {
    const button = this._urlSubmit;
    if (!button) return;
    if (loading) {
      button.classList.add('olv-url-btn-loading');
      button.type = 'button'; // suppress the form's default submit
      button.textContent = 'Cancel';
      button.title = 'Cancel the in-flight load';
      button.onclick = () => this._cancelUrlLoad();
    } else {
      button.classList.remove('olv-url-btn-loading');
      button.type = 'submit';
      button.textContent = 'Open';
      button.title = 'Stream a Cloud Optimized Point Cloud from this URL';
      button.onclick = null;
    }
  }

  /** Abort the in-flight URL load if one is running. Item E10. */
  private _cancelUrlLoad(): void {
    if (!this._urlAbortController) {
      this._setUrlLoading(false);
      return;
    }
    try {
      this._urlAbortController.abort();
    } catch {
      // ignore — abort can throw in old engines on a re-abort
    }
    this._urlAbortController = null;
    this._setUrlLoading(false);
  }

  /** Show an inline message under the URL input, severity-coloured. */
  private _showUrlError(message: string, severity: 'warning' | 'error'): void {
    if (!this._urlError) return;
    this._urlError.textContent = message;
    this._urlError.classList.remove('olv-hidden', 'olv-url-message-warning', 'olv-url-message-error');
    this._urlError.classList.add(
      severity === 'error' ? 'olv-url-message-error' : 'olv-url-message-warning',
    );
  }

  /** Hide the inline URL message. */
  private _clearUrlError(): void {
    if (!this._urlError) return;
    this._urlError.classList.add('olv-hidden');
    this._urlError.textContent = '';
  }

  /**
   * Top-of-page Retry banner. Surfaces the failed URL with a one-tap retry
   * affordance — the recover step of E9. The Retry button reuses the same
   * submit pipeline as a manual press.
   */
  private _showRetryBanner(url: string, options: StageOptions): void {
    if (!this._statusBanner) return;
    this._statusBanner.replaceChildren();
    this._statusBanner.classList.remove('olv-hidden', 'olv-empty-status-offline');
    this._statusBanner.classList.add('olv-empty-status-error');
    const label = el('span', { text: 'Last URL failed to open.' });
    const retry = el('button', {
      className: 'olv-empty-status-action',
      type: 'button',
      text: 'Retry',
    });
    retry.addEventListener('click', () => {
      this._hideStatusBanner();
      void this._handleUrlSubmit(url, options);
    });
    const dismiss = el('button', {
      className: 'olv-empty-status-dismiss',
      type: 'button',
      text: '×',
      ariaLabel: 'Dismiss',
    });
    dismiss.addEventListener('click', () => this._hideStatusBanner());
    this._statusBanner.append(label, retry, dismiss);
  }

  /** Tear down whichever status banner is currently up. */
  private _hideStatusBanner(): void {
    if (!this._statusBanner) return;
    this._statusBanner.classList.add('olv-hidden');
    this._statusBanner.replaceChildren();
  }

  /**
   * Reflect online / offline state. When offline, surface a banner and
   * disable the URL submit button — items E4. The file-pick path stays
   * available since it doesn't need the network.
   */
  private _setOfflineState(offline: boolean): void {
    if (this._urlSubmit) this._urlSubmit.disabled = offline;
    if (this._urlInput) this._urlInput.disabled = offline;
    if (!this._statusBanner) return;
    if (offline) {
      this._statusBanner.replaceChildren();
      this._statusBanner.classList.remove('olv-hidden', 'olv-empty-status-error');
      this._statusBanner.classList.add('olv-empty-status-offline');
      this._statusBanner.append(
        el('span', {
          text:
            'You\'re offline. Open a file from your device to keep working — ' +
            'streaming will resume when you reconnect.',
        }),
      );
    } else {
      // Only auto-dismiss if the offline banner is the one currently shown.
      if (this._statusBanner.classList.contains('olv-empty-status-offline')) {
        this._hideStatusBanner();
      }
    }
  }
}
