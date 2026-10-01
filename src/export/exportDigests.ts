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
import { analysisInputsOf, isStreamedCloud } from '../io/streamedClouds';
import { sourceContentDigestFromRange } from '../io/heavy/fileFingerprint';
import { LocalOocIndexerClient } from '../io/heavy/worker/localOocIndexerWorkerClient';

/** Which source an export describes: a static cloud or a streamed one. */
export interface ExportSourceRef {
  readonly key: object;
  readonly streamed: boolean;
}

export type FileDigest = (file: File, signal?: AbortSignal) => Promise<string | null>;

const fileRange = (file: File) => ({
  readRange: (offset: number, length: number) => file.slice(offset, offset + length).arrayBuffer(),
});

/** Whole-file SHA-256 in a worker; in process only where no Worker exists. */
const workerDigest: FileDigest = async (file, signal) => {
  if (typeof Worker === 'undefined') return sourceContentDigestFromRange(fileRange(file), file.size, signal);
  try {
    return await new LocalOocIndexerClient().digest({ file, fileBytes: file.size, signal });
  } catch {
    return null;
  }
};

const cache = new WeakMap<File, Promise<string | null>>();

/**
 * The source-file digest for `ref`, computed once per File. `signal` cancels a
 * long first hash; a cancelled or failed hash is not cached.
 */
export function sourceDigestOf(
  ref: ExportSourceRef | null | undefined,
  digest: FileDigest = workerDigest,
  signal?: AbortSignal,
): Promise<SourceDigest> {
  if (ref && (ref.streamed || isStreamedCloud(ref.key))) return Promise.resolve({ sha256: null, note: STREAMED_SOURCE_NOTE });
  const file = ref ? cloudFileOf(ref.key) : undefined;
  if (!file) return Promise.resolve({ sha256: null, note: SOURCE_NOT_HELD_NOTE });
  let pending = cache.get(file);
  if (!pending) {
    pending = signal?.aborted ? Promise.resolve(null) : digest(file, signal);
    cache.set(file, pending);
  }
  return pending.then((sha256) => {
    if (sha256) return { sha256, note: null };
    if (cache.get(file) === pending) cache.delete(file);
    return { sha256: null, note: SOURCE_NOT_COMPUTED_NOTE };
  });
}

/** Why a terrain export names no single source file. */
export const MULTIPLE_SOURCES_NOTE = (n: number, streamed: boolean): string =>
  `not recorded: the analysis combined ${n} sources${streamed ? ', one of them streamed' : ''}`;

/**
 * The source digest for a terrain result: the one input file it was sampled
 * from, the streamed note, or no single digest when several inputs were
 * combined. With no recorded inputs (a recovered core) it falls back to
 * `fallback`, the active cloud; with neither, it is not computed.
 */
export function analysisSourceDigest(result: object, fallback: object | null, signal?: AbortSignal): Promise<SourceDigest> {
  const inputs = analysisInputsOf(result);
  if (!inputs) {
    return fallback ? sourceDigestOf({ key: fallback, streamed: false }, undefined, signal) : Promise.resolve({ sha256: null, note: SOURCE_NOT_COMPUTED_NOTE });
  }
  const n = inputs.files.length + (inputs.streamed ? 1 : 0);
  if (n > 1) return Promise.resolve({ sha256: null, note: MULTIPLE_SOURCES_NOTE(n, inputs.streamed) });
  return sourceDigestOf({ key: inputs.files[0] ?? result, streamed: inputs.streamed }, undefined, signal);
}

/** Resolve the record for an export in one call. */
export async function resolveExportDigests(
  ref: ExportSourceRef | null | undefined,
  crs: CrsOriginInput | null | undefined,
  analysisInputSha256?: string | null,
  signal?: AbortSignal,
): Promise<ExportDigests> {
  return exportDigests(await sourceDigestOf(ref, undefined, signal), crs, analysisInputSha256);
}
