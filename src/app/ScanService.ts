/**
 * ScanService.ts — active-scan selection.
 *
 * Owns the `scan` cluster on {@link AppContext}: which loaded cloud the
 * Inspector and every scan-scoped panel currently act on. main.ts used to poke
 * `scan.activeId` directly at ~69 sites and repeat the
 * `activeId ? viewer.getCloud(activeId) : null` lookup at a dozen of them; the
 * selection now moves through this service and the lookup has one home.
 * The viewer is read through a getter because it is bound after construction,
 * the same contract {@link LayerService} uses. Part of the v0.6 decomposition
 * (see `docs/architecture/stabilization-release-plan.md`).
 */

import type { Viewer } from '../render/Viewer';
import type { PointCloud } from '../model/PointCloud';
import type { AppContext } from './appContext';

export interface ScanServiceDeps {
  /** The lazily-assigned viewer — read through a getter, never captured. */
  getViewer: () => Viewer;
  /** Shared app state; the service owns the `scan` cluster. */
  context: AppContext;
}

export interface ScanService {
  /**
   * The active scan's viewer id, or null when no scan is selected. A getter
   * rather than a method so `if (scans.activeId) use(scans.activeId)` narrows
   * exactly as the raw field did — a method call would defeat narrowing at
   * every guarded call site.
   */
  readonly activeId: string | null;
  /** Select `id` as the active scan. */
  setActive(id: string): void;
  /** Clear the selection (scan closed, or back to the empty state). */
  clear(): void;
  /** Clear only when `id` is the active scan — a layer being removed. */
  clearIf(id: string): void;
  /** The active cloud, or null when nothing is selected or it is gone. */
  activeCloud(): PointCloud | null;
}

export function createScanService(deps: ScanServiceDeps): ScanService {
  const { getViewer, context } = deps;
  const scan = context.scan;
  return {
    get activeId() {
      return scan.activeId;
    },
    setActive(id) {
      scan.activeId = id;
    },
    clear() {
      scan.activeId = null;
    },
    clearIf(id) {
      if (scan.activeId === id) scan.activeId = null;
    },
    activeCloud() {
      const id = scan.activeId;
      return id ? getViewer().getCloud(id) ?? null : null;
    },
  };
}
