/**
 * epochFramePrep.test.ts — the epoch spatial-frame resolution extracted from
 * main.ts's compareLoadedLayers. Pins the override-aware resolution (C5) and the
 * shared-vertical comparability verdict (C6) that gates whether two epochs may
 * be differenced at all.
 */

import { describe, it, expect } from 'vitest';
import { CrsService, type CrsOverridePort } from '../src/geo/CrsService';
import type { CrsInfo } from '../src/io/crs';
import type { CrsOverride } from '../src/geo/CrsOverrideStore';
import { prepareEpochFrames, epochUnitMismatchLines } from '../src/app/epochFramePrep';

function makePort(): CrsOverridePort {
  const store = new Map<string, CrsOverride>();
  return {
    get: (k) => store.get(k),
    set: (k, o) => void store.set(k, { ...o, updatedAt: 1 }),
    clear: (k) => void store.delete(k),
  };
}

const UTM12N: CrsInfo = {
  source: 'wkt', name: 'WGS 84 / UTM zone 12N', epsg: 32612,
  linearUnit: 'metre', linearUnitToMetres: 1, isGeographic: false,
};
const COMPOUND_FT: CrsInfo = {
  ...UTM12N, name: 'UTM12N + foot height', verticalEpsg: 6360,
  verticalDatum: 'NAVD88 (ftUS)', verticalUnitToMetres: 1200 / 3937,
};
const COMPOUND_M: CrsInfo = {
  ...UTM12N, name: 'UTM12N + metre height', verticalEpsg: 5703,
  verticalDatum: 'NAVD88', verticalUnitToMetres: 1,
};

const epoch = (name: string, crs: CrsInfo | undefined) => ({
  name,
  // A survey format: Z-up by specification, which the change pipeline requires.
  // The up-axis contract is exercised on its own in epochUpAxisGate.test.ts.
  sourceFormat: 'las' as const,
  positions: new Float32Array([0, 0, 0, 1, 1, 1]),
  sourceOrigin: [10, 20, 0] as [number, number, number],
  metadata: crs ? { crs } : undefined,
});

describe('prepareEpochFrames', () => {
  it('resolves both epochs and pairs each buffer with its origin', () => {
    const svc = new CrsService(makePort());
    const r = prepareEpochFrames(svc, epoch('a.laz', UTM12N), epoch('b.laz', UTM12N));
    expect(r.comparable).toBe(true);
    expect(r.ctxA.epsg).toBe(32612);
    expect(r.beforeCloud.origin).toEqual([10, 20, 0]);
    expect(r.afterCloud.positions).toHaveLength(6);
    // Frame facts spread in (isGeographic among them).
    expect(r.frames.isGeographic).toBe(false);
  });

  it('applies a user override to an epoch instead of its raw file CRS (C5)', () => {
    const port = makePort();
    // The user corrected b.laz from its declared 32612 to 32613.
    port.set('b.laz', { epsg: 32613, kind: 'projected', detectedEpsg: 32612 });
    const svc = new CrsService(port);
    const r = prepareEpochFrames(svc, epoch('a.laz', UTM12N), epoch('b.laz', UTM12N));
    // ctxA is the BEFORE epoch (a.laz) — still 32612.
    expect(r.ctxA.epsg).toBe(32612);
  });

  it('marks a metre-vs-foot epoch pair as NOT comparable (C6)', () => {
    const svc = new CrsService(makePort());
    const r = prepareEpochFrames(svc, epoch('a.laz', COMPOUND_M), epoch('b.laz', COMPOUND_FT));
    expect(r.comparable).toBe(false);
  });

  it('marks two matching-vertical-unit epochs as comparable (C6)', () => {
    const svc = new CrsService(makePort());
    const r = prepareEpochFrames(svc, epoch('a.laz', COMPOUND_M), epoch('b.laz', COMPOUND_M));
    expect(r.comparable).toBe(true);
  });
});

describe('epochUnitMismatchLines', () => {
  it('returns the header plus a re-export instruction', () => {
    const lines = epochUnitMismatchLines('A (before) → B (after)');
    expect(lines[0]).toBe('A (before) → B (after)');
    expect(lines[1]).toMatch(/different vertical units/i);
    expect(lines).toHaveLength(2);
  });
});
