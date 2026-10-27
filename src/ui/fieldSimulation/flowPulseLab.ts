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
 * a flow-accumulation overlay, a log-scaled drainage network, that counts cells rather than
 * water. None of it enters `SimulationRunRecord` — presentation state (which
 * overlay is on, which cell is selected) is not a scientific parameter, and
 * `FlowPulseParams` carries none of it.
 */

import type { ExportDigests } from '../../science/exportDigestRecord';
import type { SourceInterpretationRecord } from '../../science/sourceInterpretation';
import { showBusyScan } from '../busyScan';
import { el } from '../dom';
import type { ModalHandle } from '../Modal';
import { openLabSurface } from '../labSurface';
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
import { FlowResultGrid, flowGridLegend, maskFromIndices } from './flowResultGrid';
import { labStatRow } from './labStats';
import { prefersReducedMotion } from './labColormaps';
import {
  howToRead, labDetails, labHeader, methodDetails, needsGround, preparingGround, readinessList, statusChip, type ChipFacts,
} from '../labGuide';
import { labReadiness } from '../../process/labGuideCopy';
import { flowTerrainBannerText, flowTerrainCaveat, type FlowTerrainCaveat } from '../../process/flowTerrainCaveat';
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
import { loadFlowPulsePackage, loadWatershedGif, registerFlowOverlayInvalidator } from '../../lazyChunks';
import { downloadBytes } from '../../io/download';
import { labRun, publishLabRun, takeResultReopen } from '../../app/results/resultSignals';
import type { buildFlowPulsePackage, FlowGridFrame } from '../../export/flowPulsePackage';
import type { WatershedFacts, WatershedGifInput } from '../../export/watershedGif';
import { edgeContamination, EDGE_CONTAMINATED_NOTE, type EdgeContamination } from '../../simulation/flowPulse/edgeContamination';
import { POUR_POINT_SNAP_RADIUS_CELLS, snapPourPoint } from '../../simulation/flowPulse/pourPointSnap';
import {
  DISPLAY_THRESHOLD_M3S, PEAK_FLOW_WITHHELD, RAINFALL_DEFAULT, areaLimitWarning, flowDisplayField, peakFlowEstimate,
  peakFlowText, rationalAssumptions, settingText, type PeakFlowEstimate, type RainfallSetting,
} from '../../simulation/flowPulse/rationalDischarge';
import { buildRainfallControl } from './flowRainfallControl';
import { flowDischargeLegend, hillshade, type ActivationSource, type FlowChannelField } from './flowResultGrid';
import { buildIdentityLabel } from '../../build/buildIdentity';
import { channelMinCount, isChannel, logScale } from '../../render/flowOverlayGeometry';
import { CELL_NODATA } from '../../simulation/flowPulse/flowTypes';
import { overlayRegistry } from '../../app/overlayRegistry';

/** The analysed surface and the frame facts the Analyse panel holds for it. */
export interface FlowPulseLabInput {
  /** Source-file digest and CRS origin for the export package, resolved on export. */
  readonly exportDigests?: () => Promise<ExportDigests>;
  /** Probe interpretation level and data basis of the analysed scan, for export provenance. */
  readonly sourceInterpretation?: SourceInterpretationRecord;
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
    // Direction needs only the ratio of the two axes, so a missing unit routes
    // at 1; square metres need the unit itself, so they are withheld without it.
    unitToMetres: input.resolvedUnitToMetres ?? 1,
    resolved: input.result.horizontalScaleResolved && input.resolvedUnitToMetres != null
      && (!input.isGeographic || latitudeKnown),
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
 * `conditioning` defaults to {@link FLOW_PULSE_DEFAULTS}'s (Priority-Flood).
 */
export function runLabFlowPulse(
  input: FlowPulseLabInput | null,
  conditioning: FlowConditioning = FLOW_PULSE_DEFAULTS.conditioning,
): FlowPulseResult | FlowRefusal {
  // A display sample's DTM spans the extent, so its grid reads 'full'; the
  // scan's own data basis says what was read.
  const sampled = input?.sourceInterpretation?.dataBasis === 'sampled';
  const params: FlowPulseParams = {
    ...FLOW_PULSE_DEFAULTS,
    conditioning,
    ...(sampled ? { inputCoverage: 'sampled' as const } : {}),
  };
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
 * (0, 0) origin and no .prj, and says so in its README. A WKT or CRS name
 * without a world origin (open layers whose origins disagree) is not placed
 * either: the package writes no .prj and marks the CRS as not applied.
 */
export interface FlowPulseGeoref {
  readonly digests?: ExportDigests | null;
  /** Probe interpretation level and data basis of the analysed scan, for export provenance. */
  readonly sourceInterpretation?: SourceInterpretationRecord;
  readonly worldOrigin: { readonly x: number; readonly y: number } | null;
  readonly crsName: string | null;
  readonly wkt: string | null;
  /** See {@link runFlowPulse}'s parameter of the same name. Defaults to `'units'`. */
  readonly verticalUnitLabel?: 'm' | 'ft' | 'units';
  /** World Z of the load-time recentring origin, so exported elevations match the readout. */
  readonly elevationOrigin?: number | null;
  /** The terrain verdict and interpolated share, when the surface is Blocked or Preview. */
  readonly terrainCaveat?: FlowTerrainCaveat | null;
  /** The DTM's raster corner offset and cell size, in source units. */
  readonly gridFrame?: FlowGridFrame | null;
}

/**
 * The georef an export of `input` carries: the world origin, the CRS name and
 * WKT (for the `.prj`), the vertical unit and origin, and the terrain caveat.
 */
export function flowPulseGeorefOf(input: FlowPulseLabInput, digests: ExportDigests | null): FlowPulseGeoref {
  return {
    worldOrigin: input.worldOriginX != null && input.worldOriginY != null
      ? { x: input.worldOriginX, y: input.worldOriginY }
      : null,
    crsName: input.crsName ?? null,
    wkt: input.wkt ?? null,
    verticalUnitLabel: flowElevationReference(input).unitLabel,
    elevationOrigin: input.worldOriginZ ?? null,
    terrainCaveat: flowTerrainCaveat(input.result.quality),
    gridFrame: {
      originH1: input.result.dtm.originH1,
      originH2: input.result.dtm.originH2,
      cellSize: input.result.dtm.cellSizeM,
    },
    sourceInterpretation: input.sourceInterpretation,
    digests,
  };
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
  extras: { readonly rainfall?: RainfallSetting | null; readonly snappedFrom?: number | null } = {},
): FlowPulseExportOutcome {
  if (!outcome.ok) {
    return { ok: false, reason: 'Flow Pulse has not produced a run to export.' };
  }
  if (stale) {
    return { ok: false, reason: 'the result is stale; rerun Flow Pulse before exporting.' };
  }
  const pathInput = path && path.ok ? { cells: path.path } : null;
  const catchmentInput = catchment && catchment.ok
    ? {
      mask: catchment.mask,
      outletCell: catchment.cell.row * outcome.grid.cols + catchment.cell.col,
      snappedFrom: extras.snappedFrom ?? null,
    }
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
    elevationOrigin: georef?.elevationOrigin ?? null,
    terrainCaveat: georef?.terrainCaveat ?? null,
    gridFrame: georef?.gridFrame ?? null,
    verticalResolved: (georef?.verticalUnitLabel ?? 'units') !== 'units',
    sourceInterpretation: georef?.sourceInterpretation ?? null,
    digests: georef?.digests ?? null,
    rainfall: extras.rainfall ?? null,
  });
  return { ok: true, bytes, filename: `${basename}-flow-pulse.zip` };
}

// ── edge contamination, rainfall and the watershed GIF ─────────────────────

/** The cell with the largest upstream count (the lowest index on a tie). */
export function largestDrainageCell(outcome: FlowPulseResult): number {
  const up = outcome.accumulation.upstreamCells;
  let best = 0;
  for (let i = 1; i < up.length; i++) if (up[i]! > up[best]!) best = i;
  return best;
}

/** Square metres for `cells` cells, or null when the basis forbids a metric area. */
export function areaOfCells(outcome: FlowPulseResult, cells: number): number | null {
  if (!mayReportMetricArea(outcome.basis) || outcome.contributingAreaM2 == null) return null;
  return cells * outcome.grid.cellMetresX * outcome.grid.cellMetresY;
}

/** "3905.0 m²", "at least 3905.0 m² — …", or the withheld sentence. */
export function contributingAreaText(areaM2: number | null, lowerBound: boolean): string {
  if (areaM2 == null) return 'Withheld: the horizontal scale is not resolved';
  const text = `${areaM2.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} m²`;
  return lowerBound ? `${text} — ${EDGE_CONTAMINATED_NOTE}` : text;
}

/** The peak flow for a drainage of `cells` cells at `setting`; withheld without metres. */
export function labPeakFlow(outcome: FlowPulseResult, cells: number, setting: RainfallSetting, lowerBound: boolean): PeakFlowEstimate {
  return peakFlowEstimate(areaOfCells(outcome, cells), setting, lowerBound);
}

/**
 * The map's channel cells at `setting`: every cell whose estimated peak flow
 * reaches the 1 L/s display threshold. Null when there are no square metres,
 * and the map falls back to the upstream count.
 */
export function displayChannelField(outcome: FlowPulseResult, setting: RainfallSetting): (FlowChannelField & { channelCells: number }) | null {
  const area = mayReportMetricArea(outcome.basis) ? outcome.contributingAreaM2 : null;
  return area ? flowDisplayField(area, setting) : null;
}

/** The line under the rainfall sliders: what the map draws now, or why the estimate is withheld. */
export function rainfallNote(field: { channelCells: number } | null, setting: RainfallSetting): string {
  if (!field) return `${PEAK_FLOW_WITHHELD}, so no peak flow is estimated and the lines show upstream cell counts.`;
  return `At ${settingText(setting)}, ${field.channelCells.toLocaleString('en-US')} cells reach the line threshold of ${DISPLAY_THRESHOLD_M3S * 1000} L/s estimated peak flow.`;
}

/** The count-scale channel cells, for a GIF drawn without a rainfall estimate. */
export function countChannelMask(outcome: FlowPulseResult): Uint8Array {
  const up = outcome.accumulation.upstreamCells;
  let max = 1;
  for (const v of up) if (v > max) max = v;
  const mask = new Uint8Array(up.length);
  for (let i = 0; i < up.length; i++) if (outcome.routed.status[i] !== CELL_NODATA && isChannel(logScale(up[i]!, max))) mask[i] = 1;
  return mask;
}

/** The download name of a watershed GIF: `<base>-watershed-<col>-<row>.gif`. */
export function watershedGifFilename(basename: string, col: number, row: number): string {
  return `${basename}-watershed-${col}-${row}.gif`;
}

/** What the live region says about a snapped outlet. */
export function snapSentence(from: GridCell, to: GridCell): string {
  return `Outlet snapped to the strongest channel within ${POUR_POINT_SNAP_RADIUS_CELLS} cells: from col ${from.col}, row ${from.row} to col ${to.col}, row ${to.row}.`;
}

/**
 * Everything the GIF renderer needs for one catchment, from the current run
 * and the Lab's state. Pure, so the facts the GIF prints are testable without
 * a canvas.
 */
export function watershedGifInputFor(
  input: FlowPulseLabInput,
  outcome: FlowPulseResult,
  catchment: FlowCatchmentTrace,
  setting: RainfallSetting,
  edge: EdgeContamination,
  snappedFrom: GridCell | null,
  dateIso: string,
  version: string = buildIdentityLabel(),
): WatershedGifInput {
  const g = outcome.grid;
  const outlet = catchment.cell.row * g.cols + catchment.cell.col;
  const lowerBound = edge.contaminated[outlet] === 1;
  const areaM2 = areaOfCells(outcome, catchment.cells);
  const field = displayChannelField(outcome, setting);
  const conditioning = outcome.record.parameters.conditioning === 'raw' ? 'raw' : 'priority-flood';
  const facts: WatershedFacts = {
    outletCol: catchment.cell.col,
    outletRow: catchment.cell.row,
    sourceName: input.filename ?? input.layerId,
    conditioning,
    cellMetres: areaM2 != null ? { x: g.cellMetresX, y: g.cellMetresY } : null,
    cells: catchment.cells,
    areaM2,
    edgeContaminated: lowerBound,
    peakFlow: peakFlowEstimate(areaM2, setting, lowerBound),
    channelRule: field
      ? `estimated peak flow at least ${DISPLAY_THRESHOLD_M3S * 1000} L/s at ${settingText(setting)}`
      : `upstream count at least ${channelMinCount(outcome.summary.maxUpstreamCells).toLocaleString('en-US')} cells (no rainfall estimate without metres)`,
    crsName: input.crsName ?? null,
    isGeographic: input.isGeographic,
    version,
    dateIso,
    snappedFrom,
  };
  // Relief from the DTM itself, not the conditioned routing surface.
  const dtmZ = input.result.dtm.z;
  const shade = dtmZ.length === g.cols * g.rows ? hillshade({ ...g, z: dtmZ }) : hillshade(g);
  return {
    grid: g, routed: outcome.routed, outlet, shade,
    channel: field ? field.channel : countChannelMask(outcome),
    unit: areaM2 != null ? 'm' : 'cells',
    facts,
  };
}

function row(label: string, value: string): HTMLElement {
  return el('div', { className: 'olv-story-row' }, [
    el('span', { className: 'olv-story-k', text: label }),
    el('span', { className: 'olv-story-v', text: value }),
  ]);
}

/**
 * The run's answer as a card: a refusal's reason, or the figures and every
 * limitation. `flat` writes the method as a plain section, for a card inside Details.
 */
export function renderFlowPulseLab(
  outcome: FlowPulseResult | FlowRefusal,
  flat = false,
  edge: EdgeContamination | null = null,
): HTMLElement {
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
  const ec = edge ?? edgeContamination(outcome.grid, outcome.routed);
  const largestOpen = ec.contaminated[largestDrainageCell(outcome)] === 1;
  card.append(
    el('div', { className: 'olv-story-headline', text: 'D8 flow routing over the analysed DTM' }),
    row('Cells read', `${s.readableCells.toLocaleString('en-US')} of ${s.cells.toLocaleString('en-US')}`),
    row('Outlets', String(s.outletCount)),
    row('Sinks', String(s.sinkCount)),
    row('Flats', String(s.flatCount)),
    row('Largest upstream count', `${s.maxUpstreamCells} cells`),
    row(
      'Largest contributing area',
      metric ? contributingAreaText(s.maxContributingAreaM2!, largestOpen) : 'Withheld: the horizontal scale is not resolved',
    ),
    row(
      'Edge-contaminated cells',
      `${ec.contaminatedCells.toLocaleString('en-US')} of ${s.readableCells.toLocaleString('en-US')}: ground outside the survey may also drain through them, so their areas are lower bounds`,
    ),
  );
  const list = el('ul', { className: 'olv-story-v' });
  for (const sentence of outcome.limitations) list.append(el('li', { text: sentence }));
  card.append(
    el('span', { className: 'olv-story-k', text: 'Limitations' }), list,
    methodDetails([row('Method', outcome.record.methods.join(' → '))], flat),
  );
  return card;
}

/**
 * The three figures under the grid for a routed result. The largest drainage
 * area is in square metres only when the basis permits a metric area, and in
 * cells otherwise; sinks, flats and the rest stay in the result card.
 */
export function flowPulseStats(outcome: FlowPulseResult, edge: EdgeContamination | null = null): HTMLElement {
  const s = outcome.summary;
  const area = mayReportMetricArea(outcome.basis) ? s.maxContributingAreaM2 : null;
  // "≥" when the largest drainage reaches the survey edge: its area is a lower bound.
  const atLeast = edge?.contaminated[largestDrainageCell(outcome)] === 1 ? '≥ ' : '';
  return labStatRow('Flow figures', [
    { label: 'Surface', value: s.readableCells.toLocaleString('en-US'), unit: 'cells' },
    { label: 'Outlets', value: s.outletCount.toLocaleString('en-US') },
    area != null
      ? { label: 'Largest drainage', value: `${atLeast}${area >= 100 ? Math.round(area).toLocaleString('en-US') : area.toFixed(1)}`, unit: 'm²' }
      : { label: 'Largest drainage', value: `${atLeast}${s.maxUpstreamCells.toLocaleString('en-US')}`, unit: 'cells' },
  ]);
}

/** Label and state for the flow-motion control: pressed while paused; pressed and disabled under reduced motion. */
export function flowMotionControlState(reducedMotion: boolean, paused: boolean): { text: string; pressed: boolean; disabled: boolean } {
  // One stable label; aria-pressed carries the state (pressed = paused).
  if (reducedMotion) return { text: 'Pause flow motion', pressed: true, disabled: true };
  return { text: 'Pause flow motion', pressed: paused, disabled: false };
}

/**
 * The banner inside the status chip when the terrain run is Blocked or
 * Preview, or null when the surface is usable.
 */
export function flowTerrainBanner(input: FlowPulseLabInput): HTMLElement | null {
  const caveat = flowTerrainCaveat(input.result.quality);
  if (!caveat) return null;
  const banner = el('div', { className: 'olv-flow-terrain-banner', text: flowTerrainBannerText(caveat) });
  banner.setAttribute('role', 'note');
  banner.dataset.verdict = caveat.verdict.toLowerCase();
  return banner;
}

/** Plain lines beside a Flow Pulse result. */
export const FLOW_HOW_TO_READ: readonly string[] = [
  'Each square is one ground cell. Water in a cell moves to the neighbour with the steepest drop.',
  'Outlets are where flow leaves the surface at its edge. Sinks are low spots where it stops. A stream that enters the survey shows as a channel that starts at the edge; its area is a lower bound.',
  'Upstream counts are numbers of cells, not volumes of water or rainfall.',
];

/** One line under the Raw / Priority-Flood choice: when to use which. */
export const FLOW_CONDITIONING_HINT =
  'Use Raw to see where water pools in hollows; use Priority-Flood to follow drainage across them to an outlet.';

/**
 * What the live region says after a conditioning switch re-runs the model.
 * A re-run clears any traced path or catchment, so the announcement says so
 * when there was one.
 */
export function rerunAnnouncement(outcome: FlowPulseResult | FlowRefusal, hadSelection: boolean): string {
  const base = outcome.ok ? 'Flow Pulse run complete.' : `Flow Pulse did not run: ${outcome.reason}`;
  return hadSelection ? `${base} The traced path and catchment were cleared.` : base;
}

/** The readiness list for an input, or for none. */
function flowReadiness(input: FlowPulseLabInput | null) {
  return labReadiness('flow-pulse', !!input, !!input && flowScaleOf(input).resolved, flowTerrainCaveat(input?.result.quality));
}

/**
 * The status chip for a routed surface: a few words, and behind them the
 * terrain banner and the readiness checklist, word for word.
 */
export function flowChipFacts(input: FlowPulseLabInput, outcome: FlowPulseResult | FlowRefusal): ChipFacts {
  const caveat = flowTerrainCaveat(input.result.quality);
  const banner = flowTerrainBanner(input);
  const lines = [...(banner ? [banner] : []), readinessList(flowReadiness(input))];
  if (!outcome.ok) return { tone: 'blocked', summary: 'Flow Pulse did not run', lines };
  if (caveat) {
    return { tone: caveat.verdict === 'Blocked' ? 'blocked' : 'review', summary: `Illustration only · ${caveat.interpolatedPercent}% interpolated`, lines };
  }
  if (!mayReportMetricArea(outcome.basis)) return { tone: 'review', summary: 'Areas withheld: scale not resolved', lines };
  return { tone: 'ready', summary: 'Ground surface from the latest terrain run', lines };
}

// ── interactive layer ───────────────────────────────────────────────────────

type ClickMode = 'pulse' | 'catchment';

function button(text: string, className: string, tip: string): HTMLButtonElement {
  return el('button', { className, text, type: 'button', tip }) as HTMLButtonElement;
}

function makeRetryButton(onRetry: () => void): HTMLButtonElement {
  const b = button('Retry', 'olv-flow-retry', 'Retry loading the terrain surface.');
  b.addEventListener('click', onRetry);
  return b;
}

/** A `role="group"` of `aria-pressed` toggle buttons, single-choice. */
function segmentedControl<T extends string>(
  ariaLabel: string,
  groupClassName: string,
  btnClassName: string,
  options: ReadonlyArray<{ value: T; label: string; tip: string }>,
  current: () => T,
  onSelect: (value: T) => void,
): { element: HTMLElement; sync: () => void } {
  const group = el('div', { className: groupClassName, ariaLabel });
  group.setAttribute('role', 'group');
  const buttons = options.map((opt) => {
    const b = button(opt.label, btnClassName, opt.tip);
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
    overlayRegistry.changed();
  }
  if (!persistentFlowOverlay) {
    // On by default: the drainage in 3D is the result most readers came for.
    persistentFlowOverlay = { overlay: new FlowOverlay(host), isStale, overlayOn: true };
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
  // The terrain the last run read is gone, so the run is too.
  publishLabRun('flow-pulse', null);
  if (!persistentFlowOverlay) return;
  persistentFlowOverlay.overlay.dispose();
  persistentFlowOverlay = null;
  overlayRegistry.changed();
}

/** The open Lab's toggle, so a switch made elsewhere updates its pressed state. */
const flowToggleSyncs = new Set<(on: boolean) => void>();

/**
 * The drainage lines in the Created layers list. Visibility lives on the
 * persisted overlay (`overlayOn`), the same flag the Lab toggle writes, so
 * both controls read one state. Listed only while drainage has been uploaded.
 */
overlayRegistry.register({
  id: 'flow-drainage',
  label: 'Drainage lines',
  isAvailable: () => (persistentFlowOverlay?.overlay.accumulationCellCount ?? 0) > 0,
  get: () => persistentFlowOverlay?.overlayOn ?? false,
  set: (on) => {
    const p = persistentFlowOverlay;
    if (!p) return;
    p.overlayOn = on;
    // A hidden mesh is skipped by the renderer, so a hidden overlay costs no draw time.
    p.overlay.setAccumulationVisible(on);
    for (const fn of [...flowToggleSyncs]) fn(on);
  },
});

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
  // Every caveat folds into one chip above the map; it opens to the full text.
  const chip = statusChip('flow-pulse');
  root.append(chip.element, live, body);
  const announce = (msg: string): void => { live.textContent = msg; };

  let conditioning: FlowConditioning = FLOW_PULSE_DEFAULTS.conditioning;
  let outcome = initialOutcome;
  // The Results shelf lists the latest successful run by reference.
  const publish = (): void => { if (outcome.ok) publishLabRun('flow-pulse', { outcome, layerId: input.layerId, filename: input.filename }); };
  publish();
  let mode: ClickMode = 'pulse';
  let busy = false;
  let overlayFrame: FlowOverlayFrame | null = null;
  let lastTrace: FlowPathTrace | FlowClickRefusal | null = null;
  let lastCatchment: FlowCatchmentTrace | FlowClickRefusal | null = null;
  // Rainfall setting: kept across re-runs, so a conditioning switch keeps it.
  let rainfall: RainfallSetting = RAINFALL_DEFAULT;
  let edge: EdgeContamination | null = null;
  let snapOn = true;
  /** The pointer pick behind the current outlet, when it was snapped. */
  let lastSnap: { from: GridCell; to: GridCell } | null = null;
  let rainFrame = 0;

  const overlayHost = input.overlayHost ?? null;
  const flowOverlay = acquireFlowOverlay(overlayHost, input.isStale ?? null);
  // Reflects whatever the persisted overlay is already showing (on for a new
  // one): reopening the Lab after turning the overlay off keeps it off.
  let overlayOn = persistentFlowOverlay?.overlayOn ?? false;

  const grid = new FlowResultGrid({
    ariaLabel: 'Routed terrain grid — arrow keys move, Enter or Space acts on the selected cell',
    onMove: (_cell: GridCell, report) => announce(cellAnnouncement(report)),
    onActivate: (cell: GridCell, source: ActivationSource) => handleActivate(cell, source),
    elevationRef: flowElevationReference(input),
  });

  const conditioningCtl = segmentedControl<FlowConditioning>(
    'Terrain conditioning',
    'olv-flow-cond',
    'olv-flow-cond-btn',
    [
      { value: 'raw', label: 'Raw terrain', tip: 'Trace flow over the terrain surface as loaded, unconditioned.' },
      { value: 'priority-flood', label: 'Priority-Flood conditioned', tip: 'Fill closed hollows first, so most flow reaches an outlet; flats may remain.' },
    ],
    () => conditioning,
    (value) => { if (value !== conditioning && !busy) void rerun(value); },
  );
  const conditioningHint = el('div', { className: 'olv-flow-cond-hint', text: FLOW_CONDITIONING_HINT });

  const modeCtl = segmentedControl<ClickMode>(
    'What a selected cell does',
    'olv-flow-mode',
    'olv-flow-mode-btn',
    [
      { value: 'pulse', label: 'Trace downstream path', tip: 'Click a cell to trace its downstream flow path.' },
      { value: 'catchment', label: 'Set catchment outlet', tip: "Click a cell to set the catchment's outlet point." },
    ],
    () => mode,
    (value) => { mode = value; modeCtl.sync(); syncSnapToggle(); renderSelection(); },
  );

  // Pour-point snapping: a click in catchment mode moves to the strongest
  // channel nearby; the keyboard cursor always sets the exact cell.
  const snapToggle = button(
    'Snap outlet to channel', 'olv-flow-snap-toggle',
    `A click sets the outlet on the strongest channel within ${POUR_POINT_SNAP_RADIUS_CELLS} cells. Keyboard selection is always exact.`,
  );
  snapToggle.addEventListener('click', () => {
    snapOn = !snapOn;
    syncSnapToggle();
    announce(snapOn
      ? `Outlet snapping on: a click moves to the strongest channel within ${POUR_POINT_SNAP_RADIUS_CELLS} cells.`
      : 'Outlet snapping off: a click sets the outlet on the cell clicked.');
  });
  function syncSnapToggle(): void {
    snapToggle.setAttribute('aria-pressed', snapOn ? 'true' : 'false');
    snapToggle.hidden = mode !== 'catchment';
  }
  syncSnapToggle();

  const rainCtl = buildRainfallControl(rainfall, (next) => {
    rainfall = next;
    // One redraw per frame while the slider moves; at once where there are no frames.
    if (typeof requestAnimationFrame !== 'function') { applyRainfall(); return; }
    if (rainFrame) return;
    rainFrame = requestAnimationFrame(() => { rainFrame = 0; applyRainfall(); });
  });
  const rainAssumptions = el('div', { className: 'olv-flow-rain-assumptions' });

  /** Redraw the network for the current rainfall and refresh the figures that depend on it. */
  function applyRainfall(): void {
    if (!outcome.ok) return;
    const field = displayChannelField(outcome, rainfall);
    grid.setChannelField(field);
    rainCtl.setNote(rainfallNote(field, rainfall), !field);
    renderSelection();
  }

  const overlayToggle = button('Drainage in 3D', 'olv-flow-overlay-toggle', 'Show or hide the flow-accumulation drainage lines on the 3D view.');
  overlayToggle.setAttribute('aria-pressed', overlayOn ? 'true' : 'false');
  overlayToggle.addEventListener('click', () => {
    overlayOn = !overlayOn;
    if (persistentFlowOverlay) persistentFlowOverlay.overlayOn = overlayOn;
    overlayToggle.setAttribute('aria-pressed', overlayOn ? 'true' : 'false');
    applyOverlayVisibility();
    overlayRegistry.changed();
    announce(overlayOn ? 'Flow accumulation overlay on.' : 'Flow accumulation overlay off.');
  });
  const syncToggle = (on: boolean): void => {
    overlayOn = on;
    overlayToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
    // Turning on from the list with nothing uploaded yet draws the current run.
    if (on) applyOverlayVisibility();
  };
  flowToggleSyncs.add(syncToggle);
  const overlayLegend = el('div', {
    className: 'olv-flow-overlay-legend',
    text: 'Drainage lines on a log scale: wider and brighter lines mean more cells drain through that point. It counts cells, not water.',
  });
  const overlayUnavailable = el('div', {
    className: 'olv-flow-overlay-unavailable',
    text: 'The 3D accumulation overlay is not available in this view; the map above still traces paths and catchments.',
  });

  const selectionPanel = el('div', { className: 'olv-flow-selection' });
  // The one hint under the map: what a click on it does.
  const gridHint = el('p', { className: 'olv-flow-selection-empty' });
  const head = labHeader('flow-pulse', 1);

  function applyOverlayVisibility(): void {
    if (!flowOverlay) return;
    if (overlayOn && outcome.ok && overlayFrame) {
      flowOverlay.setAccumulation(
        buildFlowAccumulationBuffers(outcome.grid, outcome.routed, outcome.accumulation, overlayFrame),
      );
      flowOverlay.setAccumulationVisible(true);
    } else if (!outcome.ok) {
      // A failed run has no drainage to show, so the list shows no row for it.
      flowOverlay.clearAccumulation();
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
    gridHint.textContent = mode === 'pulse'
      ? 'Click a cell on the map (or use the arrow keys and Enter) to trace where water runs from it.'
      : 'Click a cell on the map (or use the arrow keys and Enter) to see the area that drains to it.';
    const current = mode === 'pulse' ? lastTrace : lastCatchment;
    head.setStage(current ? 3 : 2);
    if (!current) return;
    if (!current.ok) {
      selectionPanel.append(el('div', {
        className: 'olv-flow-selection-error',
        text: refusalSentence(mode === 'pulse' ? 'path' : 'catchment', current),
      }));
      return;
    }
    const cols = outcome.grid.cols;
    if (mode === 'pulse') {
      const t = current as FlowPathTrace;
      const end = t.path.length > 0 ? t.path[t.path.length - 1]! : t.cell.row * cols + t.cell.col;
      const endCells = outcome.accumulation.upstreamCells[end]!;
      const open = edge?.contaminated[end] === 1;
      selectionPanel.append(
        row('Path cells', t.path.length.toLocaleString('en-US')),
        row('Ends at', `${statusLabel(t.endStatus)}, col ${end % cols}, row ${Math.floor(end / cols)}`),
        row('Area draining to the end', contributingAreaText(areaOfCells(outcome, endCells), open)),
        ...peakFlowRows('Peak flow at the end', labPeakFlow(outcome, endCells, rainfall, open)),
      );
    } else {
      const c = current as FlowCatchmentTrace;
      const outlet = c.cell.row * cols + c.cell.col;
      const open = edge?.contaminated[outlet] === 1;
      selectionPanel.append(
        row('Outlet', `col ${c.cell.col}, row ${c.cell.row}`),
        ...(lastSnap ? [el('p', {
          className: 'olv-flow-snap-note',
          text: `Snapped to the strongest channel within ${POUR_POINT_SNAP_RADIUS_CELLS} cells, from col ${lastSnap.from.col}, row ${lastSnap.from.row}.`,
        })] : []),
        row('Contributing cells', c.cells.toLocaleString('en-US')),
        row('Contributing area', contributingAreaText(areaOfCells(outcome, c.cells), open)),
        ...peakFlowRows('Peak flow at the outlet', labPeakFlow(outcome, c.cells, rainfall, open)),
        el('div', { className: 'olv-lab-actions olv-flow-gif-actions' }, [gifButton, gifError]),
      );
    }
  }

  /** The peak-flow row (with its machine-readable figure) and any area-limit warning. */
  function peakFlowRows(label: string, e: PeakFlowEstimate): HTMLElement[] {
    const r = row(label, e.ok ? `${peakFlowText(e)} (rational method)` : e.reason);
    r.classList.add('olv-flow-peak');
    if (e.ok) r.dataset.qM3s = String(e.qM3s);
    const warn = areaLimitWarning(e);
    return warn ? [r, el('p', { className: 'olv-flow-peak-warning', text: warn })] : [r];
  }

  function handleActivate(clicked: GridCell, source: ActivationSource = 'keyboard'): void {
    if (!outcome.ok || busy) return;
    let cell = clicked;
    let snapped: { from: GridCell; to: GridCell } | null = null;
    if (mode === 'catchment' && source === 'pointer' && snapOn) {
      const s = snapPourPoint(
        outcome.grid.cols, outcome.grid.rows, outcome.routed.status, outcome.accumulation.upstreamCells, clicked,
      );
      if (s.snapped) {
        cell = s.cell;
        snapped = { from: s.from, to: s.cell };
        grid.setCursor(cell);
      }
    }
    try {
      const stale = input.isStale?.() ?? false;
      if (mode === 'pulse') {
        const trace = traceClick(outcome, cell, stale);
        lastTrace = trace;
        if (trace.ok) {
          grid.setPathMask(maskFromIndices(outcome.grid.cols * outcome.grid.rows, trace.path), trace.path);
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
        lastSnap = trace.ok ? snapped : null;
        if (trace.ok) {
          grid.setCatchmentMask(trace.mask);
          if (flowOverlay && overlayFrame) {
            flowOverlay.setCatchment(buildFlowCatchmentBuffers(outcome.grid, trace.mask, overlayFrame));
          }
          announce(`Catchment traced: ${trace.cells} cell(s).${snapped ? ` ${snapSentence(snapped.from, snapped.to)}` : ''}`);
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

  const exportButton = button('Export package (ZIP)', 'olv-flow-export', 'Export the run as a ZIP package: trace, catchment, and report.');
  let exportBusy = false;

  async function handleExport(): Promise<void> {
    if (!outcome.ok || busy || exportBusy) return;
    const exportLabel = exportButton.textContent ?? 'Export package (ZIP)';
    exportBusy = true;
    exportButton.disabled = true;
    showBusyScan(exportButton, 'Building…');
    try {
      const { buildFlowPulsePackage } = await loadFlowPulsePackage();
      const digests = (await input?.exportDigests?.()) ?? null;
      const built = buildFlowPulseExport(
        outcome,
        input.isStale?.() ?? false,
        lastTrace,
        lastCatchment,
        input.filename,
        input.layerId,
        buildFlowPulsePackage,
        flowPulseGeorefOf(input, digests),
        {
          rainfall: displayChannelField(outcome, rainfall) ? rainfall : null,
          snappedFrom: lastSnap ? lastSnap.from.row * outcome.grid.cols + lastSnap.from.col : null,
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

  const gifLabel = 'Export GIF';
  const gifButton = button(gifLabel, 'olv-flow-gif-export', 'Export an animated GIF of this catchment, revealed by D8 flow length to the outlet.');
  let gifBusy = false;
  const gifError = el('p', { className: 'olv-flow-gif-error' });
  gifButton.addEventListener('click', () => void handleGifExport());

  async function handleGifExport(): Promise<void> {
    if (!outcome.ok || busy || gifBusy || !lastCatchment || !lastCatchment.ok || !edge) return;
    const run = outcome, catchment = lastCatchment, ec = edge, setting = rainfall, snap = lastSnap;
    gifBusy = true;
    gifButton.disabled = true;
    gifButton.textContent = 'Preparing GIF…';
    gifError.textContent = '';
    try {
      if (input.isStale?.() ?? false) {
        announce('GIF export refused — the result is stale; rerun Flow Pulse before exporting.');
        return;
      }
      const { renderWatershedGif, canvasTextRasterizer } = await loadWatershedGif();
      const gifInput = watershedGifInputFor(input, run, catchment, setting, ec, snap ? snap.from : null, new Date().toISOString());
      const bytes = await renderWatershedGif(gifInput, {
        raster: canvasTextRasterizer(),
        onProgress: (done, total) => { gifButton.textContent = `Exporting GIF… ${done}/${total}`; },
      });
      const base = input.filename ?? input.layerId ?? 'flow-pulse';
      downloadBytes(watershedGifFilename(base, catchment.cell.col, catchment.cell.row), bytes, 'image/gif');
      announce('Watershed GIF downloaded.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      announce(`GIF export failed: ${msg}`);
      gifError.textContent = `GIF export failed: ${msg}. Your scan and the run are unchanged; try again.`;
    } finally {
      gifBusy = false;
      gifButton.disabled = false;
      gifButton.textContent = gifLabel;
    }
  }

  function showError(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    const text = `Flow simulation failed: ${msg.replace(/[.\s]+$/, '')}. Your scan and measurements are unchanged. Adjust the inputs and run it again.`;
    const panel = el('div', { className: 'olv-flow-error' }, [
      el('div', { className: 'olv-flow-error-text', text }),
      makeRetryButton(() => void rerun(conditioning)),
    ]);
    body.replaceChildren(panel);
    announce(text);
  }

  function renderReady(): void {
    edge = outcome.ok ? edgeContamination(outcome.grid, outcome.routed) : null;
    // Inside Details, the card's method is a plain section, not a second accordion.
    const staticCard = renderFlowPulseLab(outcome, outcome.ok, edge);
    chip.set(flowChipFacts(input, outcome));
    if (!outcome.ok) {
      head.setStage(1);
      body.replaceChildren(staticCard, labDetails([head.element]));
      return;
    }

    const dtm = input.result.dtm;
    overlayFrame = flowOverlayFrame(input.sceneUpAxis, dtm.originH1, dtm.originH2, dtm.cellSizeM);
    grid.load(outcome.grid, outcome.routed, outcome.accumulation, outcome.contributingAreaM2);
    lastTrace = null;
    lastCatchment = null;
    lastSnap = null;
    clearSelectionDrawing();
    applyRainfall();
    applyOverlayVisibility();
    overlayRegistry.changed();
    const metricField = displayChannelField(outcome, rainfall) != null;
    rainAssumptions.replaceChildren(
      el('p', { className: 'olv-flow-rain-assumptions-title', text: 'Rainfall estimate: what it assumes' }),
      ...rationalAssumptions(conditioning).map((t) => el('p', { className: 'olv-flow-rain-assumptions-line', text: t })),
      el('p', {
        className: 'olv-flow-rain-assumptions-line',
        text: 'Sources: Kuichling (1889) for the method; FHWA HEC-22 (2009) Table 3-1 and Schwab et al. (1993) for the C ranges; HEC-22 for the 80 ha limit. Particle speed is a display of upstream cell count, not water velocity.',
      }),
    );

    const motion = el('button', {
      className: 'olv-flow-motion-toggle', type: 'button',
      text: 'Pause flow motion',
      tip: 'Particles move along the drainage lines; speed shows upstream cell count, not water velocity. Off when the system asks for reduced motion.',
    }) as HTMLButtonElement;
    const syncMotion = (): void => {
      const st = flowMotionControlState(prefersReducedMotion(), grid.particles.paused);
      motion.disabled = st.disabled;
      motion.setAttribute('aria-pressed', st.pressed ? 'true' : 'false');
    };
    motion.addEventListener('click', () => {
      grid.particles.setPaused(!grid.particles.paused);
      syncMotion();
    });
    syncMotion();
    // The map leads, then three figures, the click hint and the actions;
    // the legend, the full card and the reading notes fold into Details.
    body.replaceChildren(
      grid.element,
      flowPulseStats(outcome, edge),
      rainCtl.element,
      el('div', { className: 'olv-lab-controls' }, [modeCtl.element, snapToggle, gridHint]),
      selectionPanel,
      el('div', { className: 'olv-lab-actions' }, [
        conditioningCtl.element,
        exportButton,
        ...(overlayHost ? [overlayToggle] : []),
      ]),
      labDetails([
        metricField ? flowDischargeLegend() : flowGridLegend(grid.maxUpstream),
        motion,
        conditioningHint,
        rainAssumptions,
        el('div', { className: 'olv-flow-overlay-section' }, [...(overlayHost ? [] : [overlayUnavailable]), overlayLegend]),
        howToRead(FLOW_HOW_TO_READ),
        head.element,
        staticCard,
      ]),
    );
  }

  async function rerun(next: FlowConditioning): Promise<void> {
    conditioning = next;
    conditioningCtl.sync();
    const hadSelection = lastTrace !== null || lastCatchment !== null;
    busy = true;
    const busyLine = el('div', { className: 'olv-flow-busy' });
    showBusyScan(busyLine, 'Running Flow Pulse…', 'emblem');
    body.replaceChildren(busyLine);
    announce('Running Flow Pulse…');
    // One frame so the busy state actually paints before the (synchronous)
    // run computes — matters most on the largest grids this feature allows.
    await new Promise<void>((resolve) => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
      else setTimeout(resolve, 0);
    });
    try {
      outcome = runLabFlowPulse(input, conditioning);
      publish();
      busy = false;
      renderReady();
      announce(rerunAnnouncement(outcome, hadSelection));
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
      if (rainFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rainFrame);
      rainFrame = 0;
      grid.dispose();
      chip.dispose();
      flowToggleSyncs.delete(syncToggle);
      // A hidden overlay that was drawn stays (hidden) so the Created layers
      // list can switch it back on; one never drawn is released.
      if (!overlayOn && persistentFlowOverlay && persistentFlowOverlay.overlay.accumulationCellCount === 0) {
        persistentFlowOverlay.overlay.dispose();
        persistentFlowOverlay = null;
        overlayRegistry.changed();
      }
    },
  };
}

/** What the host offers a lab opened without a ground surface. */
export interface LabOpenOptions {
  /** Run terrain and reopen the lab on its result. Absent: the notice has no button. */
  readonly onRunTerrain?: () => void;
}

/**
 * The lab with no ground surface: a plain notice with the terrain run, in
 * place of a refusal; the purpose, stages and checklist sit in Details.
 */
export function renderFlowPulseNeedsGround(onRunTerrain: (() => void) | null): HTMLElement {
  return el('div', { className: 'olv-flow-lab' }, [
    needsGround(onRunTerrain),
    labDetails([labHeader('flow-pulse', 0).element, readinessList(flowReadiness(null))]),
  ]);
}

/** Show Flow Pulse's page while the terrain run it needs builds the ground surface. */
export function openFlowPulsePreparing(onClose?: () => void): { close(): void } {
  return openLabSurface('flow-pulse', 'Flow Pulse', el('div', { className: 'olv-flow-lab' }, [preparingGround('flow-pulse')]), onClose);
}

/** Run and show Flow Pulse on its Analyse page. */
export function openFlowPulseLab(input: FlowPulseLabInput | null, opts: LabOpenOptions = {}): ModalHandle {
  // A shelf Focus reopens the published run on the same layer as it is.
  const prior = takeResultReopen('flow-pulse') ? labRun('flow-pulse') : null;
  if (!input) {
    // The terrain run reopens this page on its result, replacing this notice.
    return openLabSurface('flow-pulse', 'Flow Pulse', renderFlowPulseNeedsGround(opts.onRunTerrain ?? null));
  }
  const reuse = prior && prior.layerId === input.layerId ? (prior.outcome as FlowPulseResult) : null;
  const interactive = mountFlowPulseInteractive(input, reuse ?? runLabFlowPulse(input));
  return openLabSurface('flow-pulse', 'Flow Pulse', interactive.element, () => interactive.dispose());
}
