/**
 * copcHierarchy.ts
 *
 * Parses a COPC hierarchy page — a run of 32-byte `Entry` records — into
 * octree node records and child-page references.
 *
 * Unlike a batch reader (which throws on the first bad entry), this parser is
 * built for a streaming viewer opening untrusted files: a malformed or
 * truncated entry is **collected as an error and skipped**, never thrown, so a
 * single corrupt entry can never abort a whole load.
 *
 * Pure — no DOM, no three.js, no I/O.
 */

import type {
  VoxelKey,
  Box6,
  OctreeCube,
  StreamingNodeRecord,
  ChildPageRef,
} from './copcTypes';
import { keyId, isValidKey, nodeBounds, nodeSpacing, parentKey } from './voxelKey';

/** Size of one hierarchy `Entry` record, in bytes. */
export const HIERARCHY_ENTRY_SIZE = 32;

/** The result of parsing one hierarchy page. */
export interface HierarchyPage {
  /** Data nodes (`pointCount > 0`) found in this page. */
  nodes: StreamingNodeRecord[];
  /** Child-page references (`pointCount === -1`) found in this page. */
  childPages: ChildPageRef[];
  /** Keys of empty nodes (`pointCount === 0`) — structural, no point data. */
  emptyKeys: VoxelKey[];
  /** Descriptions of malformed entries that were skipped. */
  errors: string[];
}

/** Read a `VoxelKey` from a 32-byte entry at `pos`. */
function readKey(view: DataView, pos: number): VoxelKey {
  return {
    depth: view.getInt32(pos, true),
    x: view.getInt32(pos + 4, true),
    y: view.getInt32(pos + 8, true),
    z: view.getInt32(pos + 12, true),
  };
}

/**
 * Parse a hierarchy page buffer into node records and child-page references.
 *
 * `cube` is the COPC octree cube (for node bounds) and `rootSpacing` the COPC
 * `info` VLR spacing (for per-depth spacing). A buffer whose length is not a
 * multiple of 32 is parsed up to its last whole entry — a clean way to absorb
 * a hierarchy page that a clamped range read returned short.
 */
export function parseHierarchyPage(
  pageBuffer: ArrayBuffer,
  cube: OctreeCube,
  rootSpacing: number,
): HierarchyPage {
  const view = new DataView(pageBuffer);
  const entryCount = Math.floor(pageBuffer.byteLength / HIERARCHY_ENTRY_SIZE);

  const nodes: StreamingNodeRecord[] = [];
  const childPages: ChildPageRef[] = [];
  const emptyKeys: VoxelKey[] = [];
  const errors: string[] = [];

  if (pageBuffer.byteLength % HIERARCHY_ENTRY_SIZE !== 0) {
    errors.push(
      `hierarchy page length ${pageBuffer.byteLength} is not a multiple of 32 — trailing bytes ignored`,
    );
  }

  for (let i = 0; i < entryCount; i++) {
    const pos = i * HIERARCHY_ENTRY_SIZE;
    const key = readKey(view, pos);
    // `offset` is a spec uint64; a real offset is always a small positive
    // integer, so a non-safe value signals a corrupt entry.
    const offset = Number(view.getBigUint64(pos + 16, true));
    const byteSize = view.getInt32(pos + 24, true);
    const pointCount = view.getInt32(pos + 28, true);

    if (!isValidKey(key)) {
      errors.push(`entry ${i}: invalid voxel key (${key.depth},${key.x},${key.y},${key.z})`);
      continue;
    }

    if (pointCount === 0) {
      emptyKeys.push(key);
      continue;
    }

    const offsetOk = Number.isSafeInteger(offset) && offset > 0;

    if (pointCount === -1) {
      // Child hierarchy page reference.
      if (!offsetOk || byteSize <= 0 || byteSize % HIERARCHY_ENTRY_SIZE !== 0) {
        errors.push(`entry ${i} (${keyId(key)}): malformed child-page reference`);
        continue;
      }
      childPages.push({ key, pageOffset: offset, pageSize: byteSize });
      continue;
    }

    if (pointCount < -1) {
      errors.push(`entry ${i} (${keyId(key)}): invalid point count ${pointCount}`);
      continue;
    }

    // A data node (pointCount > 0).
    if (!offsetOk || byteSize <= 0) {
      errors.push(`entry ${i} (${keyId(key)}): malformed data node (offset/size)`);
      continue;
    }
    const bounds: Box6 = nodeBounds(key, cube);
    const parent = parentKey(key);
    nodes.push({
      id: keyId(key),
      key,
      bounds,
      pointCount,
      byteOffset: offset,
      byteSize,
      spacing: nodeSpacing(key.depth, rootSpacing),
      parentId: parent ? keyId(parent) : undefined,
    });
  }

  return { nodes, childPages, emptyKeys, errors };
}
