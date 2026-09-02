/**
 * processStudioMount.test.ts — live-state → ScanFacts dispatch for Process Studio.
 */

import { describe, it, expect } from 'vitest';
import { resolveActiveScanFacts, signalsFromLive } from '../src/app/processStudioMount';
import type { LiveScanAccessors } from '../src/app/processStudioMount';
import { deriveScanFacts } from '../src/process/scanFacts';
import type { RawScanSignals } from '../src/process/scanFacts';
import { runQaChecks } from '../src/qa/qaChecks';
import type { CrsInfo } from '../src/io/crs';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import { preflightSnapshot } from '../src/app/toolPreflightInput';
import { evaluateCapabilities, capabilityFor } from '../src/process/processCapabilities';

const noScan: LiveScanAccessors = {
  hasStreamingSource: () => false,
  getStreamingPointCount: () => null,
  getActivePointCount: () => null,
  getResolvedCrs: () => null,
  getPresentClassCodes: () => [],
  getClassificationDerived: () => false,
};

const staticSignals: RawScanSignals = {
  kind: 'static',
  pointCount: 1000,
  crs: null,
  classification: 'full',
  classificationProvenance: 'producer', // stated source → trusted (fail-closed default is unknown)
  groundClassified: true,
};

const streamingSignals: RawScanSignals = {
  kind: 'streaming',
  pointCount: 5_000_000,
  coverage: 'resident-only',
};

describe('resolveActiveScanFacts', () => {
  it('returns null when no scan is loaded', () => {
    expect(resolveActiveScanFacts({ getSignals: () => null })).toBeNull();
  });

  it('derives static facts, keeping trusted ground on a classified cloud', () => {
    const facts = resolveActiveScanFacts({ getSignals: () => staticSignals });
    expect(facts?.kind).toBe('static');
    expect(facts?.coverage).toBe('full');
    expect(facts?.groundClassified).toBe(true);
  });

  it('floors streaming coverage to resident-only, the conservative default', () => {
    const facts = resolveActiveScanFacts({ getSignals: () => streamingSignals });
    expect(facts?.kind).toBe('streaming');
    expect(facts?.coverage).toBe('resident-only');
  });

  it('fails closed to null when the signal read throws, never propagating', () => {
    const facts = resolveActiveScanFacts({
      getSignals: () => { throw new Error('boom'); },
    });
    expect(facts).toBeNull();
  });

  it('never trusts ground on an unclassified cloud (fail-closed)', () => {
    const facts = resolveActiveScanFacts({ getSignals: () => ({ kind: 'static', groundClassified: true }) });
    expect(facts?.groundClassified).toBe(false);
  });
});

describe('signalsFromLive', () => {
  it('returns null when neither a streaming nor a static scan is present', () => {
    expect(signalsFromLive(noScan)).toBeNull();
  });

  it('maps a static cloud, reading ground/building from class codes 2/6', () => {
    const sig = signalsFromLive({ ...noScan, getActivePointCount: () => 2000, getPresentClassCodes: () => [1, 2, 6] });
    expect(sig).toMatchObject({ kind: 'static', pointCount: 2000, classification: 'partial', groundClassified: true, hasBuildingClass: true });
  });

  it('reports no ground/building when those codes are absent', () => {
    const sig = signalsFromLive({ ...noScan, getActivePointCount: () => 500, getPresentClassCodes: () => [1] });
    expect(sig).toMatchObject({ groundClassified: false, hasBuildingClass: false, classification: 'partial' });
  });

  it('treats a mounted streaming source as the active scan over a static cloud', () => {
    const sig = signalsFromLive({
      ...noScan,
      hasStreamingSource: () => true,
      getStreamingPointCount: () => 9_000_000,
      getActivePointCount: () => 100,
    });
    expect(sig).toMatchObject({ kind: 'streaming', pointCount: 9_000_000 });
  });

  it('carries a null CRS through rather than inventing one', () => {
    const sig = signalsFromLive({ ...noScan, getActivePointCount: () => 10, getResolvedCrs: () => null });
    expect(sig?.crs).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A streaming source that states no point total
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A 3D Tiles tileset is drawn, picked and measured like any other streaming
 * scan, and it states no point total: `sourcePointCount` is null because the
 * per-tile figures are decode-admission estimates rather than counts. The shell
 * read that null as "no scan", so the capability model saw an empty scan list
 * and every tool preflight refused with NO_SCAN_LOADED over a scan on screen.
 *
 * A scan is present when a source is MOUNTED. The count is a separate fact, and
 * an absent one stays absent.
 */
const metreCrs = {
  source: 'epsg',
  name: 'WGS 84 / UTM zone 12N',
  epsg: 32612,
  linearUnit: 'metre',
  linearUnitToMetres: 1,
  isGeographic: false,
  verticalEpsg: 5703,
  verticalDatum: 'NAVD88',
  verticalUnitToMetres: 1,
} as CrsInfo;

const tilesetScan: LiveScanAccessors = {
  ...noScan,
  hasStreamingSource: () => true,
  getStreamingPointCount: () => null,
  getResolvedCrs: () => metreCrs,
};

describe('a streaming source with no stated point total', () => {
  it('is a loaded scan — presence of the source decides, not a count', () => {
    const sig = signalsFromLive(tilesetScan);
    expect(sig).not.toBeNull();
    expect(sig?.kind).toBe('streaming');
  });

  it('reports no point count rather than inventing one', () => {
    const sig = signalsFromLive(tilesetScan);
    expect(sig).not.toBeNull();
    expect(sig?.pointCount).toBeUndefined();
  });

  it('resolves scan facts, so the panel leaves its empty state', () => {
    const facts = resolveActiveScanFacts({ getSignals: () => signalsFromLive(tilesetScan) });
    expect(facts).not.toBeNull();
    expect(facts?.kind).toBe('streaming');
    expect(facts?.coverage).toBe('resident-only');
  });

  it('still prefers a static cloud when no streaming source is mounted', () => {
    const sig = signalsFromLive({ ...noScan, getActivePointCount: () => 42 });
    expect(sig).toMatchObject({ kind: 'static', pointCount: 42 });
  });

  it('leaves no tool refusing with NO_SCAN_LOADED', () => {
    const preflights = preflightSnapshot({
      getActiveSignals: () => signalsFromLive(tilesetScan),
      getSpatialContext: () => spatialContextFrom(metreCrs),
      getCompanionSignals: () => [],
      getDatumResolved: () => true,
    });
    expect(preflights.length).toBeGreaterThan(0);
    const codes = preflights.flatMap((p) => p.reasons.map((r) => r.code));
    expect(codes).not.toContain('NO_SCAN_LOADED');
  });

  it('never tells the user a scan on screen has no points', () => {
    // The end of the live path: accessors → signals → facts → the capability
    // model. With the total omitted the shell used to hand the evaluator a zero,
    // and DTM, DSM and classify-gaps each refused a drawn scan with "The scan
    // has no points to grid."
    const facts = resolveActiveScanFacts({ getSignals: () => signalsFromLive(tilesetScan) })!;
    const plan = evaluateCapabilities({ scans: [facts] });
    for (const product of ['classify-gaps', 'dtm', 'dsm'] as const) {
      const v = capabilityFor(plan, product)!;
      expect(v.reasonCode, product).toBe('POINT_TOTAL_UNSTATED');
      expect(v.reason, product).not.toMatch(/no points/i);
      expect(v.readiness, product).toBe('review');
    }
    expect(capabilityFor(plan, 'contours')!.readiness).not.toBe('blocked');
  });

  it('lets a measurement be armed over the scan on screen', () => {
    const preflights = preflightSnapshot({
      getActiveSignals: () => signalsFromLive(tilesetScan),
      getSpatialContext: () => spatialContextFrom(metreCrs),
      getCompanionSignals: () => [],
      getDatumResolved: () => true,
    });
    const distance = preflights.find((p) => p.tool === 'measure-distance');
    expect(distance?.status).not.toBe('blocked');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QA signal wiring: median spacing and full classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `tests/qaChecks.test.ts` pins the checks; this pins the WIRING. The mount
 * used to supply neither `medianSpacing` nor a `full` classification, so the
 * CLOUD_QUALITY check could only ever answer "not measured yet" and the
 * CLASSIFICATION check could never pass, whatever the loaded scan carried.
 * The live signals now measure spacing from the active static cloud's own
 * positions (converted to metres through the resolved unit) and state `full`
 * when a producer classification leaves no point unclassified.
 */

/** A flat 10 x 10 grid at 1.0 source-unit spacing, z = 0. */
function gridPositions(): Float32Array {
  const out = new Float32Array(10 * 10 * 3);
  let k = 0;
  for (let gy = 0; gy < 10; gy++) {
    for (let gx = 0; gx < 10; gx++) {
      out[k++] = gx;
      out[k++] = gy;
      out[k++] = 0;
    }
  }
  return out;
}

const footCrs = { ...metreCrs, linearUnit: 'foot', linearUnitToMetres: 0.3048 } as CrsInfo;

function staticGridScan(overrides: Partial<LiveScanAccessors> = {}): LiveScanAccessors {
  return {
    ...noScan,
    getActivePointCount: () => 100,
    getResolvedCrs: () => metreCrs,
    getActiveCloudData: () => ({ positions: gridPositions() }),
    ...overrides,
  };
}

describe('signalsFromLive measures median spacing for the QA cloud-quality check', () => {
  it('carries the probed spacing, in metres, on a static cloud with a known unit', () => {
    const sig = signalsFromLive(staticGridScan())!;
    expect(sig.medianSpacing).toBeCloseTo(1.0, 6);
    const checks = runQaChecks(deriveScanFacts(sig));
    const quality = checks.find((c) => c.id === 'CLOUD_QUALITY')!;
    expect(quality.status).toBe('pass');
    expect(quality.reason).toContain('1.00 m');
  });

  it('converts a foot-unit CRS into metres rather than stamping source units', () => {
    const sig = signalsFromLive(staticGridScan({ getResolvedCrs: () => footCrs }))!;
    expect(sig.medianSpacing).toBeCloseTo(0.3048, 6);
  });

  it('corrects for a display sample using the header-declared total', () => {
    // The loaded 100 points are a uniform sample of a declared 400-point file,
    // so the file's spacing is the probe's x sqrt(100/400) = half.
    const sig = signalsFromLive(
      staticGridScan({
        getActiveCloudData: () => ({ positions: gridPositions(), declaredPointCount: 400 }),
      }),
    )!;
    expect(sig.medianSpacing).toBeCloseTo(0.5, 6);
  });

  it('withholds spacing when the linear unit is unknown, fail-closed', () => {
    const sig = signalsFromLive(staticGridScan({ getResolvedCrs: () => null }))!;
    expect(sig.medianSpacing).toBeUndefined();
  });

  it('withholds spacing for a streaming scan (no resident buffer to probe)', () => {
    const sig = signalsFromLive(
      staticGridScan({ hasStreamingSource: () => true, getStreamingPointCount: () => 1000 }),
    )!;
    expect(sig.kind).toBe('streaming');
    expect(sig.medianSpacing).toBeUndefined();
  });

  it('withholds spacing when the shell offers no cloud data', () => {
    const sig = signalsFromLive(staticGridScan({ getActiveCloudData: undefined }))!;
    expect(sig.medianSpacing).toBeUndefined();
  });

  it('degrades a throwing data read to an unstated spacing, never a lost scan', () => {
    const sig = signalsFromLive(
      staticGridScan({ getActiveCloudData: () => { throw new Error('buffer gone'); } }),
    );
    expect(sig).not.toBeNull();
    expect(sig?.medianSpacing).toBeUndefined();
  });
});

describe('signalsFromLive states a full classification when the producer left none unclassified', () => {
  it('emits full for a static producer classification with no class 0 or 1', () => {
    const sig = signalsFromLive(staticGridScan({ getPresentClassCodes: () => [2, 3, 6] }))!;
    expect(sig.classification).toBe('full');
    const checks = runQaChecks(deriveScanFacts(sig));
    expect(checks.find((c) => c.id === 'CLASSIFICATION')?.status).toBe('pass');
  });

  it('stays partial while class 1 (unclassified) points remain', () => {
    const sig = signalsFromLive(staticGridScan({ getPresentClassCodes: () => [1, 2, 6] }))!;
    expect(sig.classification).toBe('partial');
  });

  it('stays partial while class 0 (never classified) points remain', () => {
    const sig = signalsFromLive(staticGridScan({ getPresentClassCodes: () => [0, 2] }))!;
    expect(sig.classification).toBe('partial');
  });

  it('never claims full for a derived classification (a heuristic, not a survey)', () => {
    const sig = signalsFromLive(
      staticGridScan({ getPresentClassCodes: () => [2, 6], getClassificationDerived: () => true }),
    )!;
    expect(sig.classification).toBe('partial');
  });

  it('never claims full for a streaming scan (the legend tallies decoded nodes only)', () => {
    const sig = signalsFromLive(
      staticGridScan({
        hasStreamingSource: () => true,
        getStreamingPointCount: () => 1000,
        getPresentClassCodes: () => [2, 6],
      }),
    )!;
    expect(sig.classification).toBe('partial');
  });

  it('still reports none for an unclassified cloud', () => {
    const sig = signalsFromLive(staticGridScan())!;
    expect(sig.classification).toBe('none');
  });
});
