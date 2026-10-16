/**
 * The live volume headline and the PDF report row build their caveats from
 * the same helpers (render/measure/format.ts), so the two surfaces read the
 * same words for the same record. Figures keep each surface's own precision
 * (the panel's display decimals, the report's fixed three), so the
 * comparison masks the volume numbers and compares every word.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { Measurement, VolumeRecord, Vec3 } from '../src/render/measure/types';
import type { MeasureController as MC } from '../src/render/measure/MeasureController';
import { buildMeasurementRows } from '../src/report/ReportMeasurementSection';
import { installFakeDom } from './support/measurePanelDom';

beforeAll(() => installFakeDom({ ns: true }));

const square: Vec3[] = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]];

function volume(v: Partial<VolumeRecord>): Measurement {
  const rec: VolumeRecord = {
    referenceZ: 0, footprintArea: 100, pointsInPolygon: 480, densityNative: 4.8,
    confidence: 'medium', ...v,
  };
  return { id: 'v', kind: 'volume', name: 'V', closed: true, points: square, volume: rec } as unknown as Measurement;
}

async function live(m: Measurement): Promise<string> {
  const { MeasureController } = await import('../src/render/measure/MeasureController');
  const measure: MC = new MeasureController({ onExit: () => {} } as unknown as ConstructorParameters<typeof MeasureController>[0]);
  measure.setContext({ worldUp: [0, 0, 1], origin: null });
  measure.setCrsKnown(true);
  measure.setUnitToMetres(1);
  measure.loadMeasurements([m]);
  return measure.getSummaries()[0]!.value;
}

const pdf = (m: Measurement) => buildMeasurementRows([m], 'metric', 1, [0, 0, 1], 1, true, false, false)[0]!.value;
const words = (s: string) => s.replace(/[\d.]+ (?:[cdk]?m|ft|yd)³/g, '#');

describe('live volume headline matches the PDF row', () => {
  it('a preview figure states PREVIEW with its reason, as the PDF does', async () => {
    const m = volume({
      fill: 5, cut: 1, net: 4, interpolatedFraction: 0.1, excludedFraction: 0,
      gridAuthority: 'preview', gridAuthorityReason: 'streaming source not fully resident',
    });
    const v = await live(m);
    expect(v).toContain('PREVIEW (streaming source not fully resident)');
    expect(words(v)).toBe(words(pdf(m)));
  });

  it('a preview figure with no stated reason reads PREVIEW alone', async () => {
    const m = volume({ fill: 5, cut: 1, net: 4, gridAuthority: 'preview', gridAuthorityReason: '' });
    const v = await live(m);
    expect(v).toMatch(/· PREVIEW$/);
    expect(words(v)).toBe(words(pdf(m)));
  });

  it('interpolated, left-out, noise and reduced-sample clauses read the same', async () => {
    const m = volume({
      fill: 68.465, cut: 0, net: 68.465, interpolatedFraction: 0.3, excludedFraction: 0.36,
      gridAuthority: 'measured', gridAuthorityReason: '',
      withheld: { source: 100, excluded: 0, noiseExcluded: 12, exclusionUnavailable: 'reduced-sample' } as never,
    });
    const v = await live(m);
    expect(v).toContain('30% interpolated (low confidence) · 36% outside scan, left out');
    expect(v).not.toContain('PREVIEW');
    expect(words(v)).toBe(words(pdf(m)));
  });

  it('a withheld figure states its reason and cross-check', async () => {
    const m = volume({
      interpolatedFraction: 0.64, excludedFraction: 0,
      gridAuthority: 'withheld', gridAuthorityReason: 'more than half the footprint interpolated',
      crossCheck: { fill: 12, cut: 2, net: 10, method: 'olv.volume.stockpile@3' },
    });
    const v = await live(m);
    expect(v).toContain('grid volume withheld (more than half the footprint interpolated) · cut-fill cross-check net 10.00 m³ fill');
    expect(words(v)).toBe(words(pdf(m)));
  });
});
