/**
 * recoverPointRecords.test.ts: phase C recovery on the TUNING split of the
 * intake corpus only. The held-out split is evaluated once, by
 * intakeRecoveryHeldout.test.ts, from a recorded result.
 */
import { describe, it, expect } from 'vitest';
import {
  recoverPointRecords, MAX_LAYOUT_HYPOTHESES, RECOVERY_TIME_BUDGET_MS, RECOVERY_MEMORY_BUDGET_BYTES,
  RECOVERED_PREVIEW_POINT_CAP, decodeRecovered,
} from '../src/io/probe/recover/recoverPointRecords';
import { scoreSplit } from './helpers/intakeRecoveryScore';

const tuning = scoreSplit('tuning');
const pos = tuning.filter((o) => o.label === 'positive');
const neg = tuning.filter((o) => o.label === 'negative');
/** Fields no byte stream records: the origin a writer subtracted, and an int scale. */
const UNRECOVERABLE = /^[xyz]\.(origin|scale)$/;

describe('point-record recovery on the tuning split', () => {
  it('offers nothing on any tuning negative', () => {
    expect(neg.filter((o) => o.offered).map((o) => o.id)).toEqual([]);
  });

  it('reads the record structure right whenever it offers', () => {
    const wrong = pos.filter((o) => o.offered && (o.layoutMismatch ?? []).some((m) => !UNRECOVERABLE.test(m)));
    expect(wrong.map((o) => `${o.id}: ${o.layoutMismatch}`)).toEqual([]);
  });

  it('offers on most tuning positives', () => {
    expect(pos.filter((o) => o.offered).length).toBeGreaterThanOrEqual(66);
  });

  it('is exact, coordinates included, where the bytes hold everything (float64 and text)', () => {
    const complete = pos.filter((o) => /^(f64|text)-/.test(o.layoutKey ?? '') && o.offered);
    expect(complete.length).toBeGreaterThanOrEqual(20);
    for (const o of complete) {
      expect(o.layoutExact, o.id).toBe(true);
      expect(o.coordinateError, o.id).toBeLessThanOrEqual(1e-6);
    }
  });
});

describe('recovery bounds', () => {
  const f32Cloud = () => {
    const n = 800, dv = new DataView(new ArrayBuffer(n * 12));
    let s = 7;
    const r = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let k = 0; k < n; k++) {
      const x = r() * 50, y = r() * 50;
      dv.setFloat32(12 * k, x, true); dv.setFloat32(12 * k + 4, y, true);
      dv.setFloat32(12 * k + 8, 3 * Math.sin(x / 7) + Math.cos(y / 5), true);
    }
    return new Uint8Array(dv.buffer);
  };

  it('names its bounds as constants', () => {
    expect(MAX_LAYOUT_HYPOTHESES).toBe(512);
    expect(RECOVERY_TIME_BUDGET_MS).toBe(3000);
    expect(RECOVERY_MEMORY_BUDGET_BYTES).toBe(64 * 1024 * 1024);
    expect(RECOVERED_PREVIEW_POINT_CAP).toBe(2_000_000);
  });

  it('recovers a headerless float32 XYZ stream', () => {
    const out = recoverPointRecords(f32Cloud());
    expect(out.status).toBe('offer');
    if (out.status === 'offer') {
      expect(out.layout).toMatchObject({ kind: 'binary', stride: 12, headerBytes: 0, type: 'f32', endianness: 'little' });
      expect(out.pointCount).toBe(800);
      expect(out.hypothesesTried).toBeLessThanOrEqual(MAX_LAYOUT_HYPOTHESES);
    }
  });

  it('abstains when cancelled', () => {
    const ac = new AbortController();
    ac.abort();
    const out = recoverPointRecords(f32Cloud(), { signal: ac.signal });
    expect(out).toMatchObject({ status: 'abstain', reason: 'bound reached: cancelled' });
  });

  it('abstains when the time budget runs out', () => {
    let t = 0;
    const out = recoverPointRecords(f32Cloud(), { now: () => (t += RECOVERY_TIME_BUDGET_MS) });
    expect(out).toMatchObject({ status: 'abstain', reason: 'bound reached: time budget' });
  });

  it('abstains on random bytes', () => {
    let s = 1;
    const b = Uint8Array.from({ length: 20000 }, () => (s = (s * 1664525 + 1013904223) >>> 0) >>> 24);
    expect(recoverPointRecords(b).status).toBe('abstain');
  });

  it('strides a preview down to the cap and says by how much', () => {
    const out = decodeRecovered(f32Cloud(), { kind: 'binary', headerBytes: 0, stride: 12, endianness: 'little', type: 'f32', offsets: [0, 4, 8], scale: 1 }, 100);
    expect(out.strided).toBe(8);
    expect(out.count).toBe(100);
  });
});
