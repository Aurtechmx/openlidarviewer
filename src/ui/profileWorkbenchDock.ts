/**
 * profileWorkbenchDock.ts
 *
 * Geometry and persisted state for the docked Profile Workbench.
 *
 * The workbench sits below the stage and shares its height with the 3D
 * canvas. That makes the split a numeric contract rather than a styling
 * detail: whatever the user drags, the scene keeps a usable height, because
 * the workbench exists to inspect a cloud that has to stay visible.
 *
 * Pure. No DOM. The panel module owns the elements and the drag events; this
 * owns what the numbers are allowed to be.
 */

/** Storage key for the persisted dock preference. */
export const PROFILE_WORKBENCH_DOCK_KEY = 'olv:measure:profile:workbenchDock:v1';

/** Fraction of the stage the dock takes before a user moves it. */
export const DEFAULT_DOCK_FRACTION = 0.4;

/** The dock never leaves the scene less than this many pixels. */
export const MIN_SCENE_HEIGHT = 120;

/** The dock's preferred minimum while open, on a stage that can afford it. */
export const MIN_DOCK_HEIGHT = 140;

/**
 * The dock's share of a stage too short to give it {@link MIN_DOCK_HEIGHT}
 * and the scene {@link MIN_SCENE_HEIGHT} at once.
 *
 * Below that size the minimums cannot both hold, and preferring the dock
 * would leave the scene nothing at all. Splitting instead keeps both
 * present, which is what lets the user drag back out.
 */
export const TIGHT_STAGE_DOCK_FRACTION = 0.5;

/** Height of the collapsed dock, which shows its header only. */
export const COLLAPSED_DOCK_HEIGHT = 36;

export interface DockLimits {
  /** Total height available to the stage and the dock together. */
  readonly stageHeight: number;
}

export interface DockState {
  /**
   * The height the user asked for, in pixels.
   *
   * Retained exactly as expressed, including while collapsed and while the
   * stage is too small to honour it. The height the dock actually occupies
   * is derived on read by {@link dockOccupiedHeight}, so shrinking a window
   * and growing it again returns this value rather than a clamped remnant.
   */
  readonly preferredHeightPx: number;
  readonly collapsed: boolean;
}

function finite(v: number): boolean {
  return Number.isFinite(v);
}

/**
 * The largest open height that still leaves the scene {@link MIN_SCENE_HEIGHT}.
 *
 * A stage too short to satisfy both minimums splits instead, so the scene
 * keeps a share at every stage size rather than being squeezed out by the
 * dock's own minimum.
 */
export function maxDockHeight(limits: DockLimits): number {
  const stage = finite(limits.stageHeight) && limits.stageHeight > 0 ? limits.stageHeight : 0;
  if (stage <= 0) return 0;
  const room = stage - MIN_SCENE_HEIGHT;
  if (room >= MIN_DOCK_HEIGHT) return room;
  return Math.floor(stage * TIGHT_STAGE_DOCK_FRACTION);
}

/**
 * Clamp an open height into the range this stage allows.
 *
 * The lower bound yields to the upper one, so a stage whose whole allowance
 * is below {@link MIN_DOCK_HEIGHT} produces a height inside its allowance
 * rather than one above it.
 */
export function clampDockHeight(heightPx: number, limits: DockLimits): number {
  const max = maxDockHeight(limits);
  const min = Math.min(MIN_DOCK_HEIGHT, max);
  if (!finite(heightPx)) return Math.min(Math.max(min, defaultDockHeight(limits)), max);
  return Math.min(max, Math.max(min, heightPx));
}

/** The opening height for a stage the user has expressed no preference for. */
export function defaultDockHeight(limits: DockLimits): number {
  const stage = finite(limits.stageHeight) && limits.stageHeight > 0 ? limits.stageHeight : 0;
  const max = maxDockHeight(limits);
  const min = Math.min(MIN_DOCK_HEIGHT, max);
  return Math.min(max, Math.max(min, Math.round(stage * DEFAULT_DOCK_FRACTION)));
}

/**
 * The height the dock actually occupies on this stage.
 *
 * A collapsed dock shows its header, and even that yields to a stage too
 * short to hold it beside a scene.
 */
export function dockOccupiedHeight(state: DockState, limits: DockLimits): number {
  const max = maxDockHeight(limits);
  return state.collapsed
    ? Math.min(COLLAPSED_DOCK_HEIGHT, max)
    : clampDockHeight(state.preferredHeightPx, limits);
}

/**
 * The height left for the 3D scene.
 *
 * Positive whenever the stage has any height at all, since the scene stays
 * interactive with the dock open. The dock's own minimum yields to this.
 */
export function sceneHeightFor(state: DockState, limits: DockLimits): number {
  const stage = finite(limits.stageHeight) && limits.stageHeight > 0 ? limits.stageHeight : 0;
  return Math.max(0, stage - dockOccupiedHeight(state, limits));
}

/**
 * Apply a splitter drag.
 *
 * The splitter sits on top of the dock, so dragging it upward by `dy` pixels
 * (a negative screen delta) makes the dock taller. A drag while collapsed
 * reopens the dock at the dragged height.
 */
export function resizeDock(state: DockState, dyPx: number, limits: DockLimits): DockState {
  const dy = finite(dyPx) ? dyPx : 0;
  if (state.collapsed) {
    // A collapsed dock shows only its header, so a downward drag has nothing
    // to shrink. Reopening on one would move the dock opposite the gesture.
    if (dy >= 0) return state;
    return {
      preferredHeightPx: clampDockHeight(COLLAPSED_DOCK_HEIGHT - dy, limits),
      collapsed: false,
    };
  }
  const from = dockOccupiedHeight(state, limits);
  return { preferredHeightPx: clampDockHeight(from - dy, limits), collapsed: false };
}

/** Collapse to the header, or restore the retained open height. */
export function toggleDockCollapsed(state: DockState): DockState {
  return { preferredHeightPx: state.preferredHeightPx, collapsed: !state.collapsed };
}

/** The state a stage with no stored preference starts in. */
export function initialDockState(limits: DockLimits): DockState {
  return { preferredHeightPx: defaultDockHeight(limits), collapsed: false };
}

export interface PersistedDock {
  readonly heightPx: number;
  readonly collapsed: boolean;
}

/** Serialise the preference. Stores the open height even while collapsed. */
export function encodeDockPrefs(state: DockState): string {
  return JSON.stringify({ heightPx: state.preferredHeightPx, collapsed: state.collapsed });
}

/**
 * Read a stored preference.
 *
 * Returns null for anything that is absent, unparseable, or not shaped like a
 * preference. A corrupt entry opens the workbench at its default rather than
 * throwing inside the panel's construction.
 */
export function decodeDockPrefs(raw: string | null): PersistedDock | null {
  if (raw == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  const h = rec.heightPx;
  const c = rec.collapsed;
  if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0) return null;
  if (typeof c !== 'boolean') return null;
  return { heightPx: h, collapsed: c };
}

/**
 * Restore a state, falling back to this stage's default.
 *
 * The stored height is kept as expressed rather than clamped on the way in,
 * so opening on a small screen and returning to a large one restores the
 * height the user chose.
 */
export function restoreDockState(raw: string | null, limits: DockLimits): DockState {
  const stored = decodeDockPrefs(raw);
  if (!stored) return initialDockState(limits);
  return { preferredHeightPx: stored.heightPx, collapsed: stored.collapsed };
}
