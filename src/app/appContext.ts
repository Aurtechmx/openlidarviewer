/**
 * appContext.ts — shared application state.
 *
 * main.ts historically held its cross-cutting state in ~70 module-level `let`s
 * that every closure reached into directly, which is what made the file hard to
 * split: a function couldn't move without dragging the mutables it closed over.
 * The v0.6 decomposition lifts that state onto one `AppContext` so the services
 * being extracted read and write it through a shared object instead of file
 * scope. State migrates one coherent cluster at a time; this is the first —
 * the layer / comparison view state.
 */

/** Per-cloud view state plus the latest exportable elevation comparison. */
export interface LayerViewState {
  /**
   * Each layer's explicit show/hide intent, keyed by cloud id. Solo overrides
   * the effective visibility without mutating this intent.
   */
  readonly visible: Map<string, boolean>;
  /** The isolated ("solo") layer id, or null when no layer is isolated. */
  solo: string | null;
  /**
   * The most recent elevation-difference raster, ready to download, or null
   * when no comparison has produced one this session.
   */
  lastDifference: { readonly stem: string; readonly asc: () => string } | null;
}

/** The active-scan selection state. */
export interface ScanState {
  /**
   * Viewer id of the cloud the Inspector currently controls (the most recent
   * one added), or null when no scan is loaded.
   */
  activeId: string | null;
}

/** The shared, mutable application state, grouped by cluster. */
export interface AppContext {
  readonly layers: LayerViewState;
  readonly scan: ScanState;
}

/** Construct a fresh AppContext with empty defaults. */
export function createAppContext(): AppContext {
  return {
    layers: {
      visible: new Map<string, boolean>(),
      solo: null,
      lastDifference: null,
    },
    scan: {
      activeId: null,
    },
  };
}
