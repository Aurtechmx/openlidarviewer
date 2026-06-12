/**
 * tourSteps.ts
 *
 * Pure data layer for the v0.3.9 onboarding tour. Defines the step
 * model, the session state machine, and the localStorage persistence
 * for the "I've seen this" flag. The DOM overlay that paints the
 * spotlight + tooltip is in `TourOverlay.ts` — it consumes this
 * module and never touches the persistence layer directly.
 *
 * Storage contract:
 *   - Key `olv:tour:v1:completed` — '1' once the user finished or
 *     skipped the tour.
 *   - The key is intentionally version-scoped (v1) so a future tour
 *     overhaul can re-show without manually clearing localStorage.
 *
 * Pure-data: no DOM, no three.js. Persistence is injected as a port
 * so unit tests use an in-memory fake.
 */

/** Where the tooltip card sits relative to its target. */
export type TourPlacement = 'top' | 'bottom' | 'left' | 'right' | 'center';

/** One step in the tour. */
export interface TourStep {
  /** Stable id — useful in tests and for analytics. */
  readonly id: string;
  /**
   * CSS selector that identifies the target element. The first match
   * is highlighted. Pass `null` for a centre-screen step (no spotlight).
   */
  readonly target: string | null;
  /** Headline shown in the tooltip card. */
  readonly title: string;
  /**
   * Body copy shown beneath the headline. `*asterisk-wrapped*` spans are
   * key-term highlights — the overlay renders them as themed `<mark>`
   * elements (see {@link splitEmphasis}); everything else is plain text.
   */
  readonly body: string;
  /** Where the tooltip card sits relative to the target. */
  readonly placement: TourPlacement;
  /**
   * Optional predicate — when present and returning `false`, the step
   * is skipped. Useful for "show this step only on desktop" or
   * "skip if no scan is loaded yet".
   */
  readonly runIf?: () => boolean;
}

/**
 * The default tour — five steps spanning the most-discovered surfaces.
 * Copy verified against the live UI in the v0.4.5 pass; each claim below
 * names the surface that backs it (Stage empty state, Inspector sections,
 * dock + MeasurePanel, command palette).
 */
export const DEFAULT_TOUR: readonly TourStep[] = [
  {
    id: 'welcome',
    target: null,
    title: 'Welcome to OpenLiDARViewer',
    body:
      'A quick tour of the main tools — about 30 seconds. Press Esc any time to skip.',
    placement: 'center',
  },
  {
    id: 'open-scan',
    // The empty state's primary CTA (Stage.ts `.olv-open-btn`). The old
    // selector pointed at a dock "Open" button that has never existed —
    // the spotlight silently failed on every first run.
    target: '.olv-open-btn',
    title: 'Open a scan',
    body:
      'Drop a .las, .laz, .e57, or .ply file anywhere on the page, pick one ' +
      'with this button, or stream a *.copc.laz* URL from the field below.',
    placement: 'bottom',
  },
  {
    // Copy verified v0.4.5: the Inspector really does carry all five —
    // the CRS section, the "N / M points" count, the Dataset Intelligence
    // density row, the "Color by" section and the Visuals Studio rails.
    id: 'inspector',
    target: '.olv-inspector',
    title: 'Inspector',
    body:
      'CRS, point count, density, *colour mode*, and the *Visuals Studio* all live here. Sections collapse to keep the first paint clean.',
    placement: 'left',
  },
  {
    // `.olv-dock-measure` is the stable hook toolDock.ts now stamps on the
    // Measure button; the title fallback only matched the enabled-state
    // tooltip. On the empty state the dock is hidden — the overlay detects
    // the zero-size target and centres the card instead.
    id: 'measure',
    target: '.olv-dock-measure, .olv-dock button[title*="Measure"]',
    title: 'Measure',
    body:
      'Distance, area, height, slope, profile, box, volume, and freehand lasso volume. Click *Chain* in the panel to aggregate across measurements.',
    placement: 'bottom',
  },
  {
    id: 'palette',
    target: null,
    title: 'Command palette',
    body:
      'Press *Cmd-K* (Mac) or *Ctrl-K* to find any action by name — camera presets, themes, tool toggles, and more.',
    placement: 'center',
  },
];

/** One segment of a step body: plain text, or an emphasised key term. */
export interface BodySegment {
  readonly text: string;
  /** True for `*wrapped*` spans — rendered as a themed <mark>. */
  readonly mark: boolean;
}

/**
 * Split a step body into plain / emphasised segments. `*term*` marks a key
 * term; an unpaired `*` is treated as literal text (never a dangling
 * highlight). Pure — the overlay builds real DOM nodes from the segments,
 * so step copy can never inject HTML.
 */
export function splitEmphasis(body: string): BodySegment[] {
  const out: BodySegment[] = [];
  const re = /\*([^*]+)\*/g;
  let last = 0;
  for (let m = re.exec(body); m !== null; m = re.exec(body)) {
    if (m.index > last) out.push({ text: body.slice(last, m.index), mark: false });
    out.push({ text: m[1], mark: true });
    last = m.index + m[0].length;
  }
  if (last < body.length) out.push({ text: body.slice(last), mark: false });
  return out;
}

/** Outcome of the user's interaction with the tour. */
export type TourOutcome = 'completed' | 'skipped' | 'dismissed';

/**
 * The persistence port. Default implementation uses `localStorage`;
 * tests inject a Map-backed fake.
 */
export interface TourStoragePort {
  readonly hasSeen: () => boolean;
  readonly setSeen: () => void;
  readonly clear: () => void;
}

const STORAGE_KEY = 'olv:tour:v1:completed';

/** Default `localStorage`-backed port. */
export const DEFAULT_TOUR_STORAGE: TourStoragePort = {
  hasSeen: () => {
    try {
      return typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  },
  setSeen: () => {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      /* defensive — quota-exceeded / private-mode is fine, the tour
         simply re-shows on the next session. */
    }
  },
  clear: () => {
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* defensive */
    }
  },
};

/**
 * The tour session state machine. Owns the current step index and
 * the run/skip outcome. Pure — listeners receive a fresh
 * `TourSnapshot` so the consuming overlay can paint without poking
 * at private state.
 */
export class TourSession {
  private readonly _steps: readonly TourStep[];
  private readonly _storage: TourStoragePort;
  private _index = 0;
  private _state: 'pending' | 'running' | TourOutcome = 'pending';
  private readonly _listeners = new Set<(snap: TourSnapshot) => void>();

  constructor(
    steps: readonly TourStep[] = DEFAULT_TOUR,
    storage: TourStoragePort = DEFAULT_TOUR_STORAGE,
  ) {
    this._steps = steps;
    this._storage = storage;
  }

  /** Total step count (after filtering is applied dynamically by `current`). */
  get stepCount(): number {
    return this._steps.length;
  }

  /** Current state — 'pending' before `start`, 'running' during, then the outcome. */
  get state(): 'pending' | 'running' | TourOutcome {
    return this._state;
  }

  /** Whether the user has already completed or skipped a previous run. */
  hasSeen(): boolean {
    return this._storage.hasSeen();
  }

  /**
   * Start the tour. No-op when already running. Listeners are fired
   * with a snapshot of the first runnable step.
   */
  start(): void {
    if (this._state === 'running') return;
    this._index = 0;
    this._state = 'running';
    this._skipFiltered();
    this._broadcast();
  }

  /** Advance to the next runnable step. Completes when none remains. */
  next(): void {
    if (this._state !== 'running') return;
    this._index += 1;
    this._skipFiltered();
    if (this._index >= this._steps.length) {
      this._finish('completed');
      return;
    }
    this._broadcast();
  }

  /** Step back to the previous runnable step. No-op at the first step. */
  back(): void {
    if (this._state !== 'running') return;
    this._index -= 1;
    this._skipFilteredReverse();
    if (this._index < 0) this._index = 0;
    this._broadcast();
  }

  /** End the tour with a `'skipped'` outcome and persist the flag. */
  skip(): void {
    if (this._state !== 'running') return;
    this._finish('skipped');
  }

  /** End the tour without setting the persisted flag. */
  dismiss(): void {
    if (this._state !== 'running') return;
    this._state = 'dismissed';
    this._broadcast();
  }

  /** Reset the persisted flag and the session — used by "Replay tour". */
  reset(): void {
    this._storage.clear();
    this._index = 0;
    this._state = 'pending';
    this._broadcast();
  }

  /** Snapshot the current step + index for the overlay. */
  snapshot(): TourSnapshot {
    const total = this._steps.length;
    // In any state other than 'running', `step` is null so the
    // overlay doesn't paint a phantom card when the tour hasn't
    // started / has already finished.
    const step =
      this._state === 'running' &&
      this._index >= 0 &&
      this._index < total
        ? this._steps[this._index]
        : null;
    return {
      step,
      index: this._index,
      total,
      state: this._state,
    };
  }

  /** Subscribe to state changes. Returns an unsubscribe handle. */
  subscribe(listener: (snap: TourSnapshot) => void): () => void {
    this._listeners.add(listener);
    // Defensive — same isolation pattern as the broadcast path so a
    // throwing first fire doesn't skip the unsubscribe registration.
    try {
      listener(this.snapshot());
    } catch {
      /* swallow — see CrsService for the rationale */
    }
    return () => this._listeners.delete(listener);
  }

  // ── private ────────────────────────────────────────────────────────

  private _broadcast(): void {
    const snap = this.snapshot();
    for (const fn of this._listeners) {
      try {
        fn(snap);
      } catch {
        /* defensive — a buggy subscriber must not poison siblings */
      }
    }
  }

  private _skipFiltered(): void {
    while (
      this._index < this._steps.length &&
      this._steps[this._index].runIf &&
      !this._steps[this._index].runIf!()
    ) {
      this._index += 1;
    }
  }

  private _skipFilteredReverse(): void {
    while (
      this._index >= 0 &&
      this._steps[this._index]?.runIf &&
      !this._steps[this._index].runIf!()
    ) {
      this._index -= 1;
    }
  }

  private _finish(outcome: 'completed' | 'skipped'): void {
    this._state = outcome;
    this._storage.setSeen();
    this._broadcast();
  }
}

/** A snapshot of the session state — what the overlay reads each frame. */
export interface TourSnapshot {
  readonly step: TourStep | null;
  readonly index: number;
  readonly total: number;
  readonly state: 'pending' | 'running' | TourOutcome;
}
