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
import { loadLayerHealth } from '../lazyChunks';
import { isLinearUnitKnown } from '../geo/CoordinateTypes';
import type { ResolvedCrs } from '../geo/CoordinateTypes';
import type { CrsInfo } from '../io/crs';
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
  /**
   * Resolve a layer's authoritative CRS — the loader's detected CRS combined
   * with any user override — so multi-layer compatibility / mount / project-frame
   * decisions run on the SAME CRS the Inspector shows, not raw file metadata
   * (C8). Wired to `crsService.resolveFor`; per-cloud and non-mutating, so every
   * layer resolves independently regardless of which scan is active.
   */
  resolveCrs: (name: string, detected: CrsInfo | null | undefined) => ResolvedCrs;
  /**
   * Override {@link MULTI_LAYER_MOUNT_ENABLED}. Exists so both states stay
   * under test: the mount is disabled by default in v0.6.0, and its behaviour
   * still has to be pinned rather than left to rot behind a false constant.
   */
  multiLayerMount?: boolean;
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
 * Whether layers are physically rebased onto a shared project origin.
 *
 * ENABLED in v0.6.5. The mount mechanism is a Float64 placement transform
 * (`Viewer.setLayerPlacement`), not a rewrite of the position array: the source
 * vertices never move (`tests/sourceGeometryImmutable.test.ts`), rendering
 * places the mesh by its transform, each layer's CPU work reads its own
 * source-local frame (per-cloud origin), and combined estimators run only across
 * `verified` layers. The per-layer-frame fixes that previously blocked the flag
 * have landed: the world coordinate is recovered per boundary in the frame each
 * one names — picking/inspection through `cloud.worldXYZ(index)` (not the placed
 * point), reclassify and the project-frame estimators through the
 * `layerPlacement` fold, and the exporters through each cloud's own
 * `sourceOrigin` (`exportGeoContext`). The invariant that a mount never moves the
 * world coordinate a boundary computes is pinned under a non-identity placement
 * by `tests/frameWorldCoords.test.ts`, and the browser mount is exercised by
 * `tests/e2e/twoScanMount.spec.ts` (real separation, source untouched,
 * add/remove no-move).
 *
 * One item remains a precision refinement, not a correctness defect: for
 * far-apart mounts the renderer's mesh position should fold `− renderOrigin` on
 * the CPU per mesh to keep the Float32 GPU residual small. It is bounded and
 * refused past 1 mm by the `mountPrecision` gate below (`PointCloud.rebaseQuantum`;
 * geographic frames refused outright), so a placement that would lose a
 * millimetre never mounts.
 *
 * An unaligned or foreign-CRS layer carries no placement and stays in its own
 * frame, so `mounted: false` still makes the combined estimators refuse rather
 * than average unlike frames. Single-layer work is unaffected: a lone layer's
 * placement is the identity.
 */
export const MULTI_LAYER_MOUNT_ENABLED = true;

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
  verticalMount: boolean,
): { errorMetres: number | null; basis: 'projected-linear-unit' | 'geographic' | 'unknown' } {
  if (!cloud || !frame) return { errorMetres: 0, basis: 'projected-linear-unit' };
  if (info.isGeographic) return { errorMetres: null, basis: 'geographic' };
  const usable = (s: number | undefined): s is number =>
    s !== undefined && Number.isFinite(s) && s > 0;
  const horizontalScale = info.linearUnitToMetres;
  if (!usable(horizontalScale)) return { errorMetres: null, basis: 'unknown' };
  const q = cloud.rebaseQuantum(frame.projectOrigin);
  const horizontalError = q.horizontal * horizontalScale;
  // A horizontal-only mount applies its offset in X/Y only and leaves Z on the
  // source origin (`dz = 0` below), so the vertical unit never scales a Z
  // offset and must not gate the placement. Requiring it refused the common
  // real case — a projected scan with a horizontal CRS but no declared vertical
  // unit — from ever sharing a frame. Only a vertical mount reads the Z budget.
  if (!verticalMount) {
    return { errorMetres: horizontalError, basis: 'projected-linear-unit' };
  }
  const verticalScale = info.verticalUnitToMetres;
  if (!usable(verticalScale)) return { errorMetres: null, basis: 'unknown' };
  return {
    errorMetres: Math.max(horizontalError, q.vertical * verticalScale),
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
      // Resolve through the service (detected + override), not raw metadata, so
      // a CRS the user corrected in the Inspector drives layer compatibility /
      // mount / project-frame decisions too (C8).
      const crs = deps.resolveCrs(c?.name ?? id, c?.metadata?.crs);
      // A genuinely-unknown resolved CRS (no detection, no override) must carry
      // the same "nothing declared" shape a raw null used to — undefined name /
      // unit / geographic — so the compatibility classifier still reads it as
      // `unknown` and not a declared-but-incompatible frame. A real override
      // lands as projected/geographic/local, so overrides still flow through.
      const known = crs.kind !== 'unknown';
      return {
        id,
        name: c?.name ?? id,
        pointCount: c?.pointCount ?? 0,
        visible: layers.visible.get(id) ?? true,
        locked: viewer.isCloudLocked(id),
        epsg: crs.epsg,
        crsName: known ? crs.name : undefined,
        verticalDatum: crs.verticalDatum,
        verticalEpsg: crs.verticalEpsg,
        // ResolvedCrs carries `kind`, not the CrsInfo `isGeographic` flag.
        isGeographic: known ? crs.kind === 'geographic' : undefined,
        linearUnitToMetres: known ? crs.linearUnitToMetres : undefined,
        verticalUnitToMetres: crs.verticalUnitToMetres,
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
  let lastUnmounted: string[] = [];
  /** Per-layer mount-precision result from the last frame pass — health card input. */
  let lastPrecision = new Map<string, { errorMetres: number | null; basis: string }>();
  /** Lazy health builders (lazyChunks.loadLayerHealth) — wording stays out of the shell. */
  let healthMod: typeof import('./layerHealth') | null = null;
  let healthLoading = false;

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
    // Steps 2 + 4 of the wiring plan, as ONE mechanism — now non-destructive
    // (float64-transform.md): every aligned layer gets a Float64 PLACEMENT
    // into the project frame (`setLayerPlacement`), which mounts it. The data
    // never moves; rendering places the mesh, and bounds/picking fold the
    // transform at their boundaries. A layer outside the frame (no declared
    // origin, or a foreign CRS) carries no placement: it stays where it was,
    // and its presence makes datum unanimity refuse honestly, as before.
    const frame = deps.projectFrame.frame;
    // Layers held out of combined results because nothing is MOUNTED, as
    // distinct from those held out for incompatibility. Two perfectly
    // compatible layers are both `verified` and both excluded while mounting
    // is off, so a panel that explains only compatibility shows nothing wrong
    // while nothing works — the same silent exclusion the compatibility note
    // exists to prevent, arriving through the other half of the rule.
    const unmounted: string[] = [];
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
      const precision = mountPrecision(info, cloud, aligned ? frame : null, alignsVertically(state));
      lastPrecision.set(info.id, precision);
      const precisionSafe = precision.errorMetres !== null
        && precision.errorMetres <= REBASE_QUANTUM_BUDGET_M;

      const mountable = aligned && precisionSafe && deps.projectFrame.transformFor(info.id) != null;
      const willMount = mountable && (deps.multiLayerMount ?? MULTI_LAYER_MOUNT_ENABLED);
      // Combined estimators need to know whether this layer is genuinely IN
      // the frame, not merely eligible for it.
      const mounted = willMount || infos.length <= 1;
      viewer.setCloudMounted(info.id, mounted);
      if (!mounted) unmounted.push(info.id);

      if (willMount && cloud) {
        // A horizontal-only layer is placed in X/Y and keeps its OWN vertical
        // origin: a Z offset would assert a shared vertical datum nobody
        // established — heights would line up on screen and mean nothing.
        // The offset derives from the FILE's origin (sourceOrigin), which a
        // placement cannot move, so demotion can never pin a layer to a datum
        // its panel disclaims — the trap the old in-place rebase had.
        const so = cloud.sourceOrigin;
        const dz = alignsVertically(state) ? so[2] - frame!.projectOrigin[2] : 0;
        const dx = so[0] - frame!.projectOrigin[0];
        const dy = so[1] - frame!.projectOrigin[1];
        viewer.setLayerPlacement(info.id, {
          sourceOrigin: [so[0], so[1], so[2]],
          sourceToProject: [dx, dy, dz],
          projectToSource: [-dx, -dy, -dz],
        });
      } else {
        // Membership is reversible: clearing the placement IS returning to
        // the frame the file declared — exactly, because nothing was ever
        // re-quantised. No-op for a layer that never carried one.
        viewer.setLayerPlacement(info.id, null);
      }
      // Combined estimators read this and refuse anything unproven. A layer
      // rejected on precision is reported as incompatible rather than
      // verified: it is genuinely not in the project frame.
      viewer.setCloudCompatibility(
        info.id,
        aligned && !precisionSafe ? 'incompatible' : state,
      );
    }
    lastUnmounted = unmounted;
  }

  function refreshCrsFlags(): void {
    const infos = buildLayerInfos();
    const m = detectCrsMismatch(infos);
    syncProjectFrame(infos);
    const inspector = getInspector();
    // The compatibility map rides along so the panel can say WHY a layer is
    // out of the combined results, instead of it just quietly not being there.
    inspector.setLayerCrsFlags(
      new Set(m.mismatched.map((x) => x.id)),
      m.summary,
      lastCompatibility,
      new Set(lastUnmounted),
    );
    // The health card reads the same pass: one assembly, so the card and the
    // estimators can never disagree about a layer's state. Fields fail closed
    // (null) wherever the fact is not established — see app/layerHealth.ts.
    if (!healthMod) {
      if (!healthLoading) {
        healthLoading = true;
        // Re-push through the same refresh once the wording arrives.
        void loadLayerHealth().then((m) => { healthMod = m; refreshCrsFlags(); });
      }
    } else {
      const { buildLayerHealth, buildCompatibilityReport } = healthMod;
      const viewer2 = getViewer();
      const frame2 = deps.projectFrame.frame;
      const healthLayers = infos.map((info) => {
        const c = viewer2.getCloud(info.id);
        // Same resolved CRS the compatibility flags above used (C8) — the health
        // card must not report the raw file CRS the user already overrode.
        const crs = deps.resolveCrs(c?.name ?? info.id, c?.metadata?.crs);
        const inFrame =
          frame2 != null && !lastUnmounted.includes(info.id) &&
          !deps.projectFrame.unaligned.includes(info.id);
        const tf = inFrame ? deps.projectFrame.transformFor(info.id) : null;
        const p = lastPrecision.get(info.id) ?? null;
        return {
          rows: buildLayerHealth({
            name: info.name,
            crsName: info.crsName ?? null,
            crsSource: (crs as { source?: string } | null)?.source ?? null,
            horizontalUnit:
              crs && isLinearUnitKnown(crs) ? crs.linearUnit : null,
            verticalUnit: null, // no declared vertical unit NAME exists; never reverse-map the factor
            verticalDatum: info.verticalDatum ?? null,
            compatibility: lastCompatibility.get(info.id) ?? null,
            mounted: !lastUnmounted.includes(info.id),
            sourceOrigin: c?.sourceOrigin ? [c.sourceOrigin[0], c.sourceOrigin[1], c.sourceOrigin[2]] : null,
            frameOffset: tf ? [tf.sourceToProject[0], tf.sourceToProject[1], tf.sourceToProject[2]] : null,
            precisionMm: p && p.errorMetres !== null ? p.errorMetres * 1000 : null,
            precisionBasis: (p?.basis as 'projected-linear-unit' | 'geographic' | 'unknown' | undefined) ?? null,
            streaming: false,
            soleLayer: infos.length <= 1,
          }),
          name: info.name,
        };
      });
      const report = buildCompatibilityReport(
        infos.map((info) => ({
          name: info.name,
          compatibility: lastCompatibility.get(info.id) ?? null,
          verticalDatumKnown: (info.verticalDatum ?? null) !== null,
        })),
      );
      inspector.setLayerHealth(healthLayers, report);
    }
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
