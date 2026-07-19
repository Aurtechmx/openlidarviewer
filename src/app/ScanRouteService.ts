/**
 * ScanRouteService.ts — scan-type routing state.
 *
 * Owns the `scanRoute` cluster on {@link AppContext}: whether a panel pinned the
 * routing, the manual scan-type choice, and the debounce behind a re-route.
 * These were three module-level `let`s in main.ts, with the "is the route
 * pinned?" predicate (`overridden || typeOverride !== 'auto'`) spelled out at
 * two call sites and the reset pair duplicated at two more. The predicate is now
 * the `pinned` getter and the reset is one method.
 *
 * Read state is exposed as getters, not methods, so `if (routing.pinned)`
 * narrows and reads the same as the raw fields did. The debounce handle lives in
 * the closure rather than on the context: it is a transient timer, not
 * application state worth persisting or inspecting. Part of the v0.6
 * decomposition (see `docs/architecture/stabilization-release-plan.md`).
 */

import type { ScanTypeOverride } from '../terrain/scanRoute';
import type { AppContext } from './appContext';

export interface ScanRouteService {
  /** True when a panel pinned the routing. */
  readonly overridden: boolean;
  /** The manual scan-type choice; `'auto'` leaves the route to detection. */
  readonly typeOverride: ScanTypeOverride;
  /**
   * True when detection must not change the route — either a panel pinned it
   * or the user chose a scan type explicitly.
   */
  readonly pinned: boolean;
  /** Pin the routing (a panel decided). */
  pin(): void;
  /** Record a manual scan-type choice. */
  setTypeOverride(override: ScanTypeOverride): void;
  /** Back to automatic detection — a new scan, or closing to the empty state. */
  reset(): void;
  /** Debounce a re-route, replacing any pending one. */
  schedule(run: () => void, delayMs: number): void;
  /** Cancel a pending re-route (scan closed before it fired). */
  cancelScheduled(): void;
}

export function createScanRouteService(context: AppContext): ScanRouteService {
  const state = context.scanRoute;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    get overridden() {
      return state.overridden;
    },
    get typeOverride() {
      return state.typeOverride;
    },
    get pinned() {
      return state.overridden || state.typeOverride !== 'auto';
    },
    pin() {
      state.overridden = true;
    },
    setTypeOverride(override) {
      state.typeOverride = override;
    },
    reset() {
      state.overridden = false;
      state.typeOverride = 'auto';
    },
    schedule(run, delayMs) {
      if (timer != null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        run();
      }, delayMs);
    },
    cancelScheduled() {
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
