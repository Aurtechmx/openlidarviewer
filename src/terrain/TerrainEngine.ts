/**
 * TerrainEngine.ts
 *
 * The top-level orchestrator for the terrain *foundation*. It is an internal
 * seam: the shipped terrain products (Analyse panel, contours, surface models,
 * DEM export) run through the separate `src/terrain/contour|ground|surface`
 * pipeline, not this engine. The Dataset Intelligence card reads foundation
 * metrics directly.
 *
 * Responsibilities:
 *   - Hold the per-scan grid + tile partition.
 *   - Route analysis requests through the worker (or main-thread
 *     fallback).
 *   - Cache results keyed by request fingerprint.
 *   - Honour the feature flags.
 *
 * Future work adds DTM / DSM / hillshade / slope-map / contour
 * analyses as new request kinds — every one returns a
 * `TerrainAnalysisResult` so the engine API doesn't change.
 */

import type {
  TerrainAnalysisRequest,
  TerrainAnalysisResult,
} from './TerrainContracts';
import { TerrainError } from './TerrainErrors';
import {
  DEFAULT_TERRAIN_FEATURE_FLAGS,
  type TerrainFeatureFlags,
} from './TerrainFeatureFlags';
import type { TerrainJob } from './TerrainJob';
import {
  TerrainCache,
  type TerrainCacheKey,
} from './TerrainCache';
import { createTerrainJob, type TerrainAnalyser } from './TerrainWorker';

/** Engine options. */
export interface TerrainEngineOptions {
  readonly flags?: TerrainFeatureFlags;
  readonly cache?: TerrainCache;
  /** Analyser to call when no worker is registered. */
  readonly analyser?: TerrainAnalyser;
}

/** The top-level orchestrator. */
export class TerrainEngine {
  private readonly _flags: TerrainFeatureFlags;
  private readonly _cache: TerrainCache;
  private _analyser: TerrainAnalyser | null = null;
  private _jobCounter = 0;
  private _datasetFingerprint = '';

  constructor(opts: TerrainEngineOptions = {}) {
    this._flags = opts.flags ?? DEFAULT_TERRAIN_FEATURE_FLAGS;
    this._cache = opts.cache ?? new TerrainCache();
    if (opts.analyser) this._analyser = opts.analyser;
  }

  /** Register the analyser used to fulfil requests. */
  setAnalyser(analyser: TerrainAnalyser): void {
    this._analyser = analyser;
  }

  /** Set the dataset fingerprint used in cache keys. */
  setDatasetFingerprint(fingerprint: string): void {
    this._datasetFingerprint = fingerprint;
  }

  /** Active feature flags — surface to consumers as read-only. */
  get flags(): TerrainFeatureFlags {
    return this._flags;
  }

  /** Whether the foundation's experimental UI is allowed (off in production;
   *  the shipped Analyse panel is separate and not gated by this). */
  get isExperimentalUiAllowed(): boolean {
    return this._flags.terrainExperimentalUiEnabled;
  }

  /** Cache accessor — exposed so tests can assert hit/miss behaviour. */
  get cache(): TerrainCache {
    return this._cache;
  }

  /**
   * Submit an analysis request. Returns a `TerrainJob` whose
   * promise resolves with the result.
   *
   * Cached results short-circuit immediately — the returned job
   * resolves synchronously-after-await without engaging the
   * analyser.
   */
  analyse(request: TerrainAnalysisRequest): TerrainJob {
    if (!this._flags.terrainEngineEnabled) {
      throw new TerrainError('worker-unavailable', 'Terrain engine is disabled.');
    }
    if (!this._analyser) {
      throw new TerrainError(
        'worker-unavailable',
        'No terrain analyser registered. Call setAnalyser(...) first.',
      );
    }

    const id = `terrain-${++this._jobCounter}`;
    return createTerrainJob(id, request, async (req, report, signal) => {
      const result = await this._analyser!(req, report, signal);
      // Cache the completed result under the resolved coverage mode
      // — the analyser stamps the coverage onto the result.
      this._cache.insert(this._buildCacheKey(req, result.coverage), result);
      return result;
    });
  }

  /**
   * Retrieve a cached result. Bypasses the analyser entirely.
   * Returns `undefined` on miss.
   */
  cached(
    request: TerrainAnalysisRequest,
    coverageMode: string,
  ): TerrainAnalysisResult | undefined {
    return this._cache.retrieve(this._buildCacheKey(request, coverageMode));
  }

  /**
   * Single canonical key builder so the analyse path and the cached
   * path produce identical keys for the same request. Metrics are
   * sorted into a stable order; the analysisParameters JSON uses a
   * fixed key order so a property reorder by a caller doesn't mint
   * a duplicate cache entry.
   */
  private _buildCacheKey(
    request: TerrainAnalysisRequest,
    coverageMode: string,
  ): TerrainCacheKey {
    const analysisParameters = JSON.stringify({
      kind: request.kind,
      metrics: [...request.metrics].sort(),
      radius: request.radius ?? null,
    });
    return {
      datasetFingerprint: this._datasetFingerprint || 'unknown',
      tileId: request.tiles.length === 1 ? request.tiles[0] : -1,
      analysisParameters,
      coverageMode,
      pointCountHash: request.pointBudget ?? 0,
    };
  }
}
