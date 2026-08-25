/**
 * ProfileWorkbench.ts
 *
 * The docked Profile Workbench: a plot of the individual returns inside a
 * measured cross-section, with the exact figures for the selected return
 * beside it.
 *
 * NON-MODAL BY CONTRACT. The workbench exists to inspect a cloud that stays on
 * screen, so the scene below it keeps rendering, keeps its pointer input, and
 * keeps its place in the tab order. That rules out every modal device:
 *
 *   - no `aria-modal`, and no `dialog` role — the panel is a labelled region;
 *   - no focus trap, and no focus taken on mount;
 *   - no backdrop and no blur over the scene;
 *   - Escape acts only for a key event that arrived from inside the panel, and
 *     the listener lives on the panel's own root, never on the document, so a
 *     global Escape binding still sees every press from outside.
 *
 * `ResultFocus` remains the modal surface for the compact chart, unchanged.
 *
 * Heights are not computed here. Every one of them — opening, dragged,
 * collapsed, re-derived after a stage resize — comes from
 * `profileWorkbenchDock.ts`, which owns what the numbers are allowed to be.
 *
 * The module reaches the outside world only through the host it is given and
 * `el()`: no `window`, no `localStorage`, no document-level listeners. That is
 * what lets the whole panel be driven by a plain object in a test.
 */

import { el } from './dom';
import {
  PROFILE_WORKBENCH_DOCK_KEY,
  dockOccupiedHeight,
  maxDockHeight,
  encodeDockPrefs,
  resizeDock,
  restoreDockState,
  toggleDockCollapsed,
  type DockLimits,
  type DockState,
} from './profileWorkbenchDock';

/** Minimal storage seam — a `Storage` is assignable, a plain object is too. */
export interface ProfileWorkbenchStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * What the workbench needs from whatever is hosting it.
 *
 * Structural on purpose: nothing here names the Viewer, a point cloud, or any
 * render module, so the panel is mounted against a plain object in tests and
 * against the real stage in the app.
 */
export interface ProfileWorkbenchHost {
  /** The element the dock is appended to. */
  container(): HTMLElement;
  /** Height shared between the 3D scene and the dock, in pixels. */
  stageHeight(): number;
  /** Subscribe to stage-size changes. Returns the unsubscribe. */
  onStageResize(cb: () => void): () => void;
  /** The dock's current occupied height, so the host can resize its canvas. */
  notifyDockHeight(dockPx: number): void;
  /** Persisted dock preference. Absent ⇒ the dock opens at its default. */
  storage?: ProfileWorkbenchStorage;
  /** True when the user asked for reduced motion. Absent ⇒ treated as false. */
  prefersReducedMotion?(): boolean;
}

/** One labelled figure about the selected return. */
export interface ProfileWorkbenchDetailRow {
  readonly label: string;
  readonly value: string;
}

export interface ProfileWorkbenchOptions {
  /** Region title. Also the panel's accessible name. */
  readonly title?: string;
  /** The section the plot covers, shown under the title. */
  readonly scope?: string;
  /** Called when the user closes the panel. */
  readonly onClose?: () => void;
}

/** What the caller drives the mounted panel through. */
export interface ProfileWorkbenchHandle {
  readonly element: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  /**
   * The surface the hover crosshair and the selection box are drawn on,
   * stacked over the plot.
   *
   * OPTIONAL, so a handle built by an older double still satisfies the type.
   * A separate canvas because a section can hold a hundred thousand splats:
   * moving a crosshair by redrawing the plot would put every one of them
   * through `fillRect` on each hover frame.
   */
  readonly overlay?: HTMLCanvasElement;
  /** Occupied height in pixels, as the dock module derives it. */
  height(): number;
  collapsed(): boolean;
  setCollapsed(collapsed: boolean): void;
  /** Describe the section the plot covers. */
  setScope(text: string): void;
  /**
   * Show, or clear with null, the caution about what the heights were chosen
   * from. Separate from the scope line because it is a consequence rather
   * than a description, and it earns its own space only when it applies.
   */
  setGroundBasis(note: string | null): void;
  /** Announce a status politely. */
  setStatus(text: string): void;
  /** The selected return's figures, as text. Null clears the selection. */
  setDetail(rows: readonly ProfileWorkbenchDetailRow[] | null): void;
  /**
   * The one-line readout for the return under the pointer. Null clears it.
   *
   * Separate from `setStatus`, which is a polite live region: a line that
   * changes on every hover would have a screen reader announcing the plot
   * continuously while the pointer crosses it.
   */
  setReadout?(text: string | null): void;
  close(): void;
}

/** Pixels a keyboard nudge moves the splitter. */
const KEY_RESIZE_STEP = 24;

/** The canvas is a picture of the returns; the numbers live in the detail list. */
const CANVAS_DESCRIPTION =
  'Plot of the individual returns across the measured section. Every exact figure is listed in the selected-return details beside it.';

const NO_SELECTION = 'No return selected.';

/**
 * Mount the workbench into the host's container.
 *
 * Opens at the stored height, or this stage's default when nothing usable is
 * stored. The returned handle is the only way to drive it, and `close()`
 * leaves the host as it was found — every listener released, the element gone,
 * and a later mount unaffected.
 */
export function mountProfileWorkbench(
  host: ProfileWorkbenchHost,
  options: ProfileWorkbenchOptions = {},
): ProfileWorkbenchHandle {
  return new ProfileWorkbench(host, options).handle();
}

class ProfileWorkbench {
  private readonly _host: ProfileWorkbenchHost;
  private readonly _options: ProfileWorkbenchOptions;
  private readonly _root: HTMLElement;
  private readonly _splitter: HTMLElement;
  private readonly _scope: HTMLElement;
  private readonly _groundNote: HTMLElement;
  private readonly _status: HTMLElement;
  private readonly _detail: HTMLElement;
  private readonly _readout: HTMLElement;
  private readonly _canvas: HTMLCanvasElement;
  private readonly _overlay: HTMLCanvasElement;
  private readonly _collapseBtn: HTMLButtonElement;
  private readonly _teardown: (() => void)[] = [];
  private _state: DockState;
  private _closed = false;
  private _dragFrom: number | null = null;

  constructor(host: ProfileWorkbenchHost, options: ProfileWorkbenchOptions) {
    this._host = host;
    this._options = options;
    const title = options.title ?? 'Profile workbench';

    this._state = restoreDockState(
      host.storage ? host.storage.getItem(PROFILE_WORKBENCH_DOCK_KEY) : null,
      this._limits(),
    );

    // The splitter is a real separator, so the height is reachable without a
    // pointer: the arrow keys move it through the same dock arithmetic a drag
    // uses, and the value it reports is the height the dock actually occupies.
    this._splitter = el('div', { className: 'olv-workbench-splitter' });
    this._splitter.setAttribute('role', 'separator');
    this._splitter.setAttribute('aria-orientation', 'horizontal');
    this._splitter.setAttribute('aria-label', 'Resize the profile workbench');
    this._splitter.setAttribute('tabindex', '0');

    this._scope = el('div', { className: 'olv-workbench-scope', text: options.scope ?? '' });
    // `role="note"` rather than an alert: this is standing context about the
    // plot, not an event, so it should be reachable in reading order without
    // interrupting whatever the user is doing.
    this._groundNote = el('div', { className: 'olv-workbench-basis olv-hidden' });
    this._groundNote.setAttribute('role', 'note');
    this._collapseBtn = el('button', {
      className: 'olv-workbench-btn',
      type: 'button',
      text: 'Collapse',
    });
    const closeBtn = el('button', {
      className: 'olv-workbench-btn olv-workbench-close',
      type: 'button',
      text: 'Close',
      ariaLabel: 'Close the profile workbench',
    });

    const head = el('div', { className: 'olv-workbench-head' }, [
      el('div', { className: 'olv-workbench-titles' }, [
        el('div', { className: 'olv-workbench-title', text: title }),
        this._scope,
        this._groundNote,
      ]),
      el('div', { className: 'olv-workbench-actions' }, [this._collapseBtn, closeBtn]),
    ]);

    // Polite, never assertive: a status here reports on a plot the user is
    // already looking at, and must not cut across what a screen reader is
    // saying about the scene.
    this._status = el('div', { className: 'olv-workbench-status' });
    this._status.setAttribute('role', 'status');
    this._status.setAttribute('aria-live', 'polite');

    this._canvas = el('canvas', { className: 'olv-workbench-canvas' });
    this._canvas.setAttribute('role', 'img');
    this._canvas.setAttribute('aria-label', CANVAS_DESCRIPTION);

    // Decoration over a picture: the crosshair states nothing the readout and
    // the detail rows do not already state as text, so it is hidden from
    // assistive technology rather than announced as a second image.
    this._overlay = el('canvas', { className: 'olv-workbench-overlay' });
    this._overlay.setAttribute('aria-hidden', 'true');

    this._detail = el('div', { className: 'olv-workbench-detail' });
    this._detail.setAttribute('aria-label', 'Selected return');
    this.setDetail(null);

    // Not a live region. The pointer crosses hundreds of returns in a sweep,
    // and announcing each one would talk over everything else.
    this._readout = el('div', { className: 'olv-workbench-readout' });

    const plot = el('div', { className: 'olv-workbench-plot' }, [this._canvas, this._overlay]);
    const body = el('div', { className: 'olv-workbench-body' }, [
      el('div', { className: 'olv-workbench-plotwrap' }, [plot, this._readout]),
      this._detail,
    ]);

    this._root = el('section', { className: 'olv-workbench' }, [
      this._splitter,
      head,
      this._status,
      body,
    ]);
    // A labelled region, not a dialog: assistive tech can jump to it and out of
    // it again, and nothing about it says the rest of the app is inert.
    this._root.setAttribute('role', 'region');
    this._root.setAttribute('aria-label', title);
    // Motion is opt-in. With no host opinion, or a stated preference against
    // it, the height changes land without a transition.
    if (!this._reducedMotion()) this._root.classList.add('olv-workbench-animate');

    this._on(this._collapseBtn, 'click', () => this.setCollapsed(!this._state.collapsed));
    this._on(closeBtn, 'click', () => this.close());
    this._on(this._root, 'keydown', (ev) => this._onKeyDown(ev as KeyboardEvent));
    this._on(this._splitter, 'keydown', (ev) => this._onSplitterKey(ev as KeyboardEvent));
    this._on(this._splitter, 'pointerdown', (ev) => this._onPointerDown(ev as PointerEvent));
    this._on(this._splitter, 'pointermove', (ev) => this._onPointerMove(ev as PointerEvent));
    this._on(this._splitter, 'pointerup', (ev) => this._onPointerUp(ev as PointerEvent));
    this._on(this._splitter, 'pointercancel', (ev) => this._onPointerUp(ev as PointerEvent));

    // A stage resize re-derives from the SAME stored preference, so shrinking
    // the window and growing it again returns the height the user chose rather
    // than the clamped remnant it passed through.
    const off = host.onStageResize(() => this._apply());
    this._teardown.push(off);

    host.container().append(this._root);
    this._apply();
  }

  handle(): ProfileWorkbenchHandle {
    return {
      element: this._root,
      canvas: this._canvas,
      overlay: this._overlay,
      height: () => dockOccupiedHeight(this._state, this._limits()),
      collapsed: () => this._state.collapsed,
      setCollapsed: (v: boolean) => this.setCollapsed(v),
      setScope: (t: string) => {
        this._scope.textContent = t;
      },
      setGroundBasis: (note: string | null) => {
        this._groundNote.textContent = note ?? '';
        this._groundNote.classList.toggle('olv-hidden', note == null);
      },
      setStatus: (t: string) => {
        this._status.textContent = t;
      },
      setDetail: (rows) => this.setDetail(rows),
      setReadout: (t: string | null) => {
        this._readout.textContent = t ?? '';
      },
      close: () => this.close(),
    };
  }

  setCollapsed(collapsed: boolean): void {
    if (this._closed || collapsed === this._state.collapsed) return;
    this._state = toggleDockCollapsed(this._state);
    this._persist();
    this._apply();
    this._status.textContent = this._state.collapsed
      ? 'Profile workbench collapsed.'
      : 'Profile workbench restored.';
  }

  /**
   * Render the selected return's figures.
   *
   * A canvas states nothing an assistive technology can read, so every exact
   * value the plot shows also exists here as text.
   */
  setDetail(rows: readonly ProfileWorkbenchDetailRow[] | null): void {
    if (!rows || rows.length === 0) {
      this._detail.replaceChildren(
        el('div', { className: 'olv-workbench-detail-empty', text: NO_SELECTION }),
      );
      return;
    }
    this._detail.replaceChildren(
      ...rows.map((row) =>
        el('div', { className: 'olv-workbench-detail-row' }, [
          el('span', { className: 'olv-workbench-detail-key', text: row.label }),
          el('span', { className: 'olv-workbench-detail-value', text: row.value }),
        ]),
      ),
    );
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    for (const off of this._teardown.splice(0)) off();
    this._root.remove();
    this._options.onClose?.();
  }

  private _limits(): DockLimits {
    return { stageHeight: this._host.stageHeight() };
  }

  private _reducedMotion(): boolean {
    return this._host.prefersReducedMotion ? this._host.prefersReducedMotion() : false;
  }

  private _on(target: HTMLElement, type: string, fn: (ev: Event) => void): void {
    target.addEventListener(type, fn as EventListener);
    this._teardown.push(() => target.removeEventListener(type, fn as EventListener));
  }

  /** Push the current state to the element, the splitter, and the host. */
  private _apply(): void {
    if (this._closed) return;
    const limits = this._limits();
    const height = dockOccupiedHeight(this._state, limits);
    this._root.style.height = `${height}px`;
    this._root.classList.toggle('olv-workbench-collapsed', this._state.collapsed);
    this._collapseBtn.textContent = this._state.collapsed ? 'Expand' : 'Collapse';
    this._collapseBtn.setAttribute('aria-expanded', this._state.collapsed ? 'false' : 'true');
    this._splitter.setAttribute('aria-valuenow', String(Math.round(height)));
    this._splitter.setAttribute('aria-valuemin', '0');
    this._splitter.setAttribute('aria-valuemax', String(Math.round(maxDockHeight(limits))));
    // The host owns the 3D canvas; it cannot resize what it was not told about.
    this._host.notifyDockHeight(height);
  }

  private _persist(): void {
    this._host.storage?.setItem(PROFILE_WORKBENCH_DOCK_KEY, encodeDockPrefs(this._state));
  }

  /**
   * Escape, and only from inside.
   *
   * The listener is on the panel's root, so a press anywhere else never
   * reaches it; the containment check is the second half of the same rule, for
   * an event routed here by other means. An Escape the panel does act on stops
   * there rather than also closing whatever else is listening.
   */
  private _onKeyDown(ev: KeyboardEvent): void {
    if (ev.key !== 'Escape') return;
    const target = ev.target as Node | null;
    if (!target || !this._root.contains(target)) return;
    ev.stopPropagation();
    if (this._state.collapsed) this.close();
    else this.setCollapsed(true);
  }

  private _onSplitterKey(ev: KeyboardEvent): void {
    // A drag upward is a negative screen delta, which is what makes the dock
    // taller; the arrow keys hand `resizeDock` the same sign.
    const dy = ev.key === 'ArrowUp' ? -KEY_RESIZE_STEP : ev.key === 'ArrowDown' ? KEY_RESIZE_STEP : 0;
    if (dy === 0) return;
    ev.preventDefault();
    this._resizeBy(dy);
  }

  private _onPointerDown(ev: PointerEvent): void {
    this._dragFrom = ev.clientY;
    this._root.classList.add('olv-workbench-dragging');
    // Capture on the splitter keeps the drag on this element's own listeners,
    // so the panel never binds a move handler to the document.
    this._splitter.setPointerCapture?.(ev.pointerId);
  }

  private _onPointerMove(ev: PointerEvent): void {
    if (this._dragFrom === null) return;
    const dy = ev.clientY - this._dragFrom;
    if (dy === 0) return;
    this._dragFrom = ev.clientY;
    this._resizeBy(dy);
  }

  private _onPointerUp(ev: PointerEvent): void {
    if (this._dragFrom === null) return;
    this._dragFrom = null;
    this._root.classList.remove('olv-workbench-dragging');
    this._splitter.releasePointerCapture?.(ev.pointerId);
    this._persist();
  }

  /** The one path a height changes by. */
  private _resizeBy(dy: number): void {
    if (this._closed) return;
    this._state = resizeDock(this._state, dy, this._limits());
    this._persist();
    this._apply();
  }
}
