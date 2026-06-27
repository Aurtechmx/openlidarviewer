import { describe, test, expect } from 'vitest';
import { presentStockpile, stockpileToastLine } from '../src/render/measure/stockpilePresenter';
import type { StockpileVolumeResult } from '../src/render/measure/stockpileVolume';

function result(over: Partial<StockpileVolumeResult> = {}): StockpileVolumeResult {
  return {
    volume: 1254,
    cut: 12,
    sigma: 41,
    low: 1213,
    high: 1295,
    relativeError: 0.0327,
    confidence: 'medium',
    breakdown: {
      footprintArea: 318.4,
      pointsInPolygon: 4200,
      density: 13.2,
      baseZ: 102.5,
      baseMode: 'lowest-percentile',
      baseUncertainty: 0.08,
      meanThickness: 3.94,
      thicknessStdDev: 1.1,
      samplingError: 18,
      basePlaneError: 25,
    },
    validity: 'ok',
    caveats: ['Point-sample estimate over a horizontal base plane.'],
    ...over,
  };
}

describe('presentStockpile', () => {
  test('headline carries the volume and its ± band, with relative %', () => {
    const v = presentStockpile(result());
    expect(v.headline).toBe('1,254 m³ ± 41');
    expect(v.relative).toBe('±3.3%');
    expect(v.confidence).toBe('medium');
    expect(v.confidenceLabel).toBe('Medium');
  });

  test('breakdown rows show the math (footprint, base, both error terms)', () => {
    const v = presentStockpile(result());
    const byLabel = Object.fromEntries(v.rows.map((r) => [r.label, r.value]));
    expect(byLabel['Footprint']).toBe('318.4 m²');
    expect(byLabel['Points in footprint']).toBe('4,200');
    expect(byLabel['Base plane']).toMatch(/lowest ground, ±0.08 m/);
    expect(byLabel['Sampling error']).toBe('± 18 m³');
    expect(byLabel['Base-plane error']).toBe('± 25 m³');
  });

  test('a foot-CRS result converts to true metres (lin = 0.3048)', () => {
    // Same native figures, but in feet → volume in m³ is value × 0.3048³.
    const v = presentStockpile(result({ volume: 1000, sigma: 0 }), { lin: 0.3048 });
    // 1000 ft³ ≈ 28 m³.
    expect(v.headline).toBe('28 m³ ± 0');
  });

  test('explicit base reads "(set)", not "(lowest ground)"', () => {
    const v = presentStockpile(
      result({ breakdown: { ...result().breakdown, baseMode: 'explicit', baseUncertainty: 0 } }),
    );
    const base = v.rows.find((r) => r.label === 'Base plane')!.value;
    expect(base).toMatch(/\(set\)/);
    expect(base).not.toMatch(/lowest ground/);
  });

  test('toast line is a single readable summary', () => {
    expect(stockpileToastLine(presentStockpile(result()))).toBe(
      'Stockpile: 1,254 m³ ± 41 (±3.3%) · Medium confidence',
    );
  });

  test('caveats pass through verbatim', () => {
    const v = presentStockpile(result({ caveats: ['only 12 points — indicative'] }));
    expect(v.caveats).toEqual(['only 12 points — indicative']);
  });
});
