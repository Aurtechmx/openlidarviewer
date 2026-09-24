/**
 * gridMask.ts — build a 1-bit mask from a cell-index array, shared by
 * `FlowResultGrid.setPathMask`/`setCatchmentMask` and
 * `TerrainAccessResultGrid.setRouteMask`. Byte-identical logic, previously
 * duplicated verbatim (Sonar-flagged) between `flowResultGrid.ts` and
 * `terrainAccessResultGrid.ts`, which each re-export it under their own
 * name so existing import sites are unaffected.
 */
export function maskFromIndices(n: number, indices: ArrayLike<number>): Uint8Array {
  const mask = new Uint8Array(n);
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    if (i >= 0 && i < n) mask[i] = 1;
  }
  return mask;
}
