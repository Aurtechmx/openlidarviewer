/**
 * contourStudioLaunchStateFromResult.test.ts
 *
 * Verifies the adapter maps a real analysis result + frame context onto the
 * right launcher state, reading only fields the pipeline produces.
 */

import { describe, it, expect } from 'vitest';
import {
  contourStudioLaunchStateFromResult,
  contourStudioPrerequisitesFromResult,
  type LaunchFrameContext,
} from '../src/terrain/contourStudio/contourStudioLaunchStateFromResult';
import type { AnalyseContoursResult } from '../src/terrain/contour/analyseContours';

/** Minimal result stub carrying only the fields the adapter reads. */
function resultStub(over: {
  readiness?: 'ready' | 'previewOnly' | 'blocked';
  measured?: number;
  empty?: number;
  total?: number;
  recommendedM?: number | null;
}): AnalyseContoursResult {
  return {
    quality: { readiness: over.readiness ?? 'ready' },
    cellStatusTally: {
      measured: over.measured ?? 900,
      interpolated: 90,
      empty: over.empty ?? 10,
      lowConfidence: 0,
      edgeRisk: 0,
      total: over.total ?? 1000,
    },
    gate: {
      options: [],
      recommendedM: 'recommendedM' in over ? (over.recommendedM ?? null) : 0.5,
      warnings: [],
    },
  } as unknown as AnalyseContoursResult;
}

const OK_FRAME: LaunchFrameContext = {
  streaming: false,
  crsProjected: true,
  verticalUnitsKnown: true,
};

describe('contourStudioLaunchStateFromResult', () => {
  it('maps a ready, well-supported, fully-framed result to available', () => {
    const s = contourStudioLaunchStateFromResult(resultStub({ readiness: 'ready' }), OK_FRAME);
    expect(s.status).toBe('available');
  });

  it('maps a blocked quality gate to unavailable', () => {
    const s = contourStudioLaunchStateFromResult(resultStub({ readiness: 'blocked' }), OK_FRAME);
    expect(s.status).toBe('unavailable');
  });

  it('maps previewOnly readiness to exploratory (sparse support)', () => {
    const s = contourStudioLaunchStateFromResult(resultStub({ readiness: 'previewOnly' }), OK_FRAME);
    expect(s.status).toBe('exploratory');
  });

  it('blocks when there are no measured ground cells', () => {
    const s = contourStudioLaunchStateFromResult(resultStub({ measured: 0 }), OK_FRAME);
    expect(s.status).toBe('unavailable');
  });

  it('blocks when most of the grid is empty (unsupported > ceiling)', () => {
    const s = contourStudioLaunchStateFromResult(
      resultStub({ measured: 100, empty: 700, total: 1000 }),
      OK_FRAME,
    );
    expect(s.status).toBe('unavailable');
  });

  it('caps to exploratory on a geographic CRS even when ready', () => {
    const s = contourStudioLaunchStateFromResult(resultStub({ readiness: 'ready' }), {
      ...OK_FRAME,
      crsProjected: false,
    });
    expect(s.status).toBe('exploratory');
  });

  it('caps to exploratory when the vertical unit is unknown', () => {
    const s = contourStudioLaunchStateFromResult(resultStub({ readiness: 'ready' }), {
      ...OK_FRAME,
      verticalUnitsKnown: false,
    });
    expect(s.status).toBe('exploratory');
  });

  it('caps to exploratory when no interval could be recommended', () => {
    const s = contourStudioLaunchStateFromResult(resultStub({ recommendedM: null }), OK_FRAME);
    expect(s.status).toBe('exploratory');
  });

  it('derives unsupportedFraction from empty/total', () => {
    const p = contourStudioPrerequisitesFromResult(
      resultStub({ empty: 250, total: 1000 }),
      OK_FRAME,
    );
    expect(p.unsupportedFraction).toBeCloseTo(0.25, 6);
  });
});
