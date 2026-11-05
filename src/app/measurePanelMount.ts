/**
 * measurePanelMount.ts — the lazy Measurements-panel mount lifted out of main.ts.
 *
 * The Measurements panel is constructed on the FIRST scan load, not at boot, so
 * its whole profile-as-deliverable chain (profileSampler / profileSummary /
 * civilProfileStats) stays out of the empty-state shell — no measurement can
 * exist before a scan opens. This module owns that lifecycle: the single-flight
 * lazy construction through `loadMeasurePanel()`, the DOM mount hook, the tracked
 * desired-visible / geographic-notice intent replayed on hydrate, and the
 * contents/visibility refresh. `main.ts` keeps only thin call sites (and the
 * null-guards that genuinely sit at its own layout call sites) driven through a
 * structural {@link MeasurePanelMountDeps} of accessor functions closing over the
 * shell's services — the same seam `openScan` / `sessionIo` use. Part of the v0.6
 * decomposition (see `docs/architecture/architecture-map.md`).
 *
 * MeasurePanel arrives through `loadMeasurePanel()` (a dynamic import) so this
 * module is safe to statically import from the shell: only the TYPE is eager.
 */

import { aggregate as aggregateMeasurements } from '../render/measure/measurementChains';
import { positionStepsResolver } from './measurementPositionSteps';
import type { AxisSteps } from '../render/measure/geometry';
import type { Measurement } from '../render/measure/types';
import { layerUpFrameOf, layerUpVectorResolver } from './layerUpFrames';
import { upVectorOf } from '../geo/frame/layerUpFrame';
import { cloudUpAxisMoved, setCloudUpResolver } from '../render/layerUpRegistry';
import { bindMeasureUnitFrames, chainUnitFrame, type LayerUnitSource, type MeasureUnitFrames } from './measureLayerUnits';
import { buildMeasureConfidenceContext } from './measureConfidenceContext';
import { profileExportContext, profileWorkbenchSource, type ProfileExportContext, type ProfileSourceDeps, type ProfileSourcePurpose } from './profileExportSource';
import { datasetIdentity } from '../geo/CrsService';
import { buildResultModel } from './measureResultModel';
import { copyToClipboard } from '../ui/clipboard';
import { loadMeasurePanel, loadProfileWorkbenchRuntime } from '../lazyChunks';
import { retryableOnce, mountPanelOnce } from './lazySurfaceLoad';
import { chunkReloadAction, markChunkFailureReported } from './staleChunkReload';

// Re-exported here so the shell reaches it through the cluster that owns the
// profile-workbench close signal, without adding a main.ts fan-out edge.
export { createAnalyseProfileVisibility } from './analyseProfileVisibility';
// Same reason: the Box → clip flow (the row's "Use as clipping region" and
// the Clip page's "Isolate this box" both run its one conversion).
export { mountClip, leaveClipPage } from './clipMount';
export type {
  AnalyseProfileVisibility,
  AnalyseProfileVisibilityDeps,
} from './analyseProfileVisibility';

import type { MeasurePanel } from '../ui/MeasurePanel';
import type { Viewer } from '../render/Viewer';
import type { CrsService } from '../geo/CrsService';
import type { MeasurementSummary, RemovedMeasurement } from '../render/measure/MeasureController';
import type { ProfileWorkbenchLauncher } from './profileWorkbenchLauncher';
import type { WorkbenchSectionScene } from './profileWorkbenchSection';

/** Constructor pulled through the lazy chunk — the panel's real class. */
type MeasurePanelCtor = Awaited<ReturnType<typeof loadMeasurePanel>>['MeasurePanel'];

/**
 * Accessor functions closing over the shell's late-bound services. `getViewer`
 * and `getExportPanel` are thunks because the Viewer resolves from a lazy chunk
 * and the Export panel is constructed after this mount is wired; both are only
 * dereferenced at call time (after a scan opens), never at construction.
 */
export interface MeasurePanelMountDeps {
  getViewer: () => Viewer;
  crsService: CrsService;
  getExportPanel: () => { refresh(): void };
  exportSession: () => unknown;
  handleFile: (file: File) => unknown;
  recordUsage: (category: 'measurement', kind: string) => void;
  /** The active scan's base name, as the other exports name it; null or absent when unknown. */
  getScanBaseName?: () => string | null;
  /** The app's one toast; a delete offers its Undo there. */
  toast?: (message: string, action?: { label: string; onClick: () => void }) => void;
  /**
   * The stage the docked Profile Workbench shares its box with. Absent — the
   * bare and embed layouts, which build no stage — leaves the profile Expand
   * control opening `ResultFocus`, exactly as it did before the dock existed.
   */
  workbenchStage?: { root: HTMLElement };
  /**
   * Called whenever the docked Profile Workbench closes (its Close button, a
   * scan reset, or a new scan load). The kind-change event fires on open but
   * never on close, so this is the shell's only close signal — main.ts uses it
   * to restore the AnalysePanel visibility the profile open had hidden.
   */
  onWorkbenchClose?: () => void;
  /** "Use as clipping region" on a Box row; absent hides the action. */
  onUseAsClip?: (id: string) => void;
}

/** The Measurements-panel mount controller `main.ts` drives. */
export interface MeasurePanelMount {
  /** The mounted panel, or null before the first scan load resolves it. */
  readonly panel: MeasurePanel | null;
  /** Delete one measurement as its row's × does, with the same Undo offer. False when there is none. */
  deleteMeasurement(id: string): boolean;
  /** Construct + mount the panel exactly once; idempotent and single-flight. */
  ensure(): Promise<MeasurePanel>;
  /** Refresh the panel's contents and visibility from live controller state. */
  refresh(): void;
  /**
   * Register the DOM insertion hook (desktop left column / mobile sheet). Passing
   * a hook while the panel already exists mounts it immediately, covering a scan
   * whose import resolved before the layout wiring ran.
   */
  setMountElement(fn: ((el: HTMLElement) => void) | null): void;
  /** Track + apply the geographic-CRS caveat (replayed on a later mount). */
  setGeographicNotice(value: boolean, verticalRefused?: boolean): void;
  /** Mark the panel as desired-visible and show it if already mounted. */
  showDesired(): void;
  /** Hide the panel and drop the tracked desired-visible intent. */
  hide(): void;
  /**
   * Feed the controller the active scan's unit frame and every other open
   * layer's, so work reads out in the units of the layer it was taken on.
   * Call once the viewer exists; drive the result from the CRS subscription.
   * Also binds navigation up to the same per-layer frame (`app/layerUpFrames.ts`).
   */
  bindUnitFrames(src: Omit<LayerUnitSource, 'crs' | 'realignUp'> & {
    /** A CRS change moved a layer's resolved up axis: colours were rebuilt; re-express the elevation filter. */
    readonly onUpAxisMoved?: () => void;
  }): MeasureUnitFrames;
}

/**
 * Build the Measurements-panel mount controller. Mirrors the AnalysePanel /
 * ObjectPanel lazy mounts that remain inline in `main.ts`, but extracted so the
 * scaffolding does not weigh on the shell monolith.
 */
export function createMeasurePanelMount(deps: MeasurePanelMountDeps): MeasurePanelMount {
  // The step each measurement's positions are held at on its own layer(s), bound with the unit frames.
  let chainSteps: ((m: Measurement) => AxisSteps | null) | null = null;
  // The open layers, bound with the unit frames, so a profile export names the scan it was measured on.
  let layerSource: Omit<LayerUnitSource, 'crs' | 'realignUp'> | null = null;
  /** The scan(s) one profile records it was picked on, in their own CRS; the active scan when only one is open. */
  /** The source of one profile's export, or of its raw section with `purpose` naming what the dock is doing. */
  const profileSource = (id: string, rawSection = false, purpose: ProfileSourcePurpose = 'workbench'): ProfileExportContext => {
    const v = deps.getViewer();
    const src = layerSource;
    const m = v.measure.getMeasurements().find((x) => x.id === id);
    const d: ProfileSourceDeps = {
      activeId: () => src?.activeId() ?? null,
      clouds: () => src?.clouds() ?? [],
      hasStreamingCloud: () => v.hasStreamingCloud,
      cloud: (vid) => src?.cloud(vid),
      stableIdFor: (vid) => src?.stableIdFor(vid) ?? null,
      activeCrs: () => deps.crsService.current() ?? null,
      crsOf: (c) => deps.crsService.resolveFor({ name: c.name, detected: c.metadata?.crs ?? undefined, source: 'las-vlr', identity: datasetIdentity(c) }),
      activeName: () => deps.getScanBaseName?.() ?? null,
    };
    return rawSection ? profileWorkbenchSource(m, d, purpose) : profileExportContext(m, d);
  };
  let panel: MeasurePanel | null = null;
  // One launcher for the whole mount, so a second Expand replaces the dock the
  // first one left rather than stacking on it. Memoised rather than built here:
  // the whole assembly — stage adapter, launcher, section renderer — rides a
  // dynamic import, so none of it weighs on the startup shell and none of it
  // loads before a profile's Expand control is pressed.
  const workbenchStage = deps.workbenchStage;
  let workbench: Promise<ProfileWorkbenchLauncher> | null = null;
  // The resolved launcher, held beside the promise so the dock can be closed
  // synchronously from a lifecycle hook that has no promise to wait on.
  let launcher: ProfileWorkbenchLauncher | null = null;
  // The measurement the open dock is plotting, or null when none is.
  let dockedId: string | null = null;
  let mountElement: ((el: HTMLElement) => void) | null = null;
  // Desired panel state, mirrored so a panel mounted a beat AFTER a scan event
  // (the dynamic import resolves later) replays the correct state on hydrate.
  let desiredVisible = false;
  let geographicNotice = false;
  let verticalNotice = false;
  // High-water mark for measurement count — used to detect new placements.
  let lastMeasurementCount = 0;

  /**
   * The live scene, as the section presenter reads it.
   *
   * Every member is a thunk: the layers, the resident streaming nodes and the
   * resolved CRS all change under an open dock, so a section is a snapshot of
   * the moment Expand was pressed rather than of the moment this was built.
   */
  function workbenchScene(): WorkbenchSectionScene {
    return {
      profile: (id) => {
        const measure = deps.getViewer().measure;
        const m = measure.getMeasurements().find((x) => x.id === id);
        const a = m?.points[0];
        const b = m?.points[1];
        return m && a && b ? { a, b, corridorWidth: measure.profileCorridorOf(m) } : null;
      },
      // The generator, never the run-to-completion `section()`: the walk tests
      // every point of every eligible layer, and the presenter spreads it
      // across frames so the dock stays usable while a dense cloud is read.
      sectionChunks: (request) => deps.getViewer().profileSeam.sectionChunks(request),
      metresPerUnit: () => profileMetresPerUnit(deps.crsService.context()),
      devicePixelRatio: () => (typeof window === 'undefined' ? 1 : window.devicePixelRatio),
      // The scene NOW, for a section that is a snapshot. A return is followed
      // back by the identity it was recorded under, never by matching
      // coordinates, so the seam is asked for one specific source point.
      locateReturn: (ref, out) => deps.getViewer().profileSeam.locateReturn(ref, out),
      crs: () => deps.crsService.current() ?? undefined,
      heightDatum: () => deps.getViewer().measure.elevationDatum,
      sceneOrigin: () => deps.getViewer().measure.sceneOrigin,
    };
  }

  /**
   * Close the dock, if one is open.
   *
   * A dock plots one measurement's corridor over one scene. Neither survives
   * the measurement being deleted or the scene being replaced, and a dock left
   * behind keeps both its plot and its `calc(100% - Npx)` claim on the stage.
   */
  function closeWorkbench(): void {
    dockedId = null;
    launcher?.close();
    deps.onWorkbenchClose?.();
  }

  /** Expand, for a profile row. False means the panel keeps `ResultFocus`. */
  function openWorkbench(summary: MeasurementSummary): Promise<boolean> {
    if (!workbenchStage) return Promise.resolve(false);
    workbench ??= loadProfileWorkbenchRuntime().then(({ createProfileWorkbenchRuntime }) => {
      launcher = createProfileWorkbenchRuntime({
        stage: workbenchStage,
        scene: workbenchScene(),
        // The PNG names the scan the profile was measured on; one that cannot be settled is not written.
        scanBaseName: (id) => {
          const src = profileSource(id, true, 'export');
          if (src.refused) throw new Error(src.refused);
          return src.scanName;
        },
        markerHost: () => deps.getViewer().derivedLayerHost(),
        // The pose pair, not a focus call: the workbench composes the move so
        // the arithmetic stays testable, and so the only way here is the
        // deliberate action on a clicked selection.
        camera: {
          pose: () => deps.getViewer().getCameraPose(),
          apply: (pose) => deps.getViewer().applyCameraPose(pose),
        },
        // The dock's title field commits through the SAME controller call the
        // Measurements panel's own name field does, then refreshes the panel,
        // so a rename made in either surface is the one name both show.
        rename: (id, name) => {
          deps.getViewer().measure.renameMeasurement(id, name);
          refresh();
        },
        // The panel's own export, not a second one. It is the single place the
        // sheet's inputs are assembled, which is what keeps the read scope and
        // the classification basis on a sheet exported from the dock.
        exportPdf: (id) => {
          const live = panel;
          if (!live) return Promise.reject(new Error('The measurements panel is not mounted.'));
          return live.exportProfilePdf(id);
        },
      });
      return launcher;
    });
    return workbench.then(
      async (live) => {
        const refusal = profileSource(summary.id, true).refused;
        if (refusal) { deps.toast?.(refusal); return false; }
        const opened = await live.open({ id: summary.id, kind: summary.kind, name: summary.name });
        if (opened) {
          const changed = profileSource(summary.id, true, 'closed').refused;
          if (changed) { closeWorkbench(); deps.toast?.(changed); return false; }
          dockedId = summary.id;
        }
        return opened;
      },
      (error) => {
        // A memoised rejection would make every later press fall back too, so
        // the next Expand gets a fresh attempt at the chunk.
        workbench = null;
        launcher = null;
        console.error('OpenLiDARViewer: the profile workbench failed to load.', error);
        return false;
      },
    );
  }

  /** The one delete path: the row's ×, the result card's Delete and any caller that has only the id. */
  function deleteMeasurement(id: string): boolean {
    // The dock plots THIS measurement's corridor, and a deleted measurement has none left to plot.
    if (id === dockedId) closeWorkbench();
    const removed = deps.getViewer().measure.removeMeasurement(id);
    if (removed) offerUndo(removed);
    return removed != null;
  }

  function offerUndo(removed: RemovedMeasurement): void {
    // The result card can delete before the panel chunk has landed; the offer
    // waits for the panel rather than being dropped.
    const offer = (p: MeasurePanel): void => p.offerUndo(`Deleted ${removed.measurement.name}.`, () => {
      if (deps.getViewer().measure.restoreMeasurement(removed)) refresh();
    }, deps.toast, () => deps.getViewer().measure.drafting);
    const restore = (): void => { if (deps.getViewer().measure.restoreMeasurement(removed)) refresh(); };
    if (panel) offer(panel);
    // The panel alone, not the reveal `ensure()` performs. With no panel the toast still offers it.
    else void mount().then(offer, () => { deps.toast?.(`Deleted ${removed.measurement.name}.`, { label: 'Undo', onClick: restore }); });
  }

  /** The Clear button's Undo: every measurement goes back in its old order, in one change. */
  function offerUndoAll(removed: RemovedMeasurement[]): void {
    const n = removed.length;
    const message = `Deleted ${n} ${n === 1 ? 'measurement' : 'measurements'}.`;
    const undo = (): void => {
      const measure = deps.getViewer().measure;
      if (measure.holdChange(() => removed.map((r) => measure.restoreMeasurement(r)).some(Boolean))) refresh();
    };
    if (panel) panel.offerUndo(message, undo, deps.toast, () => deps.getViewer().measure.drafting);
    else deps.toast?.(message, { label: 'Undo', onClick: undo });
  }

  /** Construct the panel; the controller drives its measurement list. */
  function construct(Ctor: MeasurePanelCtor): MeasurePanel {
    const viewer = deps.getViewer();
    viewer.measure.onClearAll = offerUndoAll;
    return new Ctor({
      onDelete: (id) => { deleteMeasurement(id); },
      // The row's Copy writes exactly what the result card's Copy writes.
      onCopy: (id) => {
        const s = viewer.measure.getSummaries().find((x) => x.id === id);
        if (!s) return;
        const model = buildResultModel(s, buildMeasureConfidenceContext(viewer, deps.crsService.current(), deps.crsService.context()));
        if (model.copyText === null) { deps.toast?.('No value to copy for this measurement.'); return; }
        void copyToClipboard(model.copyText).then((ok) => deps.toast?.(ok ? 'Result copied.' : 'Could not copy the result.'));
      },
      onRename: (id, name) => viewer.measure.renameMeasurement(id, name),
      onExport: () => void deps.exportSession(),
      // Route through the single file router so the Import button, the Open
      // picker, and a drag-drop all open a session identically (and a scan
      // picked here still loads as a scan).
      onImport: (file) => void deps.handleFile(file),
      onChainAggregate: (ids, dimension, operation) => {
        // Filter the controller's measurements to the panel-selected set
        // and aggregate via the pure-data module. The panel owns the
        // selection state; the controller owns the data + unit context.
        // The CRS unit factor (B2, v0.4.5) rides along so chain sums over a
        // foot-CRS scan come back in true metres like every other readout.
        const all = viewer.measure.getMeasurements();
        const wanted = new Set(ids);
        const selected = all.filter((m) => wanted.has(m.id));
        // Each measurement's own unit frame (the layer it was taken on), so a
        // chain over a foot scan sums feet-as-metres correctly whichever scan
        // is active; values from scans with different units are not summed.
        const shared = chainUnitFrame(selected.length > 0 ? selected.map((m) => viewer.measure.unitFrameOf(m)) : [viewer.measure.unitFrameOf()]);
        if ('refusal' in shared) {
          return { value: Number.NaN, unit: '', contributingCount: 0, totalCount: selected.length, operation, dimension, refusal: shared.refusal };
        }
        const f = shared.frame;
        return aggregateMeasurements(
          selected,
          operation,
          dimension,
          // The scene's real up-axis, NOT a hard-coded Z-up: on a Y-up dataset
          // the literal [0,0,1] made every vertical chain sum 0 while the
          // individual Height tool (which uses worldUp) read the true value —
          // a row said 10 m, the sum said 0 (pass-6 M5). The measurements'
          // own layer up, which the frame check above found shared.
          f.up ?? viewer.measure.worldUp,
          f.unitToMetres,
          // The vertical axis keeps its OWN unit factor: a compound CRS (metre
          // grid + US-foot heights) must scale a height sum and volume by feet,
          // not by the horizontal metre factor (audit #8).
          f.verticalUnitToMetres ?? f.unitToMetres,
          // The same frame verdicts the live grade and the exports read: a
          // geographic frame refuses all but height, and an unconfirmed scale
          // is not called metres.
          { positionSteps: (m) => chainSteps?.(m) ?? null, geographic: f.geographic, verticalRefused: f.verticalRefused, verticalScaleInvalid: f.verticalUnitInvalid, unitsVerified: f.crsKnown && !f.geographic },
        );
      },
      // v0.3.10 Profile-as-Deliverable — expose the controller's unit
      // system to the panel so the profile chart's axis labels (chainage,
      // elevation) read in the user's preferred units.
      getUnitSystem: () => viewer.measure.unitSystem,
      // CRS provenance and the project name for the profile PDF, CSV and
      // image, resolved at export time from the scan the profile was measured
      // on, so a late confirmation or override lands on the sheet and another
      // scan's selection does not relabel it. Local and unknown frames return
      // nulls and the PDF keeps its "— (not georeferenced)" fallback.
      getProfileExportContext: profileSource,
      getProfileExportFrame: (id) => {
        const measurement = viewer.measure.getMeasurements().find((m) => m.id === id);
        return measurement ? viewer.measure.unitFrameOf(measurement) : null;
      },
      // B7/B8 (v0.4.5) — the panel's sampler controls re-sample through the
      // controller, which clamps the values, converts the metre corridor back to
      // render units, and emits a change so the panel re-renders with the values
      // that actually shaped the new chart.
      onProfileResample: (id, params) => viewer.measure.resampleProfile(id, params),
      // Profile-station hover → highlight the matching scene dot; repaint only when the dot changed.
      onStationHover: (id, i) => { if (viewer.measure.setHoveredStation(id, i)) viewer.requestFrame(); },
      // Expand, for a profile row: the docked workbench when the shell offered
      // a stage and the launcher accepts, `ResultFocus` on every refusal. The
      // panel is told only true or false, so it never learns what a dock is.
      openProfileWorkbench: workbenchStage ? openWorkbench : undefined,
      onUseAsClip: deps.onUseAsClip,
    });
  }

  /** Refresh the panel's contents and visibility; kicks the mount if unbuilt. */
  function refresh(): void {
    if (panel) {
      const viewer = deps.getViewer();
      panel.update(viewer.measure.getSummaries());
      panel.setConfidenceContext(buildMeasureConfidenceContext(viewer, deps.crsService.current(), deps.crsService.context()));
      const measurements = viewer.measure.getMeasurements();
      const hasMeasurements = measurements.length > 0;
      panel.setVisible(viewer.measureMode || hasMeasurements);
      // Local-first counter, categorical (the kind) only — never coordinates or names.
      if (measurements.length > lastMeasurementCount) {
        const newest = measurements[measurements.length - 1];
        if (newest) deps.recordUsage('measurement', newest.kind);
      }
      lastMeasurementCount = measurements.length;
      // A rename made in the Measurements list belongs on the open dock's
      // title too: one name, two views of it. Pushed rather than polled, and
      // the panel drops the write while its field has focus, so a refresh
      // cannot overwrite a name someone is still typing into the dock.
      if (dockedId !== null) {
        const docked = measurements.find((m) => m.id === dockedId);
        const refusal = profileSource(dockedId, true, 'closed').refused;
        if (refusal) { closeWorkbench(); deps.toast?.(refusal); }
        else if (docked) launcher?.handle?.setTitle?.(docked.name);
      }
    } else {
      // Panel not mounted yet (pre-first-scan, or the chunk is still loading) —
      // kick the lazy mount; `hydrate()` re-runs this once it lands.
      void ensure().catch(() => {}); // the failure is said once, by `mount`
    }
    // Keep the Export panel's Products lane in sync with the measurement count.
    deps.getExportPanel().refresh();
  }

  /**
   * Replay the tracked state onto the freshly-mounted panel — the geographic-CRS
   * caveat and the live measurement contents/visibility — so a panel that
   * mounted a beat after a scan event shows exactly what the app asked for.
   */
  function hydrate(): void {
    if (!panel) return;
    panel.setGeographicNotice(geographicNotice, verticalNotice);
    // Recompute contents + visibility from live controller state (summaries,
    // confidence context, measure mode). This also replays `desiredVisible`
    // when the profile-kind switch asked the panel forward before it existed.
    refresh();
    if (desiredVisible) panel.setVisible(true);
  }

  // The panel's one load, shared by concurrent first mounts. retryableOnce
  // drops a failed load, so the next reveal fetches the chunk again.
  let mountFailureSaid = false;
  const mount = retryableOnce(() =>
    // No mount hook in bare/embed mode; the force path mounts it directly.
    loadMeasurePanel().then(({ MeasurePanel: Ctor }) =>
      mountPanelOnce(panel, () => (panel = construct(Ctor)), mountElement, hydrate)).then((p) => {
      mountFailureSaid = false;
      return p;
    }, (err: unknown) => {
      // Every refresh tries again, and one failure is said once.
      if (!mountFailureSaid) {
        mountFailureSaid = true;
        markChunkFailureReported();
        deps.toast?.('The Measurements list could not load. Your measurements are kept. Reload the page to try again; a reload closes open scans, so save your session first if you can.', chunkReloadAction());
      }
      throw err;
    }),
  );

  /**
   * Construct + mount the Measurements panel exactly once, pulling its chunk
   * through `loadMeasurePanel()`. Idempotent and memoised: concurrent
   * first-mounts share the single in-flight promise, and the double-construct
   * guard means only one panel is ever built. After construction it inserts into
   * the DOM (via the registered mount hook) and hydrates the tracked state.
   *
   * Also where a scan load reaches the dock: this is the call every reveal
   * makes, and a section of the previous scene is not a section of this one.
   */
  function ensure(): Promise<MeasurePanel> {
    closeWorkbench();
    return panel ? Promise.resolve(panel) : mount();
  }

  return {
    get panel() {
      return panel;
    },
    deleteMeasurement,
    ensure,
    refresh,
    setMountElement(fn) {
      mountElement = fn;
      // If the panel already mounted before this wiring ran (a scan's import
      // resolved between column build and here), place it now.
      if (fn && panel) fn(panel.element);
    },
    setGeographicNotice(value, verticalRefused = false) {
      geographicNotice = value;
      verticalNotice = verticalRefused;
      panel?.setGeographicNotice(value, verticalRefused);
    },
    showDesired() {
      desiredVisible = true;
      panel?.setVisible(true);
    },
    hide() {
      // The reset-to-empty-state path: no scan is open, so there is no scene
      // for a docked section to be a section OF.
      closeWorkbench();
      panel?.setVisible(false);
      desiredVisible = false;
    },
    bindUnitFrames: (src) => {
      layerSource = src;
      const v = deps.getViewer();
      // Bound here too: Clear offers its Undo when the panel's chunk never landed.
      v.measure.onClearAll = offerUndoAll;
      chainSteps = (m) => positionStepsResolver(src.clouds().map((id) => ({ stableId: src.stableIdFor(id), projectOffset: v.layerProjectOffset(id) })))(m);
      // Navigation up reads the same per-layer frame as the owner frames, and
      // re-aligns when a CRS change moves the active layer's axis.
      v.layerUp = layerUpVectorResolver(src.cloud, src.activeId, deps.crsService);
      // Height colouring, the elevation scale and the legend read it too.
      setCloudUpResolver((c) => {
        const id = src.activeId();
        return upVectorOf(layerUpFrameOf(deps.crsService, c, id !== null && src.cloud(id) === c));
      });
      return bindMeasureUnitFrames(v.measure, {
        ...src,
        crs: deps.crsService,
        projectOffset: (id) => v.layerProjectOffset(id),
        realignUp: () => {
          v.alignUpToLayer(src.activeId());
          if (cloudUpAxisMoved(src.clouds().map(src.cloud))) {
            v.refreshProjectSharedElevation(true);
            src.onUpAxisMoved?.();
          }
        },
      });
    },
  };
}

/**
 * Metres per source unit for the profile section, or null when there is no
 * honest factor: the linear unit is unknown, or the CRS is geographic, where
 * X and Y are degrees and the linear factor does not apply to them.
 */
export function profileMetresPerUnit(ctx: { readonly linearUnitKnown: boolean; readonly linearUnitToMetres: number; readonly isGeographic: boolean }): number | null {
  if (ctx.isGeographic) return null;
  return ctx.linearUnitKnown === true ? ctx.linearUnitToMetres : null;
}

