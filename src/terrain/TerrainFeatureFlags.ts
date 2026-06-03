/**
 * TerrainFeatureFlags.ts
 *
 * Internal feature flags for the terrain subsystem. v0.3.9 defaults
 * the engine ON internally for the foundation work but keeps every
 * UI surface OFF so no unfinished terrain controls appear in
 * production.
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
   * Whether ANY public terrain UI may render. MUST be `false` in
   * v0.3.9 — terrain tools are not user-ready. Future releases will
   * flip specific surfaces on once they're polished.
   */
  readonly terrainExperimentalUiEnabled: boolean;
}

/** Default flag values for production builds. */
export const DEFAULT_TERRAIN_FEATURE_FLAGS: TerrainFeatureFlags = {
  terrainEngineEnabled: true,
  terrainWorkerEnabled: true,
  terrainDebugEnabled: false,
  /** v0.3.9: terrain UI must NOT appear in production. */
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
