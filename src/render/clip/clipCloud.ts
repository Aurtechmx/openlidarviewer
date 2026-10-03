/**
 * clipCloud.ts
 *
 * Produce a new {@link PointCloud} containing only the points an active clip box
 * keeps — so an export or analysis run over the clipped scan writes just the
 * isolated region, not the whole cloud. Every per-point channel (colour,
 * intensity, classification, returns, GPS time, …) is filtered in lockstep with
 * the positions, so the subset stays internally consistent.
 *
 * Pure data: no DOM, no three.js, no GPU — it's the CPU realisation of the same
 * {@link clipKeepsPoint} contract the GPU clip shader draws. A disabled clip, or
 * a clip that keeps every point, returns the original cloud unchanged (no copy).
 */

import { PointCloud } from '../../model/PointCloud';
import { sourcePositions } from '../../model/pointFrames';
import { type ClipBox, clipKeepsPoint, countKept } from './clipBox';

type TypedArray = Uint8Array | Uint16Array | Uint32Array | Float32Array | Float64Array;

/** Copy `stride` elements per kept index into a fresh array of the same type. */
function filterChannel<T extends TypedArray>(
  arr: T | undefined,
  keep: Uint32Array,
  pointCount: number,
): T | undefined {
  if (!arr || pointCount <= 0) return undefined;
  const stride = (arr.length / pointCount) | 0;
  if (stride < 1) return undefined;
  const Ctor = arr.constructor as new (length: number) => T;
  const out = new Ctor(keep.length * stride);
  for (let j = 0; j < keep.length; j++) {
    const src = keep[j] * stride;
    const dst = j * stride;
    for (let s = 0; s < stride; s++) out[dst + s] = arr[src + s];
  }
  return out;
}

/**
 * The cloud restricted to the points the clip keeps. Returns the input
 * unchanged when the clip is disabled or keeps everything.
 *
 * The clip box is in the project frame, the one the viewer draws and counts
 * in. `offset` is the layer's source-local to project-local translation; each
 * point is placed by it (rounded to Float32, as the viewer's placed buffer is)
 * before the test, so the subset is exactly the set shown inside the box. The
 * subset's positions stay source-local.
 */
export function clipCloud(
  cloud: PointCloud,
  clip: ClipBox,
  offset?: readonly [number, number, number] | null,
): PointCloud {
  if (!clip.enabled) return cloud;
  const pos = sourcePositions(cloud);
  const n = (pos.length / 3) | 0;
  const [dx, dy, dz] = offset ?? [0, 0, 0];
  const placed = dx !== 0 || dy !== 0 || dz !== 0;
  const keeps = (i: number): boolean => clipKeepsPoint(clip, placed
    ? [Math.fround(pos[i * 3] + dx), Math.fround(pos[i * 3 + 1] + dy), Math.fround(pos[i * 3 + 2] + dz)]
    : [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
  let kept = 0;
  if (placed) { for (let i = 0; i < n; i++) if (keeps(i)) kept++; } else kept = countKept(clip, pos);
  if (kept >= n) return cloud;

  // Indices of the points that survive the clip.
  const keep = new Uint32Array(kept);
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (keeps(i)) keep[k++] = i;
  }

  // Classes supplied to the constructor read as the PRODUCER's, so the subset
  // takes the cloud's provenance right after construction: a subset of
  // viewer-derived or viewer-cleared codes otherwise came out claiming the
  // file had classified those points, and a subset of codes known to belong
  // to a replaced frame came out looking current. Clipping is on the export
  // path, so that is provenance invented at the moment of export.
  const classification = filterChannel(cloud.classification, keep, n);
  const prov = cloud.classificationProvenance;
  const subset = new PointCloud({
    positions: filterChannel(pos, keep, n) ?? new Float32Array(0),
    colors: filterChannel(cloud.colors, keep, n),
    intensity: filterChannel(cloud.intensity, keep, n),
    classification,
    // Flags are the producer's, never the viewer's, so they travel whatever
    // the codes' provenance. Dropping them here made a withheld point
    // indistinguishable from an ordinary one after a clip.
    classificationFlags: filterChannel(cloud.classificationFlags, keep, n),
    normals: filterChannel(cloud.normals, keep, n),
    returnNumber: filterChannel(cloud.returnNumber, keep, n),
    returnCount: filterChannel(cloud.returnCount, keep, n),
    pointSourceId: filterChannel(cloud.pointSourceId, keep, n),
    gpsTime: filterChannel(cloud.gpsTime, keep, n),
    origin: cloud.origin,
    sourceFormat: cloud.sourceFormat,
    name: cloud.name,
    metadata: cloud.metadata,
    // `organizedRange` and `acquisitionStations` (OB-INT-02) are both left
    // unset here, deliberately: `keep` reindexes and can drop points from the
    // middle of any station's range, so neither a cell-to-record identity nor
    // a station's `[start, end)` describes the subset. Recomputing either
    // from `keep` is possible in principle but not attempted here — this is
    // the export/analysis subsetting path, not a loader, and nothing reads
    // either sidecar off a clipped cloud today.
  });
  if (prov === 'cleared' || prov === 'derived') {
    // No `before` codes, so the subset keeps no second original: Restore is
    // for the live cloud, not an export copy.
    subset.setClassificationState(prov, cloud.derivedMethod);
    // Order matters: the state starts current, which is right for a new derive
    // and wrong for a copy. A subset of stale codes is stale.
    if (cloud.derivedClassificationFrameInvalid) {
      subset.markDerivedClassificationFrameInvalid();
    }
  }
  return subset;
}
