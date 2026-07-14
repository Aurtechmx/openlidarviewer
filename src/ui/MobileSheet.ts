/**
 * MobileSheet.ts
 *
 * The phone bottom-sheet (design audit 1.3 follow-up). Below the mobile
 * breakpoint the floating desktop panels do not fit side-by-side, so a single
 * bottom sheet hosts them all behind a three-way segmented control:
 *
 *   View    — appearance: Color by, Point size, Rendering, Visuals (the Inspector)
 *   Analyse — the terrain verdict / products and the Space / Object report
 *   Layers  — class legend, measurements, annotations, and export
 *
 * This component owns ONLY the sheet chrome — the segmented tablist, the three
 * tabpanel slots, the drag/collapse handle, and the show/hide state. It does NOT
 * own the panels: the host (main.ts) re-parents the existing panel elements into
 * {@link slot} on mobile and restores them on desktop, so every panel keeps its
 * own logic, state and listeners. Re-parenting a live node preserves its event
 * listeners, so nothing is re-wired on a breakpoint change.
 *
 * Snap points. The sheet has three real detents — 'peek' (just the head),
 * 'half' (~50dvh) and 'full' (~88dvh) — modelled as {@link SheetDetent}. The
 * head is draggable: a vertical pointer drag rubber-bands the sheet height and,
 * on release, snaps to the nearest detent by position; a fast flick skips to the
 * next detent in the fling direction (down → collapse toward 'peek', up → expand
 * toward 'full'). A tap (no meaningful movement) still toggles peek↔full, and
 * taps on a tab never start a drag. The two 'expanded' detents (half + full)
 * both report {@link isExpanded} as true, so the legacy collapsed/expanded
 * callers keep working unchanged.
 *
 * The drag math lives in the pure, unit-testable helpers {@link nearestDetent}
 * and {@link flingTarget}; the DOM handlers only feed them geometry.
 *
 * Tab semantics use the ARIA tabs pattern (tablist / tab / tabpanel) so the
 * control is operable and announced correctly. Arrow keys move between tabs.
 *
 * Pure DOM via {@link el}; no three.js, no app singletons — unit-testable with
 * the recording-stub document the other UI tests use.
 */

import { el } from './dom';

/** The three mobile tabs, in display order. */
export type MobileTab = 'view' | 'analyse' | 'layers';

/**
 * A snap point of the sheet, low → high:
 *   'peek' — collapsed to just the head (legacy "collapsed").
 *   'half' — roughly half the viewport.
 *   'full' — roughly the whole viewport (legacy "expanded").
 */
export type SheetDetent = 'peek' | 'half' | 'full';

/** Detents low → high; index order is used for fling stepping + clamping. */
export const DETENTS: readonly SheetDetent[] = ['peek', 'half', 'full'];

const TABS: ReadonlyArray<{ id: MobileTab; label: string }> = [
  { id: 'view', label: 'View' },
  { id: 'analyse', label: 'Analyse' },
  { id: 'layers', label: 'Layers' },
];

/** Movement (px) below which a pointer gesture counts as a tap, not a drag. */
const TAP_SLOP_PX = 6;
/**
 * Release speed (px/ms) past which we treat the gesture as a flick and step one
 * detent in the fling direction instead of snapping to the nearest by position.
 */
const FLING_VELOCITY = 0.5;

/**
 * Pick the detent whose height is closest to `heightPx`. Pure: ties resolve to
 * the first (lowest) detent scanned, which keeps the result deterministic.
 */
export function nearestDetent(
  heightPx: number,
  heights: Record<SheetDetent, number>,
): SheetDetent {
  let best: SheetDetent = DETENTS[0];
  let bestDist = Infinity;
  for (const d of DETENTS) {
    const dist = Math.abs(heights[d] - heightPx);
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  return best;
}

/**
 * Resolve a flick to a target detent. `velocity` is the vertical release speed
 * in px/ms using screen coordinates (positive = finger moving DOWN = collapse,
 * negative = UP = expand). A flick faster than `threshold` steps one detent in
 * that direction, clamped at the ends; anything slower stays put (the caller
 * then snaps by position instead). Pure and side-effect free.
 */
export function flingTarget(
  current: SheetDetent,
  velocity: number,
  threshold: number,
): SheetDetent {
  const i = DETENTS.indexOf(current);
  if (i < 0) return current;
  if (velocity <= -threshold) return DETENTS[Math.min(i + 1, DETENTS.length - 1)]; // up → expand
  if (velocity >= threshold) return DETENTS[Math.max(i - 1, 0)]; // down → collapse
  return current;
}

export interface MobileSheetOptions {
  /** Fired after the active tab changes (user click or keyboard). */
  readonly onTabChange?: (tab: MobileTab) => void;
  /**
   * Fired after the sheet crosses the collapsed⇄expanded boundary — i.e. only
   * when {@link isExpanded} flips. Moving between 'half' and 'full' does NOT
   * fire this (both are "expanded"); use {@link onDetentChange} for that.
   */
  readonly onExpandedChange?: (expanded: boolean) => void;
  /** Fired after the snap detent changes (drag release, tap, or programmatic). */
  readonly onDetentChange?: (detent: SheetDetent) => void;
  /**
   * The tab shown first. Defaults to `'analyse'` so the honesty-first verdict
   * stays the hero on phones, matching the desktop verdict-as-hero treatment.
   */
  readonly initialTab?: MobileTab;
  /**
   * Whether the sheet starts expanded. Defaults to `false` so on phones the
   * sheet opens at the 'peek' detent (just its head), leaving the canvas
   * visible. `true` starts at 'full'. Ignored if {@link initialDetent} is set.
   */
  readonly initialExpanded?: boolean;
  /**
   * The snap detent to start at. Takes precedence over {@link initialExpanded};
   * if neither is given the sheet starts at 'peek'.
   */
  readonly initialDetent?: SheetDetent;
}

export class MobileSheet {
  /** The sheet root — the host appends this to the overlay. */
  readonly element: HTMLElement;

  private readonly _slots = new Map<MobileTab, HTMLElement>();
  private readonly _tabs = new Map<MobileTab, HTMLButtonElement>();
  private readonly _onTabChange?: (tab: MobileTab) => void;
  private readonly _onExpandedChange?: (expanded: boolean) => void;
  private readonly _onDetentChange?: (detent: SheetDetent) => void;
  private _active: MobileTab;
  private _detent: SheetDetent;

  // ── drag gesture state (only touched inside pointer handlers) ─────────────
  private _dragging = false;
  private _dragStartY = 0;
  private _dragStartHeight = 0;
  private _lastY = 0;
  private _lastT = 0;
  private _lastV = 0;
  /** Set when a drag ends so the synthetic click that follows is swallowed. */
  private _suppressClick = false;

  constructor(opts: MobileSheetOptions = {}) {
    this._onTabChange = opts.onTabChange;
    this._onExpandedChange = opts.onExpandedChange;
    this._onDetentChange = opts.onDetentChange;
    this._active = opts.initialTab ?? 'analyse';
    // Default to 'peek' on phones so the sheet opens as just its head. An
    // explicit detent wins; otherwise initialExpanded maps true → 'full'.
    this._detent = opts.initialDetent ?? (opts.initialExpanded ? 'full' : 'peek');

    // ── tablist (the segmented control) ────────────────────────────────────
    const tablist = el('div', { className: 'olv-msheet-tabs' });
    tablist.setAttribute('role', 'tablist');
    tablist.setAttribute('aria-label', 'Panel group');
    for (const { id, label } of TABS) {
      const tab = el('button', { className: 'olv-msheet-tab', text: label, type: 'button' });
      tab.setAttribute('role', 'tab');
      tab.dataset.tab = id;
      tab.id = `olv-msheet-tab-${id}`;
      tab.setAttribute('aria-controls', `olv-msheet-panel-${id}`);
      tab.addEventListener('click', () => this.setActive(id));
      tab.addEventListener('keydown', (ev) => this._onTabKey(ev as KeyboardEvent, id));
      this._tabs.set(id, tab);
      tablist.append(tab);
    }

    // ── drag / collapse handle ─────────────────────────────────────────────
    const handle = el('button', {
      className: 'olv-msheet-handle',
      type: 'button',
      ariaLabel: 'Collapse panel',
    });
    handle.setAttribute('aria-expanded', 'true');
    handle.addEventListener('click', () => {
      if (this._consumeSuppressedClick()) return;
      this.toggleExpanded();
    });
    this._handle = handle;

    const head = el('div', { className: 'olv-msheet-head' }, [tablist, handle]);
    // The whole head/grip is tappable to toggle the sheet — EXCEPT taps on a
    // tab (which select a tab) and taps on the handle (which has its own
    // listener above, so we skip here to avoid a double-toggle).
    head.addEventListener('click', (ev) => {
      if (this._consumeSuppressedClick()) return;
      const target = ev.target as HTMLElement | null;
      if (target?.closest('[role="tab"]')) return;
      if (target?.closest('.olv-msheet-handle')) return;
      this.toggleExpanded();
    });
    // Vertical pointer drag on the head rubber-bands the sheet height and snaps
    // to a detent on release. Tab taps are excluded (see _onPointerDown).
    head.addEventListener('pointerdown', (ev) => this._onPointerDown(ev as PointerEvent));
    head.addEventListener('pointermove', (ev) => this._onPointerMove(ev as PointerEvent));
    head.addEventListener('pointerup', (ev) => this._onPointerUp(ev as PointerEvent));
    head.addEventListener('pointercancel', () => this._endDrag());
    this._head = head;

    // ── tabpanel slots ─────────────────────────────────────────────────────
    const body = el('div', { className: 'olv-msheet-body' });
    for (const { id } of TABS) {
      const panel = el('div', { className: 'olv-msheet-slot' });
      panel.setAttribute('role', 'tabpanel');
      panel.id = `olv-msheet-panel-${id}`;
      panel.dataset.tab = id;
      panel.setAttribute('aria-labelledby', `olv-msheet-tab-${id}`);
      this._slots.set(id, panel);
      body.append(panel);
    }
    this._body = body;

    this.element = el('div', { className: 'olv-mobile-sheet' }, [head, body]);
    this.element.setAttribute('aria-label', 'Panels');

    this._syncTabs();
    this._syncDetent();
  }

  private _handle!: HTMLButtonElement;
  private _head!: HTMLElement;
  private _body!: HTMLElement;

  /** The tabpanel container the host re-parents this tab's panels into. */
  slot(tab: MobileTab): HTMLElement {
    const s = this._slots.get(tab);
    if (!s) throw new Error(`MobileSheet: unknown tab "${tab}"`);
    return s;
  }

  /** The currently selected tab. */
  getActive(): MobileTab {
    return this._active;
  }

  /** Select a tab (idempotent). Expands the sheet if it was collapsed. */
  setActive(tab: MobileTab): void {
    if (!this._slots.has(tab)) return;
    const changed = tab !== this._active;
    this._active = tab;
    if (!this.isExpanded()) this.setExpanded(true);
    this._syncTabs();
    if (changed) this._onTabChange?.(tab);
  }

  /** Whether the body is expanded ('half' or 'full') vs collapsed ('peek'). */
  isExpanded(): boolean {
    return this._detent !== 'peek';
  }

  /** The current snap detent. */
  getDetent(): SheetDetent {
    return this._detent;
  }

  /**
   * Snap to a detent (idempotent). Fires {@link onDetentChange} when the detent
   * changes and {@link onExpandedChange} only when that crosses the peek/expand
   * boundary — preserving the legacy collapsed⇄expanded callback contract.
   */
  setDetent(detent: SheetDetent): void {
    if (!DETENTS.includes(detent) || detent === this._detent) return;
    const wasExpanded = this.isExpanded();
    this._detent = detent;
    this._syncDetent();
    if (this.isExpanded() !== wasExpanded) this._onExpandedChange?.(this.isExpanded());
    this._onDetentChange?.(detent);
  }

  setExpanded(expanded: boolean): void {
    // Map the legacy boolean onto detents: collapse → 'peek', expand → 'full'
    // (but leave an already-expanded 'half' where it is).
    if (expanded === this.isExpanded()) return;
    this.setDetent(expanded ? 'full' : 'peek');
  }

  toggleExpanded(): void {
    // A tap toggles the two-state peek↔full path callers/tests expect.
    this.setDetent(this.isExpanded() ? 'peek' : 'full');
  }

  /** Show or hide the whole sheet (the host hides it with no scan loaded). */
  setVisible(visible: boolean): void {
    this.element.classList.toggle('olv-hidden', !visible);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private _onTabKey(ev: KeyboardEvent, id: MobileTab): void {
    const idx = TABS.findIndex((t) => t.id === id);
    let next = -1;
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') next = (idx + 1) % TABS.length;
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') next = (idx - 1 + TABS.length) % TABS.length;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = TABS.length - 1;
    if (next < 0) return;
    ev.preventDefault();
    const target = TABS[next].id;
    this.setActive(target);
    this._tabs.get(target)?.focus();
  }

  // ── pointer drag ──────────────────────────────────────────────────────────

  /** Pixel heights of each detent for the current viewport (drag geometry). */
  private _detentHeights(): Record<SheetDetent, number> {
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
    const headH = this._head.getBoundingClientRect?.().height || 56;
    return {
      peek: headH,
      half: Math.round(vh * 0.5),
      full: Math.round(vh * 0.88),
    };
  }

  private _onPointerDown(ev: PointerEvent): void {
    // Never drag from a tab (that's a selection) or with a non-primary button.
    const target = ev.target as HTMLElement | null;
    if (target?.closest('[role="tab"]')) return;
    if (ev.button != null && ev.button !== 0) return;
    this._dragging = false; // becomes true once we pass the slop threshold
    this._dragStartY = ev.clientY;
    this._dragStartHeight = this._detentHeights()[this._detent];
    this._lastY = ev.clientY;
    this._lastT = ev.timeStamp || Date.now();
    this._lastV = 0;
    this._head.setPointerCapture?.(ev.pointerId);
  }

  private _onPointerMove(ev: PointerEvent): void {
    if (this._dragStartY === 0 && !this._dragging) return;
    const dy = ev.clientY - this._dragStartY;
    if (!this._dragging && Math.abs(dy) < TAP_SLOP_PX) return;
    if (!this._dragging) {
      this._dragging = true;
      this.element.classList.add('is-dragging');
    }
    // Track instantaneous velocity for the flick test on release.
    const now = ev.timeStamp || Date.now();
    const dt = now - this._lastT;
    if (dt > 0) this._lastV = (ev.clientY - this._lastY) / dt; // +down / -up (px/ms)
    this._lastY = ev.clientY;
    this._lastT = now;
    // Rubber-band the live height: dragging down (positive dy) shrinks it.
    const heights = this._detentHeights();
    const raw = this._dragStartHeight - dy;
    const clamped = Math.max(heights.peek, Math.min(heights.full, raw));
    this.element.style.height = `${clamped}px`;
    ev.preventDefault?.();
  }

  private _onPointerUp(ev: PointerEvent): void {
    if (!this._dragging) {
      // A tap: let the click handler drive the toggle. Just reset.
      this._resetDrag();
      return;
    }
    const heights = this._detentHeights();
    const rect = this.element.getBoundingClientRect?.();
    const heightPx = rect?.height ?? this._dragStartHeight;
    // Fast flick → step one detent in the fling direction; else snap nearest.
    const flick = flingTarget(this._detent, this._lastV, FLING_VELOCITY);
    const target = flick !== this._detent ? flick : nearestDetent(heightPx, heights);
    this._suppressClick = true; // swallow the click this pointerup will synthesize
    this._endDrag();
    this._head.releasePointerCapture?.(ev.pointerId);
    this.setDetent(target);
  }

  /** Clear the live drag transform + flags without changing the detent. */
  private _endDrag(): void {
    this.element.classList.remove('is-dragging');
    this.element.style.height = '';
    this._resetDrag();
  }

  private _resetDrag(): void {
    this._dragging = false;
    this._dragStartY = 0;
    this._lastV = 0;
  }

  /** True (and self-clears) if a just-finished drag should eat this click. */
  private _consumeSuppressedClick(): boolean {
    if (!this._suppressClick) return false;
    this._suppressClick = false;
    return true;
  }

  private _syncTabs(): void {
    for (const { id } of TABS) {
      const isActive = id === this._active;
      const tab = this._tabs.get(id);
      if (tab) {
        tab.classList.toggle('is-active', isActive);
        tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
        // Roving tabindex: only the active tab is in the tab order.
        tab.setAttribute('tabindex', isActive ? '0' : '-1');
      }
      const slot = this._slots.get(id);
      if (slot) slot.classList.toggle('is-active', isActive);
    }
  }

  private _syncDetent(): void {
    const collapsed = this._detent === 'peek';
    this.element.classList.toggle('is-collapsed', collapsed);
    // A per-detent class drives the CSS height (peek/half/full).
    for (const d of DETENTS) {
      this.element.classList.toggle(`olv-msheet--${d}`, d === this._detent);
    }
    this.element.dataset.detent = this._detent;
    this._body.classList.toggle('olv-hidden', collapsed);
    this._handle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    this._handle.setAttribute('aria-label', collapsed ? 'Expand panel' : 'Collapse panel');
  }
}
