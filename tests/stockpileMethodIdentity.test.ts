/**
 * stockpileMethodIdentity.test.ts — a stored volume says which estimator made it.
 *
 * One lasso can be answered by two estimators: the point-sample integration the
 * measurement record is built from, and the area-weighted grid the toast
 * reports. They do not agree, and the stored record carried no method, so
 * nothing downstream could tell which figure it held.
 *
 * The rule that matters for old files is the second half: a record written
 * before the field existed carries no method, and that absence must stay an
 * absence. Reading it as the current estimator would give a historical figure a
 * meaning it was never computed under.
 */

import { describe, it, expect } from 'vitest';
import { methodRef, methodTag, method } from '../src/science/methodRegistry';
import type { VolumeRecord } from '../src/render/measure/types';
import { parseSession, serializeSession } from '../src/io/session';

const base: VolumeRecord = {
  fill: 120,
  cut: 4,
  net: 116,
  referenceZ: 10,
  footprintArea: 50,
  pointsInPolygon: 2000,
  densityNative: 40,
  confidence: 'high',
};

describe('the two estimators are distinct records in the registry', () => {
  it('names the point-sample estimator at version 1', () => {
    expect(methodTag(methodRef('olv.volume.stockpile'))).toBe('olv.volume.stockpile@1');
  });

  it('names the area-weighted grid at version 2', () => {
    expect(methodTag(methodRef('olv.volume.stockpile-area-grid'))).toBe(
      'olv.volume.stockpile-area-grid@2',
    );
  });

  it('records that a v1 figure does not carry the v2 meaning', () => {
    // The registry says so in prose; this pins that the two are not aliases.
    expect(method('olv.volume.stockpile')?.version).toBe(1);
    expect(method('olv.volume.stockpile-area-grid')?.version).toBe(2);
    expect(method('olv.volume.stockpile-area-grid')?.summary).toContain('does not carry the v2 meaning');
  });
});

describe('a stored record and its method', () => {
  it('carries the tag it was written with', () => {
    const rec: VolumeRecord = { ...base, method: 'olv.volume.stockpile@1' };
    expect(rec.method).toBe('olv.volume.stockpile@1');
  });

  it('leaves a record written before the field without one', () => {
    expect(base.method).toBeUndefined();
  });
});

/** A session holding one lasso volume, with or without a method tag. */
function sessionWith(volume: VolumeRecord): Parameters<typeof serializeSession>[0] {
  return {
    upAxis: 'z',
    origin: [0, 0, 0],
    unitSystem: 'metric',
    views: [],
    annotations: [],
    measurements: [
      {
        id: 'vol1',
        kind: 'volume',
        name: 'Stockpile',
        points: [
          [0, 0, 0],
          [1, 0, 0],
          [1, 1, 0],
        ],
        closed: true,
        volume,
      },
    ],
  } as unknown as Parameters<typeof serializeSession>[0];
}

const roundTrip = (v: VolumeRecord): VolumeRecord | undefined => {
  const back = parseSession(serializeSession(sessionWith(v))).measurements[0];
  return (back as { volume?: VolumeRecord }).volume;
};

describe('a volume record through a session', () => {
  it('keeps the estimator it was written with', () => {
    const back = roundTrip({ ...base, method: 'olv.volume.stockpile@1' });
    expect(back?.method).toBe('olv.volume.stockpile@1');
  });

  it('keeps an area-grid tag unchanged, rather than normalising it', () => {
    const back = roundTrip({ ...base, method: 'olv.volume.stockpile-area-grid@2' });
    expect(back?.method).toBe('olv.volume.stockpile-area-grid@2');
  });

  it('leaves a record written before the field without a method', () => {
    // The rule for old files: absent is absent. Filling it in would claim the
    // figure was computed under an estimator that did not exist when it was.
    const back = roundTrip(base);
    expect(back?.method).toBeUndefined();
    expect(back?.net).toBe(116);
  });
});
