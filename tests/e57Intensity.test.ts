/**
 * e57Intensity.test.ts — intensity ingestion in `loadE57`.
 *
 * The defect this pins (found in a real-world E57 export): E57 files commonly
 * carry intensity as a UNIT-RANGE FLOAT — the sample declares
 * intensityLimits 0.2800009–0.7380647 — and the loader rounded those floats
 * straight into the Uint16 store (`clampU16(col.intensity[i])`). Math.round
 * of a 0–1 value yields only 0 or 1, so the whole continuous channel
 * collapsed to two values, and every downstream surface (CSV/XYZ export, the
 * intensity colour ramp, the inspector) saw the destroyed channel.
 *
 * Declared intensityLimits are the channel's range (ASTM E2807), so the
 * loader normalises (v − min) / (max − min) · 65535; a signed range keeps its
 * negative values instead of clamping them to 0. With no declared limits a
 * unit-range channel is rescaled to 0–65535 and a wider range is stored raw.
 *
 * The parser is mocked (same pattern as loadE57Merge.test.ts) so the scan
 * columns and declared limits are hand-built.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { E57ScanData, E57ParseResult } from '../src/io/e57/parseE57';
import { parseE57 } from '../src/io/e57/parseE57';
import { loadE57 } from '../src/io/loadE57';
import type { E57DecodePlan } from '../src/io/loadPlan';
import { toCsv } from '../src/io/exporters';

vi.mock('../src/io/e57/parseE57', () => ({
  parseE57: vi.fn(),
}));

const mockedParse = vi.mocked(parseE57);

/**
 * A decode plan that reads every record. `parseE57` is mocked here, so the
 * buffer these tests pass carries no declaration for the loader to preflight;
 * handing it the plan directly keeps the subject of each test the merge and
 * attribute logic. The loader refuses an E57 whose plan cannot be established,
 * which is what `tests/e57PreflightGuard.test.ts` covers.
 */
const READ_EVERY_RECORD: E57DecodePlan = {
  mode: 'all',
  stride: 1,
  sourceCount: 0,
  decodedCount: 0,
  memoryEstimateBytes: 0,
  fullDecodeEstimateBytes: 0,
  ceilingBytes: 0,
  fits: true,
};


const SAMPLE_MIN = 0.2800008952617645;
const SAMPLE_MAX = 0.738064706325531;

function scan(
  recordCount: number,
  intensityVals: number[],
  intensityLimits: [number, number] | null,
): E57ScanData {
  return {
    name: 'scan',
    guid: 'guid',
    recordCount,
    declaredRecordCount: recordCount,
    columns: {
      cartesianX: Float64Array.from(intensityVals.map((_, i) => 10.5 + i)),
      cartesianY: Float64Array.from(intensityVals.map(() => 20.5)),
      cartesianZ: Float64Array.from(intensityVals.map(() => 5.5)),
      intensity: Float64Array.from(intensityVals),
    },
    fields: [],
    pose: null,
    colorLimits: null,
    intensityLimits: intensityLimits
      ? { minimum: intensityLimits[0], maximum: intensityLimits[1] }
      : null,
  };
}

function parseResult(scans: E57ScanData[]): E57ParseResult {
  return {
    scans,
    metadata: {
      formatName: 'ASTM E57 3D Imaging Data File',
      guid: 'g',
      library: 'test-lib',
      creationDateTime: null,
    },
    sourceMetadata: null,
    warnings: [],
  };
}

beforeEach(() => {
  mockedParse.mockReset();
});

describe('loadE57 — unit-range float intensity (the binarization bug)', () => {
  it('preserves the continuous channel: declared limits normalise to 0–65535', async () => {
    // The regression sample: intensityLimits 0.2800009–0.7380647, values
    // declared as unit-range floats. Hand-computed:
    // Math.round((v − min) / (max − min) × 65535).
    mockedParse.mockReturnValue(
      parseResult([scan(3, [SAMPLE_MIN, 0.5, SAMPLE_MAX], [SAMPLE_MIN, SAMPLE_MAX])]),
    );
    const cloud = await loadE57(new ArrayBuffer(0), 'sample.e57', { plan: READ_EVERY_RECORD });
    // Before the unit-range fix this read [0, 1, 1].
    expect([...cloud.intensity!]).toEqual([0, 31475, 65535]);
  });

  it('normalises a signed declared range instead of clamping negatives to 0', async () => {
    // intensityLimits −2048..2047: −1000 → (−1000 + 2048) / 4095 × 65535.
    mockedParse.mockReturnValue(parseResult([scan(4, [-2048, -1000, 0, 2047], [-2048, 2047])]));
    const cloud = await loadE57(new ArrayBuffer(0), 'signed.e57', { plan: READ_EVERY_RECORD });
    expect([...cloud.intensity!]).toEqual([0, 16772, 32776, 65535]);
  });

  it('falls back to the no-limits rule when the declared range is degenerate (max == min)', async () => {
    mockedParse.mockReturnValue(parseResult([scan(2, [0.25, 0.75], [0.5, 0.5])]));
    const cloud = await loadE57(new ArrayBuffer(0), 'degenerate.e57', { plan: READ_EVERY_RECORD });
    expect([...cloud.intensity!]).toEqual([16384, 49151]);
  });

  it('rescales by an OBSERVED unit-range maximum when the file declares no limits', async () => {
    mockedParse.mockReturnValue(parseResult([scan(2, [0.25, 0.75], null)]));
    const cloud = await loadE57(new ArrayBuffer(0), 'nolimits.e57', { plan: READ_EVERY_RECORD });
    expect([...cloud.intensity!]).toEqual([16384, 49151]);
  });

  it('stores a wider-than-unit range raw (declared limits)', async () => {
    mockedParse.mockReturnValue(parseResult([scan(3, [5, 1000, 65535], [0, 65535])]));
    const cloud = await loadE57(new ArrayBuffer(0), 'raw16.e57', { plan: READ_EVERY_RECORD });
    expect([...cloud.intensity!]).toEqual([5, 1000, 65535]);
  });

  it('stores a wider-than-unit range raw (no declared limits, observed max > 1)', async () => {
    mockedParse.mockReturnValue(parseResult([scan(2, [12, 300], null)]));
    const cloud = await loadE57(new ArrayBuffer(0), 'raw-observed.e57', { plan: READ_EVERY_RECORD });
    expect([...cloud.intensity!]).toEqual([12, 300]);
  });

  it('still clamps out-of-declared-range values into the Uint16 domain', async () => {
    mockedParse.mockReturnValue(parseResult([scan(2, [-0.25, 1.5], [0, 1])]));
    const cloud = await loadE57(new ArrayBuffer(0), 'clamped.e57', { plan: READ_EVERY_RECORD });
    expect([...cloud.intensity!]).toEqual([0, 65535]);
  });

  it('regression: the CSV export of a unit-range-intensity E57 carries the continuous channel', async () => {
    // End-to-end shape of the observed defect: E57 with float intensity
    // → CSV whose intensity column held ONLY 0 and 1.
    mockedParse.mockReturnValue(
      parseResult([scan(3, [SAMPLE_MIN, 0.5, SAMPLE_MAX], [SAMPLE_MIN, SAMPLE_MAX])]),
    );
    const cloud = await loadE57(new ArrayBuffer(0), 'sample.e57', { plan: READ_EVERY_RECORD });
    const rows = toCsv(cloud).trim().split('\n');
    // Rescaled at load, so the column is named as normalised.
    expect(rows[0]).toBe('x,y,z,intensity_normalised');
    const written = rows.slice(1).map((r) => Number(r.split(',')[3]));
    expect(written).toEqual([0, 31475, 65535]);
    // The binarized signature — at most {0, 1} — must be gone.
    expect(new Set(written).size).toBe(3);
    expect(Math.max(...written)).toBeGreaterThan(1);
  });
});
