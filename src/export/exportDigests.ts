/**
 * exportDigests.ts: resolves the source-file SHA-256 for an export: hashed in
 * a worker on first request and cached per File, so a large scan never stalls
 * the page. A streamed scan, or a cloud whose File is not held, resolves to a
 * null digest with the reason (`exportDigestRecord.ts`).
 *
 * Lazy: only export paths load it.
 */
import type { CrsOriginInput } from '../science/crsOrigin';
import {
  exportDigests,
  SOURCE_NOT_COMPUTED_NOTE,
  SOURCE_NOT_HELD_NOTE,
  STREAMED_SOURCE_NOTE,
  type ExportDigests,
  type SourceDigest,
} from '../science/exportDigestRecord';
import { cloudFileOf } from '../io/sourceFiles';
import { isStreamedCloud } from '../io/streamedClouds';
import { sourceContentDigestFromRange } from '../io/heavy/fileFingerprint';
import { LocalOocIndexerClient } from '../io/heavy/worker/localOocIndexerWorkerClient';

/** Which source an export describes: a static cloud or a streamed one. */
export interface ExportSourceRef {
  readonly key: object;
  readonly streamed: boolean;
}

export type FileDigest = (file: File) => Promise<string | null>;

const fileRange = (file: File) => ({
  readRange: (offset: number, length: number) => file.slice(offset, offset + length).arrayBuffer(),
});

/** Whole-file SHA-256 in a worker; in process only where no Worker exists. */
const workerDigest: FileDigest = async (file) => {
  if (typeof Worker === 'undefined') return sourceContentDigestFromRange(fileRange(file), file.size);
  try {
    return await new LocalOocIndexerClient().digest({ file, fileBytes: file.size });
  } catch {
    return null;
  }
};

const cache = new WeakMap<File, Promise<string | null>>();

/** The source-file digest for `ref`, computed once per File. */
export function sourceDigestOf(ref: ExportSourceRef | null | undefined, digest: FileDigest = workerDigest): Promise<SourceDigest> {
  if (ref && (ref.streamed || isStreamedCloud(ref.key))) return Promise.resolve({ sha256: null, note: STREAMED_SOURCE_NOTE });
  const file = ref ? cloudFileOf(ref.key) : undefined;
  if (!file) return Promise.resolve({ sha256: null, note: SOURCE_NOT_HELD_NOTE });
  let pending = cache.get(file);
  if (!pending) {
    pending = digest(file);
    cache.set(file, pending);
  }
  return pending.then((sha256) => (sha256 ? { sha256, note: null } : { sha256: null, note: SOURCE_NOT_COMPUTED_NOTE }));
}

/** Resolve the record for an export in one call. */
export async function resolveExportDigests(
  ref: ExportSourceRef | null | undefined,
  crs: CrsOriginInput | null | undefined,
  analysisInputSha256?: string | null,
): Promise<ExportDigests> {
  return exportDigests(await sourceDigestOf(ref), crs, analysisInputSha256);
}
