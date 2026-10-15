/**
 * Studio card base rows: the Height row agrees with the Min/Max a card prints,
 * and a card rendered from a display sample says so.
 *
 * The user's 3DEP tile: 11,655,573 points in the file, 1,630,120 loaded for
 * display, elevations −7.86…39.72 m over a −8 m origin. The Height Map card
 * printed "Min Z 14.0 cm / Max Z 47.7 m" with a Height row in another format,
 * "Points 11,655,573" with nothing saying the picture came from the sample, and
 * a classification coverage percentage measured on that sample.
 */

import { describe, it, expect } from 'vitest';
import { buildScanReport } from '../src/export/BaseExportMode';
import type { ExportSceneAdapter } from '../src/export/types';

function adapter(over: Partial<ExportSceneAdapter> = {}): ExportSceneAdapter {
  return {
    worldUpAxis: () => 2 as const,
    heightOrigin: () => -8,
    localBoundsAabb: () => [0, 0, 0.14, 1000, 1000, 47.72] as const,
    dataBoundsAabb: () => [0, 0, 0.14, 1000, 1000, 47.72] as const,
    sourceName: () => 'tile.laz',
    sourcePointCount: () => 11_655_573,
    residentPointCount: () => 1_630_120,
    hasRgb: () => false,
    hasIntensity: () => true,
    hasClassification: () => true,
    classificationAssignedFraction: () => 0.529,
    crsLabel: () => ({ name: 'NAD83(2011) / UTM zone 15N', unit: 'metre' }),
    ...over,
  } as unknown as ExportSceneAdapter;
}

const row = (a: ExportSceneAdapter, label: string, extra: { label: string; value: string }[] = []) =>
  buildScanReport('Height Map', a, extra).rows.find((r) => r.label === label)?.value;

describe('Height row matches the printed Min/Max', () => {
  it('is Max − Min of the printed elevations, in the same format', () => {
    expect(row(adapter(), 'Height')).toBe('47.58 m');
  });

  it('reads the up axis on a Y-up mesh', () => {
    const a = adapter({
      worldUpAxis: () => 1 as const,
      heightOrigin: () => 0,
      dataBoundsAabb: () => [0, 0, -0.5, 40, 6, 0.5] as const,
    });
    expect(row(a, 'Height')).toBe('6.00 m');
  });
});

describe('display-sample disclosure', () => {
  it('states the rendered sample when fewer points are loaded than the file holds', () => {
    expect(row(adapter(), 'Rendered from')).toBe('1,630,120 of 11,655,573 points (display sample)');
  });

  it('labels the classification coverage as measured on the sample', () => {
    expect(row(adapter(), 'Classification')).toBe(
      'Present, classified (52.9 % coverage of the display sample)',
    );
  });

  it('adds nothing when every point is loaded', () => {
    const full = adapter({ residentPointCount: () => 11_655_573 });
    expect(row(full, 'Rendered from')).toBeUndefined();
    expect(row(full, 'Classification')).toBe('Present, classified (52.9 % coverage)');
  });
});
