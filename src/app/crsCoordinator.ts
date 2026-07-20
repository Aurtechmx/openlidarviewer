// CRS resolution + per-scan refresh — extracted from main.ts.
//
// Resolves a `CrsInfo` (LAS/LAZ VLR, COPC, or EPT) plus an optional persisted
// user override into a single `ResolvedCrs`, pushes it to the central
// `CrsService` and the point inspector, and handles user override picks.
//
// The only mutable state this owns is `_currentCrsDatasetKey` (the per-scan
// override-store key currently in scope), so it is encapsulated here behind a
// factory. Stateful collaborators that change over the app's lifetime —
// `viewer` (lazy, null until its chunk resolves), the `viewerReady` flag, and
// the `activeId` selection — are read through getters so the coordinator always
// sees current values without a top-level `viewer.*` dereference in main.ts.
import type { Viewer } from '../render/Viewer';
import type { CrsInfo } from '../io/crs';
import { type CrsSource } from '../geo/CoordinateTypes';
import type { CrsService } from '../geo/CrsService';
import {
  keyForDataset as crsKeyForDataset,
} from '../geo/CrsOverrideStore';
import { increment as recordUsage } from '../diagnostics/usageCounters';

export interface CrsCoordinatorDeps {
  /** The centralised CRS service that owns the active scan's resolved CRS. */
  crsService: CrsService;
  /** Returns the lazy Viewer instance (null-typed until its chunk resolves). */
  getViewer: () => Viewer;
  /** Whether the Viewer chunk has resolved and is safe to dereference. */
  isViewerReady: () => boolean;
  /** The active static cloud id, or null when none / streaming. */
  getActiveId: () => string | null;
  /** Mirrors main.ts's `debug` flag for the diagnostic warning paths. */
  debug: boolean;
}

export interface CrsCoordinator {
  /**
   * Resolve a `CrsInfo` (from LAS/LAZ VLR, COPC, or EPT) + an optional
   * persisted user override into a single `ResolvedCrs` for the Inspector.
   *
   * Rule of precedence:
   *  1. User override (when present and non-default) wins.
   *  2. Otherwise the detected `CrsInfo` is used.
   *  3. Otherwise we surface "unknown".
   */
  /** Refresh the Inspector's CRS section after a static-cloud load. */
  refreshCrsForStaticCloud(cloud: {
    readonly name: string;
    readonly origin?: readonly [number, number, number];
    readonly metadata?: { readonly crs?: CrsInfo | null };
  }): void;
  /** Refresh the Inspector's CRS section after a streaming-cloud open. */
  refreshCrsForStreamingCloud(cloud: {
    readonly name: string;
    readonly kind: 'copc' | 'ept';
    readonly renderOrigin?: readonly [number, number, number];
    crs(): CrsInfo | undefined;
  }): void;
  /** Handle a user CRS override picked from the Inspector. */
  handleCrsOverride(override: {
    epsg: number | null;
    kind: 'projected' | 'geographic' | 'local';
  }): void;
  /**
   * Forget the dataset key currently in scope. Called from the reset-to-empty
   * path so a later override can't target a closed scan.
   */
  clearDatasetKey(): void;
}

/**
 * Build the CRS coordinator. Behaviour is identical to the original top-level
 * functions in main.ts — only the `_currentCrsDatasetKey` state and the
 * stateful collaborator references moved behind this factory.
 */
export function createCrsCoordinator(deps: CrsCoordinatorDeps): CrsCoordinator {
  const { crsService, getViewer, isViewerReady, getActiveId, debug } = deps;

  /** The dataset key (per-scan key for the CRS override store) currently in scope. */
  let currentCrsDatasetKey: string | undefined;

  /**
   * Remember which dataset the override panel is editing. The CRS itself is
   * resolved by `crsService`; this coordinator used to run a second copy of
   * that logic which wrote `linearUnitToMetres: 1` for every projected
   * override, and ITS value is what reached the point inspector — so the
   * inspector and the measurement HUD disagreed by 3.28x on a foot-based scan
   * whose own CRS the user had merely confirmed. One resolver now.
   */
  function trackDataset(cloudName: string): void {
    currentCrsDatasetKey = crsKeyForDataset(cloudName);
  }

  function refreshCrsForStaticCloud(cloud: {
    readonly name: string;
    readonly origin?: readonly [number, number, number];
    readonly metadata?: { readonly crs?: CrsInfo | null };
  }): void {
    trackDataset(cloud.name);
    // Publish to the central service so subscribers (today: the lasso
    // volume gate via `crsService.validation()`; tomorrow: the inspector
    // override panel via `crsService.subscribe`) see the same value
    // `resolveCloudCrs` produced. The detection signal is the loader's
    // VLR; any override has already been applied inside resolveCloudCrs.
    // The inspector listens via `crsService.subscribe` (wired at boot);
    // publishing here is the single notification path.
    const resolved = crsService.resolveForScan({
      name: cloud.name,
      detected: cloud.metadata?.crs ?? undefined,
      source: 'las-vlr',
    });
    // Push the origin + CRS into the point inspector so World + Lat/Lon
    // rows render against the loaded scan. Wrapped in a viewer-loaded
    // guard because the viewer chunk may still be loading the very first
    // time this fires.
    if (isViewerReady()) {
      try { getViewer().setInspectCoordinateContext({ origin: cloud.origin, crs: resolved }); }
      catch (err) { if (debug) console.warn('[crs] setInspectCoordinateContext (static) threw', err); }
    }
  }

  function refreshCrsForStreamingCloud(cloud: {
    readonly name: string;
    readonly kind: 'copc' | 'ept';
    readonly renderOrigin?: readonly [number, number, number];
    crs(): CrsInfo | undefined;
  }): void {
    const source: CrsSource = cloud.kind === 'ept' ? 'ept-srs' : 'copc-meta';
    trackDataset(cloud.name);
    // Inspector listens via the boot-time `crsService.subscribe`; no
    // direct push needed.
    const resolved = crsService.resolveForScan({
      name: cloud.name,
      detected: cloud.crs(),
      source,
    });
    if (isViewerReady()) {
      try {
        getViewer().setInspectCoordinateContext({
          origin: cloud.renderOrigin,
          crs: resolved,
        });
      } catch (err) {
        if (debug) console.warn('[crs] setInspectCoordinateContext (streaming) threw', err);
      }
    }
  }

  function handleCrsOverride(override: {
    epsg: number | null;
    kind: 'projected' | 'geographic' | 'local';
  }): void {
    if (!currentCrsDatasetKey) return;
    // ONE writer: the override goes through `crsService.setOverride`, which
    // persists it, records the file's own declaration (`detectedEpsg`, the
    // guard that keeps a stored choice with its file), handles the
    // "reset to detected" sentinel by clearing, and re-resolves. This
    // coordinator used to write the store directly with its own copy of that
    // logic — the same split that once let two resolvers disagree about the
    // same scan's units.
    const vw = getViewer();
    const act = getActiveId();
    const sc = vw.streamingCloud;
    const detected =
      (sc ? sc.crs() : act ? vw.getCloud(act)?.metadata?.crs : undefined) ?? undefined;
    const source: CrsSource = sc ? (sc.kind === 'ept' ? 'ept-srs' : 'copc-meta') : 'las-vlr';
    crsService.setOverride({ override, detected, source });
    if (!(override.epsg === null && override.kind === 'local')) {
      recordUsage('scan-open', `crs-override:${override.epsg ?? 'local'}`);
    }
    // Re-run resolution and refresh — uses whichever cloud is currently active.
    const viewer = getViewer();
    const activeId = getActiveId();
    const staticCloud = activeId ? viewer.getCloud(activeId) : undefined;
    const streamingCloud = viewer.streamingCloud;
    if (streamingCloud) {
      refreshCrsForStreamingCloud(
        streamingCloud as {
          readonly name: string;
          readonly kind: 'copc' | 'ept';
          crs(): CrsInfo | undefined;
        },
      );
    } else if (staticCloud) {
      refreshCrsForStaticCloud(staticCloud);
    }
  }

  function clearDatasetKey(): void {
    currentCrsDatasetKey = undefined;
  }

  return {
    refreshCrsForStaticCloud,
    refreshCrsForStreamingCloud,
    handleCrsOverride,
    clearDatasetKey,
  };
}
