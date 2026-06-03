/**
 * terrainContracts.test.ts
 *
 * Asserts the honesty contract: every TerrainAnalysisResult MUST
 * include coverage / sourcePointCount / analyzedPointCount /
 * confidence / warnings.
 */

import { describe, it, expect } from 'vitest';
import {
  isHonestTerrainResult,
  makeCoverageMeta,
  summariseQuality,
} from '../src/terrain/TerrainResult';
import type { TerrainAnalysisResult } from '../src/terrain/TerrainContracts';

describe('makeCoverageMeta — honesty fields', () => {
  it('full coverage with all points walked → high confidence', () => {
    const meta = makeCoverageMeta({
      coverage: 'full',
      sourcePointCount: 1000,
      analyzedPointCount: 1000,
    });
    expect(meta.confidence).toBe(100);
    expect(meta.warnings.length).toBe(0);
  });

  it('resident-only → reduced confidence + caveat', () => {
    const meta = makeCoverageMeta({
      coverage: 'resident-only',
      sourcePointCount: 1000,
      analyzedPointCount: 500,
    });
    expect(meta.confidence).toBeLessThan(100);
    expect(meta.warnings[0]).toContain('Resident');
  });

  it('sampled → caveat appended', () => {
    const meta = makeCoverageMeta({
      coverage: 'sampled',
      sourcePointCount: 1000,
      analyzedPointCount: 200,
    });
    expect(meta.warnings.some((w) => w.startsWith('Sampled'))).toBe(true);
  });

  it('analyser-supplied confidence override is honoured', () => {
    const meta = makeCoverageMeta({
      coverage: 'full',
      sourcePointCount: 1000,
      analyzedPointCount: 1000,
      confidenceOverride: 73,
    });
    expect(meta.confidence).toBe(73);
  });

  it('confidence is clamped to 0..100', () => {
    expect(
      makeCoverageMeta({
        coverage: 'full',
        sourcePointCount: 1000,
        analyzedPointCount: 1000,
        confidenceOverride: 999,
      }).confidence,
    ).toBe(100);
    expect(
      makeCoverageMeta({
        coverage: 'full',
        sourcePointCount: 1000,
        analyzedPointCount: 1000,
        confidenceOverride: -5,
      }).confidence,
    ).toBe(0);
  });
});

describe('summariseQuality — UI badge', () => {
  it('flags residentOnly for streaming coverage', () => {
    const summary = summariseQuality(
      makeCoverageMeta({ coverage: 'resident-only', sourcePointCount: 100, analyzedPointCount: 50 }),
    );
    expect(summary.residentOnly).toBe(true);
  });

  it('does NOT flag residentOnly for full coverage', () => {
    const summary = summariseQuality(
      makeCoverageMeta({ coverage: 'full', sourcePointCount: 100, analyzedPointCount: 100 }),
    );
    expect(summary.residentOnly).toBe(false);
  });
});

describe('isHonestTerrainResult — type guard', () => {
  function honest(): TerrainAnalysisResult {
    return {
      kind: 'metrics',
      coverage: 'full',
      sourcePointCount: 10,
      analyzedPointCount: 10,
      confidence: 100,
      warnings: [],
      payload: {
        'slope-degrees': [],
        'roughness-rms': [],
        'curvature-mean': [],
        'elevation-variance': [],
        'point-density': [],
        'height-above-local-surface': [],
        'neighborhood-elevation-range': [],
        'local-planarity': [],
      },
      elapsedMs: 1,
    };
  }

  it('accepts a well-formed result', () => {
    expect(isHonestTerrainResult(honest())).toBe(true);
  });

  it('rejects a result missing warnings array', () => {
    const r = { ...honest() } as unknown as Record<string, unknown>;
    delete r.warnings;
    expect(isHonestTerrainResult(r)).toBe(false);
  });

  it('rejects a non-object', () => {
    expect(isHonestTerrainResult(null)).toBe(false);
    expect(isHonestTerrainResult(42)).toBe(false);
  });
});
