/**
 * processStudioMount.test.ts — live-state → ScanFacts dispatch for Process Studio.
 */

import { describe, it, expect } from 'vitest';
import { resolveActiveScanFacts, signalsFromLive } from '../src/app/processStudioMount';
import type { LiveScanAccessors } from '../src/app/processStudioMount';
import type { RawScanSignals } from '../src/process/scanFacts';
import type { CrsInfo } from '../src/io/crs';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import { preflightSnapshot } from '../src/app/toolPreflightInput';

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
