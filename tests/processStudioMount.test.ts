/**
 * processStudioMount.test.ts — live-state → ScanFacts dispatch for Process Studio.
 */

import { describe, it, expect } from 'vitest';
import { resolveActiveScanFacts, signalsFromLive } from '../src/app/processStudioMount';
import type { LiveScanAccessors } from '../src/app/processStudioMount';
import type { RawScanSignals } from '../src/process/scanFacts';

const noScan: LiveScanAccessors = {
  getStreamingPointCount: () => null,
  getActivePointCount: () => null,
  getResolvedCrs: () => null,
  getPresentClassCodes: () => [],
};

const staticSignals: RawScanSignals = {
  kind: 'static',
  pointCount: 1000,
  crs: null,
  classification: 'full',
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
    const sig = signalsFromLive({ ...noScan, getStreamingPointCount: () => 9_000_000, getActivePointCount: () => 100 });
    expect(sig).toMatchObject({ kind: 'streaming', pointCount: 9_000_000 });
  });

  it('carries a null CRS through rather than inventing one', () => {
    const sig = signalsFromLive({ ...noScan, getActivePointCount: () => 10, getResolvedCrs: () => null });
    expect(sig?.crs).toBeNull();
  });
});
