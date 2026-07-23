/**
 * "Classification: Yes" answers the question a reader is NOT asking. The
 * adapter's `hasClassification()` tests whether the channel exists, which is
 * the right gate for offering a classification render — but printed as a bare
 * Yes on a report it states that the scan carries classes. A file whose every
 * code is 0 (Created, never classified) then reads as classified, while the
 * Scan Report panel on the same scan says "Present, unclassified (0.0 %)".
 *
 * ASPRS treats 0 (Created) and 1 (Unclassified) as no class assigned, so the
 * assigned share is the share of codes above 1.
 */
import { describe, it, expect } from 'vitest';
import { baseReportRows } from '../src/export/BaseExportMode';
import type { ExportSceneAdapter } from '../src/export/types';

/** Minimal adapter: only what `baseReportRows` reads. */
function adapterWith(
  over: Partial<ExportSceneAdapter> = {},
): ExportSceneAdapter {
  return {
    setExportColorMode: () => {},
    currentColorMode: () => 'rgb',
    hasRgb: () => true,
    hasIntensity: () => true,
    hasClassification: () => true,
    hasNormals: () => false,
    hasGpsTime: () => false,
    sourcePointCount: () => 1000,
    sceneBounds: () => null,
    dataBoundsAabb: () => null,
    crsLabel: () => null,
    scanName: () => 'scan',
    ...over,
  } as unknown as ExportSceneAdapter;
}

function rowValue(adapter: ExportSceneAdapter, label: string): string | undefined {
  return baseReportRows(adapter, null).find((r) => r.label === label)?.value;
}

describe('the Classification row states coverage, not mere presence', () => {
  it('reports an all-unclassified channel as present with no classes assigned', () => {
    const value = rowValue(
      adapterWith({ classificationAssignedFraction: () => 0 } as Partial<ExportSceneAdapter>),
      'Classification',
    );
    expect(value).toBeDefined();
    // Must not read as a bare "Yes" — that is the false statement.
    expect(value).not.toBe('Yes');
    expect(value).toMatch(/present/i);
    expect(value).toMatch(/0\.0\s*%/);
  });

  it('reports a genuinely classified scan with its coverage', () => {
    const value = rowValue(
      adapterWith({ classificationAssignedFraction: () => 0.734 } as Partial<ExportSceneAdapter>),
      'Classification',
    );
    expect(value).toMatch(/73\.4\s*%/);
  });

  it('says No when the channel is absent', () => {
    const value = rowValue(
      adapterWith({
        hasClassification: () => false,
        classificationAssignedFraction: () => null,
      } as Partial<ExportSceneAdapter>),
      'Classification',
    );
    expect(value).toBe('No');
  });

  it('falls back to Yes when coverage cannot be measured', () => {
    // A streaming source can carry the channel without the viewer holding
    // every code. Presence is then the only honest answer available — but it
    // must not invent a percentage.
    const value = rowValue(
      adapterWith({ classificationAssignedFraction: () => null } as Partial<ExportSceneAdapter>),
      'Classification',
    );
    expect(value).toBe('Yes');
    expect(value).not.toMatch(/%/);
  });
});
