/**
 * processStudioMount.ts — wire the Process Studio panel to live scan state.
 *
 * Keeps two concerns out of the composition root:
 *   1. turning the loose live-scan signals the shell already tracks (kind, point
 *      count, resolved CRS, classification presence, attribute flags) into the
 *      panel's {@link ScanFacts} through the one fail-closed constructor,
 *      {@link deriveScanFacts} — so an unknown signal makes the panel MORE
 *      conservative, never falsely capable; and
 *   2. creating and mounting the panel and handing back one `refresh()` the
 *      caller invokes on any scan change.
 *
 * The composition root hands in the live objects it holds (`viewer`, the scan
 * service, `crsService`, the class legend) through {@link ProcessStudioShell};
 * every read off them, and the fail-closed default behind it, is written here.
 * Structural types keep this module free of three.js and the GPU, so it stays
 * Node-testable: a `null` signal set is the no-scan empty state, and a throwing
 * signal read is caught and treated as no-scan rather than propagating into a
 * scan-change handler.
 *
 * The same refresh also carries the TOOL PREFLIGHT — what limits each tool and
 * what would lift it — and routes the remediation a user picks to a real app
 * action. The model, its input builder and its action bindings ride ONE lazy
 * chunk (`toolPreflightRuntime`), pulled on the first refresh with a scan to
 * reason about; until it lands the panel simply offers nothing. The verdicts
 * stay the model's: nothing here decides.
 */

import { ProcessStudioPanel } from '../ui/ProcessStudioPanel';
import { deriveScanFacts } from '../process/scanFacts';
import type { RawScanSignals } from '../process/scanFacts';
import type { ScanFacts, ProductId } from '../process/ProcessPlan';
import type { CrsInfo } from '../io/crs';
import type { ResolvedCrs } from '../geo/CoordinateTypes';
import type { MeasurementKind } from '../render/measure/types';
import type { PreflightInput } from '../process/toolPreflight';
// TYPE-ONLY, all three: the preflight model, its live-input builder and its
// action bindings ride one lazy chunk, reached through `loadToolPreflight()`.
// A value import here would put the whole model back in the startup shell.
import type { PreflightLiveReads } from './toolPreflightInput';
import type { PreflightActionHost } from './preflightActions';
import type { PreflightActionRunner, PreflightView } from './toolPreflightRuntime';
import { loadToolPreflight } from '../lazyChunks';

/** LAS standard classification codes the panel keys ground/building on. */
const CLASS_GROUND = 2;
const CLASS_BUILDING = 6;

/**
 * Granular reads of the live shell the composition root already holds. Each is
 * a plain getter so this stays Node-testable with fakes and never touches the
 * viewer or GPU directly.
 */
export interface LiveScanAccessors {
  /**
   * True when a streaming source is MOUNTED, whatever it can say about its size.
   * This, not a point total, is what makes the active scan a streaming one: a
   * 3D Tiles tileset states no total (its per-tile figures are decode-admission
   * estimates, so summing them would report a measurement that does not exist),
   * and reading that absence as "no scan" hid a scan that is drawn, pickable
   * and measurable from the capability model.
   */
  hasStreamingSource(): boolean;
  /**
   * The streaming source's SOURCE point total, or null/undefined when the
   * format states none. Never consulted to decide whether a scan is present.
   */
  getStreamingPointCount(): number | null | undefined;
  /** Point count of the active static cloud; null/undefined when none is loaded. */
  getActivePointCount(): number | null | undefined;
  /** The resolved CRS (override applied), or null when unknown — never assumed. */
  getResolvedCrs(): CrsInfo | ResolvedCrs | null | undefined;
  /** Classification codes currently present on the active scan (empty when none). */
  getPresentClassCodes(): readonly number[];
  /** True when the present classification was DERIVED by OLV (heuristic), not
   *  carried by the producer. Distinguishes trusted vs derived ground/buildings. */
  getClassificationDerived(): boolean;
}

/**
 * Build the loose signal set from live accessors, fail-closed. A streaming
 * source wins over a static cloud (it is the active scan when mounted). Returns
 * null when nothing is loaded. Classification is reported as `partial` whenever
 * any class code is present — the conservative floor, never `full` — and ground
 * / building trust follows only from the actual class-2 / class-6 codes.
 *
 * PRESENCE AND SIZE ARE SEPARATE. Whether a scan is loaded comes from the
 * mounted source; how many points it has comes from the format. A format that
 * states no total contributes no `pointCount`, and the signal set carries that
 * absence rather than a stand-in figure.
 */
export function signalsFromLive(a: LiveScanAccessors): RawScanSignals | null {
  const isStreaming = a.hasStreamingSource();
  const streamPts = isStreaming ? a.getStreamingPointCount() : null;
  const staticPts = a.getActivePointCount();
  if (!isStreaming && staticPts == null) return null;
  const codes = a.getPresentClassCodes();
  const hasClasses = codes.length > 0;
  // Provenance: a classification OLV derived is `derived` (heuristic); one the
  // producer carried is `producer` (trusted). This keeps OLV-derived class-2
  // from reading as surveyed ground in the capability model.
  const classificationProvenance = !hasClasses
    ? 'none'
    : (a.getClassificationDerived() ? 'derived' : 'producer');
  const pointCount = isStreaming ? streamPts : staticPts;
  return {
    kind: isStreaming ? 'streaming' : 'static',
    // Omitted, not zeroed, when the source states no total: `RawScanSignals`
    // leaves `pointCount` optional precisely so an unstated size stays unstated.
    ...(pointCount == null ? {} : { pointCount }),
    crs: a.getResolvedCrs() ?? null,
    classification: hasClasses ? 'partial' : 'none',
    classificationProvenance,
    groundClassified: codes.includes(CLASS_GROUND),
    hasBuildingClass: codes.includes(CLASS_BUILDING),
  };
}

export interface ProcessStudioDeps {
  /** Live signals for the active scan, or null when none is loaded. */
  getSignals(): RawScanSignals | null | undefined;
  /**
   * Live reads for the tool preflight. Omitted ⇒ the panel renders no preflight
   * and offers no remediation, which is "nothing to say", never "all ready".
   */
  preflight?: PreflightLiveReads;
  /** What the app can do about a remediation. Omitted ⇒ every action is guidance. */
  actions?: PreflightActionHost;
}

/**
 * Resolve the active scan's facts from the live signals. Returns null when no
 * scan is loaded or the signal read throws — the panel renders its empty state.
 */
export function resolveActiveScanFacts(deps: ProcessStudioDeps): ScanFacts | null {
  let raw: RawScanSignals | null | undefined;
  try {
    raw = deps.getSignals();
  } catch {
    return null;
  }
  return raw ? deriveScanFacts(raw) : null;
}

export interface MountedProcessStudio {
  readonly panel: ProcessStudioPanel;
  /** Re-read live signals and repaint. Safe to call on every scan change. */
  refresh(): void;
  /** Mark products as generated (e.g. DTM + contours after an analysis run). */
  markProduced(ids: readonly ProductId[]): void;
  /** Clear the produced set (e.g. on scan change) so a new scan starts un-produced. */
  clearProduced(): void;
}

/**
 * Create the panel and return it plus a `refresh()` bound to `deps`.
 *
 * The preflight model arrives asynchronously (its chunk is pulled on the first
 * refresh that has live reads to give it) and the panel repaints when it lands.
 * Until then the panel renders the products from the single-scan service alone,
 * with no remediation offered — never a more permissive verdict.
 */
export function createProcessStudio(deps: ProcessStudioDeps): MountedProcessStudio {
  /** The lazy module, once it has landed. */
  let runtime: Awaited<ReturnType<typeof loadToolPreflight>> | null = null;
  let runner: PreflightActionRunner | null = null;
  let loading: Promise<void> | null = null;
  const panel = new ProcessStudioPanel({
    canRemediate: (action, tool) => runner?.canRun(action, tool) === true,
    onRemediate: (action, tool) => { runner?.run(action, tool); },
  });

  /**
   * Single-flight load of the preflight chunk, repainting once it is in. A
   * failed load (a stale chunk after a redeploy is the known case) leaves the
   * panel exactly as it is — no verdict, no remediation — and lets a later
   * refresh try again, rather than rejecting into an unhandled promise.
   */
  function ensureRuntime(): void {
    if (runtime || loading || !deps.preflight) return;
    loading = loadToolPreflight()
      .then((module) => {
        runtime = module;
        runner = module.createPreflightActionRunner(deps.actions ?? {});
        loading = null;
        repaint();
      })
      .catch(() => {
        loading = null;
      });
  }

  const preflight = (): PreflightView | undefined => {
    ensureRuntime();
    return runtime && deps.preflight ? runtime.preflightView(deps.preflight) : undefined;
  };
  function repaint(): void {
    panel.update(resolveActiveScanFacts(deps), preflight());
  }
  panel.update(null);
  // Start hidden: the shell reveals it on scan load (like the class legend) and
  // hides it on scan close, so the boot shell never shows an empty studio.
  panel.hide();
  return {
    panel,
    refresh() {
      repaint();
    },
    markProduced(ids) {
      panel.setProduced(ids);
    },
    clearProduced() {
      panel.setProduced([]);
    },
  };
}

/**
 * The live viewer reads the studio and the preflight need, typed structurally so
 * this module never imports the Viewer (and stays Node-testable with a fake).
 */
export interface StudioViewer {
  /**
   * The mounted streaming source, or null for a static / empty scene. Its
   * PRESENCE is what says a streaming scan is loaded; `sourcePointCount` is
   * null for a format that states no total and is never read as an answer to
   * that question.
   */
  readonly streamingCloud: { readonly sourcePointCount: number | null } | null;
  /** Every loaded static layer's id. */
  clouds(): readonly string[];
  getCloud(id: string):
    | {
        readonly name: string;
        readonly pointCount: number;
        readonly metadata?: { readonly crs?: CrsInfo | null };
      }
    | undefined;
  /** The measure controller — the scene's shared-datum authority. */
  readonly measure: { readonly datumResolved: boolean; setKind(kind: MeasurementKind): void };
  setMeasureMode(on: boolean): void;
}

/**
 * The shell objects the studio and the tool preflight read. Assembling them here
 * rather than in the composition root keeps every live read — and the fail-closed
 * choice behind it — next to the model it feeds.
 */
export interface ProcessStudioShell {
  getViewer(): StudioViewer;
  /** The active STATIC cloud, or null when none is loaded. */
  getActiveCloud(): { readonly pointCount: number } | null | undefined;
  /** The active scan's id (streaming-aware), so companion layers exclude it. */
  getActiveLayerId(): string | null;
  /** The CRS service: the active scan's resolved CRS and its spatial context. */
  crsService: {
    current(): CrsInfo | ResolvedCrs | null;
    context(): PreflightInput['spatial'];
  };
  /** The classification legend — which class codes are present, and their origin. */
  classLegend: {
    presentCodes(): readonly number[];
    classificationIsDerived(): boolean;
  };
  /** Resolve a NON-active layer's CRS the way the Inspector shows it (override applied). */
  resolveLayerCrs(name: string, detected: CrsInfo | null | undefined): CrsInfo | ResolvedCrs | null;
  /** Isolate one layer (the `solo-active-layer` remediation). */
  soloLayer(id: string): void;
  /** Derive classes for the active scan (the `classify-scan` remediation). */
  classifyScan(): void;
  /** Reveal the coordinate-system control (the `set-coordinate-system` remediation). */
  focusCrs(): void;
  /** Reveal the layer list (the `inspect-layer-crs` remediation). */
  focusLayers(): void;
  /** Open the add-a-dataset file picker (the `load-second-scan` remediation). */
  addDataset(): void;
}

/**
 * Every loaded layer except the active one, as loose signals. Each carries only
 * what a cheap read establishes — its kind, its point count and its resolved
 * CRS. Classification is deliberately NOT walked (a full per-point scan per
 * layer, per refresh), so a companion reads as unclassified: the capability
 * model's two-scan products do not consult it, and every other product reads
 * `scans[0]`, the active scan, whose facts are complete.
 */
function companionSignals(shell: ProcessStudioShell): readonly RawScanSignals[] {
  const viewer = shell.getViewer();
  const activeId = shell.getActiveLayerId();
  const out: RawScanSignals[] = [];
  for (const id of viewer.clouds()) {
    if (id === activeId) continue;
    const cloud = viewer.getCloud(id);
    if (!cloud) continue;
    out.push({
      kind: 'static',
      pointCount: cloud.pointCount,
      crs: shell.resolveLayerCrs(cloud.name, cloud.metadata?.crs),
    });
  }
  return out;
}

/**
 * Create the Process Studio and its tool preflight from the live shell — the
 * one call the composition root makes.
 */
export function createProcessStudioFromShell(shell: ProcessStudioShell): MountedProcessStudio {
  const accessors: LiveScanAccessors = {
    hasStreamingSource: () => shell.getViewer().streamingCloud != null,
    getStreamingPointCount: () => shell.getViewer().streamingCloud?.sourcePointCount ?? null,
    getActivePointCount: () => shell.getActiveCloud()?.pointCount ?? null,
    // Resolved CRS (override applied), not raw metadata — Studio agrees with the Inspector (C7).
    getResolvedCrs: () => shell.crsService.current(),
    getPresentClassCodes: () => shell.classLegend.presentCodes(),
    getClassificationDerived: () => shell.classLegend.classificationIsDerived(),
  };
  return createProcessStudio({
    getSignals: () => signalsFromLive(accessors),
    preflight: {
      getActiveSignals: () => signalsFromLive(accessors),
      getSpatialContext: () => shell.crsService.context(),
      getCompanionSignals: () => companionSignals(shell),
      getDatumResolved: () => shell.getViewer().measure.datumResolved,
    },
    actions: {
      openCoordinateSystem: () => shell.focusCrs(),
      inspectLayerCrs: () => shell.focusLayers(),
      soloActiveLayer: () => {
        const id = shell.getActiveLayerId();
        if (id !== null) shell.soloLayer(id);
      },
      classifyScan: () => shell.classifyScan(),
      addDataset: () => shell.addDataset(),
      // Proceeding arms the tool; the figure keeps the exploratory label the
      // measure surfaces already give it, so nothing here re-states the caveat.
      armMeasurement: (kind) => {
        const viewer = shell.getViewer();
        viewer.setMeasureMode(true);
        viewer.measure.setKind(kind);
      },
    },
  });
}
