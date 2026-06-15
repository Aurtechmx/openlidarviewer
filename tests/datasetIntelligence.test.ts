/**
 * datasetIntelligence.test.ts
 *
 * Deterministic-output tests for the Dataset Intelligence
 * classifiers + summariser. The Inspector card is purely a
 * presentation wrapper, so the bulk of the surface we need to
 * defend lives here in pure data.
 *
 * Test families requested by the brief:
 *   - Density       (sparse / moderate / dense / very-dense)
 *   - Complexity    (low / moderate / high / very-high)
 *   - Coverage      (full / resident-only / sampled)
 *   - Confidence    (value + colour band)
 *   - Empty state   (renders safely)
 */

import { describe, it, expect } from 'vitest';
import {
  classifyComplexity,
  classifyCoverage,
  classifyDensity,
  densityLabel,
  classifyGroundVisibility,
  confidenceBand,
  coverageStreamingWarning,
  summariseDataset,
} from '../src/terrain/datasetIntelligence';
import type { TerrainCoverageMeta } from '../src/terrain/TerrainContracts';

// ── Density ──────────────────────────────────────────────────────

describe('classifyDensity', () => {
  it("reads as unknown when neither pointCount nor density is known (not a fabricated 'sparse')", () => {
    expect(classifyDensity({})).toBe('unknown');
  });

  it('uses residentDensity when supplied', () => {
    // 0.5 is a genuine measured low density — it stays 'sparse', not 'unknown'.
    expect(classifyDensity({ residentDensity: 0.5 })).toBe('sparse');
    expect(classifyDensity({ residentDensity: 10 })).toBe('moderate');
    expect(classifyDensity({ residentDensity: 100 })).toBe('dense');
    expect(classifyDensity({ residentDensity: 1000 })).toBe('very-dense');
  });

  it('falls back to pointCount / bboxVolume', () => {
    // ratio = 10 → moderate band (4–40 pts/m³)
    expect(classifyDensity({ pointCount: 10_000, bboxVolume: 1000 })).toBe('moderate');
    // ratio = 1000 → very-dense (> 400 pts/m³)
    expect(classifyDensity({ pointCount: 1_000_000, bboxVolume: 1000 })).toBe('very-dense');
  });

  it('returns unknown (no signal) for non-finite or zero/negative inputs', () => {
    expect(classifyDensity({ pointCount: 1000, bboxVolume: 0 })).toBe('unknown');
    expect(classifyDensity({ residentDensity: Number.NaN })).toBe('unknown');
    expect(classifyDensity({ residentDensity: -1 })).toBe('unknown');
  });

  it('labels the unknown bucket as "—"', () => {
    expect(densityLabel('unknown')).toBe('—');
  });
});

// ── Complexity ───────────────────────────────────────────────────

describe('classifyComplexity', () => {
  it('reads as low for a flat, smooth, uniform-z neighborhood', () => {
    expect(
      classifyComplexity({ meanSlopeDeg: 1, meanRoughness: 0.01, elevationVariance: 0.1 }),
    ).toBe('low');
  });

  it('reads as moderate for rolling terrain', () => {
    expect(
      classifyComplexity({ meanSlopeDeg: 15, meanRoughness: 0.15, elevationVariance: 5 }),
    ).toBe('moderate');
  });

  it('reads as high for steep / rough terrain', () => {
    expect(
      classifyComplexity({ meanSlopeDeg: 28, meanRoughness: 0.3, elevationVariance: 15 }),
    ).toBe('high');
  });

  it('reads as very-high for mountainous terrain', () => {
    expect(
      classifyComplexity({ meanSlopeDeg: 42, meanRoughness: 0.45, elevationVariance: 22 }),
    ).toBe('very-high');
  });

  it('returns unknown when no signal at all is supplied — never fabricates', () => {
    expect(classifyComplexity({})).toBe('unknown');
  });

  it('a single signal is enough to produce a real bucket', () => {
    expect(classifyComplexity({ meanSlopeDeg: 40 })).toBe('moderate');
  });
});

// ── Ground Visibility (lightweight smoke-test of the heuristic) ──

describe('classifyGroundVisibility', () => {
  it('reads as excellent when most points are already ground-classified', () => {
    expect(
      classifyGroundVisibility({
        terrainSuggestion: {
          shouldSuggest: true,
          groundFraction: 0.85,
          vegetationFraction: 0.05,
          buildingFraction: 0.02,
          reason: 'mostly ground',
        },
      }),
    ).toBe('excellent');
  });

  it('returns unknown when no signals are present — never fabricates poor', () => {
    expect(classifyGroundVisibility({})).toBe('unknown');
  });

  it('penalises heavy vegetation cover', () => {
    // High ground-class but a heavy canopy on top — the vegetation
    // half-weight pulls the bucket down from excellent to good.
    const dense = classifyGroundVisibility({
      terrainSuggestion: {
        shouldSuggest: true,
        groundFraction: 0.9,
        vegetationFraction: 0.6,
        buildingFraction: 0.02,
        reason: 'dense canopy',
      },
    });
    const clear = classifyGroundVisibility({
      terrainSuggestion: {
        shouldSuggest: true,
        groundFraction: 0.9,
        vegetationFraction: 0,
        buildingFraction: 0.02,
        reason: 'clear ground',
      },
    });
    expect(clear).toBe('excellent');
    // Heavy veg drops the bucket at least one level.
    expect(dense).not.toBe('excellent');
  });
});

// ── Coverage ─────────────────────────────────────────────────────

describe('classifyCoverage + streaming warning', () => {
  const baseMeta = (mode: TerrainCoverageMeta['coverage']): TerrainCoverageMeta => ({
    coverage: mode,
    sourcePointCount: 1_000_000,
    analyzedPointCount: 800_000,
    confidence: 80,
    warnings: [],
  });

  it('passes through the engine coverage mode 1:1', () => {
    expect(classifyCoverage(baseMeta('full'))).toBe('full');
    expect(classifyCoverage(baseMeta('resident-only'))).toBe('resident-only');
    expect(classifyCoverage(baseMeta('sampled'))).toBe('sampled');
  });

  it('defaults to sampled when no engine output yet — keeps the warning on', () => {
    expect(classifyCoverage(undefined)).toBe('sampled');
  });

  it('full coverage has no streaming warning', () => {
    expect(coverageStreamingWarning('full')).toBeUndefined();
  });

  it('partial coverage emits the streaming warning', () => {
    const w1 = coverageStreamingWarning('resident-only');
    const w2 = coverageStreamingWarning('sampled');
    expect(w1).toBeDefined();
    expect(w2).toBeDefined();
    expect(w1).toMatch(/currently loaded data/);
    expect(w2).toMatch(/may change as additional points stream/);
  });
});

// ── Confidence band + value ──────────────────────────────────────

describe('confidenceBand', () => {
  it('green at 75+', () => {
    expect(confidenceBand(75)).toBe('green');
    expect(confidenceBand(99)).toBe('green');
  });

  it('yellow in 50..74', () => {
    expect(confidenceBand(50)).toBe('yellow');
    expect(confidenceBand(74)).toBe('yellow');
  });

  it('red for finite values below 50', () => {
    expect(confidenceBand(49)).toBe('red');
    expect(confidenceBand(0)).toBe('red');
  });

  it('unknown for non-finite or undefined', () => {
    // v0.3.10 honesty pass — `confidenceBand` previously mapped NaN /
    // undefined to `'red'`, but "no measurement" and "low measurement"
    // are different states. The new `'unknown'` branch lets the
    // Dataset Intelligence card render `"—"` for the "no signal" case
    // instead of a fake red bucket. See `ConfidenceBand` for the
    // ordered union.
    expect(confidenceBand(Number.NaN)).toBe('unknown');
    expect(confidenceBand(Number.POSITIVE_INFINITY)).toBe('unknown');
    expect(confidenceBand(undefined)).toBe('unknown');
  });
});

// ── Empty state — summariser returns null when nothing's known ───

describe('summariseDataset — empty state', () => {
  it('returns null when no fields at all are supplied', () => {
    expect(summariseDataset({})).toBeNull();
  });

  it('returns a valid summary when at least one field is supplied', () => {
    const out = summariseDataset({ pointCount: 100_000, bboxVolume: 1000 });
    expect(out).not.toBeNull();
    if (out) {
      expect(out.density.label).toBe('Dense');
      expect(out.coverage.bucket).toBe('sampled');
      expect(out.coverage.streamingWarning).toBeDefined();
    }
  });

  it('coverage label matches the engine output', () => {
    const out = summariseDataset({
      pointCount: 1_000_000,
      bboxVolume: 100_000,
      coverageMeta: {
        coverage: 'full',
        sourcePointCount: 1_000_000,
        analyzedPointCount: 1_000_000,
        confidence: 92,
        warnings: [],
      },
    });
    expect(out).not.toBeNull();
    if (out) {
      expect(out.coverage.label).toBe('Full Dataset');
      expect(out.confidence.band).toBe('green');
      expect(out.confidence.label).toBe('92%');
      expect(out.coverage.streamingWarning).toBeUndefined();
      expect(out.details.coverageMode).toBe('Full Dataset');
      expect(out.details.engineStatus).toBe('active');
    }
  });

  it('engineStatus reads idle when no engine output is attached', () => {
    const out = summariseDataset({ pointCount: 1, bboxVolume: 1 });
    expect(out?.details.engineStatus).toBe('idle');
  });
});
