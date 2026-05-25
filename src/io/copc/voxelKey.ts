/**
 * voxelKey.ts
 *
 * Octree voxel-key math for COPC: the root key, child/parent navigation,
 * deterministic ids, node bounds, and per-depth spacing.
 *
 * Node bounds are derived from the **COPC `info` VLR octree cube**
 * (`center` ± `halfsize`), which is the normative octree definition — not from
 * the LAS header's tight data bounds, which depend on writer convention.
 *
 * Pure — no DOM, no three.js, no I/O.
 */

import type { VoxelKey, Box6, OctreeCube } from './copcTypes';

/** The octree root key. */
export function rootKey(): VoxelKey {
  return { depth: 0, x: 0, y: 0, z: 0 };
}

/** The deterministic id of a key — the string `"depth-x-y-z"`. */
export function keyId(key: VoxelKey): string {
  return `${key.depth}-${key.x}-${key.y}-${key.z}`;
}

/** Whether a key is structurally valid (non-negative integers). */
export function isValidKey(key: VoxelKey): boolean {
  return (
    Number.isInteger(key.depth) &&
    Number.isInteger(key.x) &&
    Number.isInteger(key.y) &&
    Number.isInteger(key.z) &&
    key.depth >= 0 &&
    key.x >= 0 &&
    key.y >= 0 &&
    key.z >= 0
  );
}

/**
 * The eight child keys of a key. Child index bit 0 is the X half, bit 1 the Y
 * half, bit 2 the Z half — the standard COPC/EPT octree subdivision.
 */
export function childKeys(key: VoxelKey): VoxelKey[] {
  const out: VoxelKey[] = [];
  for (let i = 0; i < 8; i++) {
    out.push({
      depth: key.depth + 1,
      x: key.x * 2 + (i & 1),
      y: key.y * 2 + ((i >> 1) & 1),
      z: key.z * 2 + ((i >> 2) & 1),
    });
  }
  return out;
}

/** The hierarchical parent of a key, or `null` at the root. */
export function parentKey(key: VoxelKey): VoxelKey | null {
  if (key.depth <= 0) return null;
  return {
    depth: key.depth - 1,
    x: Math.floor(key.x / 2),
    y: Math.floor(key.y / 2),
    z: Math.floor(key.z / 2),
  };
}

/**
 * The axis-aligned bounds of a node, derived from the octree cube. A node at
 * depth `d` is a sub-cube of side `2·halfsize / 2^d`, its min corner offset
 * from the cube min corner by `side·(x, y, z)`.
 */
export function nodeBounds(key: VoxelKey, cube: OctreeCube): Box6 {
  const side = (cube.halfsize * 2) / Math.pow(2, key.depth);
  const minX = cube.center[0] - cube.halfsize + side * key.x;
  const minY = cube.center[1] - cube.halfsize + side * key.y;
  const minZ = cube.center[2] - cube.halfsize + side * key.z;
  return [minX, minY, minZ, minX + side, minY + side, minZ + side];
}

/** Point spacing at a given octree depth — root spacing halved per level. */
export function nodeSpacing(depth: number, rootSpacing: number): number {
  return rootSpacing / Math.pow(2, depth);
}
