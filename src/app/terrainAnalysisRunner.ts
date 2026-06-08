// Terrain-analysis orchestration — extracted from main.ts.
//
// `run()` drives the confidence-aware terrain pipeline on the loaded scan and
// updates the Analyse panel. The async path is fully race-guarded: each run
// claims a monotonic token + snapshots the active dataset, and bails after
// every await if a newer run started, the scan changed/closed, or the panel
// was hidden — only the winning run touches the UI (the A-1 stale-result
// guard). The heavy core is cached by a content+params fingerprint and computed
// off the main thread in a worker (with a safe main-thread fallback).
//
// The three pieces of mutable run state (the token, the in-flight
// AbortController, and the lazily-captured cache-clear fn) belong together with
// the runner, so they are encapsulated here. `abortAndClearCache()` exposes the
// teardown the reset-to-empty path needs without reaching into that state.
//
// Stateful collaborators that change over the app's lifetime — the lazy
// `viewer` and the `activeId` selection — are read through getters so the
// runner always sees current values without a top-level `viewer.*` dereference
// in main.ts.
import type { Viewer } from '../render/Viewer';
import type { AnalysePanel } from '../ui/AnalysePanel';
import type { CrsService } from '../geo/CrsService';
import type {
  AnalyseContoursResult,
  TerrainCoreParams,
} from '../terrain/contour/analyseContours';
import type { ContourShapeStyle } from '../terrain/contour/contourShapeStyle';
import {
  loadTerrainCoreCache,
  loadComputeTerrainCoreAsync,
} from '../lazyChunks';

/**
 * Derive the interval-INDEPENDENT core params (cell size + resolved CRS / datum)
 * from the gathered positions, exactly as {@link TerrainAnalysisRunner.run}
 * does. Factored out so the PDF export's interval re-pick produces a
 * byte-identical fingerprint and therefore HITS the same cached core instead of
 * recomputing the heavy half.
 */
function deriveCoreParams(
  positions: Float32Array,
  classification: Uint8Array | undefined,
  crsService: CrsService,
): TerrainCoreParams {
  const n = positions.length / 3;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  // Aim for a grid ~256 cells across, clamped to a sane floor.
  const extent = Math.max(maxX - minX, maxY - minY, 1);
  const cellSizeM = Math.max(0.25, extent / 256);
  const cur = crsService.current();
  const crsName = cur && (cur.kind === 'projected' || cur.kind === 'geographic') ? cur.name : null;
  return {
    cellSizeM,
    crs: crsName,
    isGeographic: cur?.kind === 'geographic',
    verticalUnitToMetres: cur?.linearUnitToMetres ?? 1,
    horizontalUnitToMetres: cur?.linearUnitToMetres ?? 1,
    verticalDatum: cur?.verticalDatum ?? null,
    classification,
  };
}

export interface TerrainAnalysisRunnerDeps {
  /** Returns the lazy Viewer instance (null-typed until its chunk resolves). */
  getViewer: () => Viewer;
  /** The Analyse panel the winning run updates. */
  analysePanel: AnalysePanel;
  /** The active static cloud id, snapshotted per run for the stale-result guard. */
  getActiveId: () => string | null;
  /** The centralised CRS service — feeds the resolved CRS into the analysis. */
  crsService: CrsService;
  /**
   * Fired with the winning run's result right after it lands on the panel. The
   * host uses it to wire post-analysis state that lives outside the panel — e.g.
   * adopting the DTM-confidence grid on the Viewer so the "Coverage" colour mode
   * becomes available. Never fired for a stale / aborted run.
   */
  onResult?: (result: AnalyseContoursResult) => void;
}

export interface TerrainAnalysisRunner {
  /**
   * Run the confidence-aware terrain pipeline on the loaded scan and update
   * the Analyse panel. Points are gathered (and strided if huge) from the
   * Viewer; the analysis is synchronous but yields once so the busy state
   * paints, and is fully guarded so a failure never breaks the shell.
   */
  run(intervalM?: number): Promise<void>;
  /**
   * Build a fresh contour result at a chosen interval for the PDF export WITHOUT
   * touching the visible panel/result. Reuses the SAME cached-core path as
   * {@link run} (`getOrComputeCoreAsync` → cache hit → `contoursFromCore`), so a
   * re-pick on the open scan never recomputes the heavy half. Throws when no
   * scan is loaded. Has no side effects on the panel.
   */
  buildResultAtInterval(intervalM: number): Promise<AnalyseContoursResult>;
  /**
   * Build a fresh contour result at a chosen interval AND shape style for an
   * export ONLY, over the SAME cached core path as {@link run}. Generalises
   * {@link buildResultAtInterval} with the contour-shape-style picker; a cache
   * hit means only the cheap contour stage reruns. No panel side effects.
   */
  buildResultForExport(opts: {
    intervalM: number;
    shapeStyle: ContourShapeStyle;
  }): Promise<AnalyseContoursResult>;
  /**
   * Abort any in-flight compute and drop every cached terrain core. Called
   * from the reset-to-empty path so a result for the now-closed scan can never
   * land on the panel and cached cores stay bounded. Guarded: the cache chunk
   * is only loaded after the first run, and before that there is nothing to
   * clear — so this never eagerly pulls the heavy analysis chunk.
   */
  abortAndClearCache(): void;
}

/**
 * Build the terrain-analysis runner. Behaviour — including ordering, the A-1
 * stale-result guard, the fingerprint cache, and the worker offload — is
 * identical to the original `runTerrainAnalysis` in main.ts; only the run-state
 * and the lazy-collaborator references moved behind this factory.
 */
export function createTerrainAnalysisRunner(
  deps: TerrainAnalysisRunnerDeps,
): TerrainAnalysisRunner {
  const { getViewer, analysePanel, getActiveId, crsService, onResult } = deps;

  // Monotonic token for terrain-analysis runs. `run` is async (lazy chunk
  // import + a paint yield), so rapid interval clicks can overlap and resolve
  // out of order, and a run can still be in flight when the scan is closed or
  // swapped. Each invocation captures the token + active dataset at start and
  // bails after every await if a newer run started, the dataset changed, or
  // the panel was closed — only the winning run touches the panel.
  let terrainRunToken = 0;
  // Captured once the terrain-core-cache chunk has loaded (first run), so
  // dataset close / new-cloud load can drop cached cores WITHOUT eagerly
  // pulling the heavy analysis chunk. Null until the first analysis happens —
  // before that there is nothing cached to clear anyway.
  let clearTerrainCoreCacheFn: (() => void) | null = null;
  // AbortController for the in-flight terrain-core compute (worker or
  // fallback). A newer run, an interval re-pick, or a dataset close aborts the
  // previous controller so a superseded worker job is cancelled and its reply
  // dropped. Null when no run is in flight.
  let terrainAbort: AbortController | null = null;

  async function run(intervalM?: number): Promise<void> {
    const viewer = getViewer();
    const gathered = viewer.gatherTerrainPositions();
    if (!gathered) {
      analysePanel.setStatus('Load a scan first, then run terrain analysis.');
      return;
    }
    // Claim a token + snapshot the dataset identity for this run. After every
    // await we re-check these: a newer run (token mismatch), a different/closed
    // scan (activeId changed), or a hidden panel means this result is stale and
    // must not touch the UI — the newer run (or the reset) owns it now.
    const runToken = ++terrainRunToken;
    const runDatasetId = getActiveId();
    const isStale = (): boolean =>
      runToken !== terrainRunToken || getActiveId() !== runDatasetId || !analysePanel.isVisible();
    // Abort any prior in-flight compute (a superseded run / interval re-pick) so
    // its worker job is cancelled and its reply dropped, then claim a fresh one.
    terrainAbort?.abort();
    const abort = new AbortController();
    terrainAbort = abort;
    analysePanel.setBusy(true);
    // Let the "Analysing…" state paint before the synchronous compute.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (isStale()) return;
    try {
      // The terrain "core" (classification → ground → DTM → validation →
      // calibration → gate → quality → surface) depends only on the points +
      // interval-INDEPENDENT params, so it is cached by a fingerprint of the
      // cloud content + those params. The first run computes it; an interval
      // change (or a re-opened panel, or a re-run on the same scan) reuses it and
      // only the cheap contour stage reruns. The cache rides the same lazy chunk
      // as the analysis pipeline, so there is no extra dynamic import.
      const { getOrComputeCoreAsync, contoursFromCore, clearTerrainCoreCache } =
        await loadTerrainCoreCache();
      // The worker-backed async compute bridge: it runs the heavy core OFF the
      // main thread in a dedicated worker, with a SAFE main-thread fallback if the
      // worker can't load. Lazily imported alongside the cache chunk; importing it
      // never constructs a Worker (the client is itself dynamic-imported on use).
      const { computeTerrainCoreAsync } = await loadComputeTerrainCoreAsync();
      // Remember the clear fn so dataset close / new-cloud load can drop cached
      // cores without re-importing this heavy chunk.
      clearTerrainCoreCacheFn = clearTerrainCoreCache;
      if (isStale()) return;
      const pos = gathered.positions;
      // Interval-independent (cacheable) core params. The fingerprint cache keys
      // a core by the cloud content + exactly these, so re-picking an interval
      // hits the cache instead of recomputing the heavy half. Feeds the active
      // scan's resolved CRS + vertical datum into the analysis so the readiness
      // gate and export honesty reflect a georeferenced file.
      const coreParams = deriveCoreParams(pos, gathered.classification, crsService);
      // Compute (or reuse) the heavy core. On a cache hit no worker runs; on a
      // miss the worker computes it off-thread (or the fallback does on-thread if
      // the worker can't load). The AbortSignal cancels a superseded run.
      const core = await getOrComputeCoreAsync(pos, coreParams, (input, params) =>
        computeTerrainCoreAsync(
          input as Float32Array,
          (input as Float32Array).length / 3,
          params,
          params.classification,
          abort.signal,
        ),
      );
      if (isStale()) return;
      // Cheap interval-dependent stage: contours → stitch → style → labels.
      const result = contoursFromCore(core, { intervalM });
      // Final guard before touching the panel: a newer run, a swapped/closed
      // scan, or a hidden panel means this result lost the race — drop it and
      // leave the busy/skeleton state to whoever owns it now.
      if (isStale()) return;
      analysePanel.setBusy(false);
      analysePanel.update(result);
      // Hand the fresh result to the host AFTER the panel adopts it, so any
      // post-analysis wiring (e.g. the Viewer's coverage colour grid) sees the
      // same winning result the panel shows.
      onResult?.(result);
    } catch (err) {
      // A stale run must not clobber the winning run's busy flag or status.
      if (isStale()) return;
      // An aborted run was superseded on purpose (newer run / interval re-pick /
      // dataset close) — the winning run owns the panel state, so stay quiet.
      if (abort.signal.aborted) return;
      console.error('OpenLiDARViewer: terrain analysis failed.', err);
      analysePanel.setBusy(false);
      const msg = err instanceof Error ? err.message : String(err);
      analysePanel.setStatus(`Analysis failed: ${msg}`);
    } finally {
      // Release the controller reference if it is still ours (a newer run swaps
      // in its own). Leaves an aborted controller in place for the winner.
      if (terrainAbort === abort) terrainAbort = null;
    }
  }

  async function buildResultForExport(opts: {
    intervalM: number;
    shapeStyle?: ContourShapeStyle;
  }): Promise<AnalyseContoursResult> {
    const viewer = getViewer();
    const gathered = viewer.gatherTerrainPositions();
    if (!gathered) throw new Error('No scan loaded to build contours from.');
    // Same cached-core path the run() loop uses. Because deriveCoreParams
    // reproduces the run's fingerprint exactly, an already-analysed scan HITS
    // the LRU cache here and no worker job is started — only the cheap
    // interval-dependent contour stage reruns (now also re-picking the contour
    // shape style). We deliberately do NOT touch the panel or the run token:
    // this is a side-effect-free build for an export only.
    const { getOrComputeCoreAsync, contoursFromCore } = await loadTerrainCoreCache();
    const { computeTerrainCoreAsync } = await loadComputeTerrainCoreAsync();
    const coreParams = deriveCoreParams(gathered.positions, gathered.classification, crsService);
    const core = await getOrComputeCoreAsync(gathered.positions, coreParams, (input, params) =>
      computeTerrainCoreAsync(
        input as Float32Array,
        (input as Float32Array).length / 3,
        params,
        params.classification,
        // No abort here: a cache miss (scan analysed under a different fingerprint)
        // computes once; the export awaits it. There is no superseding run to cancel.
        new AbortController().signal,
      ),
    );
    return contoursFromCore(core, { intervalM: opts.intervalM, shapeStyle: opts.shapeStyle });
  }

  // Back-compat shim: the interval-only builder is the export builder with the
  // default shape style (the on-screen contour shape).
  async function buildResultAtInterval(intervalM: number): Promise<AnalyseContoursResult> {
    return buildResultForExport({ intervalM });
  }

  function abortAndClearCache(): void {
    // Abort any in-flight terrain compute (worker job + its reply) so a result
    // for the now-closed scan can never land on the panel.
    terrainAbort?.abort();
    terrainAbort = null;
    // Drop every cached terrain core so a stale core can't be served for a
    // different scan and memory stays bounded. Guarded: the cache chunk is only
    // loaded after the first run, and before that there is nothing to clear —
    // so this never eagerly pulls the heavy analysis chunk.
    clearTerrainCoreCacheFn?.();
  }

  return { run, buildResultAtInterval, buildResultForExport, abortAndClearCache };
}
