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

/** The dock is never shorter than this while open. */
export const MIN_DOCK_HEIGHT = 140;

/** Height of the collapsed dock, which shows its header only. */
export const COLLAPSED_DOCK_HEIGHT = 36;

export interface DockLimits {
  /** Total height available to the stage and the dock together. */
  readonly stageHeight: number;
}

export interface DockState {
  /** Open height in pixels. Retained while collapsed so restore returns to it. */
  readonly heightPx: number;
  readonly collapsed: boolean;
}

function finite(v: number): boolean {
  return Number.isFinite(v);
}

/**
 * The largest open height that still leaves the scene {@link MIN_SCENE_HEIGHT}.
 *
 * Falls back to the minimum dock height when the stage is too short to
 * satisfy both, so a small window yields a cramped layout rather than a
 * negative one.
 */
export function maxDockHeight(limits: DockLimits): number {
  const stage = finite(limits.stageHeight) ? limits.stageHeight : 0;
  const room = stage - MIN_SCENE_HEIGHT;
  return room < MIN_DOCK_HEIGHT ? MIN_DOCK_HEIGHT : room;
}

/** Clamp an open height into the range this stage allows. */
export function clampDockHeight(heightPx: number, limits: DockLimits): number {
  const max = maxDockHeight(limits);
  if (!finite(heightPx)) return Math.min(defaultDockHeight(limits), max);
  return Math.min(max, Math.max(MIN_DOCK_HEIGHT, heightPx));
}

/** The opening height for a stage the user has expressed no preference for. */
export function defaultDockHeight(limits: DockLimits): number {
  const stage = finite(limits.stageHeight) ? limits.stageHeight : 0;
  const max = maxDockHeight(limits);
  return Math.min(max, Math.max(MIN_DOCK_HEIGHT, Math.round(stage * DEFAULT_DOCK_FRACTION)));
}

/** The height the dock actually occupies, collapsed or not. */
export function dockOccupiedHeight(state: DockState, limits: DockLimits): number {
  return state.collapsed ? COLLAPSED_DOCK_HEIGHT : clampDockHeight(state.heightPx, limits);
}

/**
 * The height left for the 3D scene.
 *
 * Never returns a negative value, and never zero while the stage has any
 * height at all, because the scene stays interactive with the dock open.
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
  const from = state.collapsed ? COLLAPSED_DOCK_HEIGHT : state.heightPx;
  return { heightPx: clampDockHeight(from - dy, limits), collapsed: false };
}

/** Collapse to the header, or restore the retained open height. */
export function toggleDockCollapsed(state: DockState): DockState {
  return { heightPx: state.heightPx, collapsed: !state.collapsed };
}

/** The state a stage with no stored preference starts in. */
export function initialDockState(limits: DockLimits): DockState {
  return { heightPx: defaultDockHeight(limits), collapsed: false };
}

/**
 * Re-fit a state to a resized stage.
 *
 * The stored height is clamped rather than replaced, so shrinking a window
 * and growing it again returns the user's own height instead of the default.
 */
export function refitDock(state: DockState, limits: DockLimits): DockState {
  return { heightPx: clampDockHeight(state.heightPx, limits), collapsed: state.collapsed };
}

export interface PersistedDock {
  readonly heightPx: number;
  readonly collapsed: boolean;
}

/** Serialise the preference. Stores the open height even while collapsed. */
export function encodeDockPrefs(state: DockState): string {
  return JSON.stringify({ heightPx: state.heightPx, collapsed: state.collapsed });
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

/** Restore a state for this stage, falling back to the default. */
export function restoreDockState(raw: string | null, limits: DockLimits): DockState {
  const stored = decodeDockPrefs(raw);
  if (!stored) return initialDockState(limits);
  return { heightPx: clampDockHeight(stored.heightPx, limits), collapsed: stored.collapsed };
}
