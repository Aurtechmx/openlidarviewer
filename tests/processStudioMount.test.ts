/**
 * processStudioMount.test.ts — live-state → ScanFacts dispatch for Process Studio.
 */

import { describe, it, expect } from 'vitest';
import { resolveActiveScanFacts } from '../src/app/processStudioMount';
import type { RawScanSignals } from '../src/process/scanFacts';

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
