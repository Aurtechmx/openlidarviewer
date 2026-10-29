/**
 * overlayRegistry.ts
 *
 * One place that lists the scene overlays an analysis has generated (contours,
 * Flow Pulse drainage lines, the Terrain Access map) so a single "Created
 * layers" list can switch each one on and off.
 *
 * The registry holds NO visibility state of its own. Each overlay's owner
 * registers `get`/`set` that read and write its own state (the contour
 * derived-layer record, the Lab's persisted overlay), and calls `changed()`
 * whenever that state moves. Every control (this list, the Analyse checkbox,
 * the Lab toggle) therefore reads one source of truth.
 *
 * Remembered preferences: a restored session hands over the visibility the
 * user left for each overlay id. The first time that overlay becomes available
 * again, the preference is applied once and then dropped; until then it is
 * written back by `snapshot()`, so a save before regeneration keeps it.
 * Closing the scan forgets pending preferences (see pendingSessionRestore).
 * Three-free and tiny, so it can sit in the startup shell.
 */

/** Most entries kept from a saved map; the app has three overlays. */
const MAX_OVERLAY_PREFS = 32;

/**
 * Validate a saved `overlayVisibility` map: lower-case ids of letters, digits
 * and dashes, boolean values, at most 32 entries. Anything else is dropped.
 * Returns null when nothing valid remains. Used by the session reader and
 * writer and by `restore`, so sessions and recovery share one rule.
 */
export function sanitizeOverlayPrefs(raw: unknown): Record<string, boolean> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, boolean> = {};
  let n = 0;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= MAX_OVERLAY_PREFS) break;
    if (typeof v !== 'boolean' || !/^[a-z0-9-]{1,64}$/.test(id)) continue;
    Object.defineProperty(out, id, { value: v, enumerable: true, writable: true, configurable: true });
    n += 1;
  }
  return n > 0 ? out : null;
}

export interface OverlayEntry {
  readonly id: string;
  /** Short plain label, e.g. "Contours". */
  readonly label: string;
  /** True once the overlay has been generated for the current scan. */
  isAvailable(): boolean;
  get(): boolean;
  set(visible: boolean): void;
}

export interface OverlayRegistry {
  /** Add (or replace) an overlay. Returns an unregister function. */
  register(entry: OverlayEntry): () => void;
  /** Entries whose overlay currently exists, in registration order. */
  available(): OverlayEntry[];
  /** Owners call this after their overlay appears, disappears or changes visibility. */
  changed(): void;
  /** Listen for `changed()`. Returns an unsubscribe function. */
  onChange(fn: () => void): () => void;
  /** Visibility of every available overlay, plus preferences still pending, for the saved session. */
  snapshot(): Record<string, boolean>;
  /** Preferences from a restored session, applied when each overlay next appears. Replaces any pending ones. */
  restore(prefs: unknown): void;
}

export function createOverlayRegistry(): OverlayRegistry {
  const entries = new Map<string, OverlayEntry>();
  const listeners = new Set<() => void>();
  let pending = new Map<string, boolean>();
  let applying = false;

  const applyPending = (): void => {
    for (const [id, visible] of [...pending]) {
      const e = entries.get(id);
      if (!e || !e.isAvailable()) continue;
      pending.delete(id);
      if (e.get() !== visible) e.set(visible);
    }
  };

  const reg: OverlayRegistry = {
    register(entry) {
      entries.set(entry.id, entry);
      reg.changed();
      return () => {
        if (entries.get(entry.id) === entry) entries.delete(entry.id);
        reg.changed();
      };
    },
    available() {
      return [...entries.values()].filter((e) => e.isAvailable());
    },
    changed() {
      if (applying) return;
      applying = true;
      try {
        applyPending();
      } finally {
        applying = false;
      }
      for (const fn of [...listeners]) fn();
    },
    onChange(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    snapshot() {
      // Pending first; an available overlay's owner state wins over it.
      const out: Record<string, boolean> = Object.fromEntries(pending);
      for (const e of reg.available()) out[e.id] = e.get();
      return sanitizeOverlayPrefs(out) ?? {};
    },
    restore(prefs) {
      pending = new Map(Object.entries(sanitizeOverlayPrefs(prefs) ?? {}));
      reg.changed();
    },
  };
  return reg;
}

/** The app-wide registry. */
export const overlayRegistry: OverlayRegistry = createOverlayRegistry();
