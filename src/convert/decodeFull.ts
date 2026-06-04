/**
 * decodeFull.ts — decode a file buffer to a full-resolution PointCloud.
 *
 * The converter must keep every point (unlike the viewer, which downsamples to
 * a render budget), so this passes an unbounded budget and no load plan: every
 * loader decodes in full and the budget voxel-reduce is a no-op.
 */

import { sniffFormat } from '../io/sniffFormat';
import { parseBuffer } from '../io/parseBuffer';
import type { PointCloud } from '../model/PointCloud';

/** Decode `buffer` (named `name`) into a complete PointCloud. Throws on an
 *  unknown/unsupported format — callers surface that as a per-file error. */
export async function decodeFull(buffer: ArrayBuffer, name: string): Promise<PointCloud> {
  const format = sniffFormat(buffer, name);
  const { cloud } = await parseBuffer(buffer, format, name, Number.MAX_SAFE_INTEGER);
  return cloud;
}
