/**
 * viewBookmarks.ts — saved-view (camera bookmark) list management.
 *
 * Owns the `viewBookmarks` cluster on {@link AppContext}: the saved-view array,
 * the monotonic name counter, and the add / get / remove / restore operations
 * that used to sit as free logic in main.ts. This is pure data management with
 * no viewer or UI dependency, so it is unit-tested directly; main.ts keeps the
 * viewer-coupled capture and apply (which read the render state) and routes the
 * list operations through here. Part of the v0.6 decomposition (see
 * `docs/architecture/stabilization-release-plan.md`).
 */

import type { AppContext, StoredView } from './appContext';

export interface ViewBookmarksService {
  /** Assign the next `View N` name, append the view, and return the name. */
  add(view: Omit<StoredView, 'name'>): string;
  /** The stored view at `index`, or undefined when out of range. */
  get(index: number): StoredView | undefined;
  /** Remove the view at `index` (a no-op when out of range). */
  remove(index: number): void;
  /** Rename the view at `index` (a no-op when out of range). */
  rename(index: number, name: string): void;
  /** The saved-view names in creation order, for the panel lists. */
  names(): string[];
  /** How many views are saved. */
  count(): number;
  /** Replace the whole list (session restore) and reseed the name counter. */
  restore(views: readonly StoredView[]): void;
  /** Drop every saved view and reset the name counter (scan close / reset). */
  clear(): void;
}

export function createViewBookmarks(context: AppContext): ViewBookmarksService {
  const state = context.viewBookmarks;
  return {
    add(view) {
      // Skip past any name already in use, not just past the counter: a user can
      // rename a view TO `View 7`, or a restored session can carry one, and a
      // bare counter would hand out that name a second time.
      const taken = new Set(state.savedViews.map((v) => v.name));
      let name = `View ${++state.viewCounter}`;
      while (taken.has(name)) name = `View ${++state.viewCounter}`;
      state.savedViews.push({ name, ...view });
      return name;
    },
    get(index) {
      return state.savedViews[index];
    },
    remove(index) {
      if (index >= 0 && index < state.savedViews.length) {
        state.savedViews.splice(index, 1);
      }
    },
    rename(index, name) {
      const view = state.savedViews[index];
      if (view) view.name = name;
    },
    names() {
      return state.savedViews.map((v) => v.name);
    },
    count() {
      return state.savedViews.length;
    },
    restore(views) {
      state.savedViews = [...views];
      // Seed from the highest `View N` present, NOT the count. A restored set of
      // ["View 3", "North"] has length 2, so counting would regenerate "View 3"
      // and collide with the view already sitting in the list. Non-matching
      // names (renamed views) simply do not raise the floor.
      let highest = 0;
      for (const v of state.savedViews) {
        const m = /^View (\d+)$/.exec(v.name);
        if (m) highest = Math.max(highest, Number(m[1]));
      }
      state.viewCounter = highest;
    },
    clear() {
      state.savedViews = [];
      state.viewCounter = 0;
    },
  };
}
