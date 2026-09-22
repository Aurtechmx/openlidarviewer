/**
 * flowPulseRunner.ts — one flow run, from a terrain product to a sealed record.
 *
 * The panel should not orchestrate this. Routing, conditioning, accumulation,
 * the input basis and the run record each have their own module, and a UI that
 * called them in sequence would own the order they run in, the refusals, and
 * the wording of the limitations. It would also be the only place those
 * decisions were tested, which is to say the place they were not.
 *
 * So this is the seam: a DTM and a set of parameters in, one of two things
 * out. Either a result with a sealed record, or a refusal that says which
 * precondition failed. There is no third shape and no partially-filled result,
 * because a caller that has to inspect a result to find out whether it is real
 * will eventually forget to.
 *
 * ── REFUSALS ARE TYPED, NOT THROWN ──────────────────────────────────────────
 * A missing DTM and an oversized grid are ordinary answers to "can this run",
 * not exceptions. Throwing would put them in the same channel as a genuine
 * defect, and the UI would render "something went wrong" for a condition it
 * should explain precisely.
 *
 * ── WHAT IS WITHHELD RATHER THAN REFUSED ────────────────────────────────────
 * An unresolved horizontal scale does not stop a run. Flow direction follows
 * from the ratio of the two axis lengths, which survives not knowing what a
 * unit is worth in metres; contributing area in square metres does not. So the
 * run proceeds, reports cell counts, and withholds the area. Refusing outright
 * would deny a reader a usable answer; reporting square metres anyway would
 * give them a fabricated one.
 *
 * A geographic frame with no latitude is the exception, and it is refused.
 * There the east–west length of a cell is the north–south length times cos φ,
 * so without φ the ratio between the axes is itself unknown, and D8 compares
 * diagonal and cardinal drops through exactly that ratio. The direction would
 * be as invented as the area.
 *
 * Pure: no DOM, no three.js, no I/O, no clock of its own.
 */

import { d8Flow, traceDownstream, type D8Result } from './d8Flow';
import {
  catchmentOf,
  contributingAreaM2,
  flowAccumulation,
  type AccumulationResult,
} from './flowAccumulation';
import { filledCells, priorityFlood, type PriorityFloodResult } from './priorityFlood';
import { terrainDtmToFlowGrid, type HorizontalScale, type InterpolatedPolicy } from './dtmFlowGrid';
import { basisLimitations, mayReportMetricArea } from '../simulationInputBasis';
import { sealRunRecord, type FieldSimulationRunRecord } from '../simulationRunRecord';
import type { FlowGrid } from './flowTypes';
import type { SimulationInputBasis } from '../simulationInputBasis';
import type { DtmGrid } from '../../terrain/ground/cellConfidence';

/** Whether depressions are left as they are, or filled into a second surface. */
export type FlowConditioning = 'raw' | 'priority-flood';

/** The only routing model this release ships. Verified, so it is the only one offered. */
export type FlowRoutingMethod = 'd8';

/** Why a run could not happen. */
export type FlowRefusalCode =
  /** No terrain product was supplied. */
  | 'NO_DTM'
  /** The grid holds no cell a model may read. */
  | 'NO_VALID_CELL'
  /** The grid exceeds the declared cell budget. */
  | 'TOO_LARGE'
  /** A geographic frame with no latitude, so the cell's shape is unknown. */
  | 'UNITS_UNRESOLVED';

/** A run that did not happen, and the precondition that stopped it. */
export interface FlowRefusal {
  readonly ok: false;
  readonly code: FlowRefusalCode;
  /** One sentence for a reader, naming what would make the run possible. */
  readonly reason: string;
}

/** What a completed run measured. */
export interface FlowPulseResult {
  readonly ok: true;
  readonly grid: FlowGrid;
  readonly routed: D8Result;
  readonly accumulation: AccumulationResult;
  /** Null when the horizontal scale is unresolved. */
  readonly contributingAreaM2: Float64Array | null;
  /** Present only when conditioning ran. */
  readonly conditioned: PriorityFloodResult | null;
  /** Cells the conditioning raised, or null in raw mode. */
  readonly filled: Uint8Array | null;
  readonly basis: SimulationInputBasis;
  readonly limitations: readonly string[];
  readonly record: FieldSimulationRunRecord;
  readonly summary: FlowSummary;
}

/** The figures a panel shows without reading an array. */
export interface FlowSummary {
  readonly cells: number;
  readonly readableCells: number;
  readonly sinkCount: number;
  readonly flatCount: number;
  readonly outletCount: number;
  /** Largest upstream cell count on the grid. */
  readonly maxUpstreamCells: number;
  /** Largest contributing area, or null when metres are withheld. */
  readonly maxContributingAreaM2: number | null;
  /** Cells the conditioning raised, or null in raw mode. */
  readonly cellsRaised: number | null;
  /** Deepest fill, or null in raw mode. */
  readonly maxFillDepth: number | null;
  /**
   * Fill increments Float32 could not represent, or null in raw mode.
   * Non-zero means part of the surface is still flat after conditioning.
   */
  readonly epsilonAbsorbed: number | null;
}

/** What a run was asked to do. */
export interface FlowPulseParams {
  readonly conditioning: FlowConditioning;
  readonly routing: FlowRoutingMethod;
  /** How a cell whose height was interpolated is treated. */
  readonly interpolated: InterpolatedPolicy;
  /** Rise above the spill parent when conditioning, in the vertical unit. */
  readonly fillEpsilon: number;
  /** Refuse a grid larger than this. */
  readonly maxCells: number;
  /** The caller's declaration about Withheld points behind the DTM. */
  readonly withheldExcluded: boolean | null;
}

/** Defaults a panel can offer, all of them declared rather than hidden. */
export const FLOW_PULSE_DEFAULTS: FlowPulseParams = Object.freeze({
  conditioning: 'raw',
  routing: 'd8',
  interpolated: 'route',
  fillEpsilon: 0.001,
  maxCells: 4_000_000,
  withheldExcluded: null,
});

/** The registered methods a run uses, in the order it uses them. */
export function methodsFor(params: FlowPulseParams): readonly string[] {
  const out: string[] = [];
  if (params.conditioning === 'priority-flood') {
    out.push('olv.simulation.terrain-flow.priority-flood');
  }
  out.push('olv.simulation.terrain-flow.d8', 'olv.simulation.terrain-flow.accumulation');
  return out;
}

/** Identity of the run's inputs, supplied by the caller rather than invented. */
export interface FlowRunIdentity {
  readonly layerId: string | null;
  readonly filename: string | null;
  readonly sourceDigest: string | null;
  /** Digest of the exact terrain product read. */
  readonly analysisInputDigest: string;
  readonly build: string;
  readonly id: string;
  readonly generatedAt: string;
  readonly processingManifestHead: string | null;
}

/**
 * Run one flow simulation over `dtm`.
 *
 * The order is fixed and is the processing manifest: condition, route,
 * accumulate. Conditioning produces a second surface and routing reads that
 * one; the canonical DTM is never modified, so a raw run and a conditioned run
 * over the same terrain are two answers about one unchanged input.
 */
export function runFlowPulse(
  dtm: DtmGrid | null,
  scale: HorizontalScale,
  params: FlowPulseParams,
  identity: FlowRunIdentity,
): FlowPulseResult | FlowRefusal {
  if (!dtm) {
    return {
      ok: false, code: 'NO_DTM',
      reason: 'No terrain surface is available. Run terrain analysis on a loaded scan first.',
    };
  }

  if (scale.isGeographic && !Number.isFinite(scale.latitudeDeg ?? Number.NaN)) {
    return {
      ok: false, code: 'UNITS_UNRESOLVED',
      reason: 'The terrain is in geographic degrees and its latitude is unknown, so the '
        + 'east–west length of a cell cannot be derived. Assign a CRS that resolves the latitude.',
    };
  }

  const cells = dtm.cols * dtm.rows;
  if (cells > params.maxCells) {
    return {
      ok: false, code: 'TOO_LARGE',
      reason: `The terrain grid holds ${cells} cells, above the ${params.maxCells} this run allows. `
        + 'Analyse a smaller extent or a coarser cell size.',
    };
  }

  const { grid, basis } = terrainDtmToFlowGrid(dtm, scale, {
    interpolated: params.interpolated,
    withheldExcluded: params.withheldExcluded,
  });

  if (basis.measuredCells === 0) {
    return {
      ok: false, code: 'NO_VALID_CELL',
      reason: params.interpolated === 'block'
        ? 'No cell carries a measured elevation. Allow interpolated cells, or analyse terrain with more ground returns.'
        : 'No cell in the terrain grid carries an elevation.',
    };
  }

  // Conditioning first: routing reads whichever surface the caller declared.
  const conditioned = params.conditioning === 'priority-flood'
    ? priorityFlood(grid, { epsilon: params.fillEpsilon })
    : null;
  const routingGrid: FlowGrid = conditioned ? { ...grid, z: conditioned.z } : grid;
  const filled = conditioned ? filledCells(grid, conditioned) : null;

  const routed = d8Flow(routingGrid);
  const accumulation = flowAccumulation(routingGrid, routed);
  const area = contributingAreaM2(accumulation, routingGrid, mayReportMetricArea(basis));

  let maxUpstream = 0;
  for (const upstream of accumulation.upstreamCells) {
    if (upstream > maxUpstream) maxUpstream = upstream;
  }

  const summary: FlowSummary = {
    cells,
    readableCells: basis.measuredCells,
    sinkCount: routed.sinkCount,
    flatCount: routed.flatCount,
    outletCount: routed.outletCount,
    maxUpstreamCells: maxUpstream,
    maxContributingAreaM2: area ? maxUpstream * grid.cellMetresX * grid.cellMetresY : null,
    cellsRaised: conditioned ? conditioned.cellsRaised : null,
    maxFillDepth: conditioned ? conditioned.maxFillDepth : null,
    epsilonAbsorbed: conditioned ? conditioned.epsilonAbsorbed : null,
  };

  const limitations = [...basisLimitations(basis), ...modelLimitations(params, summary)];

  const record = sealRunRecord({
    schemaVersion: 1,
    id: identity.id,
    generatedAt: identity.generatedAt,
    build: identity.build,
    kind: 'terrain-flow',
    source: {
      layerId: identity.layerId,
      filename: identity.filename,
      sourceDigest: identity.sourceDigest,
      analysisInputDigest: identity.analysisInputDigest,
      basis,
    },
    model: { id: 'olv.simulation.terrain-flow.d8', version: 1 },
    methods: methodsFor(params),
    parameters: {
      conditioning: params.conditioning,
      routing: params.routing,
      interpolated: params.interpolated,
      fillEpsilon: params.conditioning === 'priority-flood' ? params.fillEpsilon : null,
      maxCells: params.maxCells,
    },
    // The summary, not the arrays: a digest over a million cells would change
    // with any reordering of an array that carries the same field, and the
    // figures below are what a reader compares between two runs.
    result: { ...summary },
    limitations,
    processingManifestHead: identity.processingManifestHead,
  });

  return {
    ok: true, grid: routingGrid, routed, accumulation, contributingAreaM2: area,
    conditioned, filled, basis, limitations, record, summary,
  };
}

/**
 * What the model itself obliges the result to disclose.
 *
 * Separate from the basis limitations, which are about the input. These are
 * about the method: what D8 cannot represent, and what conditioning changed.
 */
export function modelLimitations(
  params: FlowPulseParams,
  summary: FlowSummary,
): readonly string[] {
  const out: string[] = [
    'A topographic routing graph over the declared surface. It is not rainfall, '
    + 'runoff, infiltration or flood modelling, and accumulation counts cells '
    + 'rather than water.',
  ];

  if (params.conditioning === 'raw') {
    if (summary.sinkCount > 0) {
      out.push(
        `${summary.sinkCount} cell(s) have no lower neighbour and keep their flow. `
        + 'Raw routing leaves real depressions in place rather than filling them.',
      );
    }
    if (summary.flatCount > 0) {
      out.push(
        `${summary.flatCount} cell(s) sit level with a neighbour and are reported `
        + 'unresolved. Raw routing does not choose a direction across a flat.',
      );
    }
  } else {
    out.push(
      `Routed over a conditioned drainage surface, not the terrain: `
      + `${summary.cellsRaised ?? 0} cell(s) were raised, the deepest by `
      + `${(summary.maxFillDepth ?? 0).toFixed(3)}. The canonical DTM is unchanged.`,
    );
    if ((summary.epsilonAbsorbed ?? 0) > 0) {
      out.push(
        `${summary.epsilonAbsorbed} filled cell(s) could not be raised above their `
        + 'spill level at this precision, so part of the surface is still flat.',
      );
    }
  }

  return out;
}

/** The downstream path from one cell, for a click-to-pulse. */
export function pulseFrom(result: FlowPulseResult, cell: number): Int32Array {
  return traceDownstream(result.routed, cell);
}

/** Everything draining to one cell, for a catchment query. */
export function catchmentFrom(result: FlowPulseResult, outlet: number): Uint8Array {
  return catchmentOf(result.grid, result.routed, outlet);
}

export { CELL_FLAT, CELL_OUTLET, CELL_SINK } from './flowTypes';
