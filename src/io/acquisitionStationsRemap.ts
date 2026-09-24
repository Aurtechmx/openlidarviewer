/**
 * acquisitionStationsRemap.ts — carrying station record ranges through
 * sanitation (docs/observatory/SPEC.md §4 OB-INT-02).
 *
 * Sanitation compacts survivors, so any drop shifts every record index after
 * the first casualty — the same shift `organizedRangeRemap.ts` carries the
 * acquisition grid through. This is the station-sidecar counterpart: a
 * `[start, end)` range per station, rather than a per-cell index, so the
 * remap is a boundary lookup instead of an element-by-element rewrite.
 */

import { RECORD_DROPPED, type CompactionWitness } from './sanitizeCloud';
import type { AcquisitionStationSet } from '../model/AcquisitionStations';

/**
 * Number of surviving records in `[0, i)`, for every `i` in `[0, sourceCount]`.
 *
 * Built once per remap, in one linear pass, so every station's boundary is
 * then an O(1) lookup rather than a repeated scan of its own range. This
 * relies on the same fact `sanitizeCloud.ts` documents for `sourceToOutput`:
 * a surviving record's output index already equals the number of survivors
 * strictly before it, because compaction's running write index only ever
 * increments on a survivor. `identity` is the cheap case sanitation returns
 * when nothing was dropped: every prefix count equals its own index.
 */
function survivorPrefixCounts(witness: CompactionWitness): Uint32Array {
  const n = witness.sourceCount;
  const prefix = new Uint32Array(n + 1);
  if (witness.kind === 'identity') {
    for (let i = 0; i <= n; i++) prefix[i] = i;
    return prefix;
  }
  const { sourceToOutput } = witness;
  let count = 0;
  for (let i = 0; i < n; i++) {
    prefix[i] = count;
    if (sourceToOutput[i] !== RECORD_DROPPED) count++;
  }
  prefix[n] = count;
  return prefix;
}

/**
 * Rewrite every station's `recordRange` from pre-sanitation indices to the
 * indices the display cloud actually holds.
 *
 * Returns `null` when the witness cannot answer for a boundary a station
 * claims (its own bookkeeping disagreeing with the witness's `sourceCount`),
 * which the caller turns into an explicit drop — the same degrade
 * `organizedRangeRemap.ts`'s `remapFrames` uses for the grid sidecar: a set
 * where one station's range is answerable and another's is not would read as
 * uniformly trustworthy, so one unanswerable station drops the whole set
 * rather than reporting a mix of trusted and guessed ranges.
 *
 * A station whose records all drop maps to an EMPTY range at the position its
 * surviving neighbours agree on (`start === end`), never removed from the
 * list: the station still existed and contributed nothing, which is a fact
 * about the scan, not a reason to erase the station.
 */
export function remapAcquisitionStations(
  set: AcquisitionStationSet,
  witness: CompactionWitness,
): AcquisitionStationSet | null {
  if (set.stations.length === 0) return set;
  const n = witness.sourceCount;
  for (const station of set.stations) {
    const { start, end } = station.recordRange;
    if (start < 0 || end < start || end > n) return null;
  }
  const prefix = survivorPrefixCounts(witness);
  return {
    kind: 'acquisition-stations',
    stations: set.stations.map((station) => ({
      ...station,
      recordRange: { start: prefix[station.recordRange.start], end: prefix[station.recordRange.end] },
    })),
  };
}
