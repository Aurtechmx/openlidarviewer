/**
 * storagePreflight.test.ts — the guard that runs BEFORE a file is indexed to disk.
 *
 * Two halves, tested apart. The demand half asks what indexing a source would
 * write, from the point count and the record schema rather than from the
 * compressed input size, because a 5 GB LAZ can hold hundreds of millions of
 * points and the cache it produces is several times the file. The decision half
 * compares that against what the browser reports free and either proceeds or
 * refuses by name.
 *
 * The cases that matter are the ones where a naive guard says yes: an estimate
 * that is missing entirely, an origin granted no quota at all, and a point count
 * large enough that the byte arithmetic leaves exact-integer range.
 */
import { describe, it, expect } from 'vitest';
import {
  estimateIndexDiskDemand,
  decideStoragePreflight,
  storagePreflight,
  storagePreflightRefusal,
  readStorageEstimate,
  STORAGE_HEADROOM_FRACTION,
  STORAGE_HEADROOM_FLOOR_BYTES,
  type StorageEstimateReading,
} from '../src/io/heavy/storagePreflight';
import { tileRecordBytes, type TileSchema } from '../src/io/heavy/tileRecord';
import { LoadError } from '../src/io/loadErrors';
import { formatByteSize } from '../src/io/formatByteSize';

const MINIMAL: TileSchema = { hasGps: false, hasRgb: false };
const FULL: TileSchema = { hasGps: true, hasRgb: true };

const GB = 1024 ** 3;

/** A reading that reports `quota` total and `usage` already spent. */
function reads(quota: number, usage = 0): StorageEstimateReading {
  return { available: true, quotaBytes: quota, usageBytes: usage };
}

describe('estimateIndexDiskDemand', () => {
  it('takes the per-point record size from the record layout, not an assumption', () => {
    const lean = estimateIndexDiskDemand({ pointCount: 1_000_000, schema: MINIMAL });
    const rich = estimateIndexDiskDemand({ pointCount: 1_000_000, schema: FULL });
    expect(lean.recordBytes).toBe(tileRecordBytes(MINIMAL));
    expect(rich.recordBytes).toBe(tileRecordBytes(FULL));
    expect(rich.recordBytes).toBeGreaterThan(lean.recordBytes);
    expect(lean.tileBytes).toBe(1_000_000 * tileRecordBytes(MINIMAL));
    expect(rich.tileBytes).toBe(1_000_000 * tileRecordBytes(FULL));
  });

  it('counts hierarchy and per-node overhead on top of the tile payload', () => {
    const d = estimateIndexDiskDemand({ pointCount: 50_000_000, schema: FULL });
    expect(d.nodeCount).toBeGreaterThan(0);
    expect(d.hierarchyBytes).toBeGreaterThan(0);
    expect(d.manifestBytes).toBeGreaterThan(0);
    expect(d.bytes).toBeGreaterThan(d.tileBytes);
    expect(d.bytes).toBe(d.tileBytes + d.hierarchyBytes + d.nodeOverheadBytes + d.manifestBytes);
  });

  it('scales with the point count a header declares, not with a compressed file size', () => {
    // The case the guard exists for: a 5 GB LAZ holding 400 M points. The cache
    // is several times the input, so a size-based check would wave it through.
    const d = estimateIndexDiskDemand({ pointCount: 400_000_000, schema: FULL });
    expect(d.known).toBe(true);
    expect(d.bytes).toBeGreaterThan(5 * GB * 2);
  });

  it('is monotonic in the point count', () => {
    const a = estimateIndexDiskDemand({ pointCount: 10_000_000, schema: FULL });
    const b = estimateIndexDiskDemand({ pointCount: 10_000_001, schema: FULL });
    expect(b.bytes).toBeGreaterThanOrEqual(a.bytes);
  });

  it('reports an empty source as a known, near-zero demand', () => {
    const d = estimateIndexDiskDemand({ pointCount: 0, schema: MINIMAL });
    expect(d.known).toBe(true);
    expect(d.tileBytes).toBe(0);
    expect(d.bytes).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(d.bytes)).toBe(true);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    'refuses to state a demand for a point count of %p',
    (pointCount) => {
      const d = estimateIndexDiskDemand({ pointCount, schema: FULL });
      expect(d.known).toBe(false);
      expect(d.reason ?? '').not.toBe('');
    },
  );

  it('stays finite and flags itself inexact when the byte arithmetic leaves safe-integer range', () => {
    // A LAS 1.4 header states the point count as a u64, so a malformed or
    // hostile header can declare more points than a double counts in bytes.
    const d = estimateIndexDiskDemand({ pointCount: 1e15, schema: FULL });
    expect(Number.isFinite(d.bytes)).toBe(true);
    expect(d.bytes).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    expect(d.exact).toBe(false);
    // It must not wrap, saturate low, or otherwise come back small enough to fit.
    const verdict = decideStoragePreflight(d, reads(1024 * GB));
    expect(verdict.proceed).toBe(false);
    expect(verdict.outcome).toBe('insufficient-storage');
  });

  it('keeps ordinary counts exact', () => {
    const d = estimateIndexDiskDemand({ pointCount: 250_000_000, schema: FULL });
    expect(d.exact).toBe(true);
    expect(Number.isSafeInteger(d.bytes)).toBe(true);
  });
});

describe('decideStoragePreflight', () => {
  const demand = estimateIndexDiskDemand({ pointCount: 200_000_000, schema: FULL });

  it('refuses when the demand exceeds what is available', () => {
    const verdict = decideStoragePreflight(demand, reads(2 * GB));
    expect(verdict.proceed).toBe(false);
    expect(verdict.outcome).toBe('insufficient-storage');
    expect(verdict.requiredBytes).toBe(demand.bytes);
  });

  it('proceeds when the demand fits with room to spare', () => {
    const verdict = decideStoragePreflight(demand, reads(200 * GB));
    expect(verdict.proceed).toBe(true);
    expect(verdict.outcome).toBe('proceed');
    expect(verdict.availableBytes).toBeGreaterThan(verdict.requiredBytes);
  });

  it('counts storage already in use against what is free', () => {
    const quota = 200 * GB;
    const spacious = decideStoragePreflight(demand, reads(quota, 0));
    const crowded = decideStoragePreflight(demand, reads(quota, quota - GB));
    expect(spacious.proceed).toBe(true);
    expect(crowded.proceed).toBe(false);
    expect(crowded.availableBytes).toBeLessThan(spacious.availableBytes);
  });

  it('keeps a margin below the reported free space rather than filling it', () => {
    // Sized to fit the raw free space and NOT the margin: the whole point of
    // the reserve is that a build which only just fits is refused.
    const small = estimateIndexDiskDemand({ pointCount: 100_000, schema: MINIMAL });
    const free = small.bytes + STORAGE_HEADROOM_FLOOR_BYTES / 2;
    const verdict = decideStoragePreflight(small, reads(free));
    expect(free).toBeGreaterThan(small.bytes); // it does fit, unguarded
    expect(verdict.proceed).toBe(false);
    expect(verdict.outcome).toBe('insufficient-storage');
    expect(verdict.reservedBytes).toBeGreaterThan(0);
    expect(verdict.availableBytes).toBeLessThan(free);
  });

  it('reserves at least the fraction of free space the constant names', () => {
    const free = 1000 * GB;
    const verdict = decideStoragePreflight(demand, reads(free));
    expect(verdict.reservedBytes).toBeGreaterThanOrEqual(free * STORAGE_HEADROOM_FRACTION);
    expect(verdict.availableBytes).toBeLessThanOrEqual(free - free * STORAGE_HEADROOM_FRACTION);
  });

  it('refuses when the browser reports no estimate at all', () => {
    const verdict = decideStoragePreflight(demand, { available: false, reason: 'no navigator.storage' });
    expect(verdict.proceed).toBe(false);
    expect(verdict.outcome).toBe('estimate-unavailable');
  });

  it('refuses when the origin is granted no quota', () => {
    const verdict = decideStoragePreflight(demand, reads(0));
    expect(verdict.proceed).toBe(false);
    expect(verdict.outcome).toBe('no-quota');
  });

  it.each([
    ['a missing quota', { available: true, usageBytes: 0 } as StorageEstimateReading],
    ['a non-numeric quota', { available: true, quotaBytes: Number.NaN, usageBytes: 0 } as StorageEstimateReading],
    ['an infinite quota', { available: true, quotaBytes: Number.POSITIVE_INFINITY, usageBytes: 0 } as StorageEstimateReading],
    ['a negative usage', { available: true, quotaBytes: 100 * GB, usageBytes: -1 } as StorageEstimateReading],
  ])('refuses on %s', (_label, reading) => {
    const verdict = decideStoragePreflight(demand, reading);
    expect(verdict.proceed).toBe(false);
    expect(verdict.outcome).toBe('quota-unknown');
  });

  it('refuses when the demand itself could not be established', () => {
    const unknown = estimateIndexDiskDemand({ pointCount: Number.NaN, schema: FULL });
    const verdict = decideStoragePreflight(unknown, reads(1000 * GB));
    expect(verdict.proceed).toBe(false);
    expect(verdict.outcome).toBe('demand-unknown');
  });

  it('treats usage above quota as no room rather than negative room', () => {
    const verdict = decideStoragePreflight(demand, reads(10 * GB, 12 * GB));
    expect(verdict.proceed).toBe(false);
    expect(verdict.availableBytes).toBe(0);
  });
});

describe('the refusal names numbers a user can act on', () => {
  const demand = estimateIndexDiskDemand({ pointCount: 200_000_000, schema: FULL });

  it('states both the required and the available figures, not a bare verdict', () => {
    const verdict = decideStoragePreflight(demand, reads(4 * GB));
    expect(verdict.proceed).toBe(false);
    expect(verdict.message).toContain(formatByteSize(verdict.requiredBytes));
    expect(verdict.message).toContain(formatByteSize(verdict.availableBytes));
    // Not reducible to a boolean: the two figures must differ and both appear.
    expect(formatByteSize(verdict.requiredBytes)).not.toBe(formatByteSize(verdict.availableBytes));
  });

  it('states the required figure even when the available one was never reported', () => {
    const verdict = decideStoragePreflight(demand, { available: false, reason: 'storage API absent' });
    expect(verdict.message).toContain(formatByteSize(verdict.requiredBytes));
    expect(verdict.message.toLowerCase()).toContain('not report');
  });

  it('explains where the demand comes from, so the figure is checkable', () => {
    const verdict = decideStoragePreflight(demand, reads(4 * GB));
    expect(verdict.message).toContain(String(demand.recordBytes));
    expect(verdict.message).toContain('200,000,000');
  });

  it('raises a categorised LoadError the existing refusal path can describe', () => {
    const verdict = decideStoragePreflight(demand, reads(4 * GB));
    const err = storagePreflightRefusal(verdict, 'big.laz');
    expect(err).toBeInstanceOf(LoadError);
    expect(err?.category).toBe('memory-constraint');
    expect(err?.message).toContain('big.laz');
    expect(err?.message).toContain(formatByteSize(verdict.requiredBytes));
    expect(err?.message).toContain(formatByteSize(verdict.availableBytes));
  });

  it('raises nothing when the verdict proceeds', () => {
    const verdict = decideStoragePreflight(demand, reads(500 * GB));
    expect(storagePreflightRefusal(verdict, 'big.laz')).toBeUndefined();
  });
});

describe('storagePreflight', () => {
  it('asks the injected reader rather than the global navigator', async () => {
    let asked = 0;
    const verdict = await storagePreflight(
      { pointCount: 1_000_000, schema: MINIMAL },
      async () => {
        asked++;
        return reads(500 * GB);
      },
    );
    expect(asked).toBe(1);
    expect(verdict.proceed).toBe(true);
  });

  it('refuses when the injected reader reports nothing', async () => {
    const verdict = await storagePreflight({ pointCount: 1_000_000, schema: MINIMAL }, async () => ({
      available: false,
      reason: 'test',
    }));
    expect(verdict.proceed).toBe(false);
    expect(verdict.outcome).toBe('estimate-unavailable');
  });

  it('refuses when the injected reader throws', async () => {
    const verdict = await storagePreflight({ pointCount: 1_000_000, schema: MINIMAL }, async () => {
      throw new Error('estimate blew up');
    });
    expect(verdict.proceed).toBe(false);
    expect(verdict.outcome).toBe('estimate-unavailable');
    expect(verdict.message).toContain('estimate blew up');
  });
});

describe('readStorageEstimate', () => {
  it('reports unavailable in an environment with no storage manager, without throwing', async () => {
    const reading = await readStorageEstimate();
    expect(reading.available).toBe(false);
    expect(reading.reason ?? '').not.toBe('');
  });

  it('reads a storage manager that is present', async () => {
    const nav = { storage: { estimate: async () => ({ quota: 12345, usage: 67 }) } };
    const reading = await readStorageEstimate(nav);
    expect(reading.available).toBe(true);
    expect(reading.quotaBytes).toBe(12345);
    expect(reading.usageBytes).toBe(67);
  });

  it('reports unavailable when the storage manager throws', async () => {
    const nav = {
      storage: {
        estimate: async () => {
          throw new Error('SecurityError');
        },
      },
    };
    const reading = await readStorageEstimate(nav);
    expect(reading.available).toBe(false);
    expect(reading.reason).toContain('SecurityError');
  });
});
