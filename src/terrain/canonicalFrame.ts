/**
 * canonicalFrame.ts — one vertical axis for the whole terrain pipeline.
 *
 * Terrain analysis reads a position buffer as "X/Y horizontal, Z elevation",
 * and nine modules under `src/terrain` do that index arithmetic directly. That
 * is correct for the survey formats and the COPC/EPT streams built on them, and
 * wrong for the phone-scan mesh formats, whose native frame is Y-up: a Y-up
 * height field was analysed with a horizontal axis standing in for elevation,
 * which corrupts the DTM, slope, aspect, hillshade, contours, density and every
 * confidence figure derived from them. A Y-up mesh reaches that path easily —
 * drone photogrammetry exported as OBJ or glTF classifies as terrain.
 *
 * The fix is a rotation at the boundary rather than an axis parameter threaded
 * through every consumer. Normalising once means the analysis, the core cache
 * fingerprints and all three exporters stay correct with no changes of their
 * own, and it cannot be half-applied — an axis contract that reaches eight of
 * nine call sites is harder to reason about than none.
 *
 * Pure — no DOM, no three.js — so the equivalence that matters (a Y-up surface
 * yields the same grid as the same surface authored Z-up) is checked in Node.
 */

/**
 * Rotate a Y-up buffer into the canonical Z-up survey frame, in place.
 *
 * Y-up here is the glTF/OBJ convention: +X right, +Y up, +Z toward the viewer.
 * The survey frame is +X east, +Y north, +Z up, so north is the Y-up frame's
 * −Z and the mapping is `(x, y, z) → (x, −z, y)`.
 *
 * That is a ROTATION (determinant +1), not an axis swap. `(x, z, y)` would be
 * one character shorter and a reflection, which mirrors the surface: elevations
 * would be right and every aspect and azimuth would be handed backwards — the
 * kind of wrong that survives inspection because the terrain still looks like
 * terrain.
 *
 * Mutates `positions` because the caller owns a freshly strided copy; rewriting
 * a multi-million-point buffer into a second allocation is not worth it.
 */
export function yUpToCanonicalZUp(positions: Float32Array): Float32Array {
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const y = positions[i + 1];
    const z = positions[i + 2];
    positions[i + 1] = -z;
    positions[i + 2] = y;
  }
  return positions;
}

/**
 * The same rotation for a single world-space triple.
 *
 * The recentre origin has to move with the points: terrain reads its second
 * component as the northing that drives the geographic cos φ scale, and the
 * exporters add it back to place the grid. An origin left in the source frame
 * would georeference a correctly-rotated surface to the wrong place — silently,
 * because both halves look reasonable on their own.
 */
export function yUpOriginToCanonicalZUp(
  origin: readonly [number, number, number],
): [number, number, number] {
  return [origin[0], -origin[2], origin[1]];
}
