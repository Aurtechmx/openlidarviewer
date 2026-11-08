/**
 * watershedValley.ts: a synthetic valley for the watershed map and chart
 * tests. A main valley drains south, a tributary joins it from the north-east,
 * an eastern valley drains east, a pit sits on the main channel, a diagonal
 * band of ground is interpolated and a small NoData hole lies off the channel.
 */
import { FLOW_PULSE_DEFAULTS, runFlowPulse, type FlowPulseResult } from '../../src/simulation/flowPulse/flowPulseRunner';
import type { HorizontalScale } from '../../src/simulation/flowPulse/dtmFlowGrid';
import {
  buildWatershedReportModel,
  type ReportLanguage,
  type WatershedReportModel,
} from '../../src/simulation/flowPulse/watershed/watershedReportModel';
import type { DtmGrid } from '../../src/terrain/ground/cellConfidence';
import { edgeContamination } from '../../src/simulation/flowPulse/edgeContamination';
import { partitionWatersheds } from '../../src/simulation/flowPulse/watershed/watershedPartition';
import { FLOW_PROJECTED_SCALE, FLOW_TEST_IDENTITY, flowDtmOf } from '../helpers/flowFixtures';

export interface Valley {
  readonly dtm: DtmGrid;
  readonly result: FlowPulseResult;
  readonly model: WatershedReportModel;
}

const COLS = 120;
const ROWS = 80;

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): { d: number; t: number } {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return { d: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t };
}

export function valleyHeight(c: number, r: number): number | null {
  if (Math.hypot(c - 22, r - 58) < 3.2) return null;
  const cx = 52 + 7 * Math.sin(r / 11);
  const main = 0.22 * r + 0.32 * Math.abs(c - cx);
  // Tributary from the north-east, joining the main valley at row 22.
  const tr = distToSeg(c, r, 52 + 7 * Math.sin(2), 22, 92, 74);
  const trib = 0.22 * 22 + 0.6 + tr.t * 12 + 0.34 * tr.d;
  // Eastern valley draining to the east edge.
  const east = 0.24 * (COLS - 1 - c) + 0.3 * Math.abs(r - 30) + 3;
  let z = Math.min(main, trib, east);
  // A rim a few cells inside the survey edge, open where the two valleys leave,
  // so the studied catchments are complete.
  const edges = [c, ROWS - 1 - r];
  if (Math.abs(c - cx) > 9) edges.push(r);
  if (Math.abs(r - 30) > 7) edges.push(COLS - 1 - c);
  const d = Math.min(...edges);
  z += 5 * Math.max(0, 1 - Math.abs(d - 5) / 5);
  z += 0.35 * Math.sin(c * 0.61) * Math.cos(r * 0.47) + 0.2 * Math.sin((c + 2 * r) * 0.23);
  // A pit on the main channel.
  const pit = Math.hypot(c - (52 + 7 * Math.sin(40 / 11)), r - 40);
  if (pit < 3) z -= 1.4 * (1 - pit / 3);
  return 100 + z;
}

/**
 * `withOpen` adds a third outlet, C3, at the terminal of an edge-contaminated
 * watershed, so its catchment is open.
 */
export function buildValley(opts: { language?: ReportLanguage; crsName?: string | null; scale?: HorizontalScale; cellSizeM?: number; withOpen?: boolean } = {}): Valley {
  const rows = Array.from({ length: ROWS }, (_, r) => Array.from({ length: COLS }, (_, c) => valleyHeight(c, r)));
  const dtm = flowDtmOf(rows, { cellSizeM: opts.cellSizeM ?? 3 });
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const i = r * COLS + c;
      if (dtm.coverage[i] === 0) continue;
      const s = c + r;
      if (s >= 64 && s <= 71 && r > 6 && r < 66) dtm.coverage[i] = 1;
      dtm.confidence[i] = dtm.coverage[i] === 2 ? 90 : 50;
      // Nine ground returns in each measured 3 m cell: one point per square metre.
      dtm.counts[i] = dtm.coverage[i] === 2 ? 9 : 0;
    }
  }
  (dtm as { analyzedPointCount: number }).analyzedPointCount = COLS * ROWS * 9;
  const result = runFlowPulse(dtm, opts.scale ?? FLOW_PROJECTED_SCALE, { ...FLOW_PULSE_DEFAULTS }, FLOW_TEST_IDENTITY);
  if (!result.ok) throw new Error(result.reason);
  const up = result.accumulation.upstreamCells;
  const best = (row: number, pred: (c: number) => boolean) => {
    let at = -1;
    for (let c = 0; c < COLS; c++) {
      const i = row * COLS + c;
      if (pred(c) && (at < 0 || up[i] > up[at])) at = i;
    }
    return at;
  };
  const c1 = best(3, () => true);
  const c2 = best(40, (c) => c > 70);
  const model = buildWatershedReportModel({
    result, dtm,
    outlets: [
      { cell: c1, label: 'C1', snappedFromCell: null }, { cell: c2, label: 'C2', snappedFromCell: null },
      ...(opts.withOpen ? [{ cell: openOutlet(result), label: 'C3', snappedFromCell: null }] : []),
    ],
    language: opts.language ?? 'en', title: 'Valley test site', thresholdM2: 2500,
    verticalToMetres: 1, originZ: null, crsName: opts.crsName === undefined ? null : opts.crsName,
    generatedAt: new Date('2026-10-25T12:00:00Z'), software: 'OpenLiDARViewer test', sourceSha256: null,
  });
  return { dtm, result, model };
}

/** The terminal of the third-largest watershed: on the north edge and edge-contaminated. */
function openOutlet(result: FlowPulseResult): number {
  const edge = edgeContamination(result.grid, result.routed);
  const part = partitionWatersheds(result.grid, result.routed, result.accumulation, edge);
  const w = part.watersheds.filter((x) => !x.minor && !x.complete)[2];
  if (!w || edge.contaminated[w.terminal] !== 1) throw new Error('valley: no open watershed for C3');
  return w.terminal;
}
