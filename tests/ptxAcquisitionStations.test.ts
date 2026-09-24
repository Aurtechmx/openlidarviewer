/**
 * ptxAcquisitionStations.test.ts — the AcquisitionStations sidecar (OB-INT-02)
 * for multi-block PTX.
 *
 * Fixture: synthetic PTX text built in-test, the same pattern
 * `tests/ptxOrganizedRange.test.ts` uses (PTX is plain text, so this needs no
 * binary fixture file). Multi-block PTX is exercised here because that is
 * where a station boundary exists at all; the pre-existing single-block
 * fixtures in `tests/loadPtx.test.ts` and `tests/ptxOrganizedRange.test.ts`
 * pass unmodified after this change, which is the byte-identity evidence for
 * the single-station and grid-carrying paths this phase must not disturb.
 */
import { describe, it, expect } from 'vitest';
import { loadPtx } from '../src/io/loadPtx';

const ptx = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer;

/** Header: cols, rows, scanner position, three axis rows, then the 4x4. */
function header(cols: number, rows: number, tx: number, ty: number, tz: number): string {
  return [
    String(cols), String(rows),
    '0 0 0',
    '1 0 0', '0 1 0', '0 0 1',
    '1 0 0 0', '0 1 0 0', '0 0 1 0',
    `${tx} ${ty} ${tz} 1`,
  ].join('\n');
}

describe('a two-block PTX', () => {
  // Block 1: 1x3 grid, 3 points, registered at (10, 0, 0).
  // Block 2: 1x2 grid, 2 points, registered at (0, 20, 0).
  const body = [
    header(1, 3, 10, 0, 0),
    '1 0 0 0.5',
    '2 0 0 0.5',
    '3 0 0 0.5',
    header(1, 2, 0, 20, 0),
    '0 1 0 0.5',
    '0 2 0 0.5',
  ].join('\n');

  it('records one station per block, with exact pre-drop ranges', async () => {
    const pc = await loadPtx(ptx(body));
    expect(pc.positions.length / 3).toBe(5);
    const stations = pc.acquisitionStations?.stations;
    expect(stations).toHaveLength(2);
    expect(stations![0]).toMatchObject({
      id: 'block-1',
      source: 'ptx-block',
      originStatus: 'DECLARED',
      recordRange: { start: 0, end: 3 },
    });
    expect(stations![1]).toMatchObject({
      id: 'block-2',
      source: 'ptx-block',
      originStatus: 'DECLARED',
      recordRange: { start: 3, end: 5 },
    });
  });

  it('carries each block\'s own registration as the declared pose', async () => {
    const pc = await loadPtx(ptx(body));
    const [a, b] = pc.acquisitionStations!.stations;
    expect(a.pose.worldTranslation).toEqual([10, 0, 0]);
    expect(b.pose.worldTranslation).toEqual([0, 20, 0]);
    expect(a.pose.localPositionSource).toBe('source-declared');
  });

  it('also produces the acquisition grid, unchanged, alongside the stations', async () => {
    const pc = await loadPtx(ptx(body));
    expect(pc.organizedRange?.frames).toHaveLength(2);
    expect(pc.organizedRange?.organization).toBe('multi-grid');
  });
});

describe('sanitation dropping records inside one station', () => {
  // Block 1: 3 points, the middle one non-finite (dropped by sanitation).
  // Block 2: 2 points, untouched.
  const body = [
    header(1, 3, 0, 0, 0),
    '1 0 0 0.5',
    'nan 0 0 0.5',
    '3 0 0 0.5',
    header(1, 2, 0, 0, 0),
    '0 1 0 0.5',
    '0 2 0 0.5',
  ].join('\n');

  it('shrinks the affected station and shifts the one after it', async () => {
    const pc = await loadPtx(ptx(body));
    expect(pc.positions.length / 3).toBe(4); // 2 survivors + 2
    const stations = pc.acquisitionStations!.stations;
    expect(stations[0].recordRange).toEqual({ start: 0, end: 2 });
    expect(stations[1].recordRange).toEqual({ start: 2, end: 4 });
  });
});

describe('a block whose declared grid the records contradict', () => {
  // Header claims 5x5 (25 cells) but the file supplies far fewer lines —
  // gridIsBacked is false, so no OrganizedRangeFrame is recorded. The station
  // must still be recorded: OB-INT-02 tracks record membership, not grid
  // topology.
  const body = [
    header(5, 5, 7, 8, 9),
    '1 0 0 0.5',
    '2 0 0 0.5',
  ].join('\n');

  it('still records a station, with no grid frame', async () => {
    const pc = await loadPtx(ptx(body));
    expect(pc.organizedRange).toBeUndefined();
    const stations = pc.acquisitionStations?.stations;
    expect(stations).toHaveLength(1);
    expect(stations![0].recordRange).toEqual({ start: 0, end: 2 });
    expect(stations![0].pose.worldTranslation).toEqual([7, 8, 9]);
  });
});

describe('a block that contributes no points', () => {
  // Every cell is a no-return or malformed — the block's range is empty from
  // the start, not from sanitation, and the station still names it.
  const body = [
    header(1, 2, 0, 0, 0),
    '0 0 0 0',
    'garbage',
    header(1, 1, 5, 5, 5),
    '1 1 1 0.5',
  ].join('\n');

  it('records an empty range rather than omitting the station', async () => {
    const pc = await loadPtx(ptx(body));
    const stations = pc.acquisitionStations!.stations;
    expect(stations).toHaveLength(2);
    expect(stations[0].recordRange).toEqual({ start: 0, end: 0 });
    expect(stations[1].recordRange).toEqual({ start: 0, end: 1 });
  });
});
