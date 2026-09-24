/**
 * flowPulseLab.ts — the Field Simulation Lab's Flow Pulse view.
 *
 * Opened from the command palette and loaded on demand: the routing core and
 * this view ride their own chunk, so a session that never asks for a flow run
 * never downloads either.
 *
 * The view decides nothing about the run. `runFlowPulse` owns the order of the
 * steps, the refusals and the wording of every limitation; this module turns
 * the analysed DTM and its frame into the runner's inputs, and turns the
 * runner's answer into rows. Each limitation is shown as the runner wrote it,
 * because a paraphrase is a second statement about the run that nothing tests.
 *
 * Square metres appear only when the basis permits them. The runner already
 * leaves the area null in that case; the view checks `mayReportMetricArea` as
 * well, so a future change to the summary cannot put a metric figure on screen
 * behind a basis that forbids one.
 *
 * ── WHAT THIS MODULE ADDS ON TOP OF THE STATIC CARD ─────────────────────────
 * A CONDITIONING control (raw / conditioned) that re-runs the model; a
 * keyboard- and pointer-accessible 2D result grid standing in for a click on
 * the live scan (`Viewer.ts` has no picking seam this feature can reach
 * without growing the monolith — see `flowResultGrid.ts`); a downstream-path
 * trace and an upstream-catchment trace, drawn on the grid and, when the
 * caller supplies scene membership, in the 3D scene through `FlowOverlay`; and
 * a flow-accumulation overlay, log-scaled, that counts cells rather than
 * water. None of it enters `SimulationRunRecord` — presentation state (which
 * overlay is on, which cell is selected) is not a scientific parameter, and
 * `FlowPulseParams` carries none of it.
 */

import { el } from '../dom';
import { openModal, type ModalHandle } from '../Modal';
import {
  FLOW_PULSE_DEFAULTS,
  runFlowPulse,
  type FlowConditioning,
  type FlowPulseParams,
  type FlowPulseResult,
  type FlowRefusal,
} from '../../simulation/flowPulse/flowPulseRunner';
import { catchmentClick, traceClick, type FlowCatchmentTrace, type FlowClickRefusal, type FlowPathTrace } from '../../simulation/flowPulse/flowClickGuard';
import {
  cellAnnouncement,
  statusLabel,
  type ElevationReference,
  type GridCell,
} from '../../simulation/flowPulse/flowGridCursor';
import { verticalUnitLabel } from '../../units/units';
import { mayReportMetricArea } from '../../simulation/simulationInputBasis';
import { dtmProductDigest } from '../../science/dtmProductDigest';
import { dtmMethodDigest, resolveLiveDtmDescriptor } from '../../science/liveDtmDescriptor';
import { buildIdentityProvenance } from '../../build/buildIdentity';
import { FlowResultGrid, maskFromIndices } from './flowResultGrid';
import {
  buildFlowAccumulationBuffers,
  buildFlowCatchmentBuffers,
  buildFlowPathBuffers,
  flowOverlayFrame,
  type FlowOverlayFrame,
} from '../../render/flowOverlayGeometry';
import { FlowOverlay, type FlowOverlayHost } from '../../render/FlowOverlay';
import type { HorizontalScale } from '../../simulation/flowPulse/dtmFlowGrid';
import type { AnalyseContoursResult } from '../../terrain/contour/analyseContours';
import { loadFlowPulsePackage, registerFlowOverlayInvalidator } from '../../lazyChunks';
import { downloadBytes } from '../../io/download';
import type { buildFlowPulsePackage } from '../../export/flowPulsePackage';

/** The analysed surface and the frame facts the Analyse panel holds for it. */
export interface FlowPulseLabInput {
  readonly result: AnalyseContoursResult;
  readonly isGeographic: boolean;
  /** World Y of the load-time recentring origin; null when the scene has no single one. */
  readonly worldOriginY: number | null;
  /**
   * World X and Z of the same load-time recentring origin, for the export
   * package's real corner and the result grid's real elevation readout.
   * Null under the same conditions `worldOriginY` is.
   */
  readonly worldOriginX?: number | null;
  readonly worldOriginZ?: number | null;
  /** The active CRS's WKT, for the export package's .prj sidecar; null when unresolved. */
  readonly wkt?: string | null;
  /** A human-readable CRS label for the export README/passport; null when unresolved. */
  readonly crsName?: string | null;
  /** Metres per source unit from the resolved frame; null when unknown. */
  readonly resolvedUnitToMetres: number | null;
  readonly layerId: string | null;
  readonly filename: string | null;
  /**
   * The scan's raw scene up-axis ('z' for the survey formats, 'y' for a Y-up
   * mesh) — the same fact `getMapContext().sceneUpAxis` already carries for
   * the map sheet. Absent/null defaults to 'z', correct for every
   * georeferenced case. Only used to place the optional 3D overlay.
   */
  readonly sceneUpAxis?: 'z' | 'y' | null;
  /**
   * Scene membership for the 3D flow overlay — `Viewer.derivedLayerHost()`
   * shaped. Absent/null: the accumulation overlay, the drawn path and the
   * drawn catchment are simply not offered in 3D; the 2D result grid still
   * carries every interaction.
   */
  readonly overlayHost?: FlowOverlayHost | null;
  /**
   * Whether the terrain behind this input has changed since it was captured —
   * evaluated fresh at the moment of each click, not cached. Absent means the
   * caller does not track this and a click is never refused as stale.
   */
  readonly isStale?: () => boolean;
}

/**
 * The horizontal scale the DTM was built under.
 *
 * On a geographic frame the latitude is the grid centre in world coordinates,
 * which needs the world origin. The map context leaves that origin undefined
 * when the scene has more than one origin or a layer has been placed, and in
 * that case the latitude is unknown: the scale reports null and the runner
 * refuses. Reading a missing origin as zero would put a site at 60° N on the
 * equator, route with cos φ ≈ 1 and roughly double every area. A projected
 * frame needs no latitude and is unaffected.
 *
 * `cellSizeM` is in source units despite its name: degrees on a geographic frame.
 */
export function flowScaleOf(input: FlowPulseLabInput): HorizontalScale {
  const dtm = input.result.dtm;
  const latitudeDeg = input.isGeographic && input.worldOriginY != null
    ? input.worldOriginY + dtm.originH2 + (dtm.rows / 2) * dtm.cellSizeM
    : null;
  const latitudeKnown = latitudeDeg != null && Number.isFinite(latitudeDeg);
  return {
    isGeographic: input.isGeographic,
    latitudeDeg: latitudeKnown ? latitudeDeg : null,
    unitToMetres: input.resolvedUnitToMetres ?? 1,
    resolved: input.result.horizontalScaleResolved && (!input.isGeographic || latitudeKnown),
  };
}

/**
 * How to recover a real elevation from the routed grid's local z, the same
 * rule `demPackage.ts` uses for the DTM/DSM rasters: the DTM's own claimed
 * vertical factor, gated on the result's own statement that the vertical
 * scale actually resolved — never the geometry placeholder a CRS-less scan
 * pins to 1, which would print "metres" for a frame whose own provenance
 * says the vertical unit is unverified.
 */
export function flowElevationReference(input: FlowPulseLabInput): ElevationReference {
  const zFactor = input.result.verticalScaleResolved === false
    ? null
    : (input.result.dtm.verticalUnitToMetres ?? null);
  const unitLabel = zFactor == null ? 'units' : verticalUnitLabel(zFactor);
  return { originZ: input.worldOriginZ ?? null, unitLabel };
}

/** Stand-ins for a run that refuses before it reads a frame or an identity. */
const NO_FRAME: HorizontalScale = {
  isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: false,
};
const NO_IDENTITY = {
  layerId: null, filename: null, sourceDigest: null, analysisInputDigest: '',
  build: '', id: '', generatedAt: '', processingManifestHead: null,
} as const;

/**
 * Run Flow Pulse on the analysed surface, or report that there is none.
 * `conditioning` defaults to {@link FLOW_PULSE_DEFAULTS}'s (raw), so an
 * existing single-argument call keeps its prior behaviour exactly.
 */
export function runLabFlowPulse(
  input: FlowPulseLabInput | null,
  conditioning: FlowConditioning = FLOW_PULSE_DEFAULTS.conditioning,
): FlowPulseResult | FlowRefusal {
  const params: FlowPulseParams = { ...FLOW_PULSE_DEFAULTS, conditioning };
  if (!input) {
    return runFlowPulse(null, NO_FRAME, params, NO_IDENTITY);
  }
  const dtm = input.result.dtm;
  return runFlowPulse(dtm, flowScaleOf(input), params, {
    layerId: input.layerId,
    filename: input.filename,
    sourceDigest: null,
    // A getter, because the runner reads the digest only when it seals a
    // record. A refused run then never hashes the grid it declined to read.
    get analysisInputDigest() { return dtmProductDigest(dtm); },
    // Digest of the terrain-core method that built this DTM, so the run
    // record binds the method as well as the exact grid it read.
    get terrainCoreDigest() { return dtmMethodDigest(resolveLiveDtmDescriptor()); },
    // The full build identity, not the bare version, so a record names the
    // exact build that produced it, dirty working tree included: the same
    // string export provenance already quotes verbatim.
    build: buildIdentityProvenance(),
    id: globalThis.crypto?.randomUUID?.() ?? `flow-${Date.now()}`,
    generatedAt: new Date().toISOString(),
    processingManifestHead: null,
  }, flowElevationReference(input).unitLabel);
}

/** Result of {@link buildFlowPulseExport}: the bytes and filename to download, or a refusal reason. */
export type FlowPulseExportOutcome =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly filename: string }
  | { readonly ok: false; readonly reason: string };

/**
 * The real-world placement facts the export package needs to georeference
 * its rasters — the same `worldOrigin`/`wkt`/`crsName` the DEM package
 * already reads off `getMapContext()`. All null when the scene has no
 * single resolved origin or CRS, in which case the package writes a local
 * (0, 0) origin and no .prj, and says so in its README.
 */
export interface FlowPulseGeoref {
  readonly worldOrigin: { readonly x: number; readonly y: number } | null;
  readonly crsName: string | null;
  readonly wkt: string | null;
  /** See {@link runFlowPulse}'s parameter of the same name. Defaults to `'units'`. */
  readonly verticalUnitLabel?: 'm' | 'ft' | 'units';
}

/**
 * Build the export package from the CURRENT run, refusing on a stale result
 * or a run that never completed. Pure and DOM-free so it is unit-testable
 * without loading the (lazy) package-builder chunk it is handed by the
 * caller — `buildFlowPulsePackage` is passed in rather than imported here,
 * which keeps this module out of the eager chunk graph.
 */
export function buildFlowPulseExport(
  outcome: FlowPulseResult | FlowRefusal,
  stale: boolean,
  path: FlowPathTrace | FlowClickRefusal | null,
  catchment: FlowCatchmentTrace | FlowClickRefusal | null,
  filename: string | null,
  layerId: string | null,
  build: typeof buildFlowPulsePackage,
  georef: FlowPulseGeoref | null = null,
): FlowPulseExportOutcome {
  if (!outcome.ok) {
    return { ok: false, reason: 'Flow Pulse has not produced a run to export.' };
  }
  if (stale) {
    return { ok: false, reason: 'the result is stale; rerun Flow Pulse before exporting.' };
  }
  const pathInput = path && path.ok ? { cells: path.path } : null;
  const catchmentInput = catchment && catchment.ok
    ? { mask: catchment.mask, outletCell: catchment.cell.row * outcome.grid.cols + catchment.cell.col }
    : null;
  const basename = filename ?? layerId ?? 'flow-pulse';
  const bytes = build(outcome, {
    basename,
    path: pathInput,
    catchment: catchmentInput,
    worldOrigin: georef?.worldOrigin ?? null,
    crsName: georef?.crsName ?? null,
    wkt: georef?.wkt ?? null,
    verticalUnitLabel: georef?.verticalUnitLabel ?? 'units',
  });
  return { ok: true, bytes, filename: `${basename}-flow-pulse.zip` };
}

function row(label: string, value: string): HTMLElement {
  return el('div', { className: 'olv-story-row' }, [
    el('span', { className: 'olv-story-k', text: label }),
    el('span', { className: 'olv-story-v', text: value }),
  ]);
}

/** The run's answer as a card: a refusal's reason, or the figures and every limitation. */
export function renderFlowPulseLab(outcome: FlowPulseResult | FlowRefusal): HTMLElement {
  const card = el('aside', { className: 'olv-story-card' });
  if (!outcome.ok) {
    card.append(
      el('div', { className: 'olv-story-headline', text: 'Flow Pulse did not run' }),
      el('div', { className: 'olv-story-next', text: outcome.reason }),
    );
    return card;
  }

  const s = outcome.summary;
  const metric = mayReportMetricArea(outcome.basis) && s.maxContributingAreaM2 != null;
  card.append(
    el('div', { className: 'olv-story-headline', text: 'D8 flow routing over the analysed DTM' }),
    row('Method', outcome.record.methods.join(' → ')),
    row('Cells routed', `${s.readableCells} of ${s.cells}`),
    row('Outlets', String(s.outletCount)),
    row('Sinks', String(s.sinkCount)),
    row('Flats', String(s.flatCount)),
    row('Largest upstream count', `${s.maxUpstreamCells} cells`),
    row(
      'Largest contributing area',
      metric ? `${s.maxContributingAreaM2!.toFixed(1)} m²` : 'Withheld: the horizontal scale is not resolved',
    ),
  );
  const list = el('ul', { className: 'olv-story-v' });
  for (const sentence of outcome.limitations) list.append(el('li', { text: sentence }));
  card.append(el('span', { className: 'olv-story-k', text: 'Limitations' }), list);
  return card;
}

// ── interactive layer ───────────────────────────────────────────────────────

type ClickMode = 'pulse' | 'catchment';

function button(text: string, className: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = text;
  return b;
}

function makeRetryButton(onRetry: () => void): HTMLButtonElement {
  const b = button('Retry', 'olv-flow-retry');
  b.addEventListener('click', onRetry);
  return b;
}

/** A `role="group"` of `aria-pressed` toggle buttons, single-choice. */
function segmentedControl<T extends string>(
  ariaLabel: string,
  groupClassName: string,
  btnClassName: string,
  options: ReadonlyArray<{ value: T; label: string }>,
  current: () => T,
  onSelect: (value: T) => void,
): { element: HTMLElement; sync: () => void } {
  const group = el('div', { className: groupClassName, ariaLabel });
  group.setAttribute('role', 'group');
  const buttons = options.map((opt) => {
    const b = button(opt.label, btnClassName);
    b.dataset.value = opt.value;
    b.addEventListener('click', () => onSelect(opt.value));
    return b;
  });
  group.append(...buttons);
  const sync = (): void => {
    const cur = current();
    for (const b of buttons) b.setAttribute('aria-pressed', b.dataset.value === cur ? 'true' : 'false');
  };
  sync();
  return { element: group, sync };
}

function liveRegion(): HTMLElement {
  // `olv-visually-hidden` (shared utility): visible to a screen reader, not
  // to the eye. A live region silenced by `display:none` never announces, so
  // this is the clip-based hide pattern rather than that one.
  const node = el('div', { className: 'olv-flow-live olv-visually-hidden' });
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  return node;
}

/** One sentence describing a click/outlet refusal, for the selection panel and the live region. */
function refusalSentence(kind: 'path' | 'catchment', refusal: FlowClickRefusal): string {
  const noun = kind === 'path' ? 'Trace' : 'Catchment';
  return `${noun} not drawn — ${refusal.reason}`;
}

/**
 * The 3D accumulation overlay (and the traced path/catchment beside it)
 * outlives the modal that built it: the Lab's own scene layer is the only
 * place a user can SEE flow accumulation, and disposing it the instant the
 * modal — which covers the scene — closes meant nobody ever saw it.
 * `derivedLayerHost()` returns a fresh object literal on every call
 * (it closes over the one Viewer scene, not a per-call state), so identity
 * cannot key this; the one Viewer in this application has exactly one
 * scene, so a single module-level session — kept until the user turns the
 * overlay off, or the terrain/CRS it was built from goes stale — is the
 * smallest correct home for it, matching the "one Lab, one scan" scope
 * `§17`'s fieldDigest isolation already assumes.
 */
let persistentFlowOverlay: {
  readonly overlay: FlowOverlay;
  /** Re-pointed to the CURRENT mount's staleness check on every open. */
  isStale: (() => boolean) | null;
  overlayOn: boolean;
} | null = null;

/**
 * The overlay for this mount: the persisted one, when it exists and its
 * terrain/CRS have not gone stale, else a fresh one. A stale persisted
 * overlay is disposed here rather than left attached to a scene whose
 * frame it no longer describes.
 */
export function acquireFlowOverlay(
  host: FlowOverlayHost | null,
  isStale: (() => boolean) | null,
): FlowOverlay | null {
  if (!host) return null;
  if (persistentFlowOverlay && persistentFlowOverlay.isStale?.() === true) {
    persistentFlowOverlay.overlay.dispose();
    persistentFlowOverlay = null;
  }
  if (!persistentFlowOverlay) {
    persistentFlowOverlay = { overlay: new FlowOverlay(host), isStale, overlayOn: false };
  } else {
    persistentFlowOverlay.isStale = isStale;
  }
  return persistentFlowOverlay.overlay;
}

/**
 * Unconditionally dispose the persisted overlay, when one exists. Exported
 * so `registerFlowOverlayInvalidator` (see `lazyChunks.ts`) can hand this to
 * every eager caller that clears the cached terrain core — a scan closing,
 * a different scan loading, a CRS change, or a classification edit — none
 * of which reopens the Lab to trigger the `isStale()` check `acquireFlowOverlay`
 * makes on its own. The event itself IS the staleness signal here, so no
 * predicate is re-checked; the caller already knows the terrain core it was
 * drawn from is gone. Idempotent: a second call with nothing to dispose is a
 * no-op.
 */
export function disposePersistentFlowOverlay(): void {
  if (!persistentFlowOverlay) return;
  persistentFlowOverlay.overlay.dispose();
  persistentFlowOverlay = null;
}

// Registered once, at module load (i.e. the first time this chunk actually
// loads — opening the Lab, or its export action). `registerFlowOverlayInvalidator`
// stores this closure in the tiny eager module `lazyChunks.ts`, which
// `terrainAnalysisRunner.ts` already calls on every terrain-cache-clearing
// event, without importing this (lazy) module itself.
registerFlowOverlayInvalidator(disposePersistentFlowOverlay);

/**
 * The interactive Flow Pulse view: the static summary card plus every control
 * that reads or re-runs it. Owns one `FlowResultGrid` for the modal's own
 * lifetime and shares the persisted `FlowOverlay` (see {@link acquireFlowOverlay}).
 * `dispose()` releases the grid's resources unconditionally, and the overlay's
 * only when the user left it OFF — an overlay the user turned on stays drawn
 * on the scan after the modal closes, with the toggle itself the visible way
 * to turn it back off (reopening the Lab shows it already pressed).
 */
function mountFlowPulseInteractive(
  input: FlowPulseLabInput,
  initialOutcome: FlowPulseResult | FlowRefusal,
): { element: HTMLElement; dispose: () => void } {
  const root = el('div', { className: 'olv-flow-lab' });
  const live = liveRegion();
  const body = el('div', { className: 'olv-flow-body' });
  root.append(live, body);
  const announce = (msg: string): void => { live.textContent = msg; };

  let conditioning: FlowConditioning = FLOW_PULSE_DEFAULTS.conditioning;
  let outcome = initialOutcome;
  let mode: ClickMode = 'pulse';
  let busy = false;
  let overlayFrame: FlowOverlayFrame | null = null;
  let lastTrace: FlowPathTrace | FlowClickRefusal | null = null;
  let lastCatchment: FlowCatchmentTrace | FlowClickRefusal | null = null;

  const overlayHost = input.overlayHost ?? null;
  const flowOverlay = acquireFlowOverlay(overlayHost, input.isStale ?? null);
  // Reflects whatever the persisted overlay is already showing: reopening
  // the Lab after leaving the overlay on picks the toggle back up in the
  // "on" state rather than forgetting it was ever shown.
  let overlayOn = persistentFlowOverlay?.overlayOn ?? false;

  const grid = new FlowResultGrid({
    ariaLabel: 'Routed terrain grid — arrow keys move, Enter or Space acts on the selected cell',
    onMove: (_cell: GridCell, report) => announce(cellAnnouncement(report)),
    onActivate: (cell: GridCell) => handleActivate(cell),
    elevationRef: flowElevationReference(input),
  });

  const conditioningCtl = segmentedControl<FlowConditioning>(
    'Terrain conditioning',
    'olv-flow-cond',
    'olv-flow-cond-btn',
    [
      { value: 'raw', label: 'Raw terrain' },
      { value: 'priority-flood', label: 'Priority-Flood conditioned' },
    ],
    () => conditioning,
    (value) => { if (value !== conditioning && !busy) void rerun(value); },
  );

  const modeCtl = segmentedControl<ClickMode>(
    'What a selected cell does',
    'olv-flow-mode',
    'olv-flow-mode-btn',
    [
      { value: 'pulse', label: 'Trace downstream path' },
      { value: 'catchment', label: 'Set catchment outlet' },
    ],
    () => mode,
    (value) => { mode = value; modeCtl.sync(); renderSelection(); },
  );

  const overlayToggle = button('Show flow accumulation', 'olv-flow-overlay-toggle');
  overlayToggle.setAttribute('aria-pressed', overlayOn ? 'true' : 'false');
  overlayToggle.addEventListener('click', () => {
    overlayOn = !overlayOn;
    if (persistentFlowOverlay) persistentFlowOverlay.overlayOn = overlayOn;
    overlayToggle.setAttribute('aria-pressed', overlayOn ? 'true' : 'false');
    applyOverlayVisibility();
    announce(overlayOn ? 'Flow accumulation overlay on.' : 'Flow accumulation overlay off.');
  });
  const overlayLegend = el('div', {
    className: 'olv-flow-overlay-legend',
    text: 'Log-scaled: brighter means more cells drain through that point. It counts cells, not water.',
  });
  const overlayUnavailable = el('div', {
    className: 'olv-flow-overlay-unavailable',
    text: 'The 3D accumulation overlay is not available in this view; the result grid below still traces paths and catchments.',
  });

  const selectionPanel = el('div', { className: 'olv-flow-selection' });

  function applyOverlayVisibility(): void {
    if (!flowOverlay) return;
    if (overlayOn && outcome.ok && overlayFrame) {
      flowOverlay.setAccumulation(
        buildFlowAccumulationBuffers(outcome.grid, outcome.routed, outcome.accumulation, overlayFrame),
      );
      flowOverlay.setAccumulationVisible(true);
    } else {
      flowOverlay.setAccumulationVisible(false);
    }
  }

  function clearSelectionDrawing(): void {
    grid.setPathMask(null);
    grid.setCatchmentMask(null);
    flowOverlay?.clearPath();
    flowOverlay?.clearCatchment();
  }

  function renderSelection(): void {
    selectionPanel.replaceChildren();
    if (!outcome.ok) return;
    const current = mode === 'pulse' ? lastTrace : lastCatchment;
    if (!current) {
      selectionPanel.append(el('div', {
        className: 'olv-flow-selection-empty',
        text: mode === 'pulse'
          ? 'Click a cell, or move the cursor and press Enter, to trace its downstream path.'
          : 'Click a cell, or move the cursor and press Enter, to set it as a catchment outlet.',
      }));
      return;
    }
    if (!current.ok) {
      selectionPanel.append(el('div', {
        className: 'olv-flow-selection-error',
        text: refusalSentence(mode === 'pulse' ? 'path' : 'catchment', current),
      }));
      return;
    }
    if (mode === 'pulse') {
      const t = current as FlowPathTrace;
      selectionPanel.append(
        row('Path cells', String(t.path.length)),
        row('Ends at', statusLabel(t.endStatus)),
      );
    } else {
      const c = current as FlowCatchmentTrace;
      const areaKnown = mayReportMetricArea(outcome.basis);
      const areaM2 = areaKnown ? c.cells * outcome.grid.cellMetresX * outcome.grid.cellMetresY : null;
      selectionPanel.append(
        row('Contributing cells', String(c.cells)),
        row(
          'Contributing area',
          areaM2 != null ? `${areaM2.toFixed(1)} m²` : 'Withheld: the horizontal scale is not resolved',
        ),
      );
    }
  }

  function handleActivate(cell: GridCell): void {
    if (!outcome.ok || busy) return;
    try {
      const stale = input.isStale?.() ?? false;
      if (mode === 'pulse') {
        const trace = traceClick(outcome, cell, stale);
        lastTrace = trace;
        if (trace.ok) {
          grid.setPathMask(maskFromIndices(outcome.grid.cols * outcome.grid.rows, trace.path));
          if (flowOverlay && overlayFrame) {
            flowOverlay.setPath(buildFlowPathBuffers(outcome.grid, trace.path, overlayFrame));
          }
          announce(`Path traced: ${trace.path.length} cell(s).`);
        } else {
          grid.setPathMask(null);
          flowOverlay?.clearPath();
          announce(refusalSentence('path', trace));
        }
      } else {
        const trace = catchmentClick(outcome, cell, stale);
        lastCatchment = trace;
        if (trace.ok) {
          grid.setCatchmentMask(trace.mask);
          if (flowOverlay && overlayFrame) {
            flowOverlay.setCatchment(buildFlowCatchmentBuffers(outcome.grid, trace.mask, overlayFrame));
          }
          announce(`Catchment traced: ${trace.cells} cell(s).`);
        } else {
          grid.setCatchmentMask(null);
          flowOverlay?.clearCatchment();
          announce(refusalSentence('catchment', trace));
        }
      }
      renderSelection();
    } catch (err) {
      showError(err);
    }
  }

  const exportButton = button('Export package (ZIP)', 'olv-flow-export');
  let exportBusy = false;

  async function handleExport(): Promise<void> {
    if (!outcome.ok || busy || exportBusy) return;
    const exportLabel = exportButton.textContent ?? 'Export package (ZIP)';
    exportBusy = true;
    exportButton.disabled = true;
    exportButton.textContent = 'Building…';
    try {
      const { buildFlowPulsePackage } = await loadFlowPulsePackage();
      const built = buildFlowPulseExport(
        outcome,
        input.isStale?.() ?? false,
        lastTrace,
        lastCatchment,
        input.filename,
        input.layerId,
        buildFlowPulsePackage,
        {
          worldOrigin: input.worldOriginX != null && input.worldOriginY != null
            ? { x: input.worldOriginX, y: input.worldOriginY }
            : null,
          crsName: input.crsName ?? null,
          wkt: input.wkt ?? null,
          verticalUnitLabel: flowElevationReference(input).unitLabel,
        },
      );
      if (!built.ok) {
        announce(`Export refused — ${built.reason}`);
        return;
      }
      downloadBytes(built.filename, built.bytes, 'application/zip');
      announce('Flow Pulse package downloaded.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      exportButton.replaceWith(
        (() => {
          const panel = el('div', { className: 'olv-flow-export-error' }, [
            el('span', { className: 'olv-flow-export-error-text', text: `Export failed: ${msg}` }),
            makeRetryButton(() => { panel.replaceWith(exportButton); void handleExport(); }),
          ]);
          return panel;
        })(),
      );
      announce(`Export failed: ${msg}`);
    } finally {
      exportBusy = false;
      exportButton.disabled = false;
      exportButton.textContent = exportLabel;
    }
  }

  exportButton.addEventListener('click', () => void handleExport());

  function showError(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    const panel = el('div', { className: 'olv-flow-error' }, [
      el('div', { className: 'olv-flow-error-text', text: `Something went wrong: ${msg}` }),
      makeRetryButton(() => void rerun(conditioning)),
    ]);
    body.replaceChildren(panel);
    announce(`Something went wrong: ${msg}`);
  }

  function renderReady(): void {
    const staticCard = renderFlowPulseLab(outcome);
    if (!outcome.ok) {
      body.replaceChildren(staticCard, makeRetryButton(() => void rerun(conditioning)));
      return;
    }

    const dtm = input.result.dtm;
    overlayFrame = flowOverlayFrame(input.sceneUpAxis, dtm.originH1, dtm.originH2, dtm.cellSizeM);
    grid.load(outcome.grid, outcome.routed, outcome.accumulation, outcome.contributingAreaM2);
    lastTrace = null;
    lastCatchment = null;
    clearSelectionDrawing();
    renderSelection();
    applyOverlayVisibility();

    const overlaySection = el('div', { className: 'olv-flow-overlay-section' }, [
      overlayHost ? overlayToggle : overlayUnavailable,
      overlayLegend,
    ]);

    body.replaceChildren(
      staticCard,
      conditioningCtl.element,
      modeCtl.element,
      grid.element,
      selectionPanel,
      overlaySection,
      exportButton,
    );
  }

  async function rerun(next: FlowConditioning): Promise<void> {
    conditioning = next;
    conditioningCtl.sync();
    busy = true;
    body.replaceChildren(el('div', { className: 'olv-flow-busy', text: 'Running Flow Pulse…' }));
    announce('Running Flow Pulse…');
    // One frame so the busy state actually paints before the (synchronous)
    // run computes — matters most on the largest grids this feature allows.
    await new Promise<void>((resolve) => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
      else setTimeout(resolve, 0);
    });
    try {
      outcome = runLabFlowPulse(input, conditioning);
      busy = false;
      renderReady();
      announce(outcome.ok ? 'Flow Pulse run complete.' : `Flow Pulse did not run: ${outcome.reason}`);
    } catch (err) {
      busy = false;
      showError(err);
    }
  }

  renderReady();

  return {
    element: root,
    // An overlay the user left ON stays attached to the scene — only an
    // overlay left OFF (nothing visible to keep) is torn down here,
    // matching the disposal-registry contract for the "off" case exactly as
    // before. `persistentFlowOverlay` itself is not cleared in the "on"
    // case: the next Lab open reclaims the SAME instance via
    // `acquireFlowOverlay`, rather than constructing a second one that would
    // leave the first orphaned in the scene.
    dispose: () => {
      if (!overlayOn && persistentFlowOverlay) {
        persistentFlowOverlay.overlay.dispose();
        persistentFlowOverlay = null;
      }
    },
  };
}

/** Run and show Flow Pulse in a dialog. */
export function openFlowPulseLab(input: FlowPulseLabInput | null): ModalHandle {
  if (!input) {
    const body = el('div', { className: 'olv-flow-lab' }, [renderFlowPulseLab(runLabFlowPulse(null))]);
    return openModal({ title: 'Field Simulation Lab: Flow Pulse', body });
  }
  const interactive = mountFlowPulseInteractive(input, runLabFlowPulse(input));
  return openModal({
    title: 'Field Simulation Lab: Flow Pulse',
    body: interactive.element,
    onClose: () => interactive.dispose(),
  });
}
