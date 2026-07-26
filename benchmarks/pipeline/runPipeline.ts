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
 * and `tests/benchmark/pipelineDriver.test.ts` pins the driver's raster grid,
 * DTM, contours and complexity output against `analyseContours` — the entry
 * point the AnalysePanel and the contour worker use — on the same input.
 * Reimplement any stage and that equality breaks immediately.
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
 * a scaling suite can see how each core scales on its own; they therefore
 * OVERLAP `dtm`, which runs both again internally.
 *
 * That overlap is a trap for a reporter — summing the stage column overstates a
 * 500k run by about 25 %. So the correct total is a function, not a convention:
 * see {@link STAGE_ROLE} and {@link pipelineDurationMs}. Getting it wrong now
 * takes ignoring an exported answer rather than missing a comment. A run that
 * does not want to pay for the isolated leaves at all passes
 * `isolateLeaves: false`.
 *
 * BROWSER-ONLY WORK IS DECLARED, NOT DROPPED. GPU upload, first rendered frame,
 * frame rate and time-to-interaction are real stages of the user's workflow and
 * Node can measure none of them. They are reported as stages whose metrics are
 * `unavailable` with a reason naming the limitation, never as 0 and never as an
 * estimate, so a workflow report shows the whole pipeline with honest gaps
 * instead of a partial one that looks complete. {@link STAGE_ROLE} marks them
 * `'declared'` so a reporter can render them as their own kind of row.
 *
 * WHAT IS COMPARABLE ACROSS MACHINES, AND WHAT IS NOT. Most artifacts here are
 * pure science and hash identically anywhere. Two are not: the scientific
 * record embeds the build identity, and the processing manifest seeds its hash
 * chain from that identity, so both track the git commit and the Node version
 * of whatever ran them (`vitest.config.ts` sets the test build's `node` from
 * `process.version`). The framework's strip list removes `builtAt` and
 * `generatedAt` but cannot remove a commit — that IS provenance, and stripping
 * it would be a lie. {@link ARTIFACT_SCOPE} marks those two `'build'`, and a
 * cross-machine reproducibility comparison must exclude them or it goes red on
 * a perfectly green pipeline. The science inside the record stays checkable:
 * `scientificRecordContent` carries the same record with build and timestamp
 * dropped, including the app's own `contentHash`, which
 * `scientificAnalysisRecord.ts` deliberately computes over the science alone.
 *
 * Runtime-neutral by construction: nothing here imports a `node:` builtin (a
 * source guard enforces it), so a browser-side suite can reuse the driver and
 * fill in the four stages Node cannot. It does need the `__BUILD_IDENTITY__`
 * define that Vite and Vitest supply, because the export-provenance path stamps
 * the build into the record. That dependency resolves at MODULE LOAD, so a bare
 * `node` process dies with a `ReferenceError` before any stage exists — it
 * cannot be reported as a failed stage, and CI invoking this outside vitest or a
 * vite build sees the process die rather than a red row.
 */

import {
  measured,
  runStage,
  toHashable,
  unavailable,
  type Metric,
  type MetricRuntime,
  type StageOutcome,
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
import { summariseTerrainComplexity } from '../../src/terrain/complexity/complexitySummary';
import {
  analysisRecordFromProvenance,
  buildExportProvenance,
  processingManifestFromProvenance,
  type ExportProvenance,
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

/** What a stage's timing means for a total. See {@link STAGE_ROLE}. */
export type StageRole = 'pipeline' | 'isolated' | 'declared';

/**
 * What each stage's timing means, so a reporter can add up the right ones.
 *
 *   'pipeline' — disjoint work. These and only these sum to the run's cost.
 *   'isolated' — a leaf that `dtm` also runs internally, timed on its own for a
 *                per-core scaling curve. Adding it to a total double-counts.
 *   'declared' — a stage that exists but cannot be measured in this runtime.
 */
export const STAGE_ROLE: Readonly<Record<PipelineStageName, StageRole>> = {
  generate: 'pipeline',
  rasterize: 'isolated',
  dtm: 'pipeline',
  descriptors: 'isolated',
  contours: 'pipeline',
  scientificRecord: 'pipeline',
  manifest: 'pipeline',
  gpuUpload: 'declared',
  renderReady: 'declared',
  fps: 'declared',
  timeToInteraction: 'declared',
};

/**
 * The run's total duration: the `'pipeline'` stages only, never the whole
 * column. Includes `generate`, because a run cannot happen without producing
 * its input; subtract that stage if you want application time alone.
 *
 * Null — not a partial sum — when any pipeline stage failed or was not
 * measured. A total missing one of its terms is not a smaller total, it is a
 * different number, and reporting the second as if it were the first is exactly
 * the class of quiet wrongness this framework exists to prevent.
 */
export function pipelineDurationMs(stages: readonly StageResult[]): number | null {
  return sumStages(
    stages,
    PIPELINE_STAGES.filter((name) => STAGE_ROLE[name] === 'pipeline'),
  );
}

/** Every artifact a complete run can produce. */
export const PIPELINE_ARTIFACTS = [
  'fixture',
  'pointBytes',
  'rasterSummary',
  'rasterZBytes',
  'dtmSummary',
  'dtmZBytes',
  'dtmConfidenceBytes',
  'dtmCoverageBytes',
  'dtmCountsBytes',
  'heightAboveGroundBytes',
  'descriptors',
  'contours',
  'contourFeatures',
  'scientificRecordContent',
  'scientificRecord',
  'processingManifest',
] as const;

export type PipelineArtifactName = (typeof PIPELINE_ARTIFACTS)[number];

/**
 * Whether an artifact's hash is a statement about the science or about the
 * build that ran it. See the header: comparing a `'build'` artifact between two
 * machines is expected to differ and says nothing about reproducibility.
 */
export const ARTIFACT_SCOPE: Readonly<Record<PipelineArtifactName, 'science' | 'build'>> = {
  fixture: 'science',
  pointBytes: 'science',
  rasterSummary: 'science',
  rasterZBytes: 'science',
  dtmSummary: 'science',
  dtmZBytes: 'science',
  dtmConfidenceBytes: 'science',
  dtmCoverageBytes: 'science',
  dtmCountsBytes: 'science',
  heightAboveGroundBytes: 'science',
  descriptors: 'science',
  contours: 'science',
  contourFeatures: 'science',
  scientificRecordContent: 'science',
  scientificRecord: 'build',
  processingManifest: 'build',
};

/** The artifacts a cross-machine reproducibility comparison may use. */
export function scienceScopedArtifacts(): readonly PipelineArtifactName[] {
  return PIPELINE_ARTIFACTS.filter((name) => ARTIFACT_SCOPE[name] === 'science');
}

/** A stage's contribution to the artifact set. */
export type ArtifactBag = Partial<Record<PipelineArtifactName, unknown>>;

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

/** Stated when a run opts out of the isolated leaf timings. */
const LEAVES_NOT_REQUESTED =
  'isolated leaf timings were not requested for this run (isolateLeaves: false); the work still happened inside the dtm stage, it was simply not timed on its own';

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
   * Time the two leaves (`rasterize`, `descriptors`) separately. Default true.
   *
   * They re-run work `dtm` already does — mostly a second SMRF pass, which is
   * the expensive part and grows with the tier. A run that only wants the
   * pipeline's cost turns them off; the stages still appear, marked unavailable
   * with the reason, so no row silently disappears from a report.
   */
  readonly isolateLeaves?: boolean;
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
  /**
   * Make a named stage throw AFTER its product exists, while its artifact is
   * being converted.
   *
   * A separate seam from {@link faults} because it exercises a different
   * contract: a conversion failure must cost that one stage's artifact and
   * nothing else, because the science already succeeded and the stages
   * downstream have the product they need. Building the artifacts outside
   * `runStage` — where an unconvertible application field once would have
   * landed — killed the entire run instead, which is why this is pinned by a
   * test rather than left to inspection.
   */
  readonly artifactFaults?: Readonly<Partial<Record<PipelineStageName, string>>>;
}

export interface PipelineRun {
  readonly datasetId: string;
  readonly seed: number;
  readonly pointCount: number;
  /** The exact parameters handed to the application pipeline. */
  readonly analysisParams: AnalyseContoursParams;
  readonly stages: readonly StageResult[];
  /**
   * Named scientific artifacts, every one JSON-representable or raw bytes,
   * ready for `hashArtifact` without further conversion. A stage that failed
   * contributes NO entry — an absent artifact says "not produced", which a
   * placeholder would not. Keyed by {@link PipelineArtifactName}, so a suite's
   * typo is a compile error rather than an `undefined` that reaches the hasher.
   */
  readonly artifacts: Readonly<ArtifactBag>;
  /** Suite-level headline numbers, in the framework's metric shape. */
  readonly metrics: Readonly<Record<string, Metric>>;
  /** The generated cloud, for a suite that wants to hash the input bytes. */
  readonly cloud: SyntheticCloud | null;
  /** The application's own analysis result, for assertions. Null if it failed. */
  readonly result: AnalyseContoursResult | null;
}

/**
 * Run the whole pipeline. Never throws: a stage that fails — including one that
 * fails while converting its own artifact — is recorded as failed and the
 * remaining stages still run, so a report shows which parts of the pipeline did
 * complete instead of stopping at the first problem.
 */
export function runOlvPipeline(options: PipelineRunOptions): PipelineRun {
  const seed = options.seed ?? 1;
  const { pointCount } = options;
  const isolateLeaves = options.isolateLeaves ?? true;
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
  const artifacts: ArtifactBag = {};
  /**
   * What each stage hands to the next.
   *
   * Held OUTSIDE the stage body and assigned BEFORE the artifact conversion, so
   * a conversion that throws costs one stage's artifact and nothing else. Built
   * the other way round — convert, then return the product alongside it — a
   * single unconvertible field on an application type would take out every
   * stage downstream of it as well.
   */
  const products: {
    cloud: SyntheticCloud | null;
    core: TerrainCore | null;
    result: AnalyseContoursResult | null;
    provenance: ExportProvenance | null;
  } = { cloud: null, core: null, result: null, provenance: null };

  const fault = (name: PipelineStageName): void => {
    const message = options.faults?.[name];
    if (message !== undefined) throw new Error(message);
  };
  /** Fired once the stage's product is captured, standing in for a conversion. */
  const artifactFault = (name: PipelineStageName): void => {
    const message = options.artifactFaults?.[name];
    if (message !== undefined) throw new Error(message);
  };
  const emit = (outcome: StageOutcome<ArtifactBag>): void => {
    stages.push(outcome.stage);
    if (outcome.value) Object.assign(artifacts, outcome.value);
  };

  // ── generate ──────────────────────────────────────────────────────────────
  emit(
    runStage('generate', (): ArtifactBag => {
      fault('generate');
      const cloud = generateSyntheticCloud({ seed, pointCount });
      products.cloud = cloud;
      artifactFault('generate');
      return {
        fixture: toHashable({
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
        }),
        // The input itself, as bytes, so a reproducibility suite can state "the
        // same seed produced these exact points" without trusting the
        // descriptor above to be complete.
        pointBytes: bytesOf(cloud.positions),
      };
    }),
  );

  // ── rasterize ─────────────────────────────────────────────────────────────
  if (!isolateLeaves) {
    stages.push(declaredStage('rasterize', LEAVES_NOT_REQUESTED, 'node'));
  } else {
    emit(
      runStage('rasterize', (): ArtifactBag => {
        fault('rasterize');
        const cloud = require_(products.cloud, 'generate', 'the point cloud');
        const points = boxPoints(cloud.positions);
        // The app's own resolver, not a copy of its defaults: it is exported as
        // "the SINGLE source of truth" precisely so a second caller cannot
        // drift from the parameters the delivered surface was filtered with.
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
          // Read off the SAME params object handed to the core below, never a
          // second copy of the constant: two values that must agree is a drift
          // waiting to happen, and a leaf silently aggregating differently from
          // the surface it is supposed to mirror is invisible in every summary
          // field. One value, so there is nothing to disagree with.
          aggregation: analysisParams.aggregation,
          verticalAxis: analysisParams.verticalAxis,
        });
        artifactFault('rasterize');
        return {
          // The raw cell values, as bytes. The only value-sensitive evidence
          // this stage produces: every geometry field below is identical under
          // a wrong aggregation, so without these the leaf could rasterise the
          // scene differently from the core and no artifact would show it.
          rasterZBytes: bytesOf(raster.z),
          rasterSummary: toHashable({
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
          }),
        };
      }),
    );
  }

  // ── dtm ───────────────────────────────────────────────────────────────────
  emit(
    runStage('dtm', (): ArtifactBag => {
      fault('dtm');
      const cloud = require_(products.cloud, 'generate', 'the point cloud');
      const core = computeTerrainCore(cloud.positions, analysisParams);
      products.core = core;
      artifactFault('dtm');
      return {
        dtmSummary: toHashable(summariseCore(core)),
        // The grids go out as RAW BYTES, not as converted arrays. `toHashable`
        // → `assertHashable` → `stripVolatile` → `canonicalJson` is three full
        // copies of every cell plus a template-literal path string per element,
        // which measured ~300 MB of transient heap for ONE 500k run; cell count
        // scales with the tile AREA, so the top of the ladder would have been
        // multiple gigabytes. Bytes also carry a NaN cell across exactly,
        // rather than through the `'NaN'` spelling the JSON path needs.
        dtmZBytes: bytesOf(core.dtm.z),
        dtmConfidenceBytes: bytesOf(core.dtm.confidence),
        dtmCoverageBytes: bytesOf(core.dtm.coverage),
        dtmCountsBytes: bytesOf(core.dtm.counts),
        // Height above bare earth is a per-cell product, not a statistic, so it
        // travels with the grids rather than on the summary.
        heightAboveGroundBytes: bytesOf(core.surface.canopy.heightM),
      };
    }),
  );

  // ── descriptors ───────────────────────────────────────────────────────────
  if (!isolateLeaves) {
    stages.push(declaredStage('descriptors', LEAVES_NOT_REQUESTED, 'node'));
  } else {
    emit(
      runStage('descriptors', (): ArtifactBag => {
        fault('descriptors');
        const core = require_(products.core, 'dtm', 'the terrain core');
        // The same guard the core applies: on a grid with no covered cells the
        // summary is null rather than figures computed over nothing. Without
        // mirroring it, a degenerate cloud makes the driver and the application
        // disagree and the drift guard goes red for the wrong reason.
        if (!core.dtm.coverage.some((c) => c !== 0)) return {};
        // The same conversion the core applies before its own complexity pass,
        // via the app's function rather than a hard-coded "cells are metres" —
        // a foot-based or geographic frame would make that assumption wrong and
        // the window/radius statements would report ground sizes that never
        // existed.
        const cell = horizontalCellMetresXY(
          core.dtm.cellSizeM,
          analysisParams.isGeographic,
          analysisParams.latitudeDeg,
          analysisParams.horizontalUnitToMetres,
        );
        const complexity = summariseTerrainComplexity({
          z: core.dtm.z,
          coverage: core.dtm.coverage,
          cols: core.dtm.cols,
          rows: core.dtm.rows,
          // The Horn slope/aspect grids the core already computed and exposes
          // for reuse — recomputing them here would time a derivative pass
          // twice and risk measuring a differently-parameterised one.
          slope: core.surface.relief.slope,
          aspect: core.surface.relief.aspect,
          cellMetresX: cell.x,
          cellMetresY: cell.y,
          verticalUnitToMetres: analysisParams.verticalUnitToMetres,
          meta: {
            coverage: core.dtm.coverageMode,
            sourcePointCount: core.dtm.sourcePointCount,
            analyzedPointCount: core.dtm.analyzedPointCount,
          },
          groundDensityPerM2: core.cellMetrics.meanDensity,
        });
        artifactFault('descriptors');
        return complexity === null ? {} : { descriptors: toHashable(complexity) };
      }),
    );
  }

  // ── contours ──────────────────────────────────────────────────────────────
  emit(
    runStage('contours', (): ArtifactBag => {
      fault('contours');
      const core = require_(products.core, 'dtm', 'the terrain core');
      const result = contoursFromCore(core, analysisParams);
      products.result = result;
      artifactFault('contours');
      return {
        contours: toHashable({
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
        }),
        // The exported geometry itself — what a GIS would receive — so the
        // reproducibility suite compares the deliverable, not a summary of it.
        contourFeatures: toHashable(result.model),
      };
    }),
  );

  // ── scientificRecord ──────────────────────────────────────────────────────
  const generatedAt = options.generatedAt ?? FIXED_GENERATED_AT;
  emit(
    runStage('scientificRecord', (): ArtifactBag => {
      fault('scientificRecord');
      const result = require_(products.result, 'contours', 'the analysis result');
      // buildExportProvenance is the app's one derivation of provenance from a
      // run; the record and the manifest are both derived from it, exactly as
      // every exporter does, so the benchmark stamps what a real export stamps.
      const provenance = buildExportProvenance(result, {
        basename: options.basename ?? null,
        generatedAt,
        verticalUnitToMetres: analysisParams.verticalUnitToMetres,
      });
      products.provenance = provenance;
      const record = analysisRecordFromProvenance(provenance);
      // The build identity and the generation time are what make the full
      // record machine-scoped; dropping them leaves the science, including the
      // app's own contentHash taken over exactly that science. See the header.
      const { build: _build, generatedAt: _generatedAt, ...content } = record;
      artifactFault('scientificRecord');
      return {
        scientificRecord: toHashable(record),
        scientificRecordContent: toHashable(content),
      };
    }),
  );

  // ── manifest ──────────────────────────────────────────────────────────────
  emit(
    runStage('manifest', (): ArtifactBag => {
      fault('manifest');
      const provenance = require_(products.provenance, 'scientificRecord', 'the export provenance');
      const manifest = processingManifestFromProvenance(provenance);
      // Verify the chain in the same stage that built it. A manifest that does
      // not verify is a failed stage, not a field on an artifact nobody reads.
      const verification = verifyProcessingManifest(manifest);
      if (!verification.ok) {
        throw new Error(
          `processing manifest failed to verify at op ${String(verification.firstInvalid)}`,
        );
      }
      artifactFault('manifest');
      return { processingManifest: toHashable(manifest) };
    }),
  );

  // ── the browser half ──────────────────────────────────────────────────────
  for (const name of BROWSER_ONLY_STAGES) {
    stages.push(declaredStage(name, BROWSER_STAGE_REASONS[name], 'browser'));
  }

  return {
    datasetId: products.cloud?.datasetId ?? `synthetic-${pointCount}-seed${seed}`,
    seed,
    pointCount,
    analysisParams,
    stages,
    artifacts,
    metrics: headlineMetrics(stages, pointCount),
    cloud: products.cloud,
    result: products.result,
  };
}

/**
 * A stage that exists but carries no number, with the reason it carries none.
 *
 * Status 'ok' rather than 'failed': nothing went wrong, and a red row in every
 * reporter would tell a reader the opposite. The honest statement lives in the
 * metric's reason, which is exactly where the framework's schema puts it — and
 * the schema makes it impossible to attach a number to it.
 */
function declaredStage(
  name: PipelineStageName,
  reason: string,
  runtime: MetricRuntime,
): StageResult {
  const provenance = { runtime, deterministic: false } as const;
  return {
    name,
    status: 'ok',
    duration: unavailable(reason, provenance),
    peakMemory: unavailable(reason, provenance),
  };
}

/**
 * Headline numbers for a report.
 *
 * Each is stated only when every stage behind it produced a measurement — a
 * "points/s" computed from a stage that never ran is the fabricated number this
 * whole framework exists to avoid.
 */
function headlineMetrics(
  stages: readonly StageResult[],
  pointCount: number,
): Record<string, Metric> {
  const provenance = { runtime: 'node', deterministic: false } as const;
  // The application's analysis proper: the app's own two halves, nothing else.
  const analysisMs = sumStages(stages, ['dtm', 'contours']);
  const runMs = pipelineDurationMs(stages);
  return {
    pointCount: measured(pointCount, 'points', { runtime: 'node', deterministic: true }),
    analysisDurationMs:
      analysisMs === null
        ? unavailable(
            'the dtm or contours stage did not complete, so there is no analysis time',
            provenance,
          )
        : measured(analysisMs, 'ms', provenance),
    runDurationMs:
      runMs === null
        ? unavailable('a pipeline stage did not complete, so the run has no total', provenance)
        : measured(runMs, 'ms', provenance),
    pointsPerSecond:
      analysisMs === null || analysisMs <= 0
        ? unavailable(
            'throughput needs a completed dtm + contours pair with a non-zero duration',
            provenance,
          )
        : measured((pointCount / analysisMs) * 1000, 'points/s', provenance),
  };
}

/** Sum named stages' durations, or null when any one is missing a measurement. */
function sumStages(stages: readonly StageResult[], names: readonly string[]): number | null {
  let total = 0;
  for (const name of names) {
    const stage = stages.find((s) => s.name === name);
    if (!stage || stage.status !== 'ok' || stage.duration.status !== 'measured') return null;
    total += stage.duration.value;
  }
  return total;
}

/**
 * A byte view over a typed array — no copy, over the buffer the pipeline
 * produced.
 *
 * Byte order is little-endian on both architectures this project targets, so a
 * hash taken here is comparable between an arm64 laptop and an x86_64 runner. A
 * big-endian host would hash identical science differently: a limitation worth
 * naming rather than one to discover.
 */
function bytesOf(array: Float32Array | Uint8Array | Uint32Array): Uint8Array {
  return new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
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
      // The canopy GRID goes out as bytes; only its statistics belong here.
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
