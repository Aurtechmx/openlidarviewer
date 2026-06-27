import { describe, test, expect } from 'vitest';
import {
  SessionFindings,
  stockpileFinding,
  changeFinding,
} from '../src/render/measure/sessionFindings';
import type { StockpileVolumeResult } from '../src/render/measure/stockpileVolume';
import { changeVolumeUncertainty } from '../src/terrain/change/changeUncertainty';
import { buildReportManifest, verifyReportManifest } from '../src/render/measure/reportManifest';

function stock(over: Partial<StockpileVolumeResult> = {}): StockpileVolumeResult {
  return {
    volume: 1000,
    cut: 0,
    sigma: 30,
    low: 970,
    high: 1030,
    relativeError: 0.03,
    confidence: 'high',
    breakdown: {
      footprintArea: 100,
      pointsInPolygon: 4000,
      density: 40,
      baseZ: 0,
      baseMode: 'lowest-percentile',
      baseUncertainty: 0.05,
      meanThickness: 10,
      thicknessStdDev: 1,
      samplingError: 10,
      basePlaneError: 28,
    },
    validity: 'ok',
    caveats: ['Point-sample estimate.'],
    ...over,
  };
}

describe('SessionFindings ledger', () => {
  test('collects findings in order and clears', () => {
    const f = new SessionFindings();
    f.add({ label: 'A', value: 1, unit: 'm³' });
    f.add({ label: 'B', value: 2, unit: 'm³' });
    expect(f.count).toBe(2);
    expect(f.all.map((x) => x.label)).toEqual(['A', 'B']);
    expect(f.pop()?.label).toBe('B');
    f.clear();
    expect(f.count).toBe(0);
  });
});

describe('converters preserve band + caveats', () => {
  test('stockpileFinding carries the band and converts units (lin = 0.3048)', () => {
    const ft = stockpileFinding(stock({ volume: 1000, sigma: 0 }), 0.3048);
    expect(ft.unit).toBe('m³');
    expect(ft.value).toBeCloseTo(1000 * 0.3048 ** 3, 6); // ≈ 28.3 m³
    const m = stockpileFinding(stock());
    expect(m.sigma).toBe(30);
    expect(m.confidence).toBe('high');
    expect(m.caveats?.[0]).toMatch(/point-sample/i);
  });

  test('changeFinding carries detectability honesty', () => {
    const u = changeVolumeUncertainty({
      netVolumeM3: 2,
      significantCells: 400,
      cellAreaM2: 1,
      cellSigmaM: 0.05,
      registrationSigmaM: 0.02,
    });
    const finding = changeFinding(2, u);
    expect(finding.value).toBe(2);
    expect(finding.confidence).toBe('low');
    expect(finding.caveats?.join(' ')).toMatch(/not distinguishable from survey noise/i);
  });
});

describe('ledger feeds a signed report end-to-end', () => {
  test('findings assembled into a manifest verify, and tampering one breaks it', () => {
    const f = new SessionFindings();
    f.add(stockpileFinding(stock()));
    const manifest = buildReportManifest({
      dataset: { id: 'site-a' },
      generatedAt: '2026-06-27T00:00:00Z',
      findings: f.all,
    });
    expect(verifyReportManifest(manifest)).toBe(true);
    const tampered = { ...manifest, findings: [{ ...manifest.findings[0], sigma: 0 }] };
    expect(verifyReportManifest(tampered)).toBe(false);
  });
});
