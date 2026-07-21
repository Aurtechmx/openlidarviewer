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
import {
  classifyLayerCompatibility,
  alignsHorizontally,
  alignsVertically,
  type LayerCompatibility,
} from '../model/layerCompatibility';
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

/**
 * Largest Float32 step a mount may land the geometry on, in source units.
 *
 * 1 mm is the resolution survey LiDAR is specified at, so a mount that cannot
 * hold a millimetre is not preserving the measurement. Layers further apart
 * than roughly 100 km trip this and stay in their own frames.
 */
export const REBASE_QUANTUM_BUDGET_M = 0.001;

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
    // Compatibility is an explicit four-state fact per layer, not the absence
    // of a detected mismatch. That inversion is the point: the previous rule
    // mounted anything nothing had contradicted, so an undeclared CRS counted
    // as agreement. `detectCrsMismatch` still drives the panel's wording;
    // this drives what is allowed to happen to the geometry.
    //
    // A vertically-unconfirmed pair is no longer folded in wholesale. It
    // aligns in X/Y, where the agreement is real, and keeps its own Z — the
    // doubt now gates the product instead of only annotating it.
    const compat = classifyLayerCompatibility(
      infos.map((i) => ({
        id: i.id, epsg: i.epsg, crsName: i.crsName, verticalDatum: i.verticalDatum,
      })),
    );
    const stateOf = (id: string): LayerCompatibility => compat.get(id) ?? 'unknown';
    const layers: ProjectFrameLayer[] = [];
    for (const info of infos) {
      // The FILE's origin, never the live one. Reading `origin` here meant that
      // one reconcile after a rebase the frame was re-seeded from the origin it
      // had itself just written — so the anchor drifted onto its own output and
      // the true source frame was gone.
      const origin = viewer.getCloud(info.id)?.sourceOrigin;
      if (!origin) continue;
      layers.push({
        id: info.id,
        sourceOrigin: [origin[0], origin[1], origin[2]],
        crsKey: horizontalKey(info),
        // Only a layer that has PROVEN a shared horizontal frame anchors the
        // project origin. An undeclared CRS used to qualify simply because
        // nothing contradicted it, which let an unreferenced mesh drag the
        // anchor and mount beside a georeferenced scan.
        alignedToProject: alignsHorizontally(stateOf(info.id)),
      });
    }
    deps.projectFrame.reconcile(layers);
    // Steps 2 + 4 of the wiring plan, as ONE mechanism: every aligned layer's
    // DATA is rebased onto the project origin (`rebaseCloudToOrigin`), which
    // mounts it — rendering, picking, terrain, lasso, volumes and exports all
    // read the same rebased positions — and gives the scene one literal origin,
    // so the measurement datum resolves through the existing unanimity rule
    // with no special case. A layer outside the frame (no declared origin, or a
    // foreign CRS) keeps its own origin: it stays where it was, and its
    // presence makes unanimity refuse the datum honestly, exactly as before
    // the frame existed.
    const frame = deps.projectFrame.frame;
    for (const info of infos) {
      const state = stateOf(info.id);
      const cloud = viewer.getCloud(info.id);
      const aligned =
        frame != null
        && alignsHorizontally(state)
        && !deps.projectFrame.unaligned.includes(info.id);

      // A mount is only worth making if it survives Float32. The offset is
      // written into the position array, so a distant layer spends the
      // mantissa its residual was using — at 100 km apart a millimetre is
      // simply gone. Past the budget the layer keeps its own frame and says
      // so, which is a truthful placement rather than a quietly rounded one.
      const quantum =
        aligned && cloud ? cloud.rebaseQuantum(frame!.projectOrigin) : 0;
      const precisionSafe = quantum <= REBASE_QUANTUM_BUDGET_M;

      if (aligned && precisionSafe && deps.projectFrame.transformFor(info.id)) {
        // A horizontal-only layer is placed in X/Y and keeps its OWN vertical
        // origin. Rebasing its Z would assert a shared vertical datum nobody
        // established — the heights would line up on screen and mean nothing.
        const target: [number, number, number] = alignsVertically(state)
          ? [frame!.projectOrigin[0], frame!.projectOrigin[1], frame!.projectOrigin[2]]
          : [frame!.projectOrigin[0], frame!.projectOrigin[1], cloud?.origin[2] ?? frame!.projectOrigin[2]];
        viewer.rebaseCloudToOrigin(info.id, target);
      } else {
        // Membership is reversible. A layer that is not (or is no longer) in
        // the frame goes back to the origin its FILE declared instead of
        // staying parked on an origin that describes a different layer —
        // which is what happened when a CRS override turned an aligned layer
        // foreign. No-ops for a layer that never moved.
        viewer.restoreCloudSourceFrame(info.id);
      }
      // Combined estimators read this and refuse anything unproven. A layer
      // rejected on precision is reported as incompatible rather than
      // verified: it is genuinely not in the project frame.
      viewer.setCloudCompatibility(
        info.id,
        aligned && !precisionSafe ? 'incompatible' : state,
      );
    }
  }

  function refreshCrsFlags(): void {
    const infos = buildLayerInfos();
    const m = detectCrsMismatch(infos);
    syncProjectFrame(infos);
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
