import { describe, expect, it } from 'vitest';
import { buildMeasurementRows } from '../src/report/ReportMeasurementSection';
import { volumeCaveatClauses, volumeWithheldClause } from '../src/render/measure/format';
import type { Measurement, VolumeRecord } from '../src/render/measure/types';

const square: [number, number, number][] = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]];

function volume(v: Partial<VolumeRecord>): Measurement {
  const rec: VolumeRecord = {
    referenceZ: 0, footprintArea: 100, pointsInPolygon: 480, densityNative: 4.8,
    confidence: 'medium', ...v,
  };
  return { id: 'v', kind: 'volume', name: 'V', points: square, volume: rec } as unknown as Measurement;
}

const row = (m: Measurement) => buildMeasurementRows([m], 'metric', 1, [0, 0, 1], 1, true, false, false)[0];

describe('PDF volume row carries the live headline caveats', () => {
  it('states interpolated and left-out shares on a partly covered footprint', () => {
    const r = row(volume({
      fill: 68.465, cut: 0, net: 68.465, coverageFraction: 0.34,
      interpolatedFraction: 0.3, excludedFraction: 0.36,
      gridAuthority: 'measured', gridAuthorityReason: '',
    }));
    expect(r.value).toContain('net 68.465 m³ fill');
    expect(r.value).toContain('30% interpolated (low confidence)');
    expect(r.value).toContain('36% outside scan, left out');
    expect(r.value).not.toContain('PREVIEW');
  });

  it('marks a preview figure with its reason', () => {
    const r = row(volume({
      fill: 5, cut: 1, net: 4, interpolatedFraction: 0.1, excludedFraction: 0,
      gridAuthority: 'preview', gridAuthorityReason: 'streaming source not fully resident',
    }));
    expect(r.value).toContain('10% interpolated');
    expect(r.value).not.toContain('low confidence');
    expect(r.value).not.toContain('outside scan');
    expect(r.value).toContain('PREVIEW (streaming source not fully resident)');
  });

  it('states why a withheld volume has no figure, and prints no cross-check figure', () => {
    const r = row(volume({
      interpolatedFraction: 0.64, excludedFraction: 0,
      gridAuthority: 'withheld', gridAuthorityReason: 'more than half the footprint interpolated',
      crossCheck: { fill: 12, cut: 2, net: 10, method: 'olv.volume.stockpile@3' },
    }));
    expect(r.value).toContain('volume withheld (more than half the footprint interpolated)');
    expect(r.value).not.toMatch(/cross-check|10\.000/);
    expect(r.value).not.toMatch(/cut\/fill —/);
  });

  it('states noise exclusion and reduced sample in the value', () => {
    const r = row(volume({
      fill: 5, cut: 1, net: 4,
      withheld: { source: 100, excluded: 0, noiseExcluded: 12, exclusionUnavailable: 'reduced-sample' } as never,
    }));
    expect(r.value).toContain('12 noise points (classes 7, 18) excluded');
    expect(r.value).toContain('reduced sample');
  });
});

describe('volumeCaveatClauses', () => {
  it('produces the live headline clause order', () => {
    expect(volumeCaveatClauses({
      referenceZ: 0, footprintArea: 1, pointsInPolygon: 1, densityNative: 1, confidence: 'low',
      interpolatedFraction: 0.3, excludedFraction: 0.2, gridAuthority: 'preview', gridAuthorityReason: '',
    })).toEqual(['30% interpolated (low confidence)', '20% outside scan, left out', 'PREVIEW']);
  });
  it('builds the withheld clause without a cross-check', () => {
    expect(volumeWithheldClause({
      referenceZ: 0, footprintArea: 1, pointsInPolygon: 1, densityNative: 1, confidence: 'low',
      gridAuthority: 'withheld', gridAuthorityReason: 'too sparse',
    })).toBe('volume withheld (too sparse)');
  });
  it('prints no cross-check figure beside a withheld grid, even when the record kept one', () => {
    expect(volumeWithheldClause({
      referenceZ: 0, footprintArea: 1, pointsInPolygon: 1, densityNative: 1, confidence: 'low',
      gridAuthority: 'withheld', gridAuthorityReason: 'too sparse',
      crossCheck: { fill: 12, cut: 2, net: 10, method: 'olv.volume.stockpile@3' },
    })).toBe('volume withheld (too sparse)');
  });
});
