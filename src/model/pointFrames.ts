/**
 * pointFrames.ts: the four coordinate frames, named at the point of access.
 *
 * A raw `cloud.positions` read is not wrong. It is SILENT. The buffer is the
 * same `Float32Array` whatever frame the reader believes it is in, so a site
 * that means world coordinates and a site that means source-local coordinates
 * are spelled identically, and a mistake between them survives review because
 * there is nothing to review. The coordinate-integrity work removed the
 * destructive rebase (docs/architecture/float64-transform.md); the residual
 * risk it left behind is exactly this, an unlabelled read.
 *
 * The four frames a position can be in:
 *
 *   source-local   The buffer as the loader wrote it. Relative to the cloud's
 *                  own `sourceOrigin`, fixed for the object's life.
 *   project-local  Source-local plus the layer's Float64 `sourceToProject`
 *                  translation. What a combined estimator over several mounted
 *                  layers must use.
 *   render-local   Relative to a render origin chosen for float precision, not
 *                  for meaning. Streaming nodes are decoded in this frame,
 *                  recentred on `StreamingPointCloud.renderOrigin`.
 *   world          Source-local plus `sourceOrigin`, in the file's own CRS.
 *                  `PointCloud.worldXYZ` and `cloudToGlobal` produce it.
 *
 * The accessors here return the buffer UNCHANGED. That is deliberate: a
 * frame label must cost nothing, or hot paths will route around it and the
 * label stops meaning anything. `sourcePositions(cloud) === cloud.positions`
 * is asserted in tests/pointFrames.test.ts, which is what makes replacing a
 * raw read with an accessor a provable no-op rather than a hopeful one.
 *
 * The frames that need arithmetic already have their boundary and are not
 * duplicated here: `PointCloud.worldXYZ` and `PointCloud.projectXYZ` for a
 * single point, `forEachPlacedPoint` / `iteratePlacedPoints` in
 * `src/geo/placementIterator.ts` for a placement-aware walk, and
 * `copyPlacedPositions` in `src/render/measure/lassoVolumeCompute.ts` for a
 * placed copy.
 *
 * `scripts/lint-position-access.mjs` classifies every remaining raw read
 * against `docs/validation/position-frames.json`, so a read that has no
 * accessor still has to say which frame it means.
 *
 * Pure: no DOM, no three.js, safe in a worker.
 */

import type { PointCloud } from './PointCloud';

/**
 * A decoded streaming chunk as a position reader sees it.
 *
 * Structural on purpose. The concrete `DecodedChunk` lives in the COPC decoder
 * (`src/io/copc/copcChunkDecode.ts`) and the streaming layer must not have to
 * import a decoder type to name a frame.
 */
export interface DecodedChunkPositions {
  readonly positions: Float32Array;
}

/**
 * The cloud's positions in its SOURCE-LOCAL frame: the buffer as the loader
 * wrote it, relative to `cloud.sourceOrigin`.
 *
 * Use this wherever the whole buffer is handed to a kernel that works in the
 * cloud's own frame (volumes, density, colour ramps, clipping, health checks).
 * Add `sourceOrigin` for world coordinates, or a layer's `sourceToProject` for
 * project coordinates. Neither is applied here.
 *
 * Returns the SAME array instance, not a copy. Callers must not write to it:
 * `positions` is written exactly once, by the loader
 * (docs/architecture/float64-transform.md, invariant 1).
 */
export function sourcePositions(cloud: PointCloud): Float32Array {
  return cloud.positions;
}

/**
 * A decoded streaming node's positions in its RENDER-LOCAL frame: recentred on
 * the streaming source's `renderOrigin`, which is picked for float precision
 * and has nothing to do with any layer's source origin.
 *
 * This is the frame that most often gets confused with source-local, because
 * both are "small numbers near zero". They are near DIFFERENT zeros. A static
 * cloud and a streaming node cannot be concatenated, differenced or averaged
 * without lifting one of them.
 *
 * Returns the SAME array instance, not a copy.
 */
export function renderLocalPositions(chunk: DecodedChunkPositions): Float32Array {
  return chunk.positions;
}
