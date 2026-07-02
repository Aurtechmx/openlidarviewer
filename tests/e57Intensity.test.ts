/**
 * e57Intensity.test.ts — intensity ingestion in `loadE57`.
 *
 * The defect this pins (found in a user's real export): E57 files commonly
 * carry intensity as a UNIT-RANGE FLOAT — the user's sample declares
 * intensityLimits 0.2800009–0.7380647 — and the loader rounded those floats
 * straight into the Uint16 store (`clampU16(col.intensity[i])`). Math.round
 * of a 0–1 value yields only 0 or 1, so the whole continuous channel
 * collapsed to two values, and every downstream surface (CSV/XYZ export, the
 * intensity colour ramp, the inspector) saw the destroyed channel. The fix
 * mirrors the PTS/PCD house rule: a unit-range channel is rescaled to the
 * full 0–65535 span; a wider range is stored raw, clamped only.
 *
 * The parser is mocked (same pattern as loadE57Merge.test.ts) so the scan
 * columns and declared limits are hand-built.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { E57ScanData, E57ParseResult } from '../src/io/e57/parseE57';
import { parseE57 } from '../src/io/e57/parseE57';
import { loadE57 } from '../src/io/loadE57';
import { toCsv } from '../src/io/exporters';

vi.mock('../src/io/e57/parseE57', () => ({
  parseE57: vi.fn(),
}));

const mockedParse = vi.mocked(parseE57);

function scan(
  recordCount: number,
  intensityVals: number[],
  intensityMax: number | null,
): E57ScanData {
  return {
    name: 'scan',
    guid: 'guid',
    recordCount,
    columns: {
      cartesianX: Float64Array.from(intensityVals.map((_, i) => 10.5 + i)),
      cartesianY: Float64Array.from(intensityVals.map(() => 20.5)),
      cartesianZ: Float64Array.from(intensityVals.map(() => 5.5)),
      intensity: Float64Array.from(intensityVals),
    },
    fields: [],
    pose: null,
    colorMax: null,
    intensityMax,
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
  it('preserves the continuous channel: declared-limit 0–1 floats rescale to 0–65535', async () => {
    // The user's sample file: intensityLimits 0.2800009–0.7380647, values
    // declared as unit-range floats. Hand-computed: Math.round(v × 65535).
    mockedParse.mockReturnValue(
      parseResult([
        scan(3, [0.2800008952617645, 0.5, 0.738064706325531], 0.738064706325531),
      ]),
    );
    const cloud = await loadE57(new ArrayBuffer(0), 'sample.e57');
    // Pre-fix this read [0, 1, 1] — the whole channel collapsed to two values.
    expect([...cloud.intensity!]).toEqual([18350, 32768, 48369]);
  });

  it('rescales by an OBSERVED unit-range maximum when the file declares no limits', async () => {
    mockedParse.mockReturnValue(parseResult([scan(2, [0.25, 0.75], null)]));
    const cloud = await loadE57(new ArrayBuffer(0), 'nolimits.e57');
    expect([...cloud.intensity!]).toEqual([16384, 49151]);
  });

  it('stores a wider-than-unit range raw (declared limits)', async () => {
    mockedParse.mockReturnValue(parseResult([scan(3, [5, 1000, 65535], 65535)]));
    const cloud = await loadE57(new ArrayBuffer(0), 'raw16.e57');
    expect([...cloud.intensity!]).toEqual([5, 1000, 65535]);
  });

  it('stores a wider-than-unit range raw (no declared limits, observed max > 1)', async () => {
    mockedParse.mockReturnValue(parseResult([scan(2, [12, 300], null)]));
    const cloud = await loadE57(new ArrayBuffer(0), 'raw-observed.e57');
    expect([...cloud.intensity!]).toEqual([12, 300]);
  });

  it('still clamps out-of-declared-range values into the Uint16 domain', async () => {
    mockedParse.mockReturnValue(parseResult([scan(2, [-0.25, 1.5], 1)]));
    const cloud = await loadE57(new ArrayBuffer(0), 'clamped.e57');
    expect([...cloud.intensity!]).toEqual([0, 65535]);
  });

  it('regression: the CSV export of a unit-range-intensity E57 carries the continuous channel', async () => {
    // End-to-end shape of the user's actual defect: E57 with float intensity
    // → CSV whose intensity column held ONLY 0 and 1.
    mockedParse.mockReturnValue(
      parseResult([
        scan(3, [0.2800008952617645, 0.5, 0.738064706325531], 0.738064706325531),
      ]),
    );
    const cloud = await loadE57(new ArrayBuffer(0), 'sample.e57');
    const rows = toCsv(cloud).trim().split('\n');
    expect(rows[0]).toBe('x,y,z,intensity');
    const written = rows.slice(1).map((r) => Number(r.split(',')[3]));
    expect(written).toEqual([18350, 32768, 48369]);
    // The binarized signature — at most {0, 1} — must be gone.
    expect(new Set(written).size).toBe(3);
    expect(Math.max(...written)).toBeGreaterThan(1);
  });
});
