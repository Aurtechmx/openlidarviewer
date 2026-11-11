/**
 * watershedReportModel.ts — everything the watershed study prints, computed
 * once and held as plain data so the renderer only lays it out.
 *
 * The model composes the partition, the traced divides, the morphometrics,
 * the main channel, the time of concentration and the quality grade for each
 * catchment the reader picked (or, when none was picked, the largest
 * watersheds). It also decides whether the run may be exported at all: the
 * report is offered only for a complete, metre-scaled, conditioned run.
 *
 * Pure: no DOM, no clock (the caller passes `generatedAt`), no I/O.
 */

import { CELL_NODATA, D8_NEIGHBOURS, type FlowGrid } from '../flowTypes';
import { traceDownstream } from '../d8Flow';
import { edgeContamination, surveyEdgeCells } from '../edgeContamination';
import {
  catchmentFrom,
  type FlowPulseResult,
} from '../flowPulseRunner';
import { depressionMembers, type DepressionEntry } from '../depressionInventory';
import type { DtmGrid } from '../../../terrain/ground/cellConfidence';
import { partitionWatersheds, type WatershedPartition } from './watershedPartition';
import { buildFlowNetwork, networkWithin, type FlowNetwork } from './flowNetwork';
import { traceDivide, type TracedDivide } from './divideTrace';
import { catchmentMorphometrics, type Figure, type Morphometrics } from './catchmentMorphometrics';
import { mainChannel, type MainChannel } from './mainChannel';
import { catchmentQuality, type CatchmentQuality } from './catchmentQuality';

export type ReportLanguage = 'en' | 'es';

export interface ReportOutlet {
  readonly cell: number;
  readonly label: string;
  /** The cell the reader clicked when the outlet was snapped, else null. */
  readonly snappedFromCell: number | null;
}

export { watershedReportGate, type ReportGate } from './reportGate';

/** Outlets the reader may pick. */
export const MAX_REPORT_OUTLETS = 5;
/** Watersheds printed when the reader picked none. */
export const MAX_AUTOMATIC_SECTIONS = 3;

/** The registered methods the report adds to the run's own. */
export const REPORT_METHOD_IDS: readonly string[] = Object.freeze([
  'olv.simulation.terrain-flow.watersheds',
  'olv.simulation.terrain-flow.network-strahler',
  'olv.simulation.terrain-flow.divide-trace',
  'olv.simulation.terrain-flow.morphometrics',
  'olv.simulation.terrain-flow.main-channel',
  'olv.simulation.terrain-flow.catchment-quality',
  'olv.simulation.terrain-flow.narrative',
]);

export interface CatchmentSection {
  /** C1..C5 or W<n> for automatic. */
  readonly label: string;
  readonly automatic: boolean;
  readonly outlet: number;
  readonly mask: Uint8Array;
  readonly divide: TracedDivide;
  readonly morph: Morphometrics;
  readonly channel: MainChannel;
  readonly network: ReturnType<typeof networkWithin>;
  /**
   * `onMainChannel`: a member cell lies on the main channel. `onFlowLine`: a
   * member cell lies on the main channel or on a flow line inside the catchment.
   */
  readonly depressions: readonly (DepressionEntry & { readonly onMainChannel: boolean; readonly onFlowLine: boolean })[];
  /** Largest depression on the main channel; null when none sits on it. */
  readonly checkOnSite: DepressionEntry | null;
  readonly quality: CatchmentQuality;
  /**
   * Share of the catchment's boundary cells that lie on the survey edge and
   * route inward, 0..1, as WatershedInfo.edgeInflowShare counts it.
   */
  readonly edgeInflowShare: number;
  /** Outlet to data edge. */
  readonly downstreamPathCells: Int32Array;
  /** Where things lie, in metres east (dx) and north (dy) of the outlet, for the narrative. */
  readonly geometry: SectionGeometry;
}

export interface SectionGeometry {
  /** Highest cell of the catchment. */
  readonly highPoint: { readonly dxM: number; readonly dyM: number };
  /** First main-channel cell on the flow network; null when the channel never reaches it. */
  readonly channelHead: { readonly dxM: number; readonly dyM: number; readonly distFromDivideM: number } | null;
  /** Height of the channel's divide end above the outlet. */
  readonly channelDropM: Figure<number>;
  /** Outlet to the data edge; null when the outlet is on the edge. */
  readonly downstream: { readonly lengthM: number; readonly dxM: number; readonly dyM: number } | null;
}

function sectionGeometry(
  grid: FlowPulseResult['grid'],
  outlet: number,
  mask: Uint8Array,
  channel: MainChannel,
  onNetwork: Uint8Array,
  downstream: Int32Array,
): SectionGeometry {
  const { cols, cellMetresX: sx, cellMetresY: sy } = grid;
  const oc = outlet % cols;
  const or = Math.floor(outlet / cols);
  // Row 0 is the southern row, so a larger row is further north.
  const offset = (i: number) => ({ dxM: (i % cols - oc) * sx, dyM: (Math.floor(i / cols) - or) * sy });

  let high = outlet;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 1 && grid.valid[i] === 1 && grid.z[i] > grid.z[high]) high = i;
  }

  let channelHead: SectionGeometry['channelHead'] = null;
  for (let k = 0; k < channel.cells.length; k++) {
    if (onNetwork[channel.cells[k]] === 1) {
      const d = channel.profile.distanceM[k];
      channelHead = { ...offset(channel.cells[k]), distFromDivideM: Number.isFinite(d) ? d : 0 };
      break;
    }
  }

  let channelDropM: Figure<number>;
  const L = channel.lengthM;
  const e0 = channel.profile.elevationM.length > 0 ? channel.profile.elevationM[0] : NaN;
  if ('withheld' in L) channelDropM = L;
  else if (!Number.isFinite(e0)) channelDropM = { withheld: 'vertical-unresolved' };
  else channelDropM = L.bound === 'minimum' ? { value: e0, bound: 'minimum' } : { value: e0 };

  let down: SectionGeometry['downstream'] = null;
  if (downstream.length > 1) {
    let lengthM = 0;
    for (let k = 1; k < downstream.length; k++) {
      const a = offset(downstream[k - 1]);
      const b = offset(downstream[k]);
      lengthM += Math.hypot(b.dxM - a.dxM, b.dyM - a.dyM);
    }
    down = { lengthM, ...offset(downstream[downstream.length - 1]) };
  }
  return { highPoint: offset(high), channelHead, channelDropM, downstream: down };
}

/** Boundary cells of the mask on the survey edge that route inward, over all its boundary cells. */
function maskEdgeInflowShare(grid: FlowGrid, receiver: Int32Array, mask: Uint8Array, surveyEdge: Uint8Array): number {
  const { cols, rows } = grid;
  let boundary = 0;
  let inward = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      if (mask[i] !== 1) continue;
      let onBoundary = false;
      for (const [dc, dr] of D8_NEIGHBOURS) {
        const nc = col + dc, nr = row + dr;
        if (nc < 0 || nc >= cols || nr < 0 || nr >= rows || mask[nr * cols + nc] !== 1) { onBoundary = true; break; }
      }
      if (!onBoundary) continue;
      boundary++;
      if (surveyEdge[i] === 1 && receiver[i]! >= 0) inward++;
    }
  }
  return boundary > 0 ? inward / boundary : 0;
}

export interface WatershedReportModel {
  readonly language: ReportLanguage;
  readonly title: string;
  readonly partition: WatershedPartition;
  readonly network: FlowNetwork;
  readonly sections: readonly CatchmentSection[];
  readonly site: {
    readonly analysedAreaM2: number;
    readonly cellSizeM: readonly [number, number];
    /** Share of the cells that carry an elevation whose ground is measured, not interpolated. */
    readonly measuredShare: number;
    /** Share of the whole grid that carries an elevation. */
    readonly gridDataShare: number;
    readonly pointCount: number;
    readonly crsName: string | null;
    readonly elevationsRelative: boolean;
    readonly verticalResolved: boolean;
  };
  readonly provenance: {
    readonly methodIds: readonly string[];
    readonly runDigest: string;
    readonly fieldDigest: string;
    readonly sourceSha256: string | null;
    readonly software: string;
    readonly generatedAt: Date;
  };
}

function emptyNetwork(cells: number, thresholdM2: number): FlowNetwork {
  return { thresholdM2, onNetwork: new Uint8Array(cells), segments: [], stepM: new Float64Array(cells) };
}

export function chooseOutlets(
  partition: WatershedPartition,
  outlets: readonly ReportOutlet[],
): readonly { label: string; cell: number; automatic: boolean }[] {
  if (outlets.length > 0) {
    return outlets.slice(0, MAX_REPORT_OUTLETS).map((o) => ({ label: o.label, cell: o.cell, automatic: false }));
  }
  const real = partition.watersheds.filter((w) => !w.minor);
  const bySize = (a: { cells: number; id: number }, b: { cells: number; id: number }) => b.cells - a.cells || a.id - b.id;
  const ordered = [
    ...real.filter((w) => w.complete).sort(bySize),
    ...real.filter((w) => !w.complete).sort(bySize),
  ];
  return ordered.slice(0, MAX_AUTOMATIC_SECTIONS).map((w) => ({ label: `W${w.id}`, cell: w.terminal, automatic: true }));
}

export function buildWatershedReportModel(input: {
  result: FlowPulseResult;
  dtm: DtmGrid;
  outlets: readonly ReportOutlet[];
  language: ReportLanguage;
  title: string;
  thresholdM2: number;
  verticalToMetres: number | null;
  originZ: number | null;
  crsName: string | null;
  generatedAt: Date;
  software: string;
  sourceSha256: string | null;
}): WatershedReportModel {
  const { result, dtm } = input;
  const { grid, routed, basis } = result;
  const cells = grid.cols * grid.rows;
  // The site figures index dtm.coverage by flow-grid cell, so the two must match.
  if (dtm.cols !== grid.cols || dtm.rows !== grid.rows) {
    throw new RangeError('buildWatershedReportModel: the DTM and the flow grid must share cols and rows');
  }

  const edge = edgeContamination(grid, routed);
  const partition = partitionWatersheds(grid, routed, result.accumulation, edge);
  const network = result.contributingAreaM2 !== null
    ? buildFlowNetwork(grid, routed, result.contributingAreaM2, input.thresholdM2)
    : emptyNetwork(cells, input.thresholdM2);

  const surveyEdge = surveyEdgeCells(grid);
  const sections: CatchmentSection[] = chooseOutlets(partition, input.outlets).map((pick) => {
    const outlet = pick.cell;
    // An outlet must be a routed cell on the grid; a NoData or out-of-range
    // pick is a caller error and is refused rather than printed as an empty page.
    if (!Number.isInteger(outlet) || outlet < 0 || outlet >= cells || routed.status[outlet] === CELL_NODATA) {
      throw new RangeError(`buildWatershedReportModel: outlet ${outlet} is not a readable cell`);
    }
    const mask = catchmentFrom(result, outlet);
    const complete = edge.contaminated[outlet] === 0;
    const divide = traceDivide(grid, mask);
    const morph = catchmentMorphometrics({
      grid, mask, outlet, divide, complete,
      verticalToMetres: input.verticalToMetres, originZ: input.originZ,
    });
    const channel = mainChannel({
      grid, routed, outlet, mask, complete,
      verticalToMetres: input.verticalToMetres, coverage: dtm.coverage,
    });
    const within = networkWithin(network, mask);
    const quality = catchmentQuality({
      dtm, mask, channel, divide, complete, flowGrid: grid,
      horizontalScaleResolved: basis.horizontalScaleResolved,
    });

    const channelSet = new Set<number>(channel.cells);
    const depressions = result.depressions.depressions
      .filter((d) => mask[d.seedCell] === 1)
      .map((d) => {
        const members = depressionMembers(result.filled, grid.cols, grid.rows, d.seedCell);
        const onMainChannel = members.some((i) => channelSet.has(i));
        const onFlowLine = onMainChannel || members.some((i) => network.onNetwork[i] === 1 && mask[i] === 1);
        return { ...d, onMainChannel, onFlowLine };
      });
    const checkOnSite = depressions
      .filter((d) => d.onMainChannel)
      .reduce<DepressionEntry | null>((best, d) => (best === null || d.cells > best.cells ? d : best), null);

    const downstreamPathCells = traceDownstream(routed, outlet);
    return {
      label: pick.label, automatic: pick.automatic, outlet, mask, divide, morph, channel,
      network: within, depressions, checkOnSite, quality, downstreamPathCells,
      edgeInflowShare: maskEdgeInflowShare(grid, routed.receiver, mask, surveyEdge),
      geometry: sectionGeometry(grid, outlet, mask, channel, network.onNetwork, downstreamPathCells),
    };
  });

  // Site figures over the readable cells of the grid.
  let valid = 0;
  let measured = 0;
  for (let i = 0; i < cells; i++) {
    if (routed.status[i] === CELL_NODATA || grid.valid[i] !== 1) continue;
    valid++;
    if (dtm.coverage[i] === 2) measured++;
  }
  const vertical = input.verticalToMetres != null && Number.isFinite(input.verticalToMetres) && input.verticalToMetres > 0;

  return {
    language: input.language,
    title: input.title,
    partition,
    network,
    sections,
    site: {
      analysedAreaM2: valid * grid.cellMetresX * grid.cellMetresY,
      cellSizeM: [grid.cellMetresX, grid.cellMetresY],
      measuredShare: valid > 0 ? measured / valid : 0,
      gridDataShare: cells > 0 ? valid / cells : 0,
      pointCount: dtm.analyzedPointCount,
      crsName: input.crsName,
      elevationsRelative: input.originZ == null || !Number.isFinite(input.originZ),
      verticalResolved: vertical,
    },
    provenance: {
      methodIds: [...result.record.methods, ...REPORT_METHOD_IDS],
      runDigest: result.record.digest,
      fieldDigest: String(result.record.result.fieldDigest),
      sourceSha256: input.sourceSha256,
      software: input.software,
      generatedAt: input.generatedAt,
    },
  };
}
