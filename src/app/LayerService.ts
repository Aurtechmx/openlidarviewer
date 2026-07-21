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
 * Largest Float32 step a mount may land the geometry on, IN METRES.
 *
 * 1 mm is the resolution survey LiDAR is specified at, so a mount that cannot
 * hold a millimetre is not preserving the measurement. The source quantum is
 * converted through the CRS's linear unit before it is compared here — the
 * two were once compared directly, which made a gate named for a millimetre
 * accept 9.5e-7 degrees, about 10.6 cm.
 */
export const REBASE_QUANTUM_BUDGET_M = 0.001;

/**
 * What a mount would cost this layer, expressed in metres — or null when that
 * question has no linear answer.
 *
 * The quantum comes back in the source's own units, split into horizontal and
 * vertical. A projected frame converts each through ITS OWN unit — a compound
 * CRS can be feet across and metres up, and putting the Z step through the
 * horizontal factor understated a 1.95 mm height error as 0.6 mm, admitting a
 * mount the millimetre budget exists to refuse. The reported error is the worse
 * of the two once both are in metres, so either axis alone can refuse.
 *
 * A GEOGRAPHIC frame does not convert at all, because a degree is not a length
 * and the metres it stands for depend on latitude and axis. Rather than
 * approximate, geographic sources are reported as having no safe linear budget,
 * which refuses the destructive mount. An undeclared unit is the same answer:
 * unknown, refuse — and specifically the vertical unit does NOT borrow the
 * horizontal one, which would be the same error in a quieter form.
 */
function mountPrecision(
  info: LayerInfo,
  cloud: {
    rebaseQuantum(t: readonly [number, number, number]): {
      horizontal: number;
      vertical: number;
    };
  } | null | undefined,
  frame: { projectOrigin: readonly [number, number, number] } | null,
): { errorMetres: number | null; basis: 'projected-linear-unit' | 'geographic' | 'unknown' } {
  if (!cloud || !frame) return { errorMetres: 0, basis: 'projected-linear-unit' };
  if (info.isGeographic) return { errorMetres: null, basis: 'geographic' };
  const usable = (s: number | undefined): s is number =>
    s !== undefined && Number.isFinite(s) && s > 0;
  const horizontalScale = info.linearUnitToMetres;
  const verticalScale = info.verticalUnitToMetres;
  if (!usable(horizontalScale) || !usable(verticalScale)) {
    return { errorMetres: null, basis: 'unknown' };
  }
  const q = cloud.rebaseQuantum(frame.projectOrigin);
  return {
    errorMetres: Math.max(q.horizontal * horizontalScale, q.vertical * verticalScale),
    basis: 'projected-linear-unit',
  };
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
        verticalEpsg: crs?.verticalEpsg,
        isGeographic: crs?.isGeographic,
        linearUnitToMetres: crs?.linearUnitToMetres,
        verticalUnitToMetres: crs?.verticalUnitToMetres,
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
  let lastCompatibility = new Map<string, LayerCompatibility>();

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
        id: i.id, epsg: i.epsg, crsName: i.crsName,
        verticalDatum: i.verticalDatum, verticalEpsg: i.verticalEpsg,
      })),
    );
    lastCompatibility = compat;
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
        // Only a vertically-verified layer may choose the project's Z origin.
        // A horizontal-only layer is one we have said we cannot trust in
        // height; letting it set the datum the verified layers are rebased
        // onto would invert the distinction entirely.
        alignsVertically: alignsVertically(stateOf(info.id)),
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
      // simply gone.
      //
      // `rebaseQuantum` reports that step in the SOURCE's own units, so it has
      // to be converted before it can be judged against a budget in metres.
      // Comparing it raw meant a gate named for a millimetre accepted 9.5e-7
      // DEGREES — about 10.6 cm — and was three times too lenient on foot
      // data. Degrees are not a linear metre frame at all, so a destructive
      // mount on geographic coordinates is refused outright rather than
      // converted through a latitude-dependent approximation.
      const precision = mountPrecision(info, cloud, aligned ? frame : null);
      const precisionSafe = precision.errorMetres !== null
        && precision.errorMetres <= REBASE_QUANTUM_BUDGET_M;

      if (aligned && precisionSafe && deps.projectFrame.transformFor(info.id)) {
        // A horizontal-only layer is placed in X/Y and keeps its OWN vertical
        // origin. Rebasing its Z would assert a shared vertical datum nobody
        // established — the heights would line up on screen and mean nothing.
        const target: [number, number, number] = alignsVertically(state)
          ? [frame!.projectOrigin[0], frame!.projectOrigin[1], frame!.projectOrigin[2]]
          // The FILE's height, never the live one. Reading `cloud.origin[2]`
          // here meant a layer that had already mounted as verified — and so
          // had the project's Z written into it — stayed pinned to that datum
          // when it was later demoted, while the panel declared its vertical
          // frame unverified. Same live-versus-source trap as the frame seed.
          : [
              frame!.projectOrigin[0],
              frame!.projectOrigin[1],
              cloud?.sourceOrigin[2] ?? frame!.projectOrigin[2],
            ];
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
    // The compatibility map rides along so the panel can say WHY a layer is
    // out of the combined results, instead of it just quietly not being there.
    inspector.setLayerCrsFlags(new Set(m.mismatched.map((x) => x.id)), m.summary, lastCompatibility);
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
