/**
 * acquisitionStationsRemap.test.ts — the station-sidecar compaction remap
 * (docs/observatory/SPEC.md §4 OB-INT-02), isolated from any loader.
 *
 * Mirrors `organizedRangeRemap.ts`'s own tests in spirit: pin the remap
 * against hand-computed `CompactionWitness` values so the boundary arithmetic
 * is checked directly, before any loader-level fixture adds its own noise.
 */
import { describe, it, expect } from 'vitest';
import { remapAcquisitionStations } from '../src/io/acquisitionStationsRemap';
import { RECORD_DROPPED, type CompactionWitness } from '../src/io/sanitizeCloud';
import {
  stationForRecord,
  stationRecordCount,
  type AcquisitionStation,
  type AcquisitionStationSet,
} from '../src/model/AcquisitionStations';

function station(id: string, start: number, end: number): AcquisitionStation {
  return {
    id,
    source: 'ptx-block',
    pose: { worldTranslation: [0, 0, 0], localPositionSource: 'not-applicable' },
    recordRange: { start, end },
    originStatus: 'DECLARED',
  };
}

function stationSet(...stations: AcquisitionStation[]): AcquisitionStationSet {
  return { kind: 'acquisition-stations', stations };
}

describe('remapAcquisitionStations — identity witness', () => {
  it('leaves every range untouched', () => {
    const witness: CompactionWitness = { kind: 'identity', sourceCount: 10 };
    const set = stationSet(station('a', 0, 4), station('b', 4, 10));
    const remapped = remapAcquisitionStations(set, witness);
    expect(remapped?.stations.map((s) => s.recordRange)).toEqual([
      { start: 0, end: 4 },
      { start: 4, end: 10 },
    ]);
  });

  it('returns the same object for an empty station list (no allocation needed)', () => {
    const witness: CompactionWitness = { kind: 'identity', sourceCount: 10 };
    const set = stationSet();
    expect(remapAcquisitionStations(set, witness)).toBe(set);
  });
});

describe('remapAcquisitionStations — compacted witness', () => {
  // 10 source records, two stations [0,4) and [4,10). Records 1 and 7 drop.
  // Survivors: 0,2,3 (station a) and 4,5,6,8,9 (station b).
  const sourceToOutput = new Int32Array([0, RECORD_DROPPED, 1, 2, 3, 4, 5, RECORD_DROPPED, 6, 7]);
  const witness: CompactionWitness = { kind: 'compacted', sourceCount: 10, sourceToOutput };

  it('shrinks each station to its surviving span, shifting later stations', () => {
    const set = stationSet(station('a', 0, 4), station('b', 4, 10));
    const remapped = remapAcquisitionStations(set, witness);
    // a: records 0,2,3 survive -> output [0,3). b starts right after: [3,8).
    expect(remapped?.stations.map((s) => s.recordRange)).toEqual([
      { start: 0, end: 3 },
      { start: 3, end: 8 },
    ]);
  });

  it('gives a station whose records all drop an EMPTY range, not removal', () => {
    // A middle station, [1,2), whose one record (index 1) is the dropped one.
    const set = stationSet(station('a', 0, 1), station('mid', 1, 2), station('b', 2, 10));
    const remapped = remapAcquisitionStations(set, witness);
    expect(remapped?.stations).toHaveLength(3);
    const mid = remapped!.stations[1];
    expect(mid.id).toBe('mid');
    expect(mid.recordRange.start).toBe(mid.recordRange.end);
    // Positioned where its surviving neighbours agree: station 'a' contributed
    // 1 survivor (record 0), so 'mid' sits at output index 1.
    expect(mid.recordRange).toEqual({ start: 1, end: 1 });
  });

  it('preserves pose and every other field, rewriting only recordRange', () => {
    const pose = { worldTranslation: [1, 2, 3] as const, localPositionSource: 'not-applicable' as const };
    const set = stationSet({ ...station('a', 0, 4), pose, source: 'e57-scan' });
    const remapped = remapAcquisitionStations(set, witness);
    const out = remapped!.stations[0];
    expect(out.pose).toBe(pose);
    expect(out.source).toBe('e57-scan');
    expect(out.id).toBe('a');
    expect(out.originStatus).toBe('DECLARED');
  });

  it('drops the whole set when a station claims a boundary the witness cannot cover', () => {
    const set = stationSet(station('a', 0, 4), station('bogus', 4, 999));
    expect(remapAcquisitionStations(set, witness)).toBeNull();
  });

  it('refuses a station with an inverted range', () => {
    const set = stationSet(station('inverted', 5, 2));
    expect(remapAcquisitionStations(set, witness)).toBeNull();
  });
});

describe('stationRecordCount', () => {
  it('is the range width', () => {
    expect(stationRecordCount(station('a', 3, 9))).toBe(6);
    expect(stationRecordCount(station('empty', 5, 5))).toBe(0);
  });
});

describe('stationForRecord', () => {
  it('resolves the owning station by [start, end) containment', () => {
    const set = stationSet(station('a', 0, 4), station('b', 4, 10), station('c', 10, 15));
    expect(stationForRecord(set, 0)!.id).toBe('a');
    expect(stationForRecord(set, 3)!.id).toBe('a');
    expect(stationForRecord(set, 4)!.id).toBe('b');
    expect(stationForRecord(set, 9)!.id).toBe('b');
    expect(stationForRecord(set, 10)!.id).toBe('c');
    expect(stationForRecord(set, 14)!.id).toBe('c');
  });

  it('returns undefined outside every range, including a gap between stations', () => {
    const set = stationSet(station('a', 0, 4), station('gap-after', 6, 10));
    expect(stationForRecord(set, 4)).toBeUndefined();
    expect(stationForRecord(set, 5)).toBeUndefined();
    expect(stationForRecord(set, 10)).toBeUndefined();
    expect(stationForRecord(set, -1)).toBeUndefined();
  });

  it('returns undefined for an empty station set', () => {
    expect(stationForRecord(stationSet(), 0)).toBeUndefined();
  });
});
