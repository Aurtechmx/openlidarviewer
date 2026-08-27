/**
 * qaChecks.test.ts — independent QA diagnostics, no fake global score.
 */

import { describe, it, expect } from 'vitest';
import { runQaChecks, worstStatus, type QaCheck } from '../src/qa/qaChecks';
import type { CrsInfo } from '../src/io/crs';
import type { ScanFacts } from '../src/process/ProcessPlan';

function crs(o: Partial<CrsInfo> = {}): CrsInfo {
  return { source: 'epsg', linearUnit: 'metre', linearUnitToMetres: 1, ...o } as CrsInfo;
}
function facts(o: Partial<ScanFacts> = {}): ScanFacts {
  return {
    kind: 'static', coverage: 'full', crs: crs(), pointCount: 1_000_000,
    hasRgb: true, hasIntensity: true, hasGpsTime: true, hasReturnNumber: true, hasPointSourceId: false,
    classification: 'full', groundClassified: true, hasBuildingClass: true, medianSpacing: 0.2, ...o,
  };
}
const byId = (checks: QaCheck[], id: string): QaCheck => checks.find((c) => c.id === id)!;

describe('runQaChecks', () => {
  it('a healthy scan passes every check', () => {
    const checks = runQaChecks(facts());
    expect(checks.every((c) => c.status === 'pass')).toBe(true);
    expect(worstStatus(checks)).toBe('pass');
  });

  it('an empty cloud blocks file integrity but leaves other checks independent', () => {
    const checks = runQaChecks(facts({ pointCount: 0 }));
    expect(byId(checks, 'FILE_INTEGRITY').status).toBe('block');
    // Independence: the spatial reference is still fine and reports pass on its own.
    expect(byId(checks, 'SPATIAL_REFERENCE').status).toBe('pass');
    expect(worstStatus(checks)).toBe('block');
  });

  it('a source that states no point total reviews file integrity rather than blocking it', () => {
    // A stated zero means the scan is empty. An unstated total (a 3D Tiles
    // tileset states none) means the check could not be run, so it reviews:
    // blocking would report an empty scan that is drawn on screen.
    const checks = runQaChecks(facts({ kind: 'streaming', pointCount: null }));
    const integrity = byId(checks, 'FILE_INTEGRITY');
    expect(integrity.status).toBe('review');
    expect(integrity.reason).not.toMatch(/no points/i);
    // Independence holds: the other axes answer on their own evidence.
    expect(byId(checks, 'SPATIAL_REFERENCE').status).toBe('pass');
  });

  it('a missing CRS blocks only the spatial-reference check (fail closed)', () => {
    const checks = runQaChecks(facts({ crs: null }));
    expect(byId(checks, 'SPATIAL_REFERENCE').status).toBe('block');
    expect(byId(checks, 'FILE_INTEGRITY').status).toBe('pass');
  });

  it('resident-only coverage and no ground each review, not block, on their own axes', () => {
    const checks = runQaChecks(facts({ kind: 'streaming', coverage: 'resident-only', groundClassified: false, classification: 'none' }));
    expect(byId(checks, 'COVERAGE').status).toBe('review');
    expect(byId(checks, 'TERRAIN_READINESS').status).toBe('review');
    expect(byId(checks, 'CLASSIFICATION').status).toBe('review');
    expect(worstStatus(checks)).toBe('review'); // nothing blocked, but attention needed
  });

  it('worstStatus is a severity roll-up (block beats review beats pass), not an average', () => {
    expect(worstStatus([{ id: 'a', label: 'a', status: 'pass', reason: '' }, { id: 'b', label: 'b', status: 'block', reason: '' }])).toBe('block');
    expect(worstStatus([{ id: 'a', label: 'a', status: 'pass', reason: '' }, { id: 'b', label: 'b', status: 'review', reason: '' }])).toBe('review');
  });
});
