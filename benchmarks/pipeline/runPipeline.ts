/**
 * runPipeline.ts
 *
 * The pipeline driver: run OLV's REAL science pipeline over a seeded synthetic
 * cloud and report one timed stage per step, plus the scientific artifacts each
 * step produced.
 *
 * WHY THE DRIVER CALLS APPLICATION CODE AND NOTHING ELSE. A benchmark that
 * re-implemented the pipeline would measure the benchmark. Worse, it would keep
 * reporting healthy numbers after the application changed, because nothing
 * would connect the two any more. So every stage below is a call into `src/`,
 * and `tests/benchmark/pipelineDriver.test.ts` pins the driver's DTM, contours
 * and complexity output against `analyseContours` — the entry point the
 * AnalysePanel and the contour worker use — on the same input. Reimplement any
 * stage and that equality breaks immediately.
 *
 * THE CALL CHAIN, stage by stage:
 *
 *   generate      → benchmarks/fixtures/syntheticCloud.ts (the only non-app code)
 *   rasterize     → resolveGroundFilterParams → classifyGroundSmrf → rasterizeDtm
 *   dtm           → computeTerrainCore  (ground filter → raster → despike +
 *                   geodesic void fill + per-cell confidence via
 *                   buildSurfaceFromRaster → buildDtmGrid → hold-out validation
 *                   → confidence calibration → interval gate → quality, scoring,
 *                   surface models)
 *   descriptors   → horizontalCellMetresXY → summariseTerrainComplexity
 *                   (VRM, Sappington et al. 2007; TPI, Weiss 2001)
 *   contours      → contoursFromCore (interval choice → contoursAt → stitch →
 *                   style → shape → feature model → tally → labels)
 *   scientificRec → buildExportProvenance → analysisRecordFromProvenance
 *   manifest      → processingManifestFromProvenance → verifyProcessingManifest
 *
 * `dtm` and `contours` are the application's OWN two halves — `analyseContours`
 * is defined as `contoursFromCore ∘ computeTerrainCore` — so together they are
 * exactly one full analysis with no work done twice and no sequencing invented
 * here. `rasterize` and `descriptors` are the two leaves timed in isolation, so
 * a scaling suite can see how each core scales on its own; they are therefore
 * NOT disjoint from `dtm`, which runs both again internally. Summing all seven
 * stages double-counts them; read `dtm` + `contours` as the pipeline's cost.
 *
 * BROWSER-ONLY WORK IS DECLARED, NOT DROPPED. GPU upload, first rendered frame,
 * frame rate and time-to-interaction are real stages of the user's workflow and
 * Node can measure none of them. They are reported as stages whose metrics are
 * `unavailable` with a reason naming the limitation, never as 0 and never as an
 * estimate, so a workflow report shows the whole pipeline with honest gaps
 * instead of a partial one that looks complete.
 *
 * Runtime-neutral by construction: nothing here imports a `node:` builtin, so a
 * browser-side suite can reuse the driver and fill in the four stages Node
 * cannot. It does need the `__BUILD_IDENTITY__` define that Vite and Vitest
 * supply (the export-provenance path stamps the build into the record), so it
 * runs under those, not under a bare `node` process.
 */

import {
  measured,
  runStage,
  unavailable,
  type Metric,
  type StageResult,
} from '../framework';
import { generateSyntheticCloud, type SyntheticCloud } from '../fixtures/syntheticCloud';
import type { TerrainPoint } from '../../src/terrain/TerrainContracts';
import { classifyGroundSmrf } from '../../src/terrain/ground/groundFilter';
import { rasterizeDtm, type DtmAggregation } from '../../src/terrain/ground/rasterizeDtm';
import { horizontalCellMetresXY } from '../../src/terrain/ground/horizontalScale';
import {
  computeTerrainCore,
  contoursFromCore,
  resolveGroundFilterParams,
  type AnalyseContoursParams,
  type AnalyseContoursResult,
  type TerrainCore,
} from '../../src/terrain/contour/analyseContours';
import {
  summariseTerrainComplexity,
  type TerrainComplexitySummary,
} from '../../src/terrain/complexity/complexitySummary';
import {
  analysisRecordFromProvenance,
  buildExportProvenance,
  processingManifestFromProvenance,
} from '../../src/terrain/export/exportProvenance';
import { verifyProcessingManifest } from '../../src/science/processingManifest';

/** The stages measurable under Node, in pipeline order. */
export const NODE_STAGES = [
  'generate',
  'rasterize',
  'dtm',
  'descriptors',
  'contours',
  'scientificRecord',
  'manifest',
] as const;

/** The stages that exist only in a browser. Reported, never measured here. */
export const BROWSER_ONLY_STAGES = [
  'gpuUpload',
  'renderReady',
  'fps',
  'timeToInteraction',
] as const;

/** Every stage a run reports, in the order a report renders them. */
export const PIPELINE_STAGES = [...NODE_STAGES, ...BROWSER_ONLY_STAGES] as const;

export type NodeStageName = (typeof NODE_STAGES)[number];
export type BrowserStageName = (typeof BROWSER_ONLY_STAGES)[number];
export type PipelineStageName = (typeof PIPELINE_STAGES)[number];

/**
 * Why each browser stage has no number here. Each names the specific runtime
 * facility Node lacks: "unavailable" on its own tells a reviewer nothing about
 * whether the measurement is impossible or merely was not taken.
 */
const BROWSER_STAGE_REASONS: Readonly<Record<BrowserStageName, string>> = {
  gpuUpload:
    'GPU buffer upload runs against the browser WebGPU/WebGL device; a Node process has no GPU adapter, so there is no upload to time.',
  renderReady:
    'Time to the first rendered frame is a compositor event; Node has no renderer and no presentation surface to present to.',
  fps: 'Frame rate is measured against the browser display refresh; Node has no frame loop and no display to synchronise with.',
  timeToInteraction:
    'Time-to-interaction runs from a user input event to the painted response; Node has neither input events nor paint.',
};

/** Default DTM/contour grid, source units. Around 16 returns per cell at QL2. */
export const DEFAULT_CELL_SIZE_M = 2;
/** A projected, metre-denominated frame, so the pipeline's unit seams are 1:1. */
export const DEFAULT_CRS = 'EPSG:32610';
export const DEFAULT_VERTICAL_DATUM = 'EPSG:5703';
/**
 * The per-cell aggregation every run benchmarks with.
 *
 * Stated explicitly rather than left to the pipeline's default, because the
 * isolated `rasterize` stage has to rasterise the SAME way the core does and
 * the live default is private to `analyseContours`. A test asserts this value
 * still equals what the core picks on its own, so a change of the live default
 * shows up as a red test rather than as a benchmark quietly measuring a surface
 * the application stopped producing.
 */
export const BENCHMARK_AGGREGATION: DtmAggregation = 'median';
/**
 * A fixed generation timestamp.
 *
 * `buildExportProvenance` defaults this to `new Date()`, and that value reaches
 * the scientific record and the manifest chain — so a real clock would make two
 * identical runs produce different artifacts and the reproducibility check would
 * never pass. (The framework's strip list would remove the ISO field itself, but
 * the manifest folds the envelope into a hash chain, where nothing can be
 * stripped after the fact.)
 */
export const FIXED_GENERATED_AT = '2000-01-01T00:00:00.000Z';

export interface PipelineRunOptions {
  readonly seed?: number;
  readonly pointCount: number;
  readonly cellSizeM?: number;
  readonly crs?: string | null;
  readonly verticalDatum?: string | null;
  /** Contour interval, source units. Omitted ⇒ the pipeline's gated choice. */
  readonly intervalM?: number;
  /** Hold-out PRNG seed handed to the app's validation. Default 1. */
  readonly holdoutSeed?: number;
  /** Source basename stamped into the provenance record. */
  readonly basename?: string;
  /** ISO generation timestamp. Default {@link FIXED_GENERATED_AT}. */
  readonly generatedAt?: string;
  /**
   * Make a named stage throw with this message.
   *
   * A deliberate injection seam: the "a failed stage is recorded and the run
   * continues" contract is the one behaviour that cannot be exercised by a
   * healthy run, and a suite that only ever sees green stages would never catch
   * a driver that aborts on the first error. Nothing populates this in a real
   * run.
   */
  readonly faults?: Readonly<Partial<Record<PipelineStageName, string>>>;
}

export interface PipelineRun {
  readonly datasetId: string;
  readonly seed: number;
  readonly pointCount: number;
  /** The exact parameters handed to the application pipeline. */
  readonly analysisParams: AnalyseContoursParams;
  readonly stages: readonly StageResult[];
  /**
   * Named scientific artifacts, every one JSON-representable (or raw bytes),
   * ready for `hashArtifact` without further conversion. A stage that failed
   * contributes NO entry — an absent artifact says "not produced", which a
   * placeholder would not.
   */
  readonly artifacts: Readonly<Record<string, unknown>>;
  /** Suite-level headline numbers, in the framework's metric shape. */
  readonly metrics: Readonly<Record<string, Metric>>;
  /** The generated cloud, for a suite that wants to hash the input bytes. */
  readonly cloud: SyntheticCloud | null;
  /** The application's own analysis result, for assertions. Null if it failed. */
  readonly result: AnalyseContoursResult | null;
}

/**
 * Run the whole pipeline. Never throws: a stage that fails is recorded as
 * failed and the remaining stages still run, so a report shows which parts of
 * the pipeline did complete instead of stopping at the first problem.
 */
export function runOlvPipeline(options: PipelineRunOptions): PipelineRun {
  const seed = options.seed ?? 1;
  const { pointCount } = options;
  const analysisParams: AnalyseContoursParams = {
    cellSizeM: options.cellSizeM ?? DEFAULT_CELL_SIZE_M,
    crs: options.crs ?? DEFAULT_CRS,
    verticalDatum: options.verticalDatum ?? DEFAULT_VERTICAL_DATUM,
    verticalAxis: 'z',
    isGeographic: false,
    horizontalUnitToMetres: 1,
    verticalUnitToMetres: 1,
    holdoutSeed: options.holdoutSeed ?? 1,
    aggregation: BENCHMARK_AGGREGATION,
    ...(options.intervalM != null ? { intervalM: options.intervalM } : {}),
  };

  const stages: StageResult[] = [];
  const artifacts: Record<string, unknown> = {};
  const fault = (name: PipelineStageName): void => {
    const message = options.faults?.[name];
    if (message !== undefined) throw new Error(message);
  };

  // ── generate ──────────────────────────────────────────────────────────────
  const generated = runStage('generate', () => {
    fault('generate');
    return generateSyntheticCloud({ seed, pointCount });
  });
  stages.push(generated.stage);
  const cloud = generated.value ?? null;
  if (cloud) {
    artifacts.fixture = toHashable({
      datasetId: cloud.datasetId,
      seed: cloud.seed,
      pointCount: cloud.pointCount,
      densityPerM2: cloud.densityPerM2,
      extentM: cloud.extentM,
      noiseHalfWidthM: cloud.noiseHalfWidthM,
      groundPointCount: cloud.groundPointCount,
      aboveGroundPointCount: cloud.aboveGroundPointCount,
      bounds: cloud.bounds,
      surface: cloud.surface,
    });
    // The input itself, as bytes. `hashArtifact` digests a Uint8Array directly,
    // so a reproducibility suite can state "the same seed produced these exact
    // points" without trusting the descriptor above to be complete. A view, not
    // a copy — the buffer is already there.
    artifacts.pointBytes = new Uint8Array(
      cloud.positions.buffer,
      cloud.positions.byteOffset,
      cloud.positions.byteLength,
    );
  }

  // ── rasterize ─────────────────────────────────────────────────────────────
  const rasterized = runStage('rasterize', () => {
    fault('rasterize');
    const c = require_(cloud, 'generate', 'the point cloud');
    const points = boxPoints(c.positions);
    // The app's own resolver, not a copy of its defaults: it is exported as
    // "the SINGLE source of truth" precisely so a second caller cannot drift
    // from the parameters the delivered surface was filtered with.
    const groundParams = resolveGroundFilterParams(analysisParams, 'z');
    const gf = classifyGroundSmrf(points, groundParams);
    const raster = rasterizeDtm(points, gf.isGround, {
      grid: {
        originH1: gf.originH1,
        originH2: gf.originH2,
        cols: gf.cols,
        rows: gf.rows,
        cellSizeM: analysisParams.cellSizeM,
      },
      aggregation: BENCHMARK_AGGREGATION,
      verticalAxis: 'z',
    });
    return { gf, raster };
  });
  stages.push(rasterized.stage);
  if (rasterized.value) {
    const { gf, raster } = rasterized.value;
    artifacts.rasterSummary = toHashable({
      cols: raster.cols,
      rows: raster.rows,
      cellSizeM: raster.cellSizeM,
      originH1: raster.originH1,
      originH2: raster.originH2,
      coverage: raster.coverage,
      sourcePointCount: raster.sourcePointCount,
      analyzedPointCount: raster.analyzedPointCount,
      filledCellCount: raster.filledCellCount,
      groundPointCount: gf.groundPointCount,
      nonGroundPointCount: gf.sourcePointCount - gf.groundPointCount,
      warnings: raster.warnings,
    });
  }

  // ── dtm ───────────────────────────────────────────────────────────────────
  const cored = runStage('dtm', () => {
    fault('dtm');
    const c = require_(cloud, 'generate', 'the point cloud');
    return computeTerrainCore(c.positions, analysisParams);
  });
  stages.push(cored.stage);
  const core = cored.value ?? null;
  if (core) {
    artifacts.dtmSummary = toHashable(summariseCore(core));
    // The grids themselves. Converted from Float32Array/Uint8Array to plain
    // arrays because `assertHashable` rejects typed arrays outright: canonical
    // JSON turns them into index-keyed objects, which hash but stop
    // discriminating in ways nobody notices. See `toHashable` for how a NaN
    // cell — the raster's honest "no data" — is carried across.
    artifacts.dtmSurface = toHashable({
      cols: core.dtm.cols,
      rows: core.dtm.rows,
      z: core.dtm.z,
      confidence: core.dtm.confidence,
      coverage: core.dtm.coverage,
      counts: core.dtm.counts,
      // Height above bare earth is a per-cell product, not a statistic, so it
      // lives with the grids — leaving it on the summary made a "summary"
      // artifact that was 95 % raster and grew with the tier.
      heightAboveGroundM: core.surface.canopy.heightM,
    });
  }

  // ── descriptors ───────────────────────────────────────────────────────────
  const descriptors = runStage('descriptors', () => {
    fault('descriptors');
    const k = require_(core, 'dtm', 'the terrain core');
    // The same conversion the core applies before its own complexity pass, via
    // the app's function rather than a hard-coded "cells are metres" — a
    // foot-based or geographic frame would make that assumption wrong and the
    // window/radius statements would report ground sizes that never existed.
    const cell = horizontalCellMetresXY(
      k.dtm.cellSizeM,
      analysisParams.isGeographic,
      analysisParams.latitudeDeg,
      analysisParams.horizontalUnitToMetres,
    );
    return summariseTerrainComplexity({
      z: k.dtm.z,
      coverage: k.dtm.coverage,
      cols: k.dtm.cols,
      rows: k.dtm.rows,
      // The Horn slope/aspect grids the core already computed and exposes for
      // reuse — recomputing them here would time a derivative pass twice and
      // risk measuring a differently-parameterised one.
      slope: k.surface.relief.slope,
      aspect: k.surface.relief.aspect,
      cellMetresX: cell.x,
      cellMetresY: cell.y,
      verticalUnitToMetres: analysisParams.verticalUnitToMetres,
      meta: {
        coverage: k.dtm.coverageMode,
        sourcePointCount: k.dtm.sourcePointCount,
        analyzedPointCount: k.dtm.analyzedPointCount,
      },
      groundDensityPerM2: k.cellMetrics.meanDensity,
    });
  });
  stages.push(descriptors.stage);
  const complexity: TerrainComplexitySummary | null = descriptors.value ?? null;
  if (complexity) artifacts.descriptors = toHashable(complexity);

  // ── contours ──────────────────────────────────────────────────────────────
  const contoured = runStage('contours', () => {
    fault('contours');
    const k = require_(core, 'dtm', 'the terrain core');
    return contoursFromCore(k, analysisParams);
  });
  stages.push(contoured.stage);
  const result = contoured.value ?? null;
  if (result) {
    artifacts.contours = toHashable({
      intervalM: result.intervalM,
      gate: result.gate,
      tally: result.tally,
      levels: result.contours.levels.map((level) => ({
        value: level.value,
        segmentCount: level.segments.length,
      })),
      stitchedPolylineCount: result.stitched.reduce((n, l) => n + l.polylines.length, 0),
      labelCount: result.labels.length,
      generationParams: result.generationParams,
      warnings: result.warnings,
    });
    // The exported geometry itself — what a GIS would receive — so the
    // reproducibility suite compares the deliverable, not a summary of it.
    artifacts.contourFeatures = toHashable(result.model);
  }

  // ── scientificRecord ──────────────────────────────────────────────────────
  const generatedAt = options.generatedAt ?? FIXED_GENERATED_AT;
  const recorded = runStage('scientificRecord', () => {
    fault('scientificRecord');
    const r = require_(result, 'contours', 'the analysis result');
    // buildExportProvenance is the app's one derivation of provenance from a
    // run; the record and the manifest are both derived from it, exactly as
    // every exporter does, so the benchmark stamps what a real export stamps.
    const provenance = buildExportProvenance(r, {
      basename: options.basename ?? null,
      generatedAt,
      verticalUnitToMetres: analysisParams.verticalUnitToMetres,
    });
    return { provenance, record: analysisRecordFromProvenance(provenance) };
  });
  stages.push(recorded.stage);
  if (recorded.value) artifacts.scientificRecord = toHashable(recorded.value.record);

  // ── manifest ──────────────────────────────────────────────────────────────
  const manifested = runStage('manifest', () => {
    fault('manifest');
    const p = require_(recorded.value, 'scientificRecord', 'the export provenance');
    const manifest = processingManifestFromProvenance(p.provenance);
    // Verify the chain in the same stage that built it. A manifest that does
    // not verify is a failed stage, not a field on an artifact nobody reads.
    const verification = verifyProcessingManifest(manifest);
    if (!verification.ok) {
      throw new Error(
        `processing manifest failed to verify at op ${String(verification.firstInvalid)}`,
      );
    }
    return manifest;
  });
  stages.push(manifested.stage);
  if (manifested.value) artifacts.processingManifest = toHashable(manifested.value);

  // ── the browser half ──────────────────────────────────────────────────────
  for (const name of BROWSER_ONLY_STAGES) stages.push(browserStage(name));

  return {
    datasetId: cloud?.datasetId ?? `synthetic-${pointCount}-seed${seed}`,
    seed,
    pointCount,
    analysisParams,
    stages,
    artifacts,
    metrics: headlineMetrics(stages, pointCount),
    cloud,
    result,
  };
}

/**
 * A stage that cannot exist in this runtime.
 *
 * Status 'ok' rather than 'failed': nothing went wrong, and a red row in every
 * reporter would tell a reader the opposite. The honest statement lives in the
 * metric's reason, which is exactly where the framework's schema puts it — and
 * the schema makes it impossible to attach a number to it.
 */
function browserStage(name: BrowserStageName): StageResult {
  const reason = BROWSER_STAGE_REASONS[name];
  const provenance = { runtime: 'browser', deterministic: false } as const;
  return {
    name,
    status: 'ok',
    duration: unavailable(reason, provenance),
    peakMemory: unavailable(reason, provenance),
  };
}

/**
 * Headline numbers for a report. Throughput is only stated when the two stages
 * it divides both produced a measurement — a "points/s" computed from a stage
 * that never ran is the fabricated number this whole framework exists to avoid.
 */
function headlineMetrics(
  stages: readonly StageResult[],
  pointCount: number,
): Record<string, Metric> {
  const provenance = { runtime: 'node', deterministic: false } as const;
  const analysisMs = ['dtm', 'contours'].reduce<number | null>((total, name) => {
    if (total === null) return null;
    const stage = stages.find((s) => s.name === name);
    if (!stage || stage.status !== 'ok' || stage.duration.status !== 'measured') return null;
    return total + stage.duration.value;
  }, 0);
  return {
    pointCount: measured(pointCount, 'points', { runtime: 'node', deterministic: true }),
    analysisDurationMs:
      analysisMs === null
        ? unavailable('the dtm or contours stage did not complete, so there is no analysis time', provenance)
        : measured(analysisMs, 'ms', provenance),
    pointsPerSecond:
      analysisMs === null || analysisMs <= 0
        ? unavailable(
            'throughput needs a completed dtm + contours pair with a non-zero duration',
            provenance,
          )
        : measured((pointCount / analysisMs) * 1000, 'points/s', provenance),
  };
}

/** The interval-independent scientific summary of one core run. */
function summariseCore(core: TerrainCore): Record<string, unknown> {
  return {
    cols: core.dtm.cols,
    rows: core.dtm.rows,
    cellSizeM: core.dtm.cellSizeM,
    originH1: core.dtm.originH1,
    originH2: core.dtm.originH2,
    crs: core.dtm.crs,
    verticalDatum: core.dtm.verticalDatum,
    coverageMode: core.dtm.coverageMode,
    sourcePointCount: core.dtm.sourcePointCount,
    analyzedPointCount: core.dtm.analyzedPointCount,
    meanConfidence: core.dtm.meanConfidence,
    minZ: core.minZ,
    maxZ: core.maxZ,
    elevationRangeM: core.elevationRangeM,
    interpolation: core.interpolation,
    aggregation: core.aggregation,
    despikeApplied: core.despikeApplied,
    excludedByClassification: core.excludedByClassification,
    // `validation.samples` is deliberately dropped: it is one entry per
    // held-out point, so it dwarfs every other artifact on a large tier while
    // adding nothing a reviewer reads — the statistics derived from it are all
    // right here.
    validation: withoutSamples(core.validation),
    confidenceCalibrationApplied: core.confidenceCalibrationApplied,
    confidenceToleranceM: core.confidenceToleranceM,
    confidenceOrdering: core.confidenceOrdering,
    reliabilitySplit: core.reliabilitySplit,
    blockedAccuracy: core.blockedAccuracy,
    accuracy: core.accuracy,
    accuracyStandards: core.accuracyStandards,
    quality: core.quality,
    qualityScore: core.qualityScore,
    cellMetrics: core.cellMetrics,
    cellStatusTally: core.cellStatusTally,
    surface: {
      dsm: core.surface.dsm,
      // The canopy GRID is on `dtmSurface`; only its statistics belong here.
      canopy: {
        coveredCells: core.surface.canopy.coveredCells,
        maxHeightM: core.surface.canopy.maxHeightM,
        meanHeightM: core.surface.canopy.meanHeightM,
        p95HeightM: core.surface.canopy.p95HeightM,
      },
      slope: core.surface.slope,
    },
    coreWarnings: core.coreWarnings,
  };
}

function withoutSamples(validation: TerrainCore['validation']): Record<string, unknown> {
  const { samples: _samples, ...rest } = validation;
  return rest;
}

/**
 * Box XYZ triples into the `TerrainPoint[]` the two ground leaves take.
 *
 * `analyseContours` does exactly this internally (`positionsToPoints`) but does
 * not export it. Duplicating five lines of data marshalling is the right call
 * here; reaching into a module's private surface is not, and neither is
 * changing `src/` to suit a benchmark.
 */
function boxPoints(positions: Float32Array): TerrainPoint[] {
  const n = (positions.length / 3) | 0;
  const points: TerrainPoint[] = new Array<TerrainPoint>(n);
  for (let i = 0; i < n; i++) {
    points[i] = { x: positions[i * 3], y: positions[i * 3 + 1], z: positions[i * 3 + 2] };
  }
  return points;
}

/**
 * Read a prerequisite a previous stage was supposed to produce.
 *
 * Throwing here is what turns "the DTM stage failed" into four downstream
 * stages recorded as failed WITH the reason, instead of four stages missing
 * from the report entirely — the difference between a report that shows a
 * broken run and one that shows a short run.
 */
function require_<T>(value: T | null | undefined, stage: NodeStageName, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`the ${stage} stage did not produce ${what}`);
  }
  return value;
}

/** What a non-finite number becomes in an artifact. */
type NonFiniteLabel = 'NaN' | 'Infinity' | '-Infinity';

/** Anything `canonicalJson` can represent faithfully. */
type Hashable = string | number | boolean | null | Hashable[] | { [key: string]: Hashable };

/**
 * Convert a pipeline product into something `hashArtifact` accepts.
 *
 * Two deliberate conversions, both of which the framework's guard would
 * otherwise reject outright:
 *
 *   - TYPED ARRAYS become plain arrays. `canonicalJson` keeps own enumerable
 *     keys, so a Float32Array would canonicalise to an index-keyed object that
 *     still hashes but no longer reads as data.
 *   - NON-FINITE NUMBERS become their name as a string. NaN is how this
 *     pipeline says "no data here" (an empty raster cell, an unmeasurable mean
 *     confidence), and `JSON.stringify(NaN)` is `null` — which is
 *     indistinguishable from a field that genuinely held null, and makes NaN,
 *     +Infinity and -Infinity all hash the same. Naming them keeps the three
 *     apart and keeps the absence explicit.
 *
 * Anything else that JSON cannot carry (a Date, a Map, a class instance) throws
 * rather than being flattened, for the same reason `assertHashable` throws: a
 * silent flattening is a hash that stopped discriminating.
 */
export function toHashable(value: unknown, path = 'artifact'): Hashable {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return value as string | boolean;
  if (t === 'number') return finiteOrLabel(value as number);
  if (t === 'bigint' || t === 'function' || t === 'symbol' || t === 'undefined') {
    throw new TypeError(`benchmark artifact: ${path} is a ${t}, which has no JSON form`);
  }
  if (Array.isArray(value)) return value.map((v, i) => toHashable(v, `${path}[${i}]`));
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const view = value as unknown as ArrayLike<number>;
    const out: Hashable[] = new Array<Hashable>(view.length);
    for (let i = 0; i < view.length; i++) out[i] = finiteOrLabel(view[i]);
    return out;
  }
  const proto = Object.getPrototypeOf(value as object) as object | null;
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(
      `benchmark artifact: ${path} is a ${
        (value as { constructor?: { name?: string } }).constructor?.name ?? 'non-plain object'
      }, which JSON cannot carry faithfully`,
    );
  }
  const out: Record<string, Hashable> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    // An absent optional field and one explicitly set to undefined describe the
    // same thing, and JSON drops both — mirroring that here keeps the two from
    // hashing differently.
    if (v === undefined) continue;
    out[key] = toHashable(v, `${path}.${key}`);
  }
  return out;
}

function finiteOrLabel(n: number): number | NonFiniteLabel {
  if (Number.isFinite(n)) return n;
  if (Number.isNaN(n)) return 'NaN';
  return n > 0 ? 'Infinity' : '-Infinity';
}
