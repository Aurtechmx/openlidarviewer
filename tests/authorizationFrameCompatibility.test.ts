/**
 * A two-scan product's readiness depends on whether the scans' frames are
 * proven compatible, so an authorization granted under a compatible frame must
 * not verify once that proof is withdrawn.
 */
import { describe, it, expect } from 'vitest';
import { ProcessService } from '../src/process/ProcessService';
import type { CrsInfo } from '../src/io/crs';
import type { ScanFacts } from '../src/process/ProcessPlan';

const crs = { source: 'epsg', linearUnit: 'metre', linearUnitToMetres: 1, epsg: 32613, verticalDatum: 'NAVD88', verticalUnitToMetres: 1 } as CrsInfo;
const SCAN: ScanFacts = {
  kind: 'static', coverage: 'full', crs, pointCount: 1_000_000,
  hasRgb: true, hasIntensity: true, hasGpsTime: true, hasReturnNumber: true, hasPointSourceId: false,
  classification: 'full', groundClassified: true, hasBuildingClass: true,
  classificationProvenance: 'producer', medianSpacing: 0.2,
};

describe('authorization and frame compatibility', () => {
  it('a volume token from a compatible frame is stale once the frame is unproven', () => {
    const before = ProcessService.fromFacts([SCAN, { ...SCAN }], true);
    const token = before.authorize('volume-cut-fill');
    expect(token).not.toBeNull();
    const after = ProcessService.fromFacts([SCAN, { ...SCAN }], false);
    expect(after.readiness('volume-cut-fill')).toBe('review');
    expect(after.verifyAuthorization(token, 'volume-cut-fill')).toEqual({ ok: false, reason: 'STALE_AUTHORIZATION' });
  });

  it('the same token still verifies while the frame stays compatible', () => {
    const token = ProcessService.fromFacts([SCAN, { ...SCAN }], true).authorize('volume-cut-fill');
    expect(ProcessService.fromFacts([SCAN, { ...SCAN }], true).verifyAuthorization(token, 'volume-cut-fill')).toEqual({ ok: true });
  });
});
