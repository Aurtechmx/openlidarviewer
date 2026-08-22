/**
 * loadPlanE57Memory.test.ts
 *
 * The E57 memory model, checked against the measurements it was fitted to.
 *
 * An E57 decode's peak is nothing like a LAS decode's, and the generic
 * `pointCount * perPointBytes + fileBytes` estimate under-reports it by about
 * 3.5x — which is why a 616 MB E57 sailed past every guard and killed the tab.
 * `estimateMemoryBytes` therefore carries a separate E57 branch, and this file
 * is the record of what that branch was calibrated against.
 *
 * HOW THE MEASUREMENTS WERE TAKEN. Each file below was loaded through `loadE57`
 * in Node, on a harness that holds exactly ONE copy of the file — the browser
 * transfers a single ArrayBuffer into the parse worker, so a harness holding a
 * second copy measures itself rather than the loader. Peak COMMITTED bytes is
 * the figure recorded: `process.memoryUsage().arrayBuffers` sampled at peak,
 * plus the source buffer (Node's Buffer allocator does not report it under
 * `arrayBuffers`). Resident set is a floor on that, not a substitute: a freshly
 * allocated typed array's pages are not resident until written, so RSS lags the
 * commitment that actually has to be satisfiable.
 *
 * WHAT THE MODEL MAY NOT DO. Under-report. Every assertion below is one-sided
 * in that direction; the margins are recorded so a later change that tightens
 * or loosens the fit is visible as a diff rather than a silent re-tune.
 */

import { describe, it, expect } from 'vitest';
import {
  estimateMemoryBytes,
  e57BytesPerRecord,
  planE57Decode,
  memoryCeilingBytes,
  E57_DECODE_CEILING_BYTES,
} from '../src/io/loadPlan';
import type { PointAttributes } from '../src/io/loadPlan';

const NONE: PointAttributes = {
  hasColor: false,
  hasIntensity: false,
  hasClassification: false,
  hasNormals: false,
};
const COLOR: PointAttributes = { ...NONE, hasColor: true };
const COLOR_INTENSITY: PointAttributes = { ...COLOR, hasIntensity: true };

/** One measured load: what the file declares, and what the decode actually cost. */
interface Measurement {
  name: string;
  fileBytes: number;
  /** Records the file's XML declares across the scans that merge. */
  declaredRecords: number;
  /** Points that survived the invalid-state filter and were merged. */
  mergedPoints: number;
  /** Float64 decode columns the parse materialised per record. */
  columnsPerRecord: number;
  attributes: PointAttributes;
  /** Peak committed bytes: peak `arrayBuffers` + the source buffer. */
  measuredPeakBytes: number;
}

/**
 * Six real files spanning 0.4 MB to 616 MB. Every figure here was read off a
 * run, not derived: change one only by re-measuring.
 */
const MEASURED: Measurement[] = [
  {
    name: 'bunnyFloat.e57',
    fileBytes: 374_784,
    declaredRecords: 30_571,
    mergedPoints: 30_571,
    columnsPerRecord: 4,
    attributes: NONE,
    measuredPeakBytes: 2_875_000,
  },
  {
    name: 'pumpARowColumnIndexNoInvalidPoints.e57',
    fileBytes: 2_596_864,
    declaredRecords: 155_201,
    mergedPoints: 155_201,
    columnsPerRecord: 8,
    attributes: COLOR_INTENSITY,
    measuredPeakBytes: 21_497_000,
  },
  {
    name: 'el_pinacate_crater_reference_model.e57',
    fileBytes: 25_765_888,
    declaredRecords: 1_350_000,
    mergedPoints: 1_350_000,
    columnsPerRecord: 7,
    attributes: COLOR_INTENSITY,
    measuredPeakBytes: 210_866_000,
  },
  {
    // The invalid-state filter drops 58 % of this file's records, so its
    // columns are sized by 2.88 M and its merged arrays by 1.21 M. The plan
    // cannot know that split before decoding and uses the declared count for
    // both, which is where its widest over-estimate comes from.
    name: 'pump.e57',
    fileBytes: 52_496_384,
    declaredRecords: 2_878_964,
    mergedPoints: 1_213_990,
    columnsPerRecord: 8,
    attributes: COLOR_INTENSITY,
    measuredPeakBytes: 338_996_000,
  },
  {
    name: 'Trimble_StSulpice-Cloud-50mm.e57',
    fileBytes: 143_808_512,
    declaredRecords: 8_484_455,
    mergedPoints: 8_484_455,
    columnsPerRecord: 7,
    attributes: COLOR_INTENSITY,
    measuredPeakBytes: 1_110_609_000,
  },
  {
    // The file that killed the tab: 10 registered scans, 26.9 M records.
    name: 'openpitmine.e57',
    fileBytes: 616_108_032,
    declaredRecords: 26_910_771,
    mergedPoints: 26_910_771,
    columnsPerRecord: 6,
    attributes: COLOR,
    measuredPeakBytes: 3_573_508_000,
  },
];

/** The model's estimate for a measured file, at the plan's own information. */
function planTimeEstimate(m: Measurement): number {
  return estimateMemoryBytes({
    // The plan knows only the DECLARED record count; the merged count is a
    // decode result. Using the declared count for both terms is the single
    // deliberate over-estimate in the model.
    pointCount: m.declaredRecords,
    attributes: m.attributes,
    fileBytes: m.fileBytes,
    format: 'e57',
    decodeColumnsPerPoint: m.columnsPerRecord,
  });
}

/**
 * The itemised array total the model claims, evaluated with the counts the
 * DECODE actually used — declared records for the columns, merged points for
 * the merged arrays. This is the part that is meant to be exact.
 */
function itemisedArrayBytes(m: Measurement): number {
  const columnBytes = m.declaredRecords * 8 * m.columnsPerRecord;
  // `e57BytesPerRecord(0, …)` is exactly the non-column half: the merged
  // Float64 xyz, the merged attributes, and the Float32 cloud beside them.
  const mergedBytes = m.mergedPoints * e57BytesPerRecord(0, m.attributes);
  return 2 * m.fileBytes + columnBytes + mergedBytes;
}

describe('E57 memory model — fit against measured loads', () => {
  it.each(MEASURED)(
    'never under-reports the measured peak: $name',
    (m) => {
      expect(planTimeEstimate(m)).toBeGreaterThanOrEqual(m.measuredPeakBytes);
    },
  );

  it('the itemised array total lands ON the measurement, not near it', () => {
    // The five array terms account for what the decode KEEPS, so the total is
    // meant to be exact rather than approximate. Two tolerances, because the
    // measurements were recorded to 0.1 MB: 0.1 % of the figure, or 100 kB,
    // whichever is larger — the second is the recording granularity and is what
    // the sub-3 MB files are actually limited by. The one file that exceeds
    // both is named in the test below.
    for (const m of MEASURED) {
      if (m.name === 'el_pinacate_crater_reference_model.e57') continue;
      const tolerance = Math.max(100_000, m.measuredPeakBytes * 0.001);
      expect(Math.abs(itemisedArrayBytes(m) - m.measuredPeakBytes)).toBeLessThan(tolerance);
    }
  });

  it('the one outlier is the transient bytestream concatenation, under 30 MB', () => {
    // el_pinacate's peak sample caught a per-field concatenation still live.
    // That buffer is bounded by a single scan's widest field and is exactly
    // what the flat resident allowance exists to cover.
    const m = MEASURED.find((x) => x.name === 'el_pinacate_crater_reference_model.e57')!;
    const excess = m.measuredPeakBytes - itemisedArrayBytes(m);
    expect(excess).toBeGreaterThan(0);
    expect(excess).toBeLessThan(30_000_000);
  });

  it('over-estimates by at most 25 % on the files whose records all merge', () => {
    // pump.e57 is excluded: 58 % of its records are invalid, and the plan is
    // told only the declared count, so its over-estimate is structural.
    // Small files are excluded too: the flat resident allowance dominates
    // anything under ~50 MB and there is nothing to fit there.
    const big = MEASURED.filter(
      (m) => m.mergedPoints === m.declaredRecords && m.fileBytes > 100_000_000,
    );
    expect(big.length).toBeGreaterThan(0);
    for (const m of big) {
      const over = planTimeEstimate(m) / m.measuredPeakBytes;
      expect(over).toBeLessThan(1.25);
    }
  });

  it('the generic non-E57 model under-reports the file that killed the tab by 3x', () => {
    // The defect this branch exists to fix, stated as a number. The generic
    // model counts the renderer's arrays and one copy of the file, and knows
    // nothing about the de-paged copy or the Float64 decode columns.
    const m = MEASURED.find((x) => x.name === 'openpitmine.e57')!;
    const generic = estimateMemoryBytes({
      pointCount: m.declaredRecords,
      attributes: m.attributes,
      fileBytes: m.fileBytes,
      format: 'ply',
    });
    expect(generic).toBeLessThan(m.measuredPeakBytes / 3);
  });
});

describe('e57BytesPerRecord', () => {
  it('counts the decode columns, the merged buffers and the Float32 cloud', () => {
    // 6 columns x 8 + Float64 xyz 24 + colour 3 + Float32 xyz 12.
    expect(e57BytesPerRecord(6, COLOR)).toBe(6 * 8 + 24 + 3 + 12);
    // Every attribute the merge can carry.
    expect(
      e57BytesPerRecord(12, {
        hasColor: true,
        hasIntensity: true,
        hasClassification: true,
        hasNormals: true,
      }),
    ).toBe(12 * 8 + 24 + (3 + 2 + 1 + 12) + 12);
  });

  it('a column-less estimate is a floor, not a peak', () => {
    expect(e57BytesPerRecord(0, COLOR)).toBeLessThan(e57BytesPerRecord(6, COLOR));
  });
});

// ────────────────────────────────────────────────────────────────────────────
// planE57Decode
// ────────────────────────────────────────────────────────────────────────────

/** The openpitmine facts, which every decision below is exercised against. */
const OPEN_PIT = {
  sourceCount: 26_910_771,
  fileBytes: 616_108_032,
  columnsPerRecord: 6,
  attributes: COLOR,
  isMobile: false,
};

describe('planE57Decode', () => {
  it('reads every record when the estimate fits', () => {
    const plan = planE57Decode({
      sourceCount: 1_350_000,
      fileBytes: 25_765_888,
      columnsPerRecord: 7,
      attributes: COLOR_INTENSITY,
      isMobile: false,
      deviceMemoryGB: 8,
    });
    expect(plan.mode).toBe('all');
    expect(plan.stride).toBe(1);
    expect(plan.decodedCount).toBe(1_350_000);
    expect(plan.fits).toBe(true);
  });

  it('strides the file that killed the tab, and the strided estimate fits', () => {
    const plan = planE57Decode({ ...OPEN_PIT, deviceMemoryGB: 8 });
    expect(plan.mode).toBe('stride');
    expect(plan.stride).toBeGreaterThan(1);
    expect(plan.fits).toBe(true);
    expect(plan.decodedCount).toBe(Math.ceil(plan.sourceCount / plan.stride));
    expect(plan.memoryEstimateBytes).toBeLessThanOrEqual(plan.ceilingBytes);
    // And the full read it replaces did NOT fit — which is the whole point.
    expect(plan.fullDecodeEstimateBytes).toBeGreaterThan(plan.ceilingBytes);
  });

  it('picks the SMALLEST stride that fits, never a rounder one', () => {
    const plan = planE57Decode({ ...OPEN_PIT, deviceMemoryGB: 8 });
    // One step looser reads more records than the ceiling can hold.
    const looser = Math.ceil(plan.sourceCount / (plan.stride - 1));
    const estimateAtLooser = estimateMemoryBytes({
      pointCount: looser,
      attributes: OPEN_PIT.attributes,
      fileBytes: OPEN_PIT.fileBytes,
      format: 'e57',
      decodeColumnsPerPoint: OPEN_PIT.columnsPerRecord,
    });
    expect(estimateAtLooser).toBeGreaterThan(plan.ceilingBytes);
  });

  it('refuses when the file copies alone exceed the ceiling', () => {
    // A 1.5 GB E57: two copies of it are 3 GB before a single point is decoded,
    // so no stride can help and the loader must refuse rather than start.
    const plan = planE57Decode({
      sourceCount: 60_000_000,
      fileBytes: 1_500_000_000,
      columnsPerRecord: 6,
      attributes: COLOR,
      isMobile: false,
      deviceMemoryGB: 8,
    });
    expect(plan.fits).toBe(false);
    expect(plan.fullDecodeEstimateBytes).toBeGreaterThan(plan.ceilingBytes);
  });

  it('refuses when the surviving sample would be under the minimum', () => {
    // Room for a few points is not room for a scan. The floor matches the one
    // `planLoad`'s memory guard refuses to plan under.
    const plan = planE57Decode({
      sourceCount: 40_000_000,
      fileBytes: 990_000_000,
      columnsPerRecord: 8,
      attributes: COLOR_INTENSITY,
      isMobile: false,
      deviceMemoryGB: 8,
    });
    expect(plan.fits).toBe(false);
  });

  it('refuses when rounding the stride up drops the sample under the floor', () => {
    // Room for 260 k of 900 k records. The stride has to be a whole number, so
    // it rounds to 4 and keeps 225 k — under the floor even though the room was
    // not. Judging the room rather than the surviving sample let this through.
    const fileBytes = 10_000_000;
    const perRecord = e57BytesPerRecord(6, COLOR);
    const fixed = estimateMemoryBytes({
      pointCount: 0,
      attributes: COLOR,
      fileBytes,
      format: 'e57',
      decodeColumnsPerPoint: 6,
    });
    const plan = planE57Decode({
      sourceCount: 900_000,
      fileBytes,
      columnsPerRecord: 6,
      attributes: COLOR,
      isMobile: false,
      deviceMemoryGB: (fixed + 260_000 * perRecord) / (1_000_000_000 * 0.6),
    });
    expect(plan.fits).toBe(false);
  });

  it('accepts a stride whose surviving sample clears the floor', () => {
    // The same shape one step wider: room for 500 k of 900 k records rounds to
    // a stride of 2 and keeps 450 k, which is a scan worth showing.
    const fileBytes = 10_000_000;
    const perRecord = e57BytesPerRecord(6, COLOR);
    const fixed = estimateMemoryBytes({
      pointCount: 0,
      attributes: COLOR,
      fileBytes,
      format: 'e57',
      decodeColumnsPerPoint: 6,
    });
    const plan = planE57Decode({
      sourceCount: 900_000,
      fileBytes,
      columnsPerRecord: 6,
      attributes: COLOR,
      isMobile: false,
      deviceMemoryGB: (fixed + 500_000 * perRecord) / (1_000_000_000 * 0.6),
    });
    expect(plan.fits).toBe(true);
    expect(plan.stride).toBe(2);
    expect(plan.decodedCount).toBe(450_000);
  });

  it('a refusal still reports the full-decode estimate and the ceiling', () => {
    const plan = planE57Decode({
      sourceCount: 60_000_000,
      fileBytes: 1_500_000_000,
      columnsPerRecord: 6,
      attributes: COLOR,
      isMobile: false,
      deviceMemoryGB: 8,
    });
    expect(Number.isFinite(plan.fullDecodeEstimateBytes)).toBe(true);
    expect(plan.fullDecodeEstimateBytes).toBeGreaterThan(0);
    expect(plan.ceilingBytes).toBeGreaterThan(0);
  });

  it('clamps the device ceiling to the whole-decode ceiling', () => {
    // A browser caps navigator.deviceMemory at 8, so the shared ceiling
    // resolves to 4.8 GB on any well-provisioned desktop. A tab does not get
    // 4.8 GB, and a whole-file decode has no out-of-core fallback to offer.
    expect(memoryCeilingBytes(8, false)).toBeGreaterThan(E57_DECODE_CEILING_BYTES);
    const plan = planE57Decode({ ...OPEN_PIT, deviceMemoryGB: 8 });
    expect(plan.ceilingBytes).toBe(E57_DECODE_CEILING_BYTES);
  });

  it('a device that reports less than the clamp keeps its own, smaller ceiling', () => {
    const plan = planE57Decode({ ...OPEN_PIT, deviceMemoryGB: 2 });
    expect(plan.ceilingBytes).toBe(memoryCeilingBytes(2, false));
    expect(plan.ceilingBytes).toBeLessThan(E57_DECODE_CEILING_BYTES);
  });

  it('a phone gets a tighter ceiling than a desktop for the same file', () => {
    const phone = planE57Decode({ ...OPEN_PIT, isMobile: true, deviceMemoryGB: 4 });
    const desktop = planE57Decode({ ...OPEN_PIT, isMobile: false, deviceMemoryGB: 4 });
    expect(phone.ceilingBytes).toBeLessThan(desktop.ceilingBytes);
  });

  it('an empty file plans a full read of nothing rather than dividing by zero', () => {
    const plan = planE57Decode({
      sourceCount: 0,
      fileBytes: 2048,
      columnsPerRecord: 4,
      attributes: NONE,
      isMobile: false,
    });
    expect(plan.mode).toBe('all');
    expect(plan.stride).toBe(1);
    expect(plan.decodedCount).toBe(0);
    expect(plan.fits).toBe(true);
  });
});
