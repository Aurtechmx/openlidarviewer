/**
 * AcquisitionStations.ts — the scanner-setup sidecar behind a display cloud
 * (docs/observatory/SPEC.md §4 OB-INT-02).
 *
 * A multi-scan E57 or multi-block PTX file registers several scanner setups
 * into one merged cloud, and the merge is exactly what a display cloud needs
 * — one continuous stream of points with no station boundary in it. That is
 * also what throws the boundary away: today nothing survives to say "records
 * 0..4999 came from station 1, at this declared pose". Observatory needs that
 * back, per SPEC §1 OB-INT-02 and §5.1 OB-RAY-02 (a posed source's rays are
 * built per station, in the station's own frame).
 *
 * This is a SIDECAR, in the same sense `OrganizedRange.ts` is one: it names
 * which already-loaded records belong to which station, and how that station
 * was posed. It never holds a second copy of the coordinates.
 *
 * Deliberately NOT a member of `CloudMetadata`, unlike `scannerOrigin`, and
 * this is a considered departure from SPEC §4 OB-INT-02's literal "a sidecar
 * on CloudMetadata" wording, not an oversight. `CloudMetadata` is forwarded
 * WHOLESALE by paths that reindex or discard points — `voxelDownsample.ts`'s
 * `emitVoxelCloud` passes `metadata: cloud.metadata` straight through to a
 * cloud of centroids — and `PointCloud.ts`'s own comment on `organizedRange`
 * names exactly this trap: a sidecar carrying a record RANGE, living inside a
 * wholesale-forwarded bag, arrives at a reindexed cloud still claiming its
 * old range, with nothing to notice. `scannerOrigin` is safe inside
 * `CloudMetadata` because it names a single position, not a range into the
 * point arrays; a station range is exactly the shape organizedRange's own
 * field comment warns about. So this sidecar follows the PATTERN
 * OB-INT-02 asks for — "a sidecar, never a second cloud" — by taking the same
 * dedicated-field shape `organizedRange` already uses, rather than the literal
 * nesting location, and every reindexing path (voxel downsample, clip) is
 * required to name it explicitly, carried or dropped, precisely because nothing
 * forwards it by accident.
 *
 * Pure and DOM-free by design (OB-INT-01): no DOM, `three` or `ui/` imports.
 * The compaction remap (which needs `CompactionWitness`, an `src/io/` concept)
 * lives beside it in `src/io/acquisitionStationsRemap.ts`, not here — the same
 * split `OrganizedRange.ts` (types) and `organizedRangeRemap.ts` (remap) use,
 * so this module never depends on the loader layer.
 */

import type { AcquisitionPose } from './OrganizedRange';

/** Where a station's declared pose and record range came from. */
export type AcquisitionStationSource = 'e57-scan' | 'ptx-block' | 'pcd-viewpoint';

/**
 * One scanner setup behind some of a cloud's records.
 *
 * `recordRange` is `[start, end)` into the FINAL `PointCloud`'s arrays, i.e.
 * after sanitation's order-preserving compaction — never into the file's own
 * record numbering, which a loader's stride or invalid-record filtering may
 * already have shrunk before this range is even computed. O0 (§2.1) confirmed
 * both PTX and E57 append surviving records in strict ascending station order,
 * so `[start, end)` costs nothing per point: one pair of integers per station,
 * not a per-record index.
 *
 * `originStatus` is always `'DECLARED'` in v0.7: every station here was read
 * from a file's own pose declaration, never inferred or user-placed
 * (OB-INV-04). A user-placed ("ASSUMED") origin is Observatory's own concept
 * (`ObservationOriginStatus`, `src/observation/types.ts`) and does not reach
 * this loader-level sidecar.
 */
export interface AcquisitionStation {
  /** Stable within one cloud; not guaranteed stable across a reload. */
  readonly id: string;
  readonly source: AcquisitionStationSource;
  /** As the file declares it — Float64, never inferred (OB-INV-04). */
  readonly pose: AcquisitionPose;
  /** `[start, end)` into the cloud's arrays, AFTER sanitation. May be empty. */
  readonly recordRange: { readonly start: number; readonly end: number };
  readonly originStatus: 'DECLARED';
}

/** The station sidecar on a `PointCloud` (`PointCloudOptions.acquisitionStations`). */
export interface AcquisitionStationSet {
  readonly kind: 'acquisition-stations';
  readonly stations: readonly AcquisitionStation[];
}

/** Number of points in a station's current range. Never negative by construction. */
export function stationRecordCount(station: AcquisitionStation): number {
  return station.recordRange.end - station.recordRange.start;
}

/**
 * The station whose `[start, end)` range contains `record`, or `undefined`.
 *
 * Joins by record-range containment, never by matching a frame's own scan
 * identifier against a station id: the grid builder's per-scan frame counter
 * (records only the scans that earned a grid) and this sidecar's per-scan
 * counter (records every merged scan) are two different counts, so a
 * `scan-N` id on one side is not the same `N` on the other side once any scan
 * fails structured eligibility. A linear scan is simplest and matches this
 * file's own style; station counts are small.
 */
export function stationForRecord(
  stations: AcquisitionStationSet,
  record: number,
): AcquisitionStation | undefined {
  for (const station of stations.stations) {
    if (record >= station.recordRange.start && record < station.recordRange.end) return station;
  }
  return undefined;
}
