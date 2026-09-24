/**
 * flowPulseLabProfile.test.ts — whether the Field Simulation Lab needs a worker.
 *
 * `flowPulseLab.ts` calls `runFlowPulse` synchronously on the UI thread. This
 * harness answers the question a worker migration would otherwise be built on
 * a guess: how long does each stage of that call actually take, at the grid
 * sizes the Lab can be handed. It drives the SAME functions `runFlowPulse`
 * calls, in the same order, over synthetic DTMs sized 250k/1M/2M/4M cells,
 * for both conditioning modes, and reports the median of several runs per
 * stage plus a memory delta. It changes nothing under `src/`.
 *
 * WHY NODE NUMBERS ARE A FLOOR, NOT THE ANSWER. This runs in Node's V8, not a
 * browser tab's main thread sharing a frame budget with layout, paint and
 * input handling. A browser main thread is typically slower than a bare Node
 * process for the same JavaScript, so a number here that already crosses a
 * "freezes the UI" threshold is conclusive; a number comfortably under it is
 * suggestive but not proof the browser stays comfortable too.
 *
 * WHY SYNTHETIC TERRAIN, NOT A FIXTURE FILE. The point is the cost of routing
 * over N cells, not any one survey's shape. The generator lays down a rolling
 * multi-octave surface with a handful of seeded local pits, so priority-flood
 * has real depressions to fill rather than raising nothing on a monotonic
 * slope, and it is seeded so a run is reproducible.
 *
 * GATED. Runs only under FLOW_PULSE_LAB_BENCH=1 (sizes via
 * FLOW_PULSE_LAB_BENCH_CELLS, default 250000,1000000,2000000,4000000; run
 * count via FLOW_PULSE_LAB_BENCH_RUNS, default 5); a normal run skips it. Set
 * BENCHMARK_FORCE_GC=1 (already wired into vitest.config.ts) to run a forced
 * collection before each measurement's baseline. A small always-on smoke test
 * exercises the same code path at a trivial size so the harness itself is
 * covered by the normal suite.
 */
import { describe, expect, it } from 'vitest';

import { dtmProductDigest } from '../../src/science/dtmProductDigest';
import { terrainDtmToFlowGrid, type HorizontalScale } from '../../src/simulation/flowPulse/dtmFlowGrid';
import { priorityFlood } from '../../src/simulation/flowPulse/priorityFlood';
import { d8Flow } from '../../src/simulation/flowPulse/d8Flow';
import { flowAccumulation, contributingAreaM2 } from '../../src/simulation/flowPulse/flowAccumulation';
import { mayReportMetricArea } from '../../src/simulation/simulationInputBasis';
import { sealRunRecord } from '../../src/simulation/simulationRunRecord';
import { FLOW_PULSE_DEFAULTS, methodsFor, modelLimitations, type FlowConditioning } from '../../src/simulation/flowPulse/flowPulseRunner';
import { basisLimitations } from '../../src/simulation/simulationInputBasis';
import type { DtmGrid } from '../../src/terrain/ground/cellConfidence';
import type { FlowGrid } from '../../src/simulation/flowPulse/flowTypes';
import { forcedGcRequested } from '../../benchmarks/runner/gcMode';

const ENABLED = process.env.FLOW_PULSE_LAB_BENCH === '1';
const SIZES = (process.env.FLOW_PULSE_LAB_BENCH_CELLS ?? '250000,1000000,2000000,4000000')
  .split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
const RUNS = Math.max(2, Number(process.env.FLOW_PULSE_LAB_BENCH_RUNS ?? 5));
const GC_ON = forcedGcRequested();

const CONDITIONINGS: readonly FlowConditioning[] = ['raw', 'priority-flood'];

const print = (line = '') => process.stdout.write(line + '\n');

/** Deterministic PRNG so a run is reproducible without a fixture file. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A rolling multi-octave surface with a handful of seeded pits, sized to
 * approximately `targetCells` and fully measured (coverage 2 throughout) so
 * every cell reads and no run refuses on `NO_VALID_CELL`.
 */
function makeSyntheticDtm(targetCells: number): DtmGrid {
  const cols = Math.max(2, Math.round(Math.sqrt(targetCells)));
  const rows = Math.max(2, Math.round(targetCells / cols));
  const n = cols * rows;
  const rand = mulberry32(0x5eed ^ n);

  const pitCount = Math.max(4, Math.round(Math.sqrt(n) / 8));
  const pits: Array<{ cx: number; cy: number; r: number; depth: number }> = [];
  for (let i = 0; i < pitCount; i++) {
    pits.push({
      cx: rand() * cols, cy: rand() * rows,
      r: 4 + rand() * (Math.min(cols, rows) / 12),
      depth: 1 + rand() * 5,
    });
  }

  const z = new Float32Array(n);
  const coverage = new Uint8Array(n).fill(2); // measured
  const confidence = new Float32Array(n).fill(100);
  const counts = new Uint32Array(n).fill(1);
  const interpDistanceCells = new Float32Array(n);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      let h = 50
        + 12 * Math.sin(c / 37) * Math.cos(r / 41)
        + 4 * Math.sin(c / 11 + r / 13)
        + 1.5 * Math.sin(c / 5) * Math.sin(r / 7);
      for (const p of pits) {
        const dx = c - p.cx, dy = r - p.cy;
        const d2 = dx * dx + dy * dy;
        h -= p.depth * Math.exp(-d2 / (2 * p.r * p.r));
      }
      z[i] = h;
    }
  }

  return {
    z, confidence, coverage, counts, interpDistanceCells,
    cols, rows, cellSizeM: 1, originH1: 0, originH2: 0, crs: 'EPSG:32610',
    horizontalEpsg: 32610, verticalDatum: null, verticalEpsg: null, verticalUnitToMetres: 1,
    coverageMode: 'full', sourcePointCount: n, analyzedPointCount: n,
    meanConfidence: 100, warnings: [],
  };
}

const NO_LATLON_SCALE: HorizontalScale = { isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: true };

interface StageTimingsMs {
  dtmDigest: number;
  gridConversion: number;
  priorityFlood: number | null;
  d8: number;
  accumulation: number;
  sealing: number;
}

interface RunOutcome {
  stages: StageTimingsMs;
  totalMs: number;
  heapUsedDeltaBytes: number;
  arrayBuffersDeltaBytes: number;
}

function memorySnapshot(): { heapUsed: number; arrayBuffers: number } {
  if (GC_ON && typeof (globalThis as { gc?: () => void }).gc === 'function') {
    (globalThis as { gc: () => void }).gc();
  }
  const u = process.memoryUsage();
  return { heapUsed: u.heapUsed, arrayBuffers: u.arrayBuffers };
}

/**
 * One full pass over the Lab's path, timed stage by stage, over a DTM already
 * built (so grid generation is never counted as part of the measured run).
 */
function runOnce(dtm: DtmGrid, conditioning: FlowConditioning): RunOutcome {
  const before = memorySnapshot();
  let peakHeap = before.heapUsed;
  let peakBuffers = before.arrayBuffers;
  const sample = () => {
    const s = memorySnapshot();
    if (s.heapUsed > peakHeap) peakHeap = s.heapUsed;
    if (s.arrayBuffers > peakBuffers) peakBuffers = s.arrayBuffers;
  };

  const params = { ...FLOW_PULSE_DEFAULTS, conditioning };

  let t0 = performance.now();
  dtmProductDigest(dtm);
  const dtmDigest = performance.now() - t0;
  sample();

  t0 = performance.now();
  const { grid, basis } = terrainDtmToFlowGrid(dtm, NO_LATLON_SCALE, {
    interpolated: params.interpolated, withheldExcluded: params.withheldExcluded,
  });
  const gridConversion = performance.now() - t0;
  sample();

  let routingGrid: FlowGrid = grid;
  let priorityFloodMs: number | null = null;
  let cellsRaised: number | null = null;
  let maxFillDepth: number | null = null;
  let epsilonAbsorbed: number | null = null;
  let cellsUnreachable: number | null = null;
  if (conditioning === 'priority-flood') {
    t0 = performance.now();
    const conditioned = priorityFlood(grid, { epsilon: params.fillEpsilon });
    priorityFloodMs = performance.now() - t0;
    sample();
    routingGrid = { ...grid, z: conditioned.z };
    cellsRaised = conditioned.cellsRaised;
    maxFillDepth = conditioned.maxFillDepth;
    epsilonAbsorbed = conditioned.epsilonAbsorbed;
    cellsUnreachable = conditioned.cellsUnreachable;
  }

  t0 = performance.now();
  const routed = d8Flow(routingGrid);
  const d8Ms = performance.now() - t0;
  sample();

  t0 = performance.now();
  const accumulation = flowAccumulation(routingGrid, routed);
  const area = contributingAreaM2(accumulation, routingGrid, mayReportMetricArea(basis));
  const accumulationMs = performance.now() - t0;
  sample();

  let maxUpstream = 0;
  for (const upstream of accumulation.upstreamCells) if (upstream > maxUpstream) maxUpstream = upstream;
  const summary = {
    cells: dtm.cols * dtm.rows,
    readableCells: basis.measuredCells,
    sinkCount: routed.sinkCount,
    flatCount: routed.flatCount,
    outletCount: routed.outletCount,
    maxUpstreamCells: maxUpstream,
    maxContributingAreaM2: area ? maxUpstream * routingGrid.cellMetresX * routingGrid.cellMetresY : null,
    cellsRaised, maxFillDepth, epsilonAbsorbed, cellsUnreachable,
  };
  const limitations = [...basisLimitations(basis), ...modelLimitations(params, summary)];

  t0 = performance.now();
  sealRunRecord({
    schemaVersion: 1,
    id: 'bench-fixed-id',
    generatedAt: '1970-01-01T00:00:00.000Z',
    build: 'bench',
    kind: 'terrain-flow',
    source: {
      layerId: null, filename: null, sourceDigest: null,
      analysisInputDigest: dtmProductDigest(dtm), terrainCoreDigest: null, basis,
    },
    model: { id: 'olv.simulation.terrain-flow.d8', version: 1 },
    methods: methodsFor(params),
    parameters: {
      conditioning: params.conditioning, routing: params.routing,
      interpolated: params.interpolated,
      fillEpsilon: params.conditioning === 'priority-flood' ? params.fillEpsilon : null,
      maxCells: params.maxCells,
    },
    result: { ...summary },
    limitations,
    processingManifestHead: null,
  });
  const sealing = performance.now() - t0;
  sample();

  const after = memorySnapshot();
  if (after.heapUsed > peakHeap) peakHeap = after.heapUsed;
  if (after.arrayBuffers > peakBuffers) peakBuffers = after.arrayBuffers;

  const stages: StageTimingsMs = {
    dtmDigest, gridConversion, priorityFlood: priorityFloodMs, d8: d8Ms,
    accumulation: accumulationMs, sealing,
  };
  const totalMs = dtmDigest + gridConversion + (priorityFloodMs ?? 0) + d8Ms + accumulationMs + sealing;
  return {
    stages, totalMs,
    heapUsedDeltaBytes: peakHeap - before.heapUsed,
    arrayBuffersDeltaBytes: peakBuffers - before.arrayBuffers,
  };
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

interface Row {
  cells: number;
  conditioning: FlowConditioning;
  dtmDigestMs: number;
  gridConversionMs: number;
  priorityFloodMs: number | null;
  d8Ms: number;
  accumulationMs: number;
  sealingMs: number;
  totalMs: number;
  heapDeltaMB: number;
  arrayBuffersDeltaMB: number;
}

function profile(targetCells: number, conditioning: FlowConditioning, runs: number): Row {
  const dtm = makeSyntheticDtm(targetCells);
  const outcomes: RunOutcome[] = [];
  // One discarded warmup run per configuration, so JIT warmup is never
  // counted into the reported median.
  runOnce(dtm, conditioning);
  for (let i = 0; i < runs; i++) outcomes.push(runOnce(dtm, conditioning));

  const pick = (f: (o: RunOutcome) => number) => median(outcomes.map(f));
  const pickStage = (f: (o: RunOutcome) => number | null): number | null => {
    const vs = outcomes.map(f).filter((v): v is number => v != null);
    return vs.length ? median(vs) : null;
  };

  return {
    cells: dtm.cols * dtm.rows,
    conditioning,
    dtmDigestMs: pick((o) => o.stages.dtmDigest),
    gridConversionMs: pick((o) => o.stages.gridConversion),
    priorityFloodMs: pickStage((o) => o.stages.priorityFlood),
    d8Ms: pick((o) => o.stages.d8),
    accumulationMs: pick((o) => o.stages.accumulation),
    sealingMs: pick((o) => o.stages.sealing),
    totalMs: pick((o) => o.totalMs),
    heapDeltaMB: pick((o) => o.heapUsedDeltaBytes) / (1024 * 1024),
    arrayBuffersDeltaMB: pick((o) => o.arrayBuffersDeltaBytes) / (1024 * 1024),
  };
}

function printTable(rows: readonly Row[]): void {
  print();
  print(
    `Flow Pulse Lab profile (Node, median of ${RUNS}, 1 warmup discarded, `
    + `forced GC ${GC_ON ? 'ON' : 'off'}) — cells | conditioning | digest | grid | `
    + 'pflood | d8 | accum | seal | total ms | heap MB | arrayBuffers MB',
  );
  for (const r of rows) {
    print(
      `  ${r.cells.toString().padStart(9)} | ${r.conditioning.padEnd(14)} | `
      + `${r.dtmDigestMs.toFixed(1).padStart(7)} | ${r.gridConversionMs.toFixed(1).padStart(6)} | `
      + `${(r.priorityFloodMs != null ? r.priorityFloodMs.toFixed(1) : '-').padStart(6)} | `
      + `${r.d8Ms.toFixed(1).padStart(6)} | ${r.accumulationMs.toFixed(1).padStart(6)} | `
      + `${r.sealingMs.toFixed(1).padStart(6)} | ${r.totalMs.toFixed(1).padStart(8)} | `
      + `${r.heapDeltaMB.toFixed(1).padStart(7)} | ${r.arrayBuffersDeltaMB.toFixed(1).padStart(8)}`,
    );
  }
  print();
}

describe('Flow Pulse Lab: is the synchronous UI-thread run actually slow', () => {
  it.skipIf(!ENABLED)('profiles the full Lab path across the cell-size ladder', () => {
    const rows: Row[] = [];
    for (const cells of SIZES) {
      for (const conditioning of CONDITIONINGS) rows.push(profile(cells, conditioning, RUNS));
    }
    printTable(rows);
    for (const r of rows) expect(r.totalMs).toBeGreaterThan(0);
  }, 900_000);

  // Always on: a trivial grid through the identical path, so a broken harness
  // fails the normal suite rather than only the gated run nobody triggers.
  it('runs the profiled path at a trivial size without throwing', () => {
    const row = profile(64, 'priority-flood', 2);
    expect(row.cells).toBeGreaterThan(0);
    expect(row.totalMs).toBeGreaterThan(0);
    expect(row.priorityFloodMs).not.toBeNull();
  });
});
