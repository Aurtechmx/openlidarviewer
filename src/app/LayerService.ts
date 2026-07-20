/**
 * LayerService.ts — layer view management.
 *
 * Owns the layer-list view logic that used to live as free functions in main.ts:
 * snapshotting each loaded cloud for the pure layer model, resolving effective
 * visibility (explicit intent + solo isolation) onto the viewer, and surfacing
 * cross-layer CRS mismatches. State lives on {@link AppContext} (`layers`); the
 * viewer and Inspector are read through getters because both are bound after this
 * service is constructed. The two-epoch comparison stays in main.ts for now — it
 * belongs with the comparison workflow, not layer management.
 */

import type { Viewer } from '../render/Viewer';
import type { Inspector } from '../ui/Inspector';
import {
  resolveVisibility,
  nextSolo,
  detectCrsMismatch,
  horizontalKey,
  type LayerInfo,
} from '../model/layerModel';
import type { AppContext } from './appContext';
import type { ProjectFrameService, ProjectFrameLayer } from './projectFrame';

export interface LayerServiceDeps {
  /** The lazily-assigned viewer — read through a getter, never captured. */
  getViewer: () => Viewer;
  /** The Inspector the service pushes layer state into (bound after this). */
  getInspector: () => Inspector;
  /** Shared app state; the service owns the `layers` cluster. */
  context: AppContext;
  /** Refresh the compass overlay after a layer-set change. */
  refreshCompass: () => void;
  /** The project's shared spatial frame, reseeded on every layer-set change. */
  projectFrame: ProjectFrameService;
}

export interface LayerService {
  /** Snapshot every loaded layer as a plain record for the pure layer model. */
  buildLayerInfos(): LayerInfo[];
  /** Push the model's effective visibility (intent + solo) to viewer + Inspector. */
  applyVisibility(): void;
  /** Recompute cross-layer CRS mismatches, compare availability, and the compass. */
  refreshCrsFlags(): void;
  /** Record a layer's explicit show/hide intent, then re-apply visibility. */
  setVisible(id: string, visible: boolean): void;
  /** Toggle solo isolation for a layer, then re-apply visibility. */
  toggleSolo(id: string): void;
}

export function createLayerService(deps: LayerServiceDeps): LayerService {
  const { getViewer, getInspector, context, refreshCompass } = deps;
  const layers = context.layers;

  function buildLayerInfos(): LayerInfo[] {
    const viewer = getViewer();
    return viewer.clouds().map((id) => {
      const c = viewer.getCloud(id);
      const crs = c?.metadata?.crs ?? null;
      return {
        id,
        name: c?.name ?? id,
        pointCount: c?.pointCount ?? 0,
        visible: layers.visible.get(id) ?? true,
        locked: viewer.isCloudLocked(id),
        epsg: crs?.epsg,
        crsName: crs?.name,
        verticalDatum: crs?.verticalDatum,
        isGeographic: crs?.isGeographic,
      };
    });
  }

  function applyVisibility(): void {
    const viewer = getViewer();
    const eff = resolveVisibility(buildLayerInfos(), layers.solo);
    for (const [id, on] of eff) viewer.setCloudVisible(id, on);
    getInspector().setLayerSolo(layers.solo);
  }

  /**
   * Rebuild the shared project frame from the layers currently loaded.
   *
   * Driven from `refreshCrsFlags` because that is the one place the app already
   * reconciles the whole layer set on every change — seeding the frame from
   * scattered add/remove call sites would eventually miss one, and a frame
   * holding a departed layer's origin is worse than no frame.
   *
   * A cloud with no declared origin is skipped rather than treated as origin
   * zero: mixing an unreferenced mesh into the anchor would drag it to zero and
   * push a georeferenced scan hundreds of kilometres out. Such a layer is not in
   * a shared spatial frame at all, which is exactly what "skip" says.
   */
  function syncProjectFrame(infos: readonly LayerInfo[]): void {
    const viewer = getViewer();
    const layers: ProjectFrameLayer[] = [];
    for (const info of infos) {
      const origin = viewer.getCloud(info.id)?.origin;
      if (!origin) continue;
      layers.push({
        id: info.id,
        sourceOrigin: [origin[0], origin[1], origin[2]],
        // The SAME key the mismatch check uses, so the layer panel and the
        // frame can never disagree about which scans share a CRS.
        crsKey: horizontalKey(info),
      });
    }
    deps.projectFrame.reconcile(layers);
  }

  function refreshCrsFlags(): void {
    const infos = buildLayerInfos();
    syncProjectFrame(infos);
    const m = detectCrsMismatch(infos);
    const inspector = getInspector();
    inspector.setLayerCrsFlags(new Set(m.mismatched.map((x) => x.id)), m.summary);
    // The two-epoch compare needs exactly two loaded layers.
    inspector.setLayerCompareAvailable(getViewer().clouds().length === 2);
    // Show the compass once a scan is open; hide it again when the last layer goes.
    refreshCompass();
  }

  function setVisible(id: string, visible: boolean): void {
    layers.visible.set(id, visible);
    applyVisibility();
  }

  function toggleSolo(id: string): void {
    layers.solo = nextSolo(layers.solo, id);
    applyVisibility();
  }

  return { buildLayerInfos, applyVisibility, refreshCrsFlags, setVisible, toggleSolo };
}
