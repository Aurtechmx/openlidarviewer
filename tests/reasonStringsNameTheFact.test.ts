/**
 * reasonStringsNameTheFact.test.ts
 *
 * Three reason strings named a condition other than the one that fired.
 *
 *  - the capability model called every partial coverage "the resident streaming
 *    set", including a strided read of a static file;
 *  - the preflight offered "wait for full coverage" against a sample, where
 *    waiting completes nothing — the read already returned everything it will;
 *  - the Contour Studio launcher called every non-projected frame "geographic",
 *    including a local frame and no CRS at all.
 *
 * Each test pins the fact the string must name, never its phrasing.
 */

import { describe, it, expect } from 'vitest';
import type { CrsInfo } from '../src/io/crs';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import type { ScanFacts, ProductId } from '../src/process/ProcessPlan';
import { evaluateCapabilities, capabilityFor } from '../src/process/processCapabilities';
import { preflightFor, type PreflightInput, type ToolPreflight } from '../src/process/toolPreflight';
import {
  evaluateContourStudioLaunchState,
  type ContourStudioPrerequisites,
} from '../src/terrain/contourStudio/contourStudioLaunchState';

function crs(overrides: Partial<CrsInfo> = {}): CrsInfo {
  return {
    source: 'epsg',
    name: 'WGS 84 / UTM zone 12N',
    epsg: 32612,
    linearUnit: 'metre',
    linearUnitToMetres: 1,
    isGeographic: false,
    verticalEpsg: 5703,
    verticalDatum: 'NAVD88',
    verticalUnitToMetres: 1,
    ...overrides,
  } as CrsInfo;
}

function scan(overrides: Partial<ScanFacts> = {}): ScanFacts {
  return {
    kind: 'static',
    coverage: 'full',
    crs: crs(),
    pointCount: 1_000_000,
    hasRgb: true,
    hasIntensity: true,
    hasGpsTime: true,
    hasReturnNumber: true,
    hasPointSourceId: false,
    classification: 'full',
    classificationProvenance: 'producer',
    groundClassified: true,
    hasBuildingClass: true,
    medianSpacing: 0.2,
    ...overrides,
  };
}

function verdict(s: ScanFacts, product: ProductId) {
  return capabilityFor(evaluateCapabilities({ scans: [s] }), product)!;
}

function input(scans: readonly ScanFacts[]): PreflightInput {
  return {
    scans,
    spatial: spatialContextFrom(crs()),
    layerCompatibility: ['verified'],
    datumResolved: true,
  };
}

const actions = (p: ToolPreflight): readonly string[] => p.remediations.map((r) => r.action);

function launch(overrides: Partial<ContourStudioPrerequisites> = {}): ContourStudioPrerequisites {
  return {
    scanLoaded: true,
    analysisComplete: true,
    streaming: false,
    terrainSurfaceAvailable: true,
    groundSourceAvailable: true,
    intervalRecommended: true,
    verticalUnitsKnown: true,
    crsProjected: true,
    unsupportedFraction: 0.03,
    supportSufficient: true,
    ...overrides,
  };
}

/** The exploratory reasons, or an empty list when the launcher did not cap. */
function reasonsOf(p: ContourStudioPrerequisites): readonly string[] {
  const s = evaluateContourStudioLaunchState(p);
  return 'reasons' in s ? s.reasons : [];
}

describe('a partial-coverage verdict names the coverage that fired', () => {
  it('does not call a strided static read a resident streaming set', () => {
    const v = verdict(scan({ kind: 'static', coverage: 'sampled' }), 'dtm');
    expect(v.readiness).toBe('review');
    expect(v.reasonCode).toBe('SAMPLED');
    expect(v.reason).not.toMatch(/streaming|resident/i);
    expect(v.reason).toMatch(/sample/i);
  });

  it('still names the resident streaming set when that is the coverage', () => {
    const v = verdict(scan({ kind: 'streaming', coverage: 'resident-only' }), 'dtm');
    expect(v.reasonCode).toBe('RESIDENT_ONLY');
    expect(v.reason).toMatch(/resident streaming set/i);
  });

  it('splits the same way for the upper surface', () => {
    expect(verdict(scan({ coverage: 'sampled' }), 'dsm').reasonCode).toBe('SAMPLED');
    expect(verdict(scan({ kind: 'streaming', coverage: 'resident-only' }), 'dsm').reasonCode)
      .toBe('RESIDENT_ONLY');
  });

  it('does not describe a sampled scan as a streaming view when footprints are blocked', () => {
    const v = verdict(scan({ coverage: 'sampled' }), 'building-footprints');
    expect(v.readiness).toBe('blocked');
    expect(v.reasonCode).toBe('SAMPLED');
    expect(v.reason).not.toMatch(/streaming/i);
  });

  it('keys on coverage, not on the scan kind', () => {
    // A streaming source can be sampled too: a budget stride over resident
    // nodes. The verdict follows the coverage, which is the fact that fired.
    expect(verdict(scan({ kind: 'streaming', coverage: 'sampled' }), 'dtm').reasonCode)
      .toBe('SAMPLED');
  });
});

describe('a sample is not offered an action that waiting cannot complete', () => {
  it('withholds "wait for full coverage" from a sampled derived surface', () => {
    const a = actions(preflightFor('terrain-dtm', input([scan({ coverage: 'sampled' })])));
    expect(a).not.toContain('await-full-coverage');
    expect(a).toContain('continue-resident-only');
  });

  it('withholds it from a sampled measurement too', () => {
    expect(actions(preflightFor('measure-area', input([scan({ coverage: 'sampled' })]))))
      .not.toContain('await-full-coverage');
  });

  it('keeps it for a resident-only streaming scan, where waiting does complete', () => {
    const streaming = input([scan({ kind: 'streaming', coverage: 'resident-only' })]);
    expect(actions(preflightFor('terrain-dtm', streaming))).toContain('await-full-coverage');
    expect(actions(preflightFor('measure-distance', streaming))).toContain('await-full-coverage');
  });
});

describe('the contour launcher names the frame it actually has', () => {
  it('does not call a local frame geographic', () => {
    const r = reasonsOf(launch({ crsProjected: false, crsKind: 'local' }));
    expect(r.some((s) => /geographic/i.test(s))).toBe(false);
    expect(r.some((s) => /local/i.test(s))).toBe(true);
  });

  it('does not call an unidentified frame geographic', () => {
    const r = reasonsOf(launch({ crsProjected: false, crsKind: 'unknown' }));
    expect(r.some((s) => /geographic/i.test(s))).toBe(false);
    expect(r.some((s) => /projected frame/i.test(s))).toBe(true);
  });

  it('says geographic when the frame is geographic', () => {
    const r = reasonsOf(launch({ crsProjected: false, crsKind: 'geographic' }));
    expect(r.some((s) => /geographic/i.test(s))).toBe(true);
  });

  it('asserts no particular frame when the kind was not supplied', () => {
    const r = reasonsOf(launch({ crsProjected: false }));
    expect(r.some((s) => /geographic/i.test(s))).toBe(false);
    expect(r.some((s) => /projected frame/i.test(s))).toBe(true);
  });

  it('raises nothing about the frame once it is projected', () => {
    expect(reasonsOf(launch({ crsKind: 'projected' }))).toHaveLength(0);
  });
});
