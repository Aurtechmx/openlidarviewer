/**
 * The box headline, the stockpile ± figures and the change-detection volumes
 * read through the shared volume formatter (5 significant figures, at most
 * 4 decimals), like every other displayed volume.
 */
import { describe, it, expect } from 'vitest';
import { formatBoxHeadline, formatVolumeNumber } from '../src/render/measure/format';
import { presentStockpile } from '../src/render/measure/stockpilePresenter';
import type { StockpileVolumeResult } from '../src/render/measure/stockpileVolume';
import { compareDtms, summarizeChange } from '../src/terrain/change/compareDtms';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

describe('volume displays at 5 significant figures', () => {
  it('box headline', () => {
    expect(formatBoxHeadline(13.2, 4.8, 0.005, 0.316801, 'metric')).toMatch(/· 0\.3168 m³$/);
    expect(formatBoxHeadline(13.2, 4.8, 0.005, 0.000123456, 'metric')).toMatch(/· 0\.0001 m³$/);
    expect(formatBoxHeadline(13.2, 4.8, 0.005, 1234.56789, 'metric')).toMatch(/· 1,234\.6 m³$/);
  });

  it('stockpile ± figures', () => {
    const r = {
      volume: 499909.6, cut: 0, sigma: 123456.7, low: 0, high: 0, relativeError: 0.25, confidence: 'medium',
      densityUnitKnown: true, validity: 'ok', caveats: [],
      breakdown: { footprintArea: 1, pointsInPolygon: 1, densityNative: 1, baseZ: 0, baseMode: 'explicit',
        baseUncertainty: 0, meanThickness: 1, thicknessStdDev: 0, samplingError: 0.42, basePlaneError: 98765.4 },
    } as unknown as StockpileVolumeResult;
    const v = presentStockpile(r);
    expect(v.headline).toBe('499,910 m³ ± 123,460 m³ (model band)');
    const row = (l: string) => v.rows.find((x) => x.label === l)!.value;
    expect(row('Surface spread term')).toBe('± 0.4200 m³');
    expect(row('Base-plane term')).toBe('± 98,765 m³');
  });

  it('change-detection volumes', () => {
    const g = (z: number): DtmGrid =>
      ({ cols: 2, rows: 2, cellSizeM: 1, originH1: 0, originH2: 0, crs: 'EPSG:32612', verticalDatum: 'NAVD88',
        z: new Float32Array(4).fill(z), coverage: new Uint8Array(4).fill(2), confidence: new Float32Array(4).fill(100) }) as unknown as DtmGrid;
    const lines = summarizeChange(compareDtms(g(0), g(0.5)), { horizontalUnitToMetres: 1 });
    expect(lines.find((l) => l.startsWith('Net volume change (raw'))).toContain(`${formatVolumeNumber(2)} m³.`);
    expect(lines.find((l) => l.startsWith('Detectable gross change'))).toContain(`gain ${formatVolumeNumber(2)} m³`);
  });
});
