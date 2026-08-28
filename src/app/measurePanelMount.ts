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
import { buildMeasureConfidenceContext } from './measureConfidenceContext';
import { loadMeasurePanel, loadProfileWorkbenchRuntime } from '../lazyChunks';

// Re-exported here so the shell reaches it through the cluster that owns the
// profile-workbench close signal, without adding a main.ts fan-out edge.
export { createAnalyseProfileVisibility } from './analyseProfileVisibility';
export type {
  AnalyseProfileVisibility,
  AnalyseProfileVisibilityDeps,
} from './analyseProfileVisibility';

import type { MeasurePanel } from '../ui/MeasurePanel';
import type { Viewer } from '../render/Viewer';
import type { CrsService } from '../geo/CrsService';
import type { MeasurementSummary } from '../render/measure/MeasureController';
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
}

/** The Measurements-panel mount controller `main.ts` drives. */
export interface MeasurePanelMount {
  /** The mounted panel, or null before the first scan load resolves it. */
  readonly panel: MeasurePanel | null;
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
  setGeographicNotice(value: boolean): void;
  /** Mark the panel as desired-visible and show it if already mounted. */
  showDesired(): void;
  /** Hide the panel and drop the tracked desired-visible intent. */
  hide(): void;
}

/**
 * Build the Measurements-panel mount controller. Mirrors the AnalysePanel /
 * ObjectPanel lazy mounts that remain inline in `main.ts`, but extracted so the
 * scaffolding does not weigh on the shell monolith.
 */
export function createMeasurePanelMount(deps: MeasurePanelMountDeps): MeasurePanelMount {
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
  let ready: Promise<MeasurePanel> | null = null;
  let mountElement: ((el: HTMLElement) => void) | null = null;
  // Desired panel state, mirrored so a panel mounted a beat AFTER a scan event
  // (the dynamic import resolves later) replays the correct state on hydrate.
  let desiredVisible = false;
  let geographicNotice = false;
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
        const m = deps.getViewer().measure.getMeasurements().find((x) => x.id === id);
        const a = m?.points[0];
        const b = m?.points[1];
        return a && b ? { a, b, corridorWidth: m?.profileCorridorWidth ?? null } : null;
      },
      // The generator, never the run-to-completion `section()`: the walk tests
      // every point of every eligible layer, and the presenter spreads it
      // across frames so the dock stays usable while a dense cloud is read.
      sectionChunks: (request) => deps.getViewer().profileSeam.sectionChunks(request),
      metresPerUnit: () => {
        const crs = deps.crsService.context();
        return crs.linearUnitKnown === true ? crs.linearUnitToMetres : null;
      },
      devicePixelRatio: () => (typeof window === 'undefined' ? 1 : window.devicePixelRatio),
      // The scene NOW, for a section that is a snapshot. A return is followed
      // back by the identity it was recorded under, never by matching
      // coordinates, so the seam is asked for one specific source point.
      locateReturn: (ref, out) => deps.getViewer().profileSeam.locateReturn(ref, out),
      crs: () => deps.crsService.current() ?? undefined,
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
        const opened = await live.open({ id: summary.id, kind: summary.kind, name: summary.name });
        if (opened) dockedId = summary.id;
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

  /** Construct the panel; the controller drives its measurement list. */
  function construct(Ctor: MeasurePanelCtor): MeasurePanel {
    const viewer = deps.getViewer();
    return new Ctor({
      onDelete: (id) => {
        // The dock plots THIS measurement's corridor, and a deleted
        // measurement has none left to plot.
        if (id === dockedId) closeWorkbench();
        viewer.measure.removeMeasurement(id);
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
        return aggregateMeasurements(
          selected,
          operation,
          dimension,
          // The scene's real up-axis, NOT a hard-coded Z-up: on a Y-up dataset
          // the literal [0,0,1] made every vertical chain sum 0 while the
          // individual Height tool (which uses worldUp) read the true value —
          // a row said 10 m, the sum said 0 (pass-6 M5).
          viewer.measure.worldUp,
          viewer.measure.unitToMetres,
          // The vertical axis keeps its OWN unit factor: a compound CRS (metre
          // grid + US-foot heights) must scale a height sum and volume by feet,
          // not by the horizontal metre factor (audit #8).
          viewer.measure.verticalUnitToMetres,
        );
      },
      // v0.3.10 Profile-as-Deliverable — expose the controller's unit
      // system to the panel so the profile chart's axis labels (chainage,
      // elevation) read in the user's preferred units.
      getUnitSystem: () => viewer.measure.unitSystem,
      // v0.4.5 (B4) — CRS provenance for the profile PDF header, resolved at
      // export time so a late confirmation/override lands on the sheet. Local
      // and unknown frames return nulls and the PDF keeps its honest
      // "— (not georeferenced)" fallback.
      getProfileExportContext: () => {
        const cur = deps.crsService.current();
        if (!cur || (cur.kind !== 'projected' && cur.kind !== 'geographic')) {
          return { crs: null, verticalDatum: null };
        }
        return {
          // "EPSG:NNNN — name" when the code is known; the resolved name alone
          // otherwise (it already falls back to the WKT name / EPSG label).
          crs: cur.epsg != null ? `EPSG:${cur.epsg} — ${cur.name}` : cur.name,
          verticalDatum: cur.verticalDatum ?? null,
        };
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
    });
  }

  /** Refresh the panel's contents and visibility; kicks the mount if unbuilt. */
  function refresh(): void {
    if (panel) {
      const viewer = deps.getViewer();
      panel.update(viewer.measure.getSummaries());
      panel.setConfidenceContext(buildMeasureConfidenceContext(viewer, deps.crsService.current()));
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
        if (docked) launcher?.handle?.setTitle?.(docked.name);
      }
    } else {
      // Panel not mounted yet (pre-first-scan, or the chunk is still loading) —
      // kick the lazy mount; `hydrate()` re-runs this once it lands.
      void ensure();
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
    panel.setGeographicNotice(geographicNotice);
    // Recompute contents + visibility from live controller state (summaries,
    // confidence context, measure mode). This also replays `desiredVisible`
    // when the profile-kind switch asked the panel forward before it existed.
    refresh();
    if (desiredVisible) panel.setVisible(true);
  }

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
    if (panel) return Promise.resolve(panel);
    if (ready) return ready;
    ready = loadMeasurePanel().then(({ MeasurePanel: Ctor }) => {
      // A concurrent caller may have won the race while the import was in flight.
      if (!panel) {
        panel = construct(Ctor);
        // Insert into the DOM in its canonical spot; no-op in bare/embed mode
        // where no left column was built (the force path mounts it directly).
        mountElement?.(panel.element);
        hydrate();
      }
      return panel;
    });
    return ready;
  }

  return {
    get panel() {
      return panel;
    },
    ensure,
    refresh,
    setMountElement(fn) {
      mountElement = fn;
      // If the panel already mounted before this wiring ran (a scan's import
      // resolved between column build and here), place it now.
      if (fn && panel) fn(panel.element);
    },
    setGeographicNotice(value) {
      geographicNotice = value;
      panel?.setGeographicNotice(value);
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
  };
}
