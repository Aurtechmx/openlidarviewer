/**
 * prefs.ts
 *
 * Remembers the user's viewer settings between sessions, in `localStorage`.
 *
 * Only genuinely global preferences are stored — point size, the render-quality
 * settings, and the measurement unit system. Per-scan choices (such as the
 * colour mode, which is auto-selected from what each file actually contains)
 * are deliberately left out.
 *
 * Every storage access is guarded: `localStorage` can be disabled, cleared, or
 * blocked entirely (private mode, a partitioned `<iframe>`). On any failure the
 * app simply falls back to its defaults and carries on — preferences never
 * being saved is not an error.
 *
 * `parsePrefs` is pure (string in, validated data out) and unit-tested; the
 * `loadPrefs` / `savePrefs` wrappers add the `localStorage` I/O.
 */

import type { PointSizeMode } from './render/pointStyle';
import type { UnitSystem } from './render/measure/types';

/**
 * The user's choice of mobile multi-touch model.
 *
 *  - **standard** — the v0.3.7 simultaneous-decomposition recogniser
 *    (Maps / Procreate model). Two fingers do twist + pinch + pan at
 *    once, each above its own dead-zone. The default.
 *  - **advanced** — the CAD-style "3-finger zoom" reassignment. Two
 *    fingers do twist + pan only (no pinch-zoom); three-finger vertical
 *    drag dollies. Opt-in for users who want unambiguous gestures.
 */
export type TouchModel = 'standard' | 'advanced';

/** The persisted viewer preferences. */
export interface ViewerPrefs {
  /** Base point size, in screen pixels (1–8). */
  pointSize: number;
  /** Whether Eye Dome Lighting is enabled. */
  edlEnabled: boolean;
  /** Eye Dome Lighting strength (0–1.5). */
  edlStrength: number;
  /** Adaptive or fixed point sizing. */
  pointSizeMode: PointSizeMode;
  /** Whether point-edge antialiasing is on. */
  antialiasing: boolean;
  /** Measurement unit system. */
  unitSystem: UnitSystem;
  /** Mobile multi-touch model — twist + pinch + pan, or 3-finger zoom. */
  touchModel: TouchModel;
  /** Use the colourblind-safe (Okabe-Ito) categorical class palette. */
  colorblindSafeClasses: boolean;
}

/** The `localStorage` key; the `.v1` suffix lets the schema evolve later. */
const STORAGE_KEY = 'openlidarviewer.prefs.v1';

/** Clamp a number into `[min, max]`. */
function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * Validate a raw JSON string into a partial set of preferences. Only keys that
 * are present AND well-typed survive; anything malformed is dropped, so a
 * corrupt or partial record degrades gracefully rather than throwing. Never
 * throws.
 */
export function parsePrefs(raw: string): Partial<ViewerPrefs> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) return {};
  const o = parsed as Record<string, unknown>;
  const out: Partial<ViewerPrefs> = {};

  if (typeof o.pointSize === 'number' && Number.isFinite(o.pointSize)) {
    out.pointSize = clamp(o.pointSize, 1, 8);
  }
  if (typeof o.edlEnabled === 'boolean') out.edlEnabled = o.edlEnabled;
  if (typeof o.edlStrength === 'number' && Number.isFinite(o.edlStrength)) {
    out.edlStrength = clamp(o.edlStrength, 0, 1.5);
  }
  if (o.pointSizeMode === 'adaptive' || o.pointSizeMode === 'fixed') {
    out.pointSizeMode = o.pointSizeMode;
  }
  if (typeof o.antialiasing === 'boolean') out.antialiasing = o.antialiasing;
  if (o.unitSystem === 'metric' || o.unitSystem === 'imperial') {
    out.unitSystem = o.unitSystem;
  }
  if (o.touchModel === 'standard' || o.touchModel === 'advanced') {
    out.touchModel = o.touchModel;
  }
  if (typeof o.colorblindSafeClasses === 'boolean') {
    out.colorblindSafeClasses = o.colorblindSafeClasses;
  }
  return out;
}

/**
 * Load saved preferences. Returns only the keys that were stored and valid, so
 * the caller keeps its own default for anything absent. Never throws.
 */
export function loadPrefs(): Partial<ViewerPrefs> {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return {};
  }
  return raw ? parsePrefs(raw) : {};
}

/** Persist the given preferences. A storage failure is silently ignored. */
export function savePrefs(prefs: ViewerPrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable — preferences just will not persist this session.
  }
}
