/**
 * ScanService.ts — active-scan selection.
 *
 * Owns the `scan` cluster on {@link AppContext}: which loaded cloud the
 * Inspector and every scan-scoped panel currently act on. main.ts used to poke
 * `scan.activeId` directly at ~69 sites and repeat the
 * `activeId ? viewer.getCloud(activeId) : null` lookup at a dozen of them; the
 * selection now moves through this service and the lookup has one home.
 * The viewer is read through a getter because it is bound after construction,
 * the same contract {@link LayerService} uses. Part of the v0.6 decomposition of main.ts
 * into per-cluster services.
 */

import type { Viewer } from '../render/Viewer';
import type { ClassSample, PointCloud } from '../model/PointCloud';
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
  /**
   * The identity the export/terrain scan-identity guards compare: the active
   * STATIC scan's `activeId`, or — when a streaming scan is open (`activeId` is
   * null for streaming) — that streaming scan's stable shell id, or null when
   * nothing identifiable is active.
   *
   * Deliberately SEPARATE from {@link activeId}, which keeps returning null for
   * a streaming scan so no `activeId ? … : …` branch shifts. Only the export and
   * terrain guards read this streaming-aware form, so they can tell one
   * streaming scan from another where raw `activeId` could not — closing the
   * blind spot where `sameExportTarget(null, null)` hid a streaming→streaming
   * swap. Fails closed: a streaming scan reports a concrete id, never a
   * wildcard, and a genuinely unidentified state is still null.
   */
  activeExportTargetId(): string | null;
  /**
   * Told after {@link activeExportTargetId} changes: a static scan selected
   * or cleared, or a streaming scan attached or detached. Returns an
   * unsubscribe.
   */
  onActiveChange(fn: () => void): () => void;
  /**
   * Re-read the active identity and tell listeners when it moved. The host
   * calls this after a streaming scan attaches or detaches, which changes the
   * identity without going through {@link setActive}.
   */
  syncActive(): void;
}

export function createScanService(deps: ScanServiceDeps): ScanService {
  const { getViewer, context } = deps;
  const scan = context.scan;
  const listeners = new Set<() => void>();
  const target = (): string | null => {
    try { return scan.activeId ?? getViewer().streamingCloud?.id ?? null; } catch { return scan.activeId; }
  };
  let last: string | null = scan.activeId;
  const syncActive = (): void => {
    const now = target();
    if (now === last) return;
    last = now;
    for (const fn of [...listeners]) fn();
  };
  const set = (id: string | null): void => {
    scan.activeId = id;
    syncActive();
  };
  return {
    get activeId() {
      return scan.activeId;
    },
    setActive(id) {
      set(id);
    },
    clear() {
      set(null);
    },
    clearIf(id) {
      if (scan.activeId === id) set(null);
    },
    syncActive,
    onActiveChange(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    activeCloud() {
      const id = scan.activeId;
      return id ? getViewer().getCloud(id) ?? null : null;
    },
    activeExportTargetId() {
      // Static id wins when a static scan is selected (unchanged identity); a
      // streaming scan leaves `activeId` null, so fall through to the streaming
      // cloud's stable shell id. Same late-`getViewer()` assumption `activeCloud`
      // relies on — only the export/terrain guards call this, well after the
      // viewer is bound and a scan is open.
      return scan.activeId ?? getViewer().streamingCloud?.id ?? null;
    },
  };
}

/**
 * The layer that should be active once `removedId` is removed, given the open
 * layers in panel order (`order`, before the removal) and the active layer.
 * Removing another layer keeps the active one. Removing the active layer moves
 * to the next layer, else the previous one, else none. With no static layer
 * active (a streaming scan, or nothing) nothing is promoted.
 */
export function survivorAfterRemoval(order: readonly string[], removedId: string, activeId: string | null): string | null {
  if (activeId !== removedId) return activeId;
  const i = order.indexOf(removedId);
  if (i < 0) return null;
  return order[i + 1] ?? order[i - 1] ?? null;
}

/*
 * What the Inspector describes when the active scan changes without an open.
 *
 * A static open fills the per-scan surfaces for the scan it attached: the CRS,
 * the provenance and Dataset Intelligence cards, the class legend, the colour
 * chips, the point-count detail and the Scan Report. Removing the active layer
 * promotes a survivor, and picking another layer makes it active, and both
 * used to refresh only the first three, so the legend, chips, detail and
 * report kept describing a layer that was no longer active, or no longer
 * open. The same list is refreshed here for the layer that became active, in
 * the order the open uses: the legend first, because the report's class scope
 * reads it.
 */

export interface ActiveLayerSurfaceDeps<Cloud> {
  refreshCrs(cloud: Cloud): void;
  refreshProvenance(cloud: Cloud, layerId: string): void;
  refreshDatasetIntelligence(cloud: Cloud): void;
  /**
   * Seed the class legend from the layer's classes. Resets the class filter to
   * all visible, as the open does: the filter was a selection over another
   * layer's classes.
   */
  refreshClassLegend(classification: ArrayLike<number> | undefined, sample: { readonly loaded: number; readonly declared?: number; readonly shares?: ClassSample }): void;
  /** Re-sync the colour chips to the layer's available modes and its live mode. */
  syncColorMode(): void;
  /** The point-count detail: shown against the file's decoded total. */
  setDetail(shown: number, total: number): void;
  /** The Scan Report for the layer, in the class scope the legend now shows. */
  setReport(cloud: Cloud): void;
}

/** The fields the refresh reads off the layer's cloud. */
export interface ActiveLayerCloud {
  readonly pointCount: number;
  readonly declaredPointCount?: number;
  readonly decodedPointCount?: number;
  readonly classification?: ArrayLike<number>;
  readonly classSample?: ClassSample;
}

/** A static layer became the active scan: describe it everywhere the open would. */
export function refreshActiveLayerSurfaces<Cloud extends ActiveLayerCloud>(
  deps: ActiveLayerSurfaceDeps<Cloud>,
  cloud: Cloud,
  layerId: string,
): void {
  deps.refreshCrs(cloud);
  deps.refreshProvenance(cloud, layerId);
  deps.refreshDatasetIntelligence(cloud);
  deps.refreshClassLegend(cloud.classification, { loaded: cloud.pointCount, declared: cloud.declaredPointCount, shares: cloud.classSample });
  deps.syncColorMode();
  deps.setDetail(cloud.pointCount, cloud.decodedPointCount ?? cloud.pointCount);
  deps.setReport(cloud);
}

/** What the shell refreshes when a stream becomes the whole scene again. */
export interface StreamSurfaceDeps<Stream> {
  refreshCrs(stream: Stream): void;
  refreshProvenance(stream: Stream): void;
  /** The Dataset Intelligence card described the removed layer: fill it from the stream, or clear it when the stream has none. */
  refreshDatasetIntelligence(stream: Stream): void;
  /** The stream's session class tally, by code. */
  streamClasses(): Map<number, number>;
  /** Put the stream's classes back on the legend in place of the removed layer's. */
  reseedLegend(classes: Map<number, number>): void;
  /** The streaming Scan Report, in the legend's class scope. */
  refreshReport(): void;
}

/**
 * The last static layer beside an out-of-core stream was removed. The stream
 * stays, so the scene is not empty, but the removed layer was the active scan
 * and the per-scan surfaces described it: the CRS the measurements read in,
 * the cards, the class legend and the report return to the stream's.
 */
export function refreshStreamSurfaces<Stream>(deps: StreamSurfaceDeps<Stream>, stream: Stream): void {
  deps.refreshCrs(stream);
  deps.refreshProvenance(stream);
  deps.refreshDatasetIntelligence(stream);
  deps.reseedLegend(deps.streamClasses());
  deps.refreshReport();
}
