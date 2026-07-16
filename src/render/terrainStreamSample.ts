/**
 * Reproducible terrain subsample for the streaming (COPC) path.
 *
 * Streaming nodes decode in network / worker order, so the Map that holds them
 * is in arrival order — nondeterministic. Applying one global stride counter
 * across that order made which points survived the ≤300k subsample depend on
 * timing, so re-loading the same cloud and re-running Analyse Terrain produced
 * different exported RMSEz / contour geometry each run.
 *
 * The fix is here: streaming buffers carry a stable octree node key and are
 * sorted by it before the stride walk, so the same resident set always yields
 * the same sampled points. Static clouds already iterate in a stable Map order,
 * so they keep their given order and lead the walk.
 */

/** A cloud/node buffer contributing to the terrain subsample. */
export interface TerrainStreamBuffer {
  /** Local-space positions, length `3 · pointCount`. */
  pos: Float32Array;
  /** Optional index-aligned classification channel. */
  cls?: ArrayLike<number>;
}

/** A streaming-node buffer with the stable octree key it is sorted by. */
export interface KeyedTerrainStreamBuffer extends TerrainStreamBuffer {
  /** Deterministic octree node id (`"depth-x-y-z"`). */
  key: string;
}

/** The strided subsample: positions, optional class channel, and a sampled flag. */
export interface StridedTerrainSample {
  positions: Float32Array;
  classification?: Uint8Array;
  /** True when a stride > 1 was applied (a representative subsample, not all points). */
  sampled: boolean;
}

/**
 * Build the strided terrain subsample from the resident buffers, invariant to
 * streaming arrival order.
 *
 * `totalPoints` is the point count across every buffer (static + streaming);
 * the stride is derived from it so a multi-million-point cloud is never copied
 * whole. Non-finite points are skipped but still advance the stride counter, so
 * the stride stays consistent across buffer boundaries. Returns `null` when no
 * finite point survives.
 */
export function sampleStridedTerrain(
  staticBuffers: ReadonlyArray<TerrainStreamBuffer>,
  streamingBuffers: ReadonlyArray<KeyedTerrainStreamBuffer>,
  totalPoints: number,
  maxPoints: number,
  anyClass: boolean,
): StridedTerrainSample | null {
  // Static clouds keep their stable order; streaming nodes are ordered by their
  // octree key so arrival timing can't reshuffle the walk.
  const sortedStreaming = [...streamingBuffers].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
  const buffers: TerrainStreamBuffer[] = [...staticBuffers, ...sortedStreaming];

  const stride = Math.max(1, Math.ceil(totalPoints / maxPoints));
  const cap = Math.ceil(totalPoints / stride);
  const positions = new Float32Array(cap * 3);
  // 255 = "no class channel" sentinel; terrain treats it as "keep".
  const classification = anyClass ? new Uint8Array(cap).fill(255) : undefined;
  let gi = 0;
  let oi = 0;
  for (const { pos, cls } of buffers) {
    const pts = (pos.length / 3) | 0;
    for (let i = 0; i < pts; i++, gi++) {
      if (gi % stride !== 0 || oi >= cap) continue;
      const s = i * 3;
      const x = pos[s];
      const y = pos[s + 1];
      const z = pos[s + 2];
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
        positions[oi * 3] = x;
        positions[oi * 3 + 1] = y;
        positions[oi * 3 + 2] = z;
        if (classification && cls) classification[oi] = cls[i];
        oi++;
      }
    }
  }
  if (oi === 0) return null;
  return {
    positions: oi * 3 === positions.length ? positions : positions.subarray(0, oi * 3),
    classification: classification
      ? oi === cap
        ? classification
        : classification.subarray(0, oi)
      : undefined,
    sampled: stride > 1,
  };
}
