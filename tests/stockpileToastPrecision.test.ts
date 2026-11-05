import { describe, it, expect } from 'vitest';
import { stockpileAreaGridToastLine } from '../src/render/measure/stockpilePresenter';

describe('the stockpile toast prints its volume as the headline does', () => {
  it('five significant figures for the volume and two for the surface term', () => {
    const view = {
      method: 'area-weighted-grid', authority: 'measured', reason: '',
      volumeM3: 12.3456, fillNative: 12.3456, cutNative: 0, netNative: 12.3456,
      supportFraction: 1, coverage: 'full', interpolatedFraction: 0, excludedFraction: 0,
      surfaceTermM3: 1.4567, baseZM: 100, baseIsElevation: true, baseUncertaintyM: 0.05,
      cellCount: 100, pointCount: 5000,
    } as unknown as Parameters<typeof stockpileAreaGridToastLine>[0];
    const line = stockpileAreaGridToastLine(view);
    expect(line).toMatch(/^Stockpile: 12\.346 m³/);
    expect(line).toMatch(/surface term ± 1\.5 m³/);
  });

  it('does not state zero uncertainty for a term that could not be computed', () => {
    const view = {
      method: 'area-weighted-grid', authority: 'measured', reason: '',
      volumeM3: 12.3456, fillNative: 12.3456, cutNative: 0, netNative: 12.3456,
      supportFraction: 1, coverage: 'full', interpolatedFraction: 0, excludedFraction: 0,
      surfaceTermM3: Number.NaN, baseZM: 100, baseIsElevation: true, baseUncertaintyM: 0.05,
      cellCount: 100, pointCount: 5000,
    } as unknown as Parameters<typeof stockpileAreaGridToastLine>[0];
    expect(stockpileAreaGridToastLine(view)).not.toMatch(/± 0 m³/);
  });

  it('keeps two significant figures when rounding carries', () => {
    const view = {
      method: 'area-weighted-grid', authority: 'measured', reason: '',
      volumeM3: 12.3456, fillNative: 12.3456, cutNative: 0, netNative: 12.3456,
      supportFraction: 1, coverage: 'full', interpolatedFraction: 0, excludedFraction: 0,
      surfaceTermM3: 9.96, baseZM: 100, baseIsElevation: true, baseUncertaintyM: 0.05,
      cellCount: 100, pointCount: 5000,
    } as unknown as Parameters<typeof stockpileAreaGridToastLine>[0];
    expect(stockpileAreaGridToastLine(view)).toMatch(/surface term ± 10 m³/);
  });
});
