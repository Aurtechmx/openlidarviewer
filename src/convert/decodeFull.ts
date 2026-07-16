/**
 * decodeFull.ts — decode a file buffer to a full-resolution PointCloud.
 *
 * The converter must keep every point (unlike the viewer, which downsamples to
 * a render budget), so this passes an unbounded budget and no load plan: every
 * loader decodes in full and the budget voxel-reduce is a no-op.
 *
 * The decode runs in the shared parse worker (reusing `loadFile`'s machinery),
 * not on the calling thread — the loader's synchronous work (the laz-perf
 * decompression loop, the attribute-array expansion) would otherwise freeze the
 * UI for seconds-to-minutes on a large full-res re-decode or batch conversion.
 * An optional `AbortSignal` cancels an in-flight decode.
 */

import { decodeFullViaWorker } from '../io/loadFile';
import type { PointCloud } from '../model/PointCloud';

/** Decode `buffer` (named `name`) into a complete PointCloud. Throws on an
 *  unknown/unsupported format — callers surface that as a per-file error.
 *  Rejects with `LoadCancelledError` if `signal` aborts mid-decode. */
export async function decodeFull(
  buffer: ArrayBuffer,
  name: string,
  signal?: AbortSignal,
): Promise<PointCloud> {
  return decodeFullViaWorker(buffer, name, signal);
}
