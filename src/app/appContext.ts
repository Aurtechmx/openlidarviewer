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

import type { CameraPose } from '../render/NavController';
import type { ViewStateBundle } from '../io/session';

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

/**
 * An in-memory saved view: the camera pose plus (v7) an optional display-state
 * bundle (clip, colour mode, class/point filters, render settings). `pose` keeps
 * the v6 camera-bookmark shape the panels and the KML exporter read; a pre-v7
 * view has no bundle and behaves exactly as it always did.
 */
export interface StoredView {
  name: string;
  pose: CameraPose;
  state?: ViewStateBundle;
}

/** Saved camera viewpoints (v7: view states) for the current scan. */
export interface ViewBookmarksState {
  /** The saved views, in creation order. */
  savedViews: StoredView[];
  /** Monotonic counter behind default view names. */
  viewCounter: number;
}

/** The shared, mutable application state, grouped by cluster. */
export interface AppContext {
  readonly layers: LayerViewState;
  readonly scan: ScanState;
  readonly viewBookmarks: ViewBookmarksState;
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
    viewBookmarks: {
      savedViews: [],
      viewCounter: 0,
    },
  };
}
