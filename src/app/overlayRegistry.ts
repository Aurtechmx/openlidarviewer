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
 * again, the preference is applied once and then dropped. Three-free and tiny,
 * so it can sit in the startup shell.
 */

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
  /** Visibility of every available overlay, for the saved session. */
  snapshot(): Record<string, boolean>;
  /** Preferences from a restored session, applied when each overlay next appears. */
  restore(prefs: Record<string, boolean> | undefined | null): void;
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
      const out: Record<string, boolean> = {};
      for (const e of reg.available()) out[e.id] = e.get();
      return out;
    },
    restore(prefs) {
      pending = new Map();
      if (prefs && typeof prefs === 'object') {
        for (const [id, v] of Object.entries(prefs)) if (typeof v === 'boolean') pending.set(id, v);
      }
      reg.changed();
    },
  };
  return reg;
}

/** The app-wide registry. */
export const overlayRegistry: OverlayRegistry = createOverlayRegistry();
