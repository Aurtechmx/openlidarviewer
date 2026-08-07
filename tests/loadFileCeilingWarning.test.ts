/**
 * tests/loadFileCeilingWarning.test.ts
 *
 * `LoadPlan.mayExceedCeiling` was computed on every LAS/LAZ open and read by
 * nothing — the doc comment said the loader "should warn the user (or refuse
 * the open) rather than imply the file fits", and the only warning the user got
 * was the ordinary "large file, may spike RAM" size note. This drives the REAL
 * preflight path (`fileMetadata` → `buildLasPlan` → `planLoad` →
 * `buildSourceMetadata` → `buildPreloadSummary`) to pin the wiring: an estimate
 * the budget guard cannot pull under the device ceiling now reads as a stronger
 * caution, and an ordinary large file still reads as the ordinary one.
 */

import { describe, it, expect } from 'vitest';
import { fileMetadata } from '../src/io/loadFile';
import { buildPreloadSummary } from '../src/io/preloadSummary';
import { planLoad, LARGE_STATIC_LAS_THRESHOLD_BYTES } from '../src/io/loadPlan';
import type { PointAttributes } from '../src/io/loadPlan';

/**
 * A minimal but genuinely parseable LAS 1.2 public header. The preflight only
 * reads the head slice, so this is the whole input `planLoad` ever sees — which
 * is what lets a test claim a multi-GB file without allocating one.
 */
function lasHeaderBytes(pointCount: number, pointFormat = 2): Uint8Array {
  const bytes = new Uint8Array(375);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('LASF'), 0);
  view.setUint8(24, 1); // version major
  view.setUint8(25, 2); // version minor — LAS 1.2, legacy uint32 point count
  view.setUint16(94, 227, true); // header size
  view.setUint32(96, 227, true); // offset to point data
  view.setUint8(104, pointFormat);
  view.setUint16(105, 26, true); // point record length
  view.setUint32(107, pointCount, true);
  for (let i = 0; i < 3; i++) {
    view.setFloat64(131 + i * 8, 0.001, true); // scale — must be finite and > 0
    view.setFloat64(155 + i * 8, 0, true); // offset
  }
  // max/min pairs, interleaved per axis
  for (let i = 0; i < 3; i++) {
    view.setFloat64(179 + i * 16, 1000, true);
    view.setFloat64(187 + i * 16, 0, true);
  }
  return bytes;
}

/** A `File` stand-in whose head slice is a real LAS header; the size is a claim. */
function fakeLasFile(name: string, size: number, pointCount: number): File {
  const head = lasHeaderBytes(pointCount);
  return {
    name,
    size,
    slice: () => ({
      arrayBuffer: async () => head.buffer.slice(0, head.byteLength),
    }),
  } as unknown as File;
}

const LAS_F2_ATTRS: PointAttributes = {
  hasColor: true,
  hasIntensity: true,
  hasClassification: true,
  hasNormals: false,
};

describe('mayExceedCeiling reaches the user as a stronger warning', () => {
  it('the fixture really does trip the flag (the premise of the test)', () => {
    // Asserted through `planLoad` directly so a failure here is unambiguous:
    // the file shape is wrong, not the warning wiring.
    const plan = planLoad({
      sourceCount: 100_000_000,
      fileBytes: 4_000_000_000,
      budget: 4_000_000,
      isMobile: false,
      attributes: LAS_F2_ATTRS,
      format: 'laz',
    });
    expect(plan.mayExceedCeiling).toBe(true);
  });

  it('warns that the open may fail, not merely that RAM may spike', async () => {
    const meta = await fileMetadata(fakeLasFile('huge.laz', 4_000_000_000, 100_000_000));
    expect(meta.warning).toBeDefined();
    expect(meta.warning).toMatch(/may fail/i);
    // The ordinary size note must not be what the user sees for this file.
    expect(meta.warning).not.toMatch(/may spike RAM/i);
    // And it has to survive into the lines the UI actually renders.
    const summary = buildPreloadSummary(meta);
    expect(summary.some((l) => /⚠/.test(l) && /may fail/i.test(l))).toBe(true);
  });

  it('a large-but-fitting LAS keeps the ordinary caution, not the stronger one', async () => {
    // Over the large-static-LAS threshold, so it still warns — but the estimate
    // fits the ceiling, so it must NOT claim the open may fail.
    const size = LARGE_STATIC_LAS_THRESHOLD_BYTES + 1;
    const meta = await fileMetadata(fakeLasFile('big.las', size, 5_000_000));
    expect(meta.warning).toBeDefined();
    expect(meta.warning).not.toMatch(/may fail/i);
    expect(meta.warning).toMatch(/COPC|EPT/i);
  });

  it('a routine LAS tile still carries no warning at all', async () => {
    const meta = await fileMetadata(fakeLasFile('tile.las', 200 * 1024 * 1024, 4_000_000));
    expect(meta.warning).toBeUndefined();
  });
});
