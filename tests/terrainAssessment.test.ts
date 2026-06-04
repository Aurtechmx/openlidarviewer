import { describe, it, expect } from 'vitest';
import { terrainAssessment } from '../src/terrain/contour/terrainAssessment';
import type { AnalyseContoursResult } from '../src/terrain/contour/analyseContours';

function fixture(readiness: 'ready' | 'previewOnly' | 'blocked', reasons: string[] = []): AnalyseContoursResult {
  // 4 cells: 3 measured (2), 1 interpolated (1) → 75% measured / 25% interpolated.
  return {
    quality: { readiness, reasons },
    dtm: { coverage: new Uint8Array([2, 2, 2, 1]) },
  } as unknown as AnalyseContoursResult;
}

describe('terrainAssessment', () => {
  it('maps a ready gate to a Good verdict with no caution and no survey claim', () => {
    const a = terrainAssessment(fixture('ready'));
    expect(a.verdict).toBe('Good');
    expect(a.caution).toBe('');
    expect(a.bestFor).toMatch(/terrain products/i);
    expect(a.reason).toMatch(/measured/i);
    // Must never claim survey-grade / survey standards.
    expect(`${a.reason} ${a.bestFor} ${a.caution}`).not.toMatch(/survey/i);
  });

  it('maps previewOnly to Preview and surfaces the gate reason', () => {
    const a = terrainAssessment(fixture('previewOnly', ['CRS unknown — needs a projected CRS']));
    expect(a.verdict).toBe('Preview');
    expect(a.reason).toBe('CRS unknown — needs a projected CRS');
    expect(a.caution).toMatch(/preliminary|verify/i);
    expect(a.caution).not.toMatch(/survey/i);
  });

  it('maps blocked to Limited with a no-products caution', () => {
    const a = terrainAssessment(fixture('blocked', ['Too sparse']));
    expect(a.verdict).toBe('Limited');
    expect(a.caution).toMatch(/not suitable/i);
    expect(a.bestFor).toMatch(/inspection/i);
  });

  it('falls back to an interpolation read when the gate gives no reason', () => {
    const a = terrainAssessment(fixture('previewOnly', []));
    expect(a.reason).toMatch(/25% interpolated/);
  });
});
