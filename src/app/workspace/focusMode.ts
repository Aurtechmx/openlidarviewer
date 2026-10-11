/**
 * focusMode.ts
 *
 * Focus mode gives the scan the screen: both side rails collapse and the
 * secondary header chrome steps aside, while the compass, the navigation card,
 * the dock, the measure guidance, the state strip's warnings and every toast
 * stay where they are. It is presentation only. It never touches the camera,
 * what is drawn, classification, clipping, measurements or analysis, and it
 * puts nothing over the canvas: the hiding is one class on the overlay.
 *
 * The rails move through their own programmatic seam (`RailToggle`) with
 * `persist: false`, so the stored collapse preference is never written. Enter
 * records what it found; exit puts exactly that back, so a rail the user had
 * collapsed stays collapsed. The state lives for the page only: a reload, a
 * closed scan or a switch to the phone layout ends it.
 *
 * Phones are not offered Focus mode. There the panels live in the bottom
 * sheet, whose smallest detent already gives the scan the screen, and a
 * second mechanism over the sheet would only compete with its own handle.
 */

/** A rail as Focus mode needs it: read and set, without persisting. */
export interface FocusRail {
  isCollapsed(): boolean;
  setCollapsed(collapsed: boolean, opts?: { persist?: boolean }): void;
}

export interface FocusRoute {
  readonly mode: string;
  readonly page: string | null;
}

export interface FocusModeDeps {
  /** Receives `olv-focus-mode`; the stylesheet hides the secondary chrome. */
  readonly root: Pick<HTMLElement, 'classList'>;
  readonly left: FocusRail;
  readonly right: FocusRail;
  /** The workspace route, recorded on enter. */
  readonly route: () => FocusRoute;
  /** False on a phone or with no scan open. */
  readonly available: () => boolean;
  /**
   * True while something with a stronger claim on Escape is up: a dialog, an
   * open popover, pointer lock. Escape then belongs to it.
   */
  readonly escapeBlocked?: () => boolean;
  readonly onChange?: (active: boolean) => void;
}

export interface FocusSnapshot {
  readonly leftCollapsed: boolean;
  readonly rightCollapsed: boolean;
  readonly route: FocusRoute;
}

export interface FocusMode {
  isActive(): boolean;
  /** What enter recorded, or null outside Focus mode. */
  snapshot(): FocusSnapshot | null;
  /** Returns false when Focus mode is not available here. */
  enter(): boolean;
  exit(): void;
  /** Enter or exit; returns whether Focus mode is now on. */
  toggle(): boolean;
  /** Escape: exits and returns true only when nothing else claims the key. */
  escape(): boolean;
  /**
   * Re-check after the route or the layout changed. Navigating elsewhere asks
   * for a rail, so Focus mode steps aside; so does losing availability.
   */
  sync(): void;
  dispose(): void;
}

export const FOCUS_MODE_CLASS = 'olv-focus-mode';
/** The command-palette action asks the shell through this document event. */
export const FOCUS_MODE_TOGGLE_EVENT = 'olv-focus-mode-toggle';

export function createFocusMode(d: FocusModeDeps): FocusMode {
  let snap: FocusSnapshot | null = null;

  const exit = (): void => {
    if (!snap) return;
    const s = snap;
    snap = null;
    d.left.setCollapsed(s.leftCollapsed, { persist: false });
    d.right.setCollapsed(s.rightCollapsed, { persist: false });
    d.root.classList.remove(FOCUS_MODE_CLASS);
    d.onChange?.(false);
  };

  const enter = (): boolean => {
    if (snap) return true;
    if (!d.available()) return false;
    snap = {
      leftCollapsed: d.left.isCollapsed(),
      rightCollapsed: d.right.isCollapsed(),
      route: { ...d.route() },
    };
    d.left.setCollapsed(true, { persist: false });
    d.right.setCollapsed(true, { persist: false });
    d.root.classList.add(FOCUS_MODE_CLASS);
    d.onChange?.(true);
    return true;
  };

  return {
    isActive: () => snap !== null,
    snapshot: () => snap,
    enter,
    exit,
    toggle: () => {
      if (snap) { exit(); return false; }
      return enter();
    },
    escape: () => {
      if (!snap || d.escapeBlocked?.()) return false;
      exit();
      return true;
    },
    sync: () => {
      if (!snap) return;
      const r = d.route();
      if (!d.available() || r.mode !== snap.route.mode || r.page !== snap.route.page) exit();
    },
    dispose: exit,
  };
}
