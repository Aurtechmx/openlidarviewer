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
import { withStockpileGrid, type StockpileGridFigure } from '../src/render/measure/measureDerivations';

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

// ── D2: the area-weighted grid becomes the LASSO record's canonical figure ──

const grid = (over: Partial<StockpileGridFigure> = {}): StockpileGridFigure => ({
  method: 'olv.volume.stockpile-area-grid@2',
  authority: 'measured',
  reason: '',
  fillNative: 90, cutNative: 3, netNative: 87,
  ...over,
});

describe('withStockpileGrid — D2 clause 1 (scope)', () => {
  it('passes the point-sample record through unchanged when there is no grid', () => {
    const rec = { ...base, method: 'olv.volume.stockpile@1' };
    expect(withStockpileGrid(rec, null)).toEqual(rec);
  });

  it('the polygon Volume tool never calls this, so its record never carries gridAuthority', () => {
    // Scope is enforced by main.ts only calling withStockpileGrid on the lasso
    // path (see measureDerivations.test.ts's grep on main.ts); this pins the
    // function's OWN half of the contract — untouched input, untouched output.
    const rec = { ...base, method: 'olv.volume.stockpile@1' };
    const out = withStockpileGrid(rec, null);
    expect(out.gridAuthority).toBeUndefined();
    expect(out.crossCheck).toBeUndefined();
  });
});

describe('withStockpileGrid — D2 clause 2 (authority) and clause 3 (method version)', () => {
  it('a measured grid becomes the canonical fill/cut/net, tagged with the grid method', () => {
    const rec = { ...base, method: 'olv.volume.stockpile@1' };
    const out = withStockpileGrid(rec, grid());
    expect(out.fill).toBe(90);
    expect(out.cut).toBe(3);
    expect(out.net).toBe(87);
    expect(out.method).toBe('olv.volume.stockpile-area-grid@2');
    expect(out.gridAuthority).toBe('measured');
  });

  it('a preview grid is stored and labelled preview, with a number', () => {
    const rec = { ...base, method: 'olv.volume.stockpile@1' };
    const out = withStockpileGrid(rec, grid({ authority: 'preview', reason: 'display sample' }));
    expect(out.gridAuthority).toBe('preview');
    expect(out.gridAuthorityReason).toBe('display sample');
    expect(out.fill).toBe(90);
  });

  it('a withheld grid carries no fill/cut/net at all — never the cross-check under the grid\'s name', () => {
    const rec = { ...base, method: 'olv.volume.stockpile@1' };
    const out = withStockpileGrid(rec, grid({ authority: 'withheld', reason: 'insufficient observations' }));
    expect(out.gridAuthority).toBe('withheld');
    expect(out.fill).toBeUndefined();
    expect(out.cut).toBeUndefined();
    expect(out.net).toBeUndefined();
    // The withheld grid's own (unreliable) numbers must not leak in either.
    expect(out).not.toMatchObject({ fill: 90 });
  });
});

describe('withStockpileGrid — D2 clause 5 (cut and fill cross-check)', () => {
  it('keeps the point-sample figure as a labelled cross-check under its own tag', () => {
    const rec = { ...base, method: 'olv.volume.stockpile@1' };
    const out = withStockpileGrid(rec, grid());
    expect(out.crossCheck).toEqual({ fill: 120, cut: 4, net: 116, method: 'olv.volume.stockpile@1' });
  });

  it('the cross-check survives even when the grid is withheld — it is the only figure left', () => {
    const rec = { ...base, method: 'olv.volume.stockpile@1' };
    const out = withStockpileGrid(rec, grid({ authority: 'withheld', reason: 'insufficient observations' }));
    expect(out.crossCheck).toEqual({ fill: 120, cut: 4, net: 116, method: 'olv.volume.stockpile@1' });
  });
});

describe('a session round trip carries an old record and a switched one unchanged', () => {
  it('an old point-sample record and a new grid-canonical record each read back exactly as saved', () => {
    const oldRecord: VolumeRecord = { ...base, method: 'olv.volume.stockpile@1' };
    const newRecord = withStockpileGrid({ ...base, method: 'olv.volume.stockpile@1' }, grid());
    const session = {
      upAxis: 'z', origin: [0, 0, 0], unitSystem: 'metric', views: [], annotations: [],
      measurements: [
        { id: 'old', kind: 'volume', name: 'Old pile', points: [[0, 0, 0], [1, 0, 0], [1, 1, 0]], closed: true, volume: oldRecord },
        { id: 'new', kind: 'volume', name: 'New pile', points: [[0, 0, 0], [1, 0, 0], [1, 1, 0]], closed: true, volume: newRecord },
      ],
    } as unknown as Parameters<typeof serializeSession>[0];
    const back = parseSession(serializeSession(session)).measurements as unknown as Array<{ id: string; volume?: VolumeRecord }>;
    const backOld = back.find((m) => m.id === 'old')!.volume!;
    const backNew = back.find((m) => m.id === 'new')!.volume!;
    expect(backOld).toEqual(oldRecord);
    expect(backNew.method).toBe('olv.volume.stockpile-area-grid@2');
    expect(backNew.gridAuthority).toBe('measured');
    expect(backNew.crossCheck).toEqual({ fill: 120, cut: 4, net: 116, method: 'olv.volume.stockpile@1' });
    expect(backNew.fill).toBe(90);
  });

  it('a withheld record round-trips with no fill/cut/net and the cross-check intact', () => {
    const withheld = withStockpileGrid(
      { ...base, method: 'olv.volume.stockpile@1' },
      grid({ authority: 'withheld', reason: 'insufficient observations' }),
    );
    const back = roundTrip(withheld);
    expect(back?.fill).toBeUndefined();
    expect(back?.gridAuthority).toBe('withheld');
    expect(back?.gridAuthorityReason).toBe('insufficient observations');
    expect(back?.crossCheck).toEqual({ fill: 120, cut: 4, net: 116, method: 'olv.volume.stockpile@1' });
  });

  it('a withheld record never reads back a fill/cut/net, even if the raw file carries one', () => {
    // withStockpileGrid deletes fill/cut/net before saving a withheld record,
    // but a hand-edited, shared, or corrupted session file is not written by
    // that function. The parser must refuse the numbers on the way in too,
    // or a withheld verdict could still show a cut-and-fill figure under the
    // grid's name.
    const tampered: VolumeRecord = {
      ...base,
      method: 'olv.volume.stockpile@1',
      gridAuthority: 'withheld',
      gridAuthorityReason: 'insufficient observations',
      fill: 999,
      cut: 5,
      net: 994,
    };
    const back = roundTrip(tampered);
    expect(back?.gridAuthority).toBe('withheld');
    expect(back?.fill).toBeUndefined();
    expect(back?.cut).toBeUndefined();
    expect(back?.net).toBeUndefined();
  });
});
