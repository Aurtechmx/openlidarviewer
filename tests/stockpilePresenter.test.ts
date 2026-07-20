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
    densityUnitKnown: true,
    breakdown: {
      footprintArea: 318.4,
      pointsInPolygon: 4200,
      densityNative: 13.2,
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
  test('headline carries the volume, its ± band, and an explicit (1σ) label', () => {
    // "± 41" alone reads as a hard bound; the presenter must say it is one
    // standard deviation.
    const v = presentStockpile(result());
    expect(v.headline).toBe('1,254 m³ ± 41 m³ (1σ)');
    expect(v.relative).toBe('±3.3%');
    expect(v.confidence).toBe('medium');
    expect(v.confidenceLabel).toBe('Medium');
  });

  test('breakdown rows show the math (footprint, base, both error terms)', () => {
    const v = presentStockpile(result());
    const byLabel = Object.fromEntries(v.rows.map((r) => [r.label, r.value]));
    expect(byLabel['Footprint']).toBe('318.4 m²');
    expect(byLabel['Points in footprint']).toBe('4,200');
    expect(byLabel['Density']).toBe('13.2 pts/m²');
    expect(byLabel['Base plane']).toMatch(/lowest ground, ±0.08 m/);
    expect(byLabel['Sampling error']).toBe('± 18 m³');
    expect(byLabel['Base-plane error']).toBe('± 25 m³');
  });

  test('an unknown-unit result labels density honestly instead of claiming pts/m²', () => {
    const v = presentStockpile(result({ densityUnitKnown: false }));
    const density = v.rows.find((r) => r.label === 'Density')!.value;
    expect(density).toMatch(/unit unknown/);
    expect(density).not.toMatch(/pts\/m²/);
    // The native density is still surfaced, just not dressed as metres.
    expect(density).toMatch(/13\.2 pts\/unit²/);
  });

  test('a foot-CRS result converts to true metres (lin = 0.3048)', () => {
    // Same native figures, but in feet → volume in m³ is value × 0.3048³.
    const v = presentStockpile(result({ volume: 1000, sigma: 0 }), { lin: 0.3048 });
    // 1000 ft³ ≈ 28 m³.
    expect(v.headline).toBe('28 m³ ± 0 m³ (1σ)');
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
      'Stockpile: 1,254 m³ ± 41 m³ (1σ) (±3.3%) · Medium confidence',
    );
  });

  test('caveats pass through verbatim', () => {
    const v = presentStockpile(result({ caveats: ['only 12 points — indicative'] }));
    expect(v.caveats).toEqual(['only 12 points — indicative']);
  });
});

/**
 * A compound CRS — metre eastings over US-survey-foot heights — needs two
 * factors. The presenter had only `lin` and scaled volume by lin³, so a
 * stockpile on a NAD83(2011) / NAVD88-foot site was overstated by 3.28×, and
 * base plane and mean thickness (both VERTICAL) were scaled by the horizontal
 * unit. `measurementExport` has used linear²·vertical for volume since the
 * vertical-unit pass; this path never got it.
 */
describe('presentStockpile — compound CRS vertical factor', () => {
  const US_FOOT = 1200 / 3937;

  test('volume uses linear squared times vertical, not linear cubed', () => {
    // 1254 native (m²·ft) → 1254 × 1 × 1 × 0.3048006 = 382.2 m³.
    const v = presentStockpile(result(), { lin: 1, vert: US_FOOT });
    expect(v.headline).toContain('382');
  });

  test('a single-unit CRS is unchanged when no vertical factor is given', () => {
    expect(presentStockpile(result(), { lin: 1 }).headline).toContain('1,254');
  });

  test('base plane and mean thickness use the VERTICAL factor', () => {
    const v = presentStockpile(result(), { lin: 1, vert: US_FOOT });
    const row = (label: string) => v.rows.find((r) => r.label === label)?.value ?? '';
    // 102.5 ft → 31.24 m; 3.94 ft → 1.20 m.
    expect(row('Base plane')).toContain('31.2');
    expect(row('Mean thickness')).toContain('1.20');
  });

  test('footprint area and density stay on the HORIZONTAL factor', () => {
    // Mixing the vertical factor into an area would be the mirror-image bug.
    const v = presentStockpile(result(), { lin: 1, vert: US_FOOT });
    const row = (label: string) => v.rows.find((r) => r.label === label)?.value ?? '';
    expect(row('Footprint')).toContain('318.4');
    expect(row('Density')).toContain('13.2');
  });

  test('the error bands scale with the same cubic factor as the volume', () => {
    const v = presentStockpile(result(), { lin: 1, vert: US_FOOT });
    const row = (label: string) => v.rows.find((r) => r.label === label)?.value ?? '';
    expect(row('Sampling error')).toContain('5'); // 18 × 0.3048 = 5.49
    expect(row('Base-plane error')).toContain('8'); // 25 × 0.3048 = 7.62
  });
});
