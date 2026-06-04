/**
 * TerrainFeatureFlags.ts
 *
 * Internal feature flags for the terrain *foundation* subsystem. The engine
 * runs internally for foundation work, but its own experimental UI surfaces
 * stay OFF in production. Note: the shipped terrain products (the Analyse
 * panel, contours, surface models, DEM export) are a separate pipeline under
 * `src/terrain/contour|ground|surface` and are NOT gated by this flag.
 */

/** The flag set. */
export interface TerrainFeatureFlags {
  /** Engine + worker registration. */
  readonly terrainEngineEnabled: boolean;
  /** Use Web Worker for long-running analyses (vs main thread). */
  readonly terrainWorkerEnabled: boolean;
  /** Verbose console logging from the engine. */
  readonly terrainDebugEnabled: boolean;
  /**
   * Whether the foundation's EXPERIMENTAL terrain UI may render. Stays
   * `false` in production — these are the engine's own unfinished controls,
   * distinct from the shipped Analyse panel (which is always mounted and
   * does not consult this flag).
   */
  readonly terrainExperimentalUiEnabled: boolean;
}

/** Default flag values for production builds. */
export const DEFAULT_TERRAIN_FEATURE_FLAGS: TerrainFeatureFlags = {
  terrainEngineEnabled: true,
  terrainWorkerEnabled: true,
  terrainDebugEnabled: false,
  /** The foundation's experimental UI stays off in production. */
  terrainExperimentalUiEnabled: false,
};

/**
 * Read flags from the page URL search string. Honoured params:
 *
 *   - `?terrainDebug=1` — enables debug logging.
 *   - `?terrainUi=1` — enables experimental UI (developer use).
 *
 * Defaults apply when params are absent. The function is pure: pass
 * any search string in tests.
 */
export function readTerrainFlagsFromUrl(
  search: string,
  defaults: TerrainFeatureFlags = DEFAULT_TERRAIN_FEATURE_FLAGS,
): TerrainFeatureFlags {
  try {
    const params = new URLSearchParams(search);
    return {
      ...defaults,
      terrainDebugEnabled:
        params.get('terrainDebug') === '1' ? true : defaults.terrainDebugEnabled,
      terrainExperimentalUiEnabled:
        params.get('terrainUi') === '1' ? true : defaults.terrainExperimentalUiEnabled,
    };
  } catch {
    return defaults;
  }
}
