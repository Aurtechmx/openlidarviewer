/**
 * terrainFeatureFlags.test.ts
 *
 * Asserts the most important production contract: no terrain UI is
 * exposed by default.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TERRAIN_FEATURE_FLAGS,
  readTerrainFlagsFromUrl,
} from '../src/terrain/TerrainFeatureFlags';

describe('TerrainFeatureFlags — production defaults', () => {
  it('experimental UI is OFF by default', () => {
    expect(DEFAULT_TERRAIN_FEATURE_FLAGS.terrainExperimentalUiEnabled).toBe(false);
  });

  it('engine + worker are ON internally', () => {
    expect(DEFAULT_TERRAIN_FEATURE_FLAGS.terrainEngineEnabled).toBe(true);
    expect(DEFAULT_TERRAIN_FEATURE_FLAGS.terrainWorkerEnabled).toBe(true);
  });

  it('debug logging is OFF by default', () => {
    expect(DEFAULT_TERRAIN_FEATURE_FLAGS.terrainDebugEnabled).toBe(false);
  });

  it('?terrainUi=1 enables experimental UI', () => {
    const flags = readTerrainFlagsFromUrl('?terrainUi=1');
    expect(flags.terrainExperimentalUiEnabled).toBe(true);
  });

  it('?terrainDebug=1 enables debug logging', () => {
    const flags = readTerrainFlagsFromUrl('?terrainDebug=1');
    expect(flags.terrainDebugEnabled).toBe(true);
  });

  it('empty search preserves defaults', () => {
    expect(readTerrainFlagsFromUrl('')).toEqual(DEFAULT_TERRAIN_FEATURE_FLAGS);
  });
});
