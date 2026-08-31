/**
 * contourDeliverableJson.test.ts
 *
 * The two JSON products of the complete contour package. Both must be honest:
 * non-finite statistics become null (never NaN), the validation object states
 * its internal-only scope and never claims external checkpoints, and the studio
 * object reflects the REAL generation settings passed in.
 */

import { describe, it, expect } from 'vitest';
import {
  validationDeliverableJson,
  contourStudioDeliverableJson,
} from '../src/terrain/export/contourDeliverableJson';
import type { ValidationReport } from '../src/terrain/validate/ValidationReport';
import type { AnalyseGenerationParams } from '../src/terrain/contour/analyseContours';

const report = (over: Partial<ValidationReport> = {}): ValidationReport => ({
  estimand: 'point-reconstruction',
  rmse: 0.12,
  mae: 0.08,
  p95: 0.3,
  bias: -0.01,
  nmad: 0.09,
  sampleSize: 240,
  uncoveredCount: 6,
  holdoutFraction: 0.2,
  perBand: [],
  method: 'holdout-cross-validation',
  coverageMode: 'measured-only',
  warnings: ['near-flat areas excluded'],
  ...over,
}) as ValidationReport;

const params: AnalyseGenerationParams = {
  interpolation: 'idw',
  contourStyle: 'generalized',
  generalizeToleranceCells: 1.5,
  smoothing: true,
  despike: false,
  aggregation: 'median',
};

describe('validationDeliverableJson', () => {
  it('carries the hold-out figures and states its internal-only scope', () => {
    const j = validationDeliverableJson(report());
    expect(j.estimand).toBe('point-reconstruction');
    expect(j.rmse).toBe(0.12);
    expect(j.sampleSize).toBe(240);
    expect(j.independentCheckpoints).toBe(false);
    expect(String(j.scope)).toMatch(/internal hold-out/i);
    expect(String(j.scope)).toMatch(/not survey-grade/i);
  });

  it('reports a non-finite statistic as null, never NaN', () => {
    const j = validationDeliverableJson(report({ rmse: NaN, bias: Infinity }));
    expect(j.rmse).toBeNull();
    expect(j.bias).toBeNull();
    // And it round-trips as JSON without a bare NaN token.
    expect(JSON.stringify(j)).not.toContain('NaN');
  });

  it('omits the raw calibration samples (a deliverable, not a fit input)', () => {
    const j = validationDeliverableJson(
      report({ samples: [{ confidence: 50, absError: 0.1 }] } as Partial<ValidationReport>),
    );
    expect('samples' in j).toBe(false);
  });
});

describe('contourStudioDeliverableJson', () => {
  it('reflects the real generation settings, not defaults', () => {
    const j = contourStudioDeliverableJson(params, {
      contourMethod: 'olv.contour.generalize@1',
      purpose: 'presentation-map',
      intervalM: 0.5,
      software: 'OpenLiDARViewer',
      softwareVersion: '0.6.9',
      generatedAt: '2026-08-31T00:00:00.000Z',
    });
    expect(j.contourStyle).toBe('generalized');
    expect(j.interpolation).toBe('idw');
    expect(j.aggregation).toBe('median');
    expect(j.generalizeToleranceCells).toBe(1.5);
    expect(j.contourMethod).toBe('olv.contour.generalize@1');
    expect(j.purpose).toBe('presentation-map');
    expect(j.intervalM).toBe(0.5);
  });

  it('reports a non-finite interval as null', () => {
    const j = contourStudioDeliverableJson(params, {
      contourMethod: null,
      purpose: null,
      intervalM: NaN,
      software: 'OpenLiDARViewer',
      softwareVersion: '0.6.9',
      generatedAt: '2026-08-31T00:00:00.000Z',
    });
    expect(j.intervalM).toBeNull();
  });
});
