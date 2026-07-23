import { el } from './dom';
import { SOURCE_FORMATS } from '../io/sniffFormat';
import { openConfirm } from './Modal';
import { FullscreenToggle } from './FullscreenToggle';
import { formatByteSize as formatBytes } from '../io/formatByteSize';
import { isMobileDevice } from './isMobileDevice';

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
   * One curated streaming dataset surfaced as the "Try a sample scan"
   * ghost button directly under the primary CTA — the one-click demo for
   * a visitor with no LiDAR file on hand. Uses the same approval gate and
   * `onSample` path as the sample list.
   */
  demoSample?: Sample;
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
   *
   * `signal` is the Stage's own cancel signal: it aborts when the user
   * presses the field's Cancel button (or the empty state hides). The host
   * MUST honour it — before v0.4.4 the Cancel button aborted a signal
   * nobody consumed, so an in-flight stream kept downloading.
   */
  onOpenUrl?: (url: string, signal?: AbortSignal) => void | Promise<void>;
  /**
   * Called when the user chooses "Batch convert files" on the empty state —
   * opens the format converter without loading a scan into the 3D view.
   */
  onBatchConvert?: () => void;
  /**
   * Starts the onboarding tour. The tour used to auto-open on first visit,
   * which put a modal over the product before the visitor had seen anything;
   * it is now launched only from this quiet chip near the CTA.
   */
  onStartTour?: () => void;
  /**
   * Optional ready-made DOM node that the empty state mounts as the
   * verified-public-LiDAR-dataset picker. Built by main.ts so the
   * catalog module — including its dataset list — never enters this
   * UI file. When omitted the empty state simply skips the section.
   */
  catalogPanel?: HTMLElement;
}

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

/**
 * The official OpenLiDARViewer brand mark — `public/brand-mark.svg`, the
 * delivered logo asset cropped (via its root viewBox, nothing redrawn) to
 * the point-cloud-orb mark region. Rendered with `<img src>` rather than
 * inline SVG so the asset ships byte-faithful and never enters the
 * `unsafeHtml` escape hatch. `BASE_URL` keeps the reference correct under
 * the relative-base (`./`) production build.
 */
const MARK_SRC = `${import.meta.env.BASE_URL}brand-mark.svg`;

/** Build an `<img>` for the official brand mark. Decorative by default. */
function brandMarkImg(className: string, alt = ''): HTMLImageElement {
  const img = el('img', { className });
  img.src = MARK_SRC;
  img.alt = alt;
  img.decoding = 'async';
  return img;
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
    // The official brand mark (public/brand-mark.svg, via <img>) beside the
    // text wordmark. The mark is the delivered logo asset — the asset's own
    // raster wordmark band stays cropped out here because it is near-white
    // and sized for dark hero fields, not a 28 px light-theme top bar.
    const wordmark = el('div', { className: 'olv-wordmark' });
    wordmark.append(
      brandMarkImg('olv-wordmark-mark'),
      el('span', { text: 'OpenLiDARViewer' }),
    );

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

    // Data sources & credits — a quiet ghost link, same treatment as GitHub.
    // Keeps attribution for the streamed public datasets one click away from
    // every screen without crowding the trust signal.
    const credits = el('a', {
      className: 'olv-github',
      text: 'Credits',
      href: 'credits.html',
      ariaLabel: 'Data sources and credits',
    });
    credits.target = '_blank';
    credits.rel = 'noreferrer';

    // Full-screen toggle — lives in the header cluster (just left of the
    // theme toggle, which inserts itself before GitHub). Self-contained:
    // it drives the Fullscreen API on the whole app and tracks F11/Esc too.
    const fullscreen = new FullscreenToggle();

    const right = el('div', { className: 'olv-topbar-right' }, [
      privacy,
      fullscreen.element,
      credits,
      github,
    ]);
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
    const mobile = isMobileDevice();
    // Hero: the official brand mark (public/brand-mark.svg, via <img> —
    // the delivered logo asset, mark-only crop). The product name already
    // reads in the top-left nav wordmark; repeating it here made the hero
    // carry the brand twice before saying anything, so the mark stands
    // alone and the headline below is the first text. The image itself is
    // decorative (alt="").
    const heroMark = el('div', { className: 'olv-empty-hero' }, [
      brandMarkImg('olv-empty-hero-mark'),
    ]);
    const eyebrow = el('div', {
      className: 'olv-empty-eyebrow',
      text: 'Browser-native point-cloud workspace',
    });
    const title = el('h1', {
      className: 'olv-empty-title',
      text: 'Inspect LiDAR and 3D scans in your browser',
    });
    // v0.3.6 desktop-audit fix: one consolidated trust line. Replaces three
    // separate "verified at release time" / "verified at build time" / CORS
    // helper paragraphs that previously stacked across the empty state. The
    // privacy posture is the single most important first-paint signal — give
    // it one home, then let the actions speak for themselves.
    // Precision over punch: "Nothing leaves your device" was not quite true
    // of a product that can stream remote COPC when asked to. Say exactly
    // what holds: local files stay local; remote data moves only on request.
    const sub = el('p', {
      className: 'olv-empty-sub',
      text: mobile
        ? 'Local files stay on this device.'
        : 'Local files stay on this device; remote datasets stream only when selected.',
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
      // The approval gate is now async (styled modal) — open only once approved.
      if (file) void this._approveFile(file).then((ok) => { if (ok) options.onOpenFile?.(file); });
      fileInput.value = ''; // let the same file be re-picked
    });
    // No idle pulse: an instrument is still until you touch it. The CTA's
    // size, colour and position carry the affordance on their own.
    const openButton = el('button', {
      className: 'olv-open-btn',
      type: 'button',
      text: 'Open scan from device',
      title: 'Choose a point-cloud file from your device — or drag one onto the page',
    });
    openButton.addEventListener('click', () => fileInput.click());

    // "Try a sample scan" — the zero-friction demo path, promoted from the
    // Explore card below the fold to a ghost button directly under the
    // primary CTA. A visitor with no LiDAR file on hand is the common case;
    // one click streams a real dataset and shows the product working. Reuses
    // the first streaming sample (and its approval gate) so there is exactly
    // one consent path for remote data.
    const demoSample =
      options.demoSample ?? (options.samples ?? []).find((s) => s.url.startsWith('http'));
    const tryButton = demoSample
      ? el('button', {
          className: 'olv-try-sample',
          type: 'button',
          // The provider stays IN the label: naming swisstopo on the button
          // is the courtesy attribution their open-data terms ask for, and
          // docs/credits.md records the exact object behind it.
          text: `Launch a sample — ${demoSample.label}`,
          title: `Open ${demoSample.label.toLowerCase()} — streams over your network, nothing uploaded`,
        })
      : null;
    if (tryButton && demoSample) {
      tryButton.addEventListener('click', () => {
        void this._approveSample(demoSample).then((ok) => {
          if (ok) options.onSample?.(demoSample.url, demoSample.name);
        });
      });
    }

    // Item 5: format list collapses to a one-line summary with a tap-to-
    // expand. Reads cleanly on mobile instead of a wall of 10 extensions.
    // Both lines are generated from the sniffer's own registry, never typed:
    // the hand-maintained version said "10 formats" beside an 11-format
    // sniffer and silently omitted .xyz from the list.
    const formats = el('details', { className: 'olv-empty-formats' });
    const formatsSummary = el('summary', {
      className: 'olv-empty-formats-summary',
      text: `Compatible data — ${SOURCE_FORMATS.length} formats including .las, .laz, .e57`,
    });
    const formatsFull = el('p', {
      className: 'olv-empty-formats-full',
      text: SOURCE_FORMATS.map((f) => `.${f}`).join(' · '),
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
        label: 'Aerial LiDAR',
      },
      {
        // iPhone: rounded body, screen rim, speaker slit + home indicator.
        icon: `<svg viewBox="0 0 16 16" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
<rect x="4" y="1" width="8" height="14" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/>
<rect x="6.6" y="2.4" width="2.8" height="0.7" rx="0.35" fill="currentColor"/>
<rect x="6" y="12.6" width="4" height="0.6" rx="0.3" fill="currentColor" opacity="0.55"/></svg>`,
        label: 'Mobile LiDAR',
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
        label: 'Terrestrial scanning',
      },
    ];
    const CHIP_TITLES: Readonly<Record<string, string>> = {
      'Aerial LiDAR': 'Drone and aircraft LiDAR surveys',
      'Mobile LiDAR': 'iPhone, iPad and handheld scanner captures',
      'Terrestrial scanning': 'Tripod-mounted terrestrial laser scanners',
    };
    for (const k of KINDS) {
      const chip = el('span', {
        className: 'olv-capture-chip',
        title: CHIP_TITLES[k.label] ?? k.label,
      });
      // Wrap the inline SVG in its own span so we can target it
      // independently in CSS without parsing the SVG namespace.
      const iconWrap = el('span', { className: 'olv-capture-chip-icon', unsafeHtml: k.icon });
      chip.append(iconWrap, el('span', { text: k.label }));
      captureKinds.append(chip);
    }
    // The chips live INSIDE the compatible-data disclosure: what capture
    // kinds this opens is the same question as what formats it opens, and
    // neither deserves a high-priority row on the launch surface.
    formats.append(captureKinds);

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
        void this._approveSample(s).then((ok) => { if (ok) options.onSample?.(s.url, s.name); });
      });
      samples.append(btn);
    }

    // ── Section: Open from URL (visible, the second real entry path) ─────
    // After merging the catalog into Quick demos, URL is the only
    // remaining secondary path — no need to hide it behind a disclosure.
    // The PC STAC "Search by location" lives inside the catalog panel
    // so it clusters with the curated dropdown.
    const urlRow = this._buildUrlRow(options);

    // ── Workflow rail ────────────────────────────────────────────────────
    // The four-step "Get started" stepper is now a compact one-line rail:
    // small numerals, short labels, a hairline connector, no interaction.
    // The old vertical timeline read as a tutorial and owned the space
    // between the headline and the CTA; worse, its "interactive" first step
    // focused the remote-URL input — the wrong target for "Open a scan".
    // The rail states the shape of the work and then gets out of the way.
    const RAIL_STEPS: ReadonlyArray<string> = [
      'Open a scan',
      'Move around',
      'Inspect or measure',
      'Export or share',
    ];
    const stepsList = el('ol', { className: 'olv-rail' });
    for (let i = 0; i < RAIL_STEPS.length; i++) {
      const li = el('li', { className: 'olv-rail-step' });
      if (i === 0) {
        li.classList.add('olv-rail-step-active');
        li.setAttribute('aria-current', 'step');
      }
      li.append(
        el('span', { className: 'olv-rail-num', text: String(i + 1).padStart(2, '0') }),
        el('span', { className: 'olv-rail-label', text: RAIL_STEPS[i] }),
      );
      stepsList.append(li);
    }
    const getStarted = el('nav', {
      className: 'olv-getstarted',
      ariaLabel: 'Workflow: open, move, measure, export',
    }, [stepsList]);

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

    // The tour is offered, never imposed: it used to auto-open on first
    // visit, covering the product with a modal before the visitor had seen
    // anything. The feature survives as this quiet chip.
    const tourChip = options.onStartTour
      ? el('button', {
          className: 'olv-tour-chip',
          type: 'button',
          text: 'Take the 30-second tour',
          title: 'A quick guided tour of the main tools',
        })
      : null;
    if (tourChip) tourChip.addEventListener('click', () => options.onStartTour?.());

    // One line for the claims the product actually stakes its identity on.
    const trustStrip = el('div', {
      className: 'olv-trust-strip',
      text: 'Local processing · No account · WebGPU / WebGL 2 · Open source',
    });

    // Order is the hierarchy: identity → primary action → workflow shape →
    // trust → compatibility disclosures → alternative data sources.
    // Sample and tour share one row; Convert lives inside the
    // compatible-data disclosure with the other file utilities. Both moves
    // exist to keep the first screen to one column of short lines.
    const secondary =
      tryButton || tourChip
        ? el('div', { className: 'olv-empty-secondary' }, [
            ...(tryButton ? [tryButton] : []),
            ...(tourChip ? [tourChip] : []),
          ])
        : null;
    if (options.onBatchConvert) formats.append(convertChip);
    const children: (Node | string)[] = [
      this._statusBanner,
      heroMark,
      eyebrow,
      title,
      sub,
      openButton,
    ];
    if (secondary) children.push(secondary);
    children.push(fileInput, getStarted, trustStrip, formats);
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
    // Connection requirements are real constraints, but stating them before
    // the input made the section shout protocol at every visitor. They fold
    // into a disclosure the person who actually needs them will open.
    const bullets = el('details', { className: 'olv-url-reqs' }, [
      el('summary', { className: 'olv-url-reqs-summary', text: 'Connection requirements' }),
      el('ul', { className: 'olv-url-rules' }, [
        el('li', { text: 'File must be in COPC format (.copc.laz)' }),
        el('li', { text: 'Server must allow CORS range requests' }),
      ]),
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
  private _approveFile(file: File): Promise<boolean> {
    if (!isMobileDevice()) return Promise.resolve(true);
    if (file.size < MOBILE_MEMORY_WARN_BYTES) return Promise.resolve(true);
    const message =
      `This file is ${formatBytes(file.size)}. On phones it may exceed the ` +
      `tab's memory and crash. Open anyway?`;
    // Styled confirm, not window.confirm(): the latter is suppressed in many
    // embedded WebViews, which would silently block the load.
    return openConfirm({ title: 'Open large file?', message, confirmLabel: 'Open anyway' });
  }

  /**
   * Sample-button gate. Items E1 (cellular warning) and E2 (mobile memory
   * warning) layer onto the same confirmation prompt so the user sees a
   * single, focused decision before a large download begins.
   */
  private _approveSample(sample: Sample): Promise<boolean> {
    const size = sample.sizeBytes ?? 0;
    if (size === 0) return Promise.resolve(true);

    const reasons: string[] = [];
    const cellular = isCellularConnection();
    if (cellular && size >= CELLULAR_WARN_BYTES) {
      reasons.push(
        `You're on a cellular connection — ${formatBytes(size)} of data ` +
        `may use your mobile-data quota.`,
      );
    }
    if (isMobileDevice() && size >= MOBILE_MEMORY_WARN_BYTES) {
      reasons.push(
        `This sample is ${formatBytes(size)} — on phones it may exceed the ` +
        `tab's memory.`,
      );
    }
    if (reasons.length === 0) return Promise.resolve(true);
    // Styled confirm, not window.confirm(): reliable inside embedded WebViews.
    return openConfirm({
      title: 'Download this sample?',
      message: reasons.join('\n'),
      confirmLabel: 'Continue',
    });
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
    if (!url) {
      // An empty "Open" press used to be a silent no-op — tell the user
      // what the field wants instead of doing nothing (E-hierarchy:
      // communicate, don't ignore).
      this._showUrlError(
        'Enter a URL to a .copc.laz file or an EPT dataset (ept.json).',
        'warning',
      );
      return;
    }
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
      // Hand the controller's signal to the host so the Cancel button's
      // abort actually reaches the in-flight fetches (it previously
      // aborted a signal nobody consumed).
      const result = options.onOpenUrl?.(url, controller.signal);
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
      // WHY preventDefault: clicking Cancel runs _cancelUrlLoad →
      // _setUrlLoading(false), which flips this button back to
      // type="submit" while the click event is still dispatching. The
      // browser then evaluates the click's default action against the
      // *current* type and submits the form — instantly re-starting the
      // very load the user just cancelled. Suppressing the default
      // action up front breaks that re-submission loop.
      button.onclick = (e) => {
        e.preventDefault();
        this._cancelUrlLoad();
      };
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
