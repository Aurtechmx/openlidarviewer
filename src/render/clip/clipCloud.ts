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
 */
export function clipCloud(cloud: PointCloud, clip: ClipBox): PointCloud {
  if (!clip.enabled) return cloud;
  const pos = sourcePositions(cloud);
  const n = (pos.length / 3) | 0;
  const kept = countKept(clip, pos);
  if (kept >= n) return cloud;

  // Indices of the points that survive the clip.
  const keep = new Uint32Array(kept);
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (clipKeepsPoint(clip, [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]])) keep[k++] = i;
  }

  // A DERIVED classification cannot travel through the constructor: classes
  // supplied there are a PRODUCER's, so a subset of viewer-derived codes came
  // out claiming the file had classified those points, and a subset of codes
  // known to belong to a replaced frame came out looking current. Clipping is
  // on the export path, so that is provenance invented at the moment of export.
  // Source classes still go through the constructor, because that is what they
  // are.
  const classification = filterChannel(cloud.classification, keep, n);
  const derived = cloud.classificationIsDerived;
  const subset = new PointCloud({
    positions: filterChannel(pos, keep, n) ?? new Float32Array(0),
    colors: filterChannel(cloud.colors, keep, n),
    intensity: filterChannel(cloud.intensity, keep, n),
    classification: derived ? undefined : classification,
    normals: filterChannel(cloud.normals, keep, n),
    returnNumber: filterChannel(cloud.returnNumber, keep, n),
    returnCount: filterChannel(cloud.returnCount, keep, n),
    pointSourceId: filterChannel(cloud.pointSourceId, keep, n),
    gpsTime: filterChannel(cloud.gpsTime, keep, n),
    origin: cloud.origin,
    sourceFormat: cloud.sourceFormat,
    name: cloud.name,
    metadata: cloud.metadata,
  });
  if (derived && classification) {
    subset.attachDerivedClassification(Uint8Array.from(classification));
    // Order matters: attaching marks the codes freshly derived, which is right
    // for a new derive and wrong for a copy. A subset of stale codes is stale.
    if (cloud.derivedClassificationFrameInvalid) {
      subset.markDerivedClassificationFrameInvalid();
    }
  }
  return subset;
}
