/**
 * processStages.test.ts — the adaptive Process Studio stage model.
 */

import { describe, it, expect } from 'vitest';
import { adaptiveStages, relevantStages } from '../src/process/processStages';
import type { CrsInfo } from '../src/io/crs';
import type { ScanFacts } from '../src/process/ProcessPlan';

function crs(o: Partial<CrsInfo> = {}): CrsInfo {
  return { source: 'epsg', linearUnit: 'metre', linearUnitToMetres: 1, ...o } as CrsInfo;
}
function scan(o: Partial<ScanFacts> = {}): ScanFacts {
  return {
    kind: 'static', coverage: 'full', crs: crs(), pointCount: 1_000_000,
    hasRgb: true, hasIntensity: true, hasGpsTime: true, hasReturnNumber: true, hasPointSourceId: false,
    classification: 'full', groundClassified: true, hasBuildingClass: true, medianSpacing: 0.2, ...o,
  };
}
const stage = (stages: ReturnType<typeof adaptiveStages>, id: string) => stages.find((s) => s.id === id)!;

describe('adaptiveStages', () => {
  it('always shows Prepare and Validate/Export', () => {
    const s = adaptiveStages({ scans: [scan()] });
    expect(stage(s, 'prepare').relevant).toBe(true);
    expect(stage(s, 'validate-export').relevant).toBe(true);
  });

  it('skips Classify when the cloud is already fully classified, shows it when partial', () => {
    expect(stage(adaptiveStages({ scans: [scan({ classification: 'full' })] }), 'classify').relevant).toBe(false);
    expect(stage(adaptiveStages({ scans: [scan({ classification: 'partial' })] }), 'classify').relevant).toBe(true);
    expect(stage(adaptiveStages({ scans: [scan({ classification: 'none' })] }), 'classify').relevant).toBe(true);
  });

  it('shows Align only for two or more scans', () => {
    expect(stage(adaptiveStages({ scans: [scan()] }), 'align').relevant).toBe(false);
    expect(stage(adaptiveStages({ scans: [scan(), scan()] }), 'align').relevant).toBe(true);
  });

  it('shows Surface for resident-only streaming — an exploratory surface is possible', () => {
    const residentOnly = scan({ kind: 'streaming', coverage: 'resident-only' });
    expect(stage(adaptiveStages({ scans: [residentOnly] }), 'surface').relevant).toBe(true);
  });
  it('skips Surface when no terrain product is possible at all (empty scan)', () => {
    const empty = scan({ pointCount: 0 });
    expect(stage(adaptiveStages({ scans: [empty] }), 'surface').relevant).toBe(false);
  });

  it('relevantStages returns only the shown stages', () => {
    const shown = relevantStages({ scans: [scan({ classification: 'full' })] });
    expect(shown.every((s) => s.relevant)).toBe(true);
    expect(shown.find((s) => s.id === 'classify')).toBeUndefined(); // fully classified → hidden
  });
});
