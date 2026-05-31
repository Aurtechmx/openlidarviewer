/**
 * terrainSuggestion.ts
 *
 * Pure-data heuristic — should the Inspector hint the analyst to switch
 * to the Terrain inspection preset? Driven by the classification
 * histogram of the loaded cloud:
 *
 *   - LAS classification 2 is "Ground" (ASPRS).
 *   - LAS classifications 3 / 4 / 5 are "Low / Medium / High Vegetation".
 *   - LAS classifications 6 is "Building".
 *
 * The Terrain preset is worth suggesting when the cloud has enough
 * ground-classified or vegetation-classified points relative to the
 * total — the analyst is looking at a survey, not at a constructed
 * scene. Buildings push against the suggestion: a downtown scan with
 * lots of buildings reads as Infrastructure, not Terrain.
 *
 * Pure data — no DOM, no three.js — so the heuristic ships through
 * the same module-graph seam every Stream A leaf uses.
 */

/** Result of analysing a classification histogram for terrain suitability. */
export interface TerrainSuggestionResult {
  /** Whether the Terrain inspection preset is worth surfacing. */
  readonly shouldSuggest: boolean;
  /** Fraction of points classified as ground (LAS class 2), [0, 1]. */
  readonly groundFraction: number;
  /** Fraction of points classified as vegetation (LAS classes 3-5), [0, 1]. */
  readonly vegetationFraction: number;
  /** Fraction of points classified as buildings (LAS class 6), [0, 1]. */
  readonly buildingFraction: number;
  /**
   * A short, user-facing explanation. Inspector renders it next to a
   * "Switch to Terrain preset" CTA so the analyst sees the rationale.
   */
  readonly reason: string;
}

/** Inputs to `terrainSuggestion`. */
export interface TerrainSuggestionInput {
  /**
   * Per-point classification, Uint8 (LAS / LAZ / COPC / EPT all carry
   * the standard ASPRS classification byte). Length is the point count.
   */
  classifications: Uint8Array;
  /**
   * Optional sampling stride. The analyser walks one point every
   * `stride`, so a stride of 64 gives 1 / 64 the cloud's pixels.
   * Defaults to ~50 000-sample budget across the input.
   */
  stride?: number;
}

// ASPRS LAS classification codes — only the ones the heuristic uses.
const LAS_CLASS_GROUND = 2;
const LAS_CLASS_LOW_VEG = 3;
const LAS_CLASS_MED_VEG = 4;
const LAS_CLASS_HIGH_VEG = 5;
const LAS_CLASS_BUILDING = 6;

/** Documented thresholds — easy to retune if the heuristic proves jumpy. */
const GROUND_THRESHOLD = 0.35;
const VEGETATION_THRESHOLD = 0.25;
const BUILDING_VETO_THRESHOLD = 0.40;

/** Analyse a cloud's classification histogram and decide. */
export function terrainSuggestion(
  input: TerrainSuggestionInput,
): TerrainSuggestionResult {
  const total = input.classifications.length;
  if (total === 0) {
    return {
      shouldSuggest: false,
      groundFraction: 0,
      vegetationFraction: 0,
      buildingFraction: 0,
      reason: 'No classification data.',
    };
  }
  const targetSamples = 50_000;
  const stride = Math.max(
    1,
    input.stride ?? Math.max(1, Math.floor(total / targetSamples)),
  );

  let ground = 0;
  let veg = 0;
  let bldg = 0;
  let walked = 0;
  for (let i = 0; i < total; i += stride) {
    const c = input.classifications[i];
    if (c === LAS_CLASS_GROUND) ground++;
    else if (
      c === LAS_CLASS_LOW_VEG ||
      c === LAS_CLASS_MED_VEG ||
      c === LAS_CLASS_HIGH_VEG
    ) {
      veg++;
    } else if (c === LAS_CLASS_BUILDING) bldg++;
    walked++;
  }

  const groundFraction = walked === 0 ? 0 : ground / walked;
  const vegetationFraction = walked === 0 ? 0 : veg / walked;
  const buildingFraction = walked === 0 ? 0 : bldg / walked;

  // Decide.
  let shouldSuggest = false;
  let reason = '';
  if (buildingFraction >= BUILDING_VETO_THRESHOLD) {
    reason = `Buildings dominate (${(buildingFraction * 100).toFixed(0)} %). Infrastructure preset is a better default.`;
  } else if (groundFraction >= GROUND_THRESHOLD) {
    shouldSuggest = true;
    reason = `Ground classification covers ${(groundFraction * 100).toFixed(0)} %. Terrain preset will reveal elevation and shading.`;
  } else if (vegetationFraction >= VEGETATION_THRESHOLD) {
    shouldSuggest = true;
    reason = `Vegetation classification covers ${(vegetationFraction * 100).toFixed(0)} %. Terrain preset will surface canopy structure.`;
  } else {
    reason = `Ground / vegetation classification is sparse (${((groundFraction + vegetationFraction) * 100).toFixed(0)} %). No terrain hint.`;
  }

  return {
    shouldSuggest,
    groundFraction,
    vegetationFraction,
    buildingFraction,
    reason,
  };
}
