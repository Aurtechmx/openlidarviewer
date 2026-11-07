/**
 * flowDrainageSheetPdf.ts: the Flow Pulse drainage sheet, a printable PDF of
 * one run.
 *
 * Four optional sections, each chosen in the Lab's dialog:
 *   map          plan view: hillshade, flow lines, outlets, catchment, collar;
 *   summary      the hydrology figures, peak flow, limitations and provenance;
 *   traced       the user's downstream path and catchment, listed;
 *   depressions  the largest depressions, the columns of the package's CSV.
 *
 * The figures are the ones the Flow Pulse package writes, from the same
 * helpers, and the sheet states the same limits: it is a routing graph, not
 * a flood model, and a sampled or Preview surface marks every page PREVIEW.
 * Placement follows `flowPulsePackage.ts`: real coordinates only with both a
 * world origin and the DTM raster frame, otherwise local grid metres.
 *
 * `buildDrainageSheetModel` is pure data (testable without a PDF);
 * `buildFlowDrainageSheetPdf` draws it with pdf-lib, so this module rides its
 * own lazy chunk (`loadFlowDrainageSheet` in `lazyChunks.ts`).
 */

import {
  PDFDocument, StandardFonts, rgb, concatTransformationMatrix, drawObject, lineTo, moveTo, popGraphicsState,
  pushGraphicsState, setLineCap, setLineWidth, setStrokingRgbColor, stroke, LineCapStyle,
  type PDFPage,
} from 'pdf-lib';
import { renderWatershedReport } from './watershedReport/watershedReportPdf';
import { encodePng } from './watershedReport/pngEncode';
import type { ReportFonts } from './watershedReport/reportFonts';
import {
  PALETTE, drawRuns, heading, paragraph, sectionTitle, table, widthOf, type PageCursor, type PageSize,
} from './watershedReport/pageKit';
import { SOURCE_NOT_SUPPLIED_NOTE, sourceSha256Text } from '../science/exportDigestRecord';
import { crsOriginLine } from '../science/crsOrigin';
import { sourceInterpretationLines, sourceInterpretationOf } from '../science/sourceInterpretation';
import { BUILD_IDENTITY, buildIdentityProvenance } from '../build/buildIdentity';
import type { FlowPulseResult } from '../simulation/flowPulse/flowPulseRunner';
import { catchmentFrom } from '../simulation/flowPulse/flowPulseRunner';
import { CELL_NODATA, CELL_OUTLET } from '../simulation/flowPulse/flowTypes';
import { statusLabel } from '../simulation/flowPulse/flowGridCursor';
import { hillshade } from '../simulation/flowPulse/flowHillshade';
import { edgeContamination } from '../simulation/flowPulse/edgeContamination';
import {
  DISPLAY_THRESHOLD_M3S, minAreaForFlowM2, areaLimitWarning, flowDisplayField, formatRunoffC, peakFlowEstimate, peakFlowText, presetOf,
  rationalAssumptions, settingText, type PeakFlowEstimate,
} from '../simulation/flowPulse/rationalDischarge';
import { mayReportMetricArea } from '../simulation/simulationInputBasis';
import { FLOW_TERRAIN_BANNER, interpolatedShareText } from '../process/flowTerrainCaveat';
import { channelMinCount, isChannel, logScale } from '../render/flowOverlayGeometry';
import {
  fitTransform, gridTicks, mapScaleRatio, niceStep, scaleBar, tickDecimals,
} from '../terrain/contour/mapSheetLayout';
import { mapLinearUnitLabel, mapScaleLabel, readinessNote } from '../render/measure/mapSheetPdf';
import { scaleBarUnit } from '../render/measure/scaleBar';
import { winAnsiSafe } from '../winAnsiText';
import type { FlowPulsePackageOptions } from './flowPulsePackage';
import type { DtmGrid } from '../terrain/ground/cellConfidence';
import { buildWatershedReportModel, chooseOutlets, watershedReportGate, type ReportOutlet, type WatershedReportModel } from '../simulation/flowPulse/watershed/watershedReportModel';
import { partitionWatersheds } from '../simulation/flowPulse/watershed/watershedPartition';
import { DEFAULT_NETWORK_THRESHOLD_M2 } from '../simulation/flowPulse/watershed/flowNetwork';
import { traceDivide, type TracedDivide } from '../simulation/flowPulse/watershed/divideTrace';
import { catchmentStudyGateText } from './flowDrainageSheetUnits';
import { UNIT_TO_METRES, type DrainageLinearUnit } from './flowDrainageSheetUnits';

export { linearUnitOf, type DrainageLinearUnit } from './flowDrainageSheetUnits';

export type DrainageSheetSection = 'map' | 'summary' | 'catchment' | 'traced' | 'depressions';

export const DRAINAGE_SHEET_SECTIONS: readonly DrainageSheetSection[] = ['map', 'summary', 'catchment', 'traced', 'depressions'];

/** Rows the depression table shows at most. */
export const DRAINAGE_DEPRESSION_ROWS = 25;


/** The package's options, plus which sections to draw and the frame's linear unit. */
export interface FlowDrainageSheetOptions extends Pick<FlowPulsePackageOptions,
  'basename' | 'generationDateIso' | 'build' | 'worldOrigin' | 'crsName' | 'verticalUnitLabel' | 'sourceSha256'
  | 'digests' | 'sourceInterpretation' | 'path' | 'catchment' | 'elevationOrigin' | 'terrainCaveat' | 'gridFrame'
  | 'verticalResolved' | 'rainfall'> {
  /** Sections to include; an omitted key is included. */
  readonly sections?: Partial<Record<DrainageSheetSection, boolean>>;
  /** Linear unit of the placed frame (source units). Ignored when the sheet is not placed. */
  readonly linearUnit?: DrainageLinearUnit;
  /** Depression rows to list. Default {@link DRAINAGE_DEPRESSION_ROWS}. */
  readonly depressionRows?: number;
  /** The analysed DTM (coverage, confidence, counts), for the catchment study. Omitted: no study. */
  readonly dtm?: DtmGrid | null;
  /** Project title for the cover. Default the basename. */
  readonly title?: string;
  /** Metres per vertical unit; null withholds every height, slope and relief in the study. */
  readonly verticalToMetres?: number | null;
}

/** The catchment study: the watershed model and the network threshold it was built at. */
export interface DrainageCatchmentStudy {
  readonly model: WatershedReportModel;
  readonly thresholdM2: number;
  /** How the threshold was set, for the page. */
  readonly thresholdText: string;
  /** Display names per catchment label. */
  readonly names: Readonly<Record<string, string>>;
}

export interface DrainageMapModel {
  readonly placed: boolean;
  /** Lower-left corner and cell size of the drawn frame. */
  readonly ox: number;
  readonly oy: number;
  readonly cellX: number;
  readonly cellY: number;
  readonly linearUnit: DrainageLinearUnit;
  readonly unitToMetres: number | null;
  /** 1 for every cell drawn as a flow line. */
  readonly channel: Uint8Array;
  readonly channelCells: number;
  /** What the flow lines show, for the legend. */
  readonly channelBasis: string;
  readonly outlets: readonly number[];
  readonly catchment: { readonly mask: Uint8Array; readonly kind: 'user' | 'largest'; readonly outletCell: number; readonly divide: TracedDivide } | null;
  readonly path: Int32Array | null;
  readonly crsText: string;
  readonly gridText: string;
}

export interface DrainageTable {
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly note: string;
}

export interface DrainageSheetModel {
  readonly title: string;
  readonly basename: string;
  readonly generated: string;
  readonly build: string;
  readonly preview: boolean;
  /** Printed in every title block. */
  readonly statusLines: readonly string[];
  readonly sections: readonly DrainageSheetSection[];
  readonly map: DrainageMapModel | null;
  readonly summary: readonly string[] | null;
  readonly traced: readonly string[] | null;
  readonly depressions: DrainageTable | null;
  readonly catchmentStudy: DrainageCatchmentStudy | null;
  /** Why the catchment study was asked for and not printed, or null. */
  readonly catchmentStudyWithheld: string | null;
}

/** Why the traced section cannot be included, or null when it can. */
export function tracedUnavailableReason(hasPath: boolean, hasCatchment: boolean): string | null {
  return hasPath || hasCatchment ? null : 'Trace a path or set a catchment outlet on the map first.';
}

/** The download name: `<basename>-drainage.pdf`. */
export function drainageSheetFilename(basename: string): string {
  return `${basename}-drainage.pdf`;
}

function num(v: number, digits: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function verticalSuffix(label: 'm' | 'ft' | 'units'): string {
  return label === 'units' ? ' source units' : ` ${label}`;
}

/**
 * The cells drawn as flow lines: those whose estimated peak flow reaches the
 * Lab's 1 L/s line threshold at the rainfall setting, or, without square
 * metres or a setting, the Lab's count-scale channel threshold.
 */
export function drainageChannelMask(result: FlowPulseResult, rainfall: FlowDrainageSheetOptions['rainfall']): {
  readonly mask: Uint8Array; readonly cells: number; readonly basis: string;
} {
  const area = mayReportMetricArea(result.basis) ? result.contributingAreaM2 : null;
  if (area && rainfall) {
    const field = flowDisplayField(area, rainfall);
    return {
      mask: field.channel, cells: field.channelCells,
      basis: `Estimated peak flow of at least ${DISPLAY_THRESHOLD_M3S * 1000} L/s at ${settingText(rainfall)}`,
    };
  }
  const up = result.accumulation.upstreamCells;
  let max = 1;
  for (const v of up) if (v > max) max = v;
  const mask = new Uint8Array(up.length);
  let cells = 0;
  for (let i = 0; i < up.length; i++) {
    if (result.routed.status[i] !== CELL_NODATA && isChannel(logScale(up[i]!, max))) { mask[i] = 1; cells++; }
  }
  return { mask, cells, basis: `Upstream count of at least ${channelMinCount(max).toLocaleString('en-US')} cells (log scale); counts cells, not water` };
}

function largestCell(result: FlowPulseResult): number {
  const up = result.accumulation.upstreamCells;
  let best = 0;
  for (let i = 1; i < up.length; i++) if (up[i]! > up[best]!) best = i;
  return best;
}

function maskCount(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] === 1) n++;
  return n;
}

function peakLines(label: string, e: PeakFlowEstimate): string[] {
  if (!e.ok) return [`${label}: not estimated. ${e.reason}.`];
  const warn = areaLimitWarning(e);
  return [
    `${label}: ${peakFlowText(e)} (rational method)${e.lowerBound ? ', a lower bound' : ''}.`,
    ...(warn ? [`  ${warn}`] : []),
  ];
}

/** Everything the sheet prints, as data. */
export function buildDrainageSheetModel(result: FlowPulseResult, options: FlowDrainageSheetOptions = {}): DrainageSheetModel {
  const grid = result.grid;
  const cols = grid.cols;
  const basename = options.basename ?? 'flow-pulse';
  const build = options.build ?? BUILD_IDENTITY;
  const metric = mayReportMetricArea(result.basis);
  const rainfall = options.rainfall ?? null;
  const vLabel = options.verticalUnitLabel ?? 'units';
  const conditioning = result.record.parameters.conditioning === 'raw' ? 'raw' : 'priority-flood';
  const hasPath = !!options.path && options.path.cells.length > 0;
  const hasCatchment = !!options.catchment;
  const want = (s: DrainageSheetSection): boolean => options.sections?.[s] !== false;
  // The watershed model drives the cover, site map and quality pages, so it is
  // built whenever the DTM is supplied. Catchment pages are printed only for a
  // complete, metre-scaled, conditioned run: otherwise the study is withheld.
  let catchmentStudy: DrainageCatchmentStudy | null = null;
  let catchmentStudyWithheld: string | null = null;
  const dtmOk = !!options.dtm && options.dtm.cols === cols && options.dtm.rows === grid.rows;
  if (dtmOk) {
    const gateText = catchmentStudyGateText(watershedReportGate(result, conditioning));
    const studied = want('catchment') && gateText == null;
    if (want('catchment') && gateText) catchmentStudyWithheld = gateText;
    const thresholdM2 = rainfall ? minAreaForFlowM2(rainfall) : DEFAULT_NETWORK_THRESHOLD_M2;
    const vToM = options.verticalResolved === false ? null : options.verticalToMetres ?? null;
    // The drawn catchment first, then the two largest watersheds that are not it.
    const outlets: ReportOutlet[] = [];
    if (studied) {
      if (options.catchment) outlets.push({ cell: options.catchment.outletCell, label: 'C1', snappedFromCell: options.catchment.snappedFrom ?? null });
      const partition = partitionWatersheds(grid, result.routed, result.accumulation, edgeContamination(grid, result.routed));
      for (const auto of chooseOutlets(partition, [])) {
        if (outlets.length >= (options.catchment ? 3 : 2)) break;
        // Skip a watershed that holds the drawn catchment, or lies inside it.
        if (options.catchment && (options.catchment.mask[auto.cell] === 1 || catchmentFrom(result, auto.cell)[options.catchment.outletCell] === 1)) continue;
        outlets.push({ cell: auto.cell, label: `C${outlets.length + 1}`, snappedFromCell: null });
      }
    }
    const model = buildWatershedReportModel({
      result, dtm: options.dtm!, outlets,
      language: 'en', title: options.title ?? basename, thresholdM2,
      verticalToMetres: vToM, originZ: vToM == null ? null : options.elevationOrigin ?? null,
      crsName: options.crsName ?? null, generatedAt: new Date(options.generationDateIso ?? Date.now()),
      software: buildIdentityProvenance(build), sourceSha256: options.sourceSha256 ?? options.digests?.sourceSha256 ?? null,
    });
    catchmentStudy = {
      thresholdM2,
      thresholdText: rainfall
        ? `Flow lines: cells whose estimated peak flow reaches ${DISPLAY_THRESHOLD_M3S * 1000} L/s at ${settingText(rainfall)} (at least ${num(thresholdM2, 0)} m2 draining), the Lab's line threshold.`
        : `Flow lines: cells with at least ${num(thresholdM2, 0)} m2 draining to them.`,
      model: studied ? model : { ...model, sections: [] },
      names: options.catchment && studied ? { C1: 'your catchment' } : {},
    };
    if (studied && model.sections.length === 0) catchmentStudyWithheld = 'No watershed on the grid is large enough to study.';
  } else if (want('catchment')) {
    catchmentStudyWithheld = 'The analysed DTM was not supplied with the run.';
  }
  const sections = DRAINAGE_SHEET_SECTIONS.filter((s) => want(s) && (s !== 'traced' || hasPath || hasCatchment) && (s !== 'catchment' || (catchmentStudy?.model.sections.length ?? 0) > 0));

  // Placement, as the package places its rasters.
  const placedOrigin = options.worldOrigin && options.gridFrame ? options.worldOrigin : null;
  const frame = placedOrigin ? options.gridFrame ?? null : null;
  const ox = (placedOrigin?.x ?? 0) + (frame?.originH1 ?? 0);
  const oy = (placedOrigin?.y ?? 0) + (frame?.originH2 ?? 0);
  const cellX = frame?.cellSize ?? grid.cellMetresX;
  const cellY = frame?.cellSize ?? grid.cellMetresY;
  const placed = placedOrigin != null;
  const linearUnit: DrainageLinearUnit = placed ? options.linearUnit ?? 'unknown' : metric ? 'metre' : 'unknown';
  const crsName = options.crsName ?? null;
  const crsText = crsName == null
    ? 'not georeferenced; local grid coordinates from (0, 0)'
    : placed ? crsName : `${crsName} (not applied: local grid coordinates from (0, 0))`;
  const placeCell = (c: number): [number, number] => {
    const col = c % cols, row = (c - col) / cols;
    return [ox + (col + 0.5) * cellX, oy + (row + 0.5) * cellY];
  };
  const cellName = (c: number): string => `col ${c % cols} from the west, row ${Math.floor(c / cols)} from the south`;
  const posName = (c: number): string => {
    const [x, y] = placeCell(c);
    return `${num(x, 2)}, ${num(y, 2)} ${placed ? (crsName ?? 'source coordinates') : 'local grid'}`;
  };

  const contaminated = hasPath || hasCatchment ? edgeContamination(grid, result.routed).contaminated : null;
  const areaOf = (cells: number): number | null => (metric && result.contributingAreaM2 != null ? cells * grid.cellMetresX * grid.cellMetresY : null);
  const areaText = (cells: number, lowerBound: boolean): string => {
    const a = areaOf(cells);
    return a == null ? 'area withheld (horizontal scale not resolved)' : `${lowerBound ? 'at least ' : ''}${num(a, 1)} m2`;
  };
  const sourceInterpretation = {
    ...(options.sourceInterpretation ?? sourceInterpretationOf(undefined, undefined)),
    ...(options.digests ? { crsOrigin: options.digests.crsOrigin } : {}),
  };

  const caveat = options.terrainCaveat ?? null;
  const preview = caveat != null || !result.basis.complete;
  const statusLines = [
    ...(preview ? [readinessNote('previewOnly')] : ['Simulated result; not survey-grade.']),
    ...(caveat ? [`${FLOW_TERRAIN_BANNER}. Terrain verdict: ${caveat.verdict}; ${interpolatedShareText(caveat)}.`] : []),
    ...(!result.basis.complete ? [`Input coverage: ${result.basis.coverage} (partial).`] : []),
    'A topographic routing graph: not rainfall-runoff, hydraulic or flood modelling.',
  ];

  // ── map ──
  let map: DrainageMapModel | null = null;
  if (sections.includes('map')) {
    const ch = drainageChannelMask(result, rainfall);
    const up = result.accumulation.upstreamCells;
    const outlets: number[] = [];
    for (let i = 0; i < up.length; i++) if (result.routed.status[i] === CELL_OUTLET && ch.mask[i] === 1) outlets.push(i);
    outlets.sort((a, b) => up[b]! - up[a]! || a - b);
    const userCatchment = options.catchment ?? null;
    const outletCell = userCatchment ? userCatchment.outletCell : largestCell(result);
    const catchMask = userCatchment ? userCatchment.mask : catchmentFrom(result, outletCell);
    map = {
      placed, ox, oy, cellX, cellY, linearUnit, unitToMetres: UNIT_TO_METRES[linearUnit],
      channel: ch.mask, channelCells: ch.cells, channelBasis: ch.basis,
      outlets: outlets.slice(0, 200),
      catchment: maskCount(catchMask) > 0 ? { mask: catchMask, kind: userCatchment ? 'user' : 'largest', outletCell, divide: traceDivide(grid, catchMask) } : null,
      path: sections.includes('traced') && hasPath ? options.path!.cells : null,
      crsText,
      gridText: placed
        ? `Grid: ${crsName ?? 'source coordinates (no CRS resolved)'}, in ${mapLinearUnitLabel(linearUnit)}`
        : `Grid: local grid ${metric ? 'metres' : 'units'} from the grid's (0, 0) corner; not placed`,
    };
  }

  // ── summary ──
  let summary: string[] | null = null;
  if (sections.includes('summary')) {
    const s = result.summary;
    const r = result.record;
    const preset = rainfall ? presetOf(rainfall) : null;
    const peaks: string[] = [];
    if (rainfall && contaminated) {
      if (options.catchment) {
        const cells = maskCount(options.catchment.mask);
        const lb = contaminated[options.catchment.outletCell] === 1;
        peaks.push(...peakLines(`At the catchment outlet (${cellName(options.catchment.outletCell)})`, peakFlowEstimate(areaOf(cells), rainfall, lb)));
      }
      if (hasPath) {
        const end = options.path!.cells[options.path!.cells.length - 1]!;
        const lb = contaminated[end] === 1;
        peaks.push(...peakLines(`At the path end (${cellName(end)})`, peakFlowEstimate(areaOf(result.accumulation.upstreamCells[end]!), rainfall, lb)));
      }
    }
    summary = [
      '# Surface',
      `Surface cells: ${s.cells.toLocaleString('en-US')} (${cols} x ${grid.rows}, cell ${num(grid.cellMetresX, 3)} x ${num(grid.cellMetresY, 3)} m)`,
      `Readable cells: ${s.readableCells.toLocaleString('en-US')}`,
      `Outlets: ${s.outletCount.toLocaleString('en-US')}`,
      `Sinks: ${s.sinkCount.toLocaleString('en-US')}; flats (unresolved): ${s.flatCount.toLocaleString('en-US')}`,
      `Largest drainage: ${s.maxUpstreamCells.toLocaleString('en-US')} cells, ${metric && s.maxContributingAreaM2 != null ? `${num(s.maxContributingAreaM2, 1)} m2` : 'area withheld (horizontal scale not resolved)'}`,
      conditioning === 'raw'
        ? 'Conditioning: raw terrain (no depression filling)'
        : `Conditioning: Priority-Flood; ${(s.cellsRaised ?? 0).toLocaleString('en-US')} cells raised, max fill depth ${s.maxFillDepth == null ? 'not recorded' : `${num(s.maxFillDepth, 3)}${verticalSuffix(vLabel)}`}`,
      '# Rainfall and peak flow (rational method, Q = C x i x A)',
      ...(rainfall ? [
        `Rainfall intensity: ${rainfall.intensityMmH} mm/h, uniform over the catchment`,
        `Runoff coefficient C: ${formatRunoffC(rainfall.runoffC)}${preset ? `, ${preset.label}, midpoint of ${preset.range[0]} to ${preset.range[1]} (${preset.source})` : ', set by hand'}`,
        ...(peaks.length > 0 ? peaks : ['No path or catchment was drawn, so no peak flow was estimated.']),
        'Assumptions:',
        ...rationalAssumptions(conditioning).map((a) => `- ${a}`),
      ] : ['Not estimated: the horizontal scale is not resolved, so there are no square metres to apply it to.']),
      ...(catchmentStudyWithheld ? ['# Catchment study', `Not included: ${catchmentStudyWithheld}`] : []),
      '# Limitations',
      ...result.limitations.map((l) => `- ${l}`),
      ...(caveat ? [`- ${FLOW_TERRAIN_BANNER}. Terrain verdict: ${caveat.verdict}; ${interpolatedShareText(caveat)}.`] : []),
      '# Source and frame',
      ...sourceInterpretationLines(sourceInterpretation, '').map((l) => l.replace(/^(\S.*?)\s{2,}/, '$1: ')),
      `Source file: ${r.source.filename ?? 'unknown'}`,
      `Source SHA-256: ${options.sourceSha256 ?? (options.digests ? sourceSha256Text(options.digests) : (r.source.sourceDigest ?? SOURCE_NOT_SUPPLIED_NOTE))}`,
      `Input coverage: ${r.source.basis.coverage} (${r.source.basis.complete ? 'complete' : 'partial'})`,
      `CRS: ${crsText}`,
      ...(sourceInterpretation.crsOrigin ? [crsOriginLine(sourceInterpretation.crsOrigin)] : []),
      `Vertical unit: ${vLabel === 'units' ? 'unresolved; depths are in source units' : vLabel}`,
      `Method: ${r.model.id}@${r.model.version}, D8 single-flow-direction routing`,
      `Field digest: ${String(r.result.fieldDigest)}`,
      `Run record digest: ${r.digest}`,
    ];
  }

  // ── traced path and catchment ──
  let traced: string[] | null = null;
  if (sections.includes('traced') && contaminated) {
    traced = [];
    if (hasPath) {
      const cells = options.path!.cells;
      const start = cells[0]!, end = cells[cells.length - 1]!;
      let len = 0;
      for (let i = 1; i < cells.length; i++) {
        const a = cells[i - 1]!, b = cells[i]!;
        const dc = (b % cols) - (a % cols), dr = Math.floor(b / cols) - Math.floor(a / cols);
        len += metric ? Math.hypot(dc * grid.cellMetresX, dr * grid.cellMetresY) : Math.hypot(dc, dr);
      }
      const endCells = result.accumulation.upstreamCells[end]!;
      traced.push(
        '# Downstream path',
        `Start: ${cellName(start)} (${posName(start)})`,
        `End: ${statusLabel(result.routed.status[end]!)}, ${cellName(end)} (${posName(end)})`,
        `Length: ${metric ? `${num(len, 1)} m` : `${num(len, 1)} cell widths`} over ${cells.length.toLocaleString('en-US')} cells`,
        `Draining to the end: ${endCells.toLocaleString('en-US')} cells, ${areaText(endCells, contaminated[end] === 1)}`,
      );
    }
    if (options.catchment) {
      const c = options.catchment;
      const cells = maskCount(c.mask);
      const snapped = c.snappedFrom != null && c.snappedFrom !== c.outletCell ? c.snappedFrom : null;
      traced.push(
        '# Catchment',
        `Outlet: ${cellName(c.outletCell)} (${posName(c.outletCell)})`,
        ...(snapped != null ? [`Snapped from the picked cell ${cellName(snapped)} to the strongest channel nearby`] : []),
        `Contributing cells: ${cells.toLocaleString('en-US')}`,
        `Catchment area: ${areaText(cells, contaminated[c.outletCell] === 1)}`,
        ...(contaminated[c.outletCell] === 1 ? ['Survey-edge cells drain into this catchment, so the area is a lower bound.'] : []),
      );
    }
  }

  // ── depressions ──
  let depressions: DrainageTable | null = null;
  if (sections.includes('depressions')) {
    const elevationOrigin = options.verticalResolved === false ? null : options.elevationOrigin ?? null;
    const all = [...result.depressions.depressions].sort((a, b) => b.cells - a.cells || a.rank - b.rank);
    const limit = Math.max(0, options.depressionRows ?? DRAINAGE_DEPRESSION_ROWS);
    const shown = all.slice(0, limit);
    const vs = verticalSuffix(vLabel).trim();
    depressions = {
      header: ['Rank', 'Cells', 'Area (m2)', `Max fill depth (${vs})`, elevationOrigin == null ? `Outlet elev. local (${vs})` : `Outlet elev. (${vs})`, 'Seed col', 'Seed row'],
      rows: shown.map((d) => {
        const col = d.seedCell % cols;
        return [
          String(d.rank), d.cells.toLocaleString('en-US'),
          d.areaM2 == null ? '' : num(d.areaM2, 1),
          d.maxFillDepth == null ? '' : num(d.maxFillDepth, 3),
          d.outletElevation == null ? '' : num(d.outletElevation + (elevationOrigin ?? 0), 3),
          String(col), String((d.seedCell - col) / cols),
        ];
      }),
      note: all.length === 0
        ? 'No depressions were catalogued.'
        : `${shown.length} of ${all.length} shown, largest first.${elevationOrigin == null ? ' Outlet elevations are in the load-time recentred frame.' : ''}${conditioning === 'raw' ? ' Raw mode records no fill depth or outlet elevation.' : ''}`,
    };
  }

  return {
    title: 'Drainage sheet',
    basename,
    generated: options.generationDateIso ?? new Date().toISOString(),
    build: buildIdentityProvenance(build),
    preview,
    statusLines,
    sections,
    map,
    summary,
    traced,
    depressions,
    catchmentStudy,
    catchmentStudyWithheld,
  };
}

// ── drawing ─────────────────────────────────────────────────────────────
//
// The sheet is the watershed report (cover, reading guide and site map,
// catchment pages, data quality and method, appendix A) with the drainage
// sheet's own parts drawn in the same page kit between them: the plan-view
// drainage map and the hydrology summary after the site map, the traced path
// and depression table before the data quality page.

const WATER = rgb(0.08, 0.36, 0.78), PATH = rgb(0.8, 0.12, 0.1), CATCH = rgb(0.93, 0.55, 0.12);
const safe = winAnsiSafe;

const SECTION_LABEL: Readonly<Record<DrainageSheetSection, string>> = {
  map: 'Drainage map', summary: 'Hydrology summary', catchment: 'Catchment study', traced: 'Traced path and catchment', depressions: 'Depressions',
};

function text(page: PDFPage, s: string, x: number, y: number, size: number, fonts: ReportFonts, bold = false, color = PALETTE.ink): number {
  return drawRuns(page, safe(s), x, y, { font: bold ? fonts.bodyBold : fonts.body, size, color }, fonts);
}

/** The plan-view drainage map, full text width, with its legend and frame notes below. */
function drawDrainageMap(c: PageCursor, doc: PDFDocument, result: FlowPulseResult, map: DrainageMapModel, fonts: ReportFonts, roomBelow = 0): PageCursor {
  const page = c.page;
  let cur = heading(c, 'Drainage map', 'Flow lines, outlets and your selection', null, fonts);
  const g = result.grid;
  const cols = g.cols, rows = g.rows;
  const box = { minX: map.ox, minY: map.oy, maxX: map.ox + cols * map.cellX, maxY: map.oy + rows * map.cellY };
  // Room for the legend, plus any text the caller sets below it on this page.
  const legendH = 170 + roomBelow;
  const mapH = cur.y - 14 - cur.bottom - legendH;
  const frame = { x: cur.left + 40, y: cur.bottom + legendH, w: cur.right - cur.left - 44, h: roomBelow > 0 ? Math.min(mapH, 225) : mapH };
  frame.y = cur.y - 14 - frame.h;
  const t = fitTransform(box, frame);
  // Top-align the map under the heading.
  const oy = frame.y + frame.h - t.drawnH;
  const px = (wx: number): number => t.ox + (wx - box.minX) * t.scale;
  const py = (wy: number): number => oy + (wy - box.minY) * t.scale;
  const cellCentre = (cell: number): [number, number] => {
    const col = cell % cols, row = (cell - col) / cols;
    return [px(map.ox + (col + 0.5) * map.cellX), py(map.oy + (row + 0.5) * map.cellY)];
  };

  // Hillshade, as a grey image (row 0 of the image is the northern row).
  const step = Math.max(1, Math.ceil(Math.max(cols, rows) / 1400));
  const iw = Math.ceil(cols / step), ih = Math.ceil(rows / step);
  const shade = hillshade(g);
  const pixels = new Uint8Array(iw * ih);
  for (let y = 0; y < ih; y++) {
    const row = rows - 1 - Math.min(rows - 1, y * step);
    for (let x = 0; x < iw; x++) {
      const i = row * cols + Math.min(cols - 1, x * step);
      pixels[y * iw + x] = g.valid[i] ? Math.round(120 + 128 * shade[i]!) : 255;
    }
  }
  const img = doc.context.register(doc.context.flateStream(pixels, {
    Type: 'XObject', Subtype: 'Image', Width: iw, Height: ih, ColorSpace: 'DeviceGray', BitsPerComponent: 8,
  }));
  const imgName = page.node.newXObject('DrainageHillshade', img);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(t.drawnW, 0, 0, t.drawnH, t.ox, oy), drawObject(imgName), popGraphicsState());

  if (map.catchment) {
    const m = map.catchment.mask;
    for (let r = 0; r < rows; r++) {
      let col = 0;
      while (col < cols) {
        if (m[r * cols + col] !== 1) { col++; continue; }
        const c0 = col;
        while (col < cols && m[r * cols + col] === 1) col++;
        page.drawRectangle({
          x: px(map.ox + c0 * map.cellX), y: py(map.oy + r * map.cellY),
          width: (col - c0) * map.cellX * t.scale, height: map.cellY * t.scale, color: CATCH, opacity: 0.22,
        });
      }
    }
    const ring = map.catchment.divide.outer;
    if (ring.length >= 4) {
      const ops = [pushGraphicsState(), setStrokingRgbColor(0.78, 0.38, 0.05), setLineWidth(1.1)];
      for (let k = 0; k < ring.length; k += 2) {
        const x = px(map.ox + (ring[k]! / g.cellMetresX) * map.cellX), y = py(map.oy + (ring[k + 1]! / g.cellMetresY) * map.cellY);
        ops.push(k === 0 ? moveTo(x, y) : lineTo(x, y));
      }
      ops.push(stroke(), popGraphicsState());
      page.pushOperators(...ops);
    }
  }

  // Flow lines: each line cell to its D8 receiver, in three width classes.
  const up = result.accumulation.upstreamCells;
  let max = 1;
  for (const v of up) if (v > max) max = v;
  const recv = result.routed.receiver;
  for (const cls of [0, 1, 2]) {
    const ops = [pushGraphicsState(), setStrokingRgbColor(WATER.red, WATER.green, WATER.blue), setLineWidth(0.4 + cls * 0.6), setLineCap(LineCapStyle.Round)];
    let any = false;
    for (let i = 0; i < up.length; i++) {
      if (map.channel[i] !== 1) continue;
      if (Math.min(2, Math.floor(logScale(up[i]!, max) * 3)) !== cls) continue;
      const j = recv[i]!;
      if (j < 0) continue;
      const [x0, y0] = cellCentre(i), [x1, y1] = cellCentre(j);
      ops.push(moveTo(x0, y0), lineTo(x1, y1));
      any = true;
    }
    ops.push(stroke(), popGraphicsState());
    if (any) page.pushOperators(...ops);
  }

  if (map.path && map.path.length > 0) {
    const ops = [pushGraphicsState(), setStrokingRgbColor(PATH.red, PATH.green, PATH.blue), setLineWidth(1.7), setLineCap(LineCapStyle.Round)];
    map.path.forEach((cell, i) => { const [x, y] = cellCentre(cell); ops.push(i === 0 ? moveTo(x, y) : lineTo(x, y)); });
    ops.push(stroke(), popGraphicsState());
    page.pushOperators(...ops);
    const [sx, sy] = cellCentre(map.path[0]!);
    page.drawCircle({ x: sx, y: sy, size: 3.2, color: PATH });
    const [ex, ey] = cellCentre(map.path[map.path.length - 1]!);
    page.drawRectangle({ x: ex - 3.2, y: ey - 3.2, width: 6.4, height: 6.4, color: PATH });
  }
  for (const o of map.outlets) {
    const [x, y] = cellCentre(o);
    page.drawCircle({ x, y, size: 2.6, borderColor: WATER, borderWidth: 1, color: rgb(1, 1, 1) });
  }
  if (map.catchment) {
    const [x, y] = cellCentre(map.catchment.outletCell);
    page.drawCircle({ x, y, size: 3.6, borderColor: PALETTE.ink, borderWidth: 1, color: CATCH });
  }

  // Map grid with its coordinates.
  const stepW = niceStep(Math.max(box.maxX - box.minX, box.maxY - box.minY), 5);
  const dec = tickDecimals(stepW);
  for (const v of gridTicks(box.minX, box.maxX, stepW)) {
    const x = px(v);
    page.drawLine({ start: { x, y: oy }, end: { x, y: oy + t.drawnH }, thickness: 0.3, color: PALETTE.rule, opacity: 0.9 });
    const s = num(v, dec);
    text(page, s, x - widthOf(s, fonts.body, 7, fonts) / 2, oy - 10, 7, fonts, false, PALETTE.mute);
  }
  for (const v of gridTicks(box.minY, box.maxY, stepW)) {
    const y = py(v);
    page.drawLine({ start: { x: t.ox, y }, end: { x: t.ox + t.drawnW, y }, thickness: 0.3, color: PALETTE.rule, opacity: 0.9 });
    const s = num(v, dec);
    text(page, s, t.ox - 4 - widthOf(s, fonts.body, 7, fonts), y - 2.5, 7, fonts, false, PALETTE.mute);
  }
  page.drawRectangle({ x: t.ox, y: oy, width: t.drawnW, height: t.drawnH, borderColor: PALETTE.ink, borderWidth: 0.6 });
  // Grid north in the map corner.
  const nx = t.ox + t.drawnW - 14, ny = oy + t.drawnH - 8;
  page.drawRectangle({ x: nx - 10, y: ny - 30, width: 20, height: 28, color: rgb(1, 1, 1), opacity: 0.85 });
  page.drawSvgPath('M 0 0 L 5 13 L 0 10 L -5 13 Z', { x: nx, y: ny - 4, color: PALETTE.ink });
  text(page, 'N', nx - 3.5, ny - 27, 8, fonts, true);

  // Below the map: scale, frame notes on the left; the legend on the right.
  let ly = oy - 30;
  const colW = (cur.right - cur.left) / 2 - 10;
  const bar = scaleBar(t.scale, colW - 40);
  let leftY = ly;
  if (bar.barPt > 0) {
    const { unit, divisor } = scaleBarUnit(bar.totalGround, map.linearUnit);
    for (let i = 0; i < bar.segments; i++) {
      page.drawRectangle({ x: cur.left + (i * bar.barPt) / bar.segments, y: leftY, width: bar.barPt / bar.segments, height: 4, color: i % 2 ? rgb(1, 1, 1) : PALETTE.ink, borderColor: PALETTE.ink, borderWidth: 0.5 });
    }
    text(page, '0', cur.left - 2, leftY - 10, 7, fonts);
    const end = `${Number((bar.totalGround / divisor).toPrecision(6))} ${unit}`;
    text(page, end, cur.left + bar.barPt - widthOf(end, fonts.body, 7, fonts) / 2, leftY - 10, 7, fonts);
    leftY -= 26;
  }
  const scaleN = map.unitToMetres != null ? Math.round(mapScaleRatio(t.scale, map.unitToMetres)) : 0;
  let left: PageCursor = { ...cur, right: cur.left + colW, y: leftY + 6 };
  for (const line of [`Scale ${mapScaleLabel(scaleN, map.linearUnit)} on the printed page.`, `Coordinate system: ${map.crsText}.`, `${map.gridText}.`, 'Grey shading: hillshade of the analysed DTM, sun from the north-west.']) {
    left = paragraph(left, line, fonts, { size: 9 });
  }
  let right: PageCursor = { ...cur, left: cur.left + colW + 20, y: ly + 10 };
  right = { ...right, y: right.y - 2 };
  text(page, 'LEGEND', right.left, right.y - 9, 9, fonts, true, PALETTE.mute);
  let y = right.y - 24;
  const item = (draw: (x: number, y: number) => void, label: string): void => {
    draw(right.left + 8, y + 3);
    const p = paragraph({ ...right, left: right.left + 22, y: y + 9 }, label, fonts, { size: 9 });
    y = p.y - 6;
  };
  item((x, yy) => page.drawLine({ start: { x: x - 7, y: yy }, end: { x: x + 7, y: yy }, thickness: 1.5, color: WATER }),
    `Flow lines, ${map.channelCells.toLocaleString('en-US')} cells: ${map.channelBasis}. Wider lines drain more cells.`);
  item((x, yy) => page.drawCircle({ x, y: yy, size: 2.6, borderColor: WATER, borderWidth: 1, color: rgb(1, 1, 1) }),
    `Outlet on a flow line (${map.outlets.length} of ${result.summary.outletCount} outlets)`);
  if (map.catchment) {
    item((x, yy) => page.drawRectangle({ x: x - 7, y: yy - 3.5, width: 14, height: 7, color: CATCH, opacity: 0.45 }),
      map.catchment.kind === 'user' ? 'Your catchment, its divide and outlet' : 'Largest catchment on the grid, its divide and outlet');
  }
  if (map.path) {
    item((x, yy) => page.drawLine({ start: { x: x - 7, y: yy }, end: { x: x + 7, y: yy }, thickness: 1.7, color: PATH }),
      'Traced downstream path: circle at the start, square at the end');
  }
  item((x, yy) => page.drawRectangle({ x: x - 7, y: yy - 3.5, width: 14, height: 7, color: rgb(1, 1, 1), borderColor: PALETTE.rule, borderWidth: 0.6 }), 'No data');
  return { ...cur, y: Math.min(left.y, y) - 6 };
}

/** Hydrology summary and traced-path lines: `# ` starts a section, `- ` a list item, `Label: value` a lead. */
function drawLines(c: PageCursor, lines: readonly string[], fonts: ReportFonts): PageCursor {
  let cur = c;
  for (const raw of lines) {
    if (raw.startsWith('# ')) { cur = sectionTitle(cur, safe(raw.slice(2)), fonts); continue; }
    if (raw.startsWith('- ')) { cur = paragraph({ ...cur, left: cur.left + 10 }, safe(`- ${raw.slice(2)}`), fonts, { size: 9 }); cur = { ...cur, left: c.left }; continue; }
    const k = raw.indexOf(': ');
    const lead = k > 0 && k < 48 ? safe(raw.slice(0, k + 1)) : undefined;
    cur = paragraph(cur, safe(lead ? raw.slice(k + 2) : raw.trim()), fonts, { size: 9, ...(lead ? { lead } : {}) });
  }
  return cur;
}

function drawDepressionTable(c: PageCursor, table_: DrainageTable, fonts: ReportFonts): PageCursor {
  let cur = sectionTitle(c, 'Depressions, largest first', fonts);
  cur = paragraph(cur, safe(table_.note), fonts, { size: 9.5 });
  if (table_.rows.length === 0) return cur;
  const w = cur.right - cur.left;
  const shares = [0.08, 0.1, 0.14, 0.17, 0.25, 0.13, 0.13];
  return table(cur, table_.header.map((h, i) => ({ title: safe(h), align: i === 0 ? 'left' as const : 'right' as const, width: Math.floor(w * shares[i]!) })), table_.rows, fonts, { size: 9 });
}

/** Default Helvetica faces, used only when the report fonts cannot be embedded. */
async function fallbackFonts(doc: PDFDocument): Promise<ReportFonts> {
  const body = await doc.embedFont(StandardFonts.Helvetica);
  const bodyBold = await doc.embedFont(StandardFonts.HelveticaBold);
  return { title: body, titleBold: bodyBold, body, bodyBold, symbol: await doc.embedFont(StandardFonts.Symbol) };
}

export interface DrainageSheetRenderOptions {
  /** Font loader; the browser default fetches the bundled fonts. */
  readonly loadFont?: (name: string) => Promise<Uint8Array>;
  /** PNG encoder for the map rasters. Default the platform-zlib encoder. */
  readonly encodePng?: (rgba: Uint8Array, w: number, h: number) => Promise<Uint8Array>;
  readonly size?: PageSize;
}

/** Build the drainage sheet PDF. Needs `options.dtm` (the analysed DTM). */
export async function buildFlowDrainageSheetPdf(
  result: FlowPulseResult, options: FlowDrainageSheetOptions = {}, render: DrainageSheetRenderOptions = {},
): Promise<Uint8Array> {
  const model = buildDrainageSheetModel(result, options);
  const study = model.catchmentStudy;
  if (!study) throw new Error('The drainage sheet needs the analysed DTM of the run.');
  const status = model.statusLines.slice(0, 1).join(' ');
  const { bytes } = await renderWatershedReport(study.model, {
    size: render.size ?? 'letter',
    encodePng: render.encodePng ?? encodePng,
    loadFont: render.loadFont,
    fallbackFonts,
    raster: { grid: result.grid, coverage: options.dtm!.coverage, filled: result.filled },
    sourceName: result.record.source.filename ?? null,
    catchmentNames: study.names,
    status: model.preview ? status : null,
    afterSiteMap: async (h) => {
      // The map page carries the traced path and catchment under its legend; the
      // summary page carries the depression table after the hydrology figures.
      if (model.map) {
        let c = drawDrainageMap(h.start('M', SECTION_LABEL.map), h.doc, result, model.map, h.fonts, model.traced ? 15 * model.traced.length : 0);
        if (model.traced) c = drawLines(c, model.traced, h.fonts);
        h.tag('map');
      }
      const traced = model.map ? null : model.traced;
      if (model.summary || traced || model.depressions) {
        const title = model.summary ? 'What the run found' : 'Your selection';
        let c = heading(h.start('H', model.summary ? SECTION_LABEL.summary : SECTION_LABEL.traced), model.summary ? 'Hydrology summary' : 'Traced path and depressions', title, null, h.fonts);
        if (model.summary) {
          c = paragraph(c, safe(model.statusLines.join(' ')), h.fonts, { size: 9 });
          c = drawLines(c, model.summary, h.fonts);
        }
        if (traced) c = drawLines(c, traced, h.fonts);
        if (model.depressions) drawDepressionTable(c, model.depressions, h.fonts);
        h.tag('summary');
      }
    },
  });
  return bytes;
}
