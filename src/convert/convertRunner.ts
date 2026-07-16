/**
 * convertRunner.ts — drive a batch of files through the converter.
 *
 * Decoding is injected (`DecodeFn`) so this stays testable without the real
 * loaders and so the UI can route decoding through a worker later. Each file
 * is isolated: a decode or conversion failure produces a failed report and the
 * batch continues. Output filenames are de-duplicated so a "download all"
 * archive never silently overwrites a same-named result.
 *
 * Pure orchestration — no DOM. Yields between files (await) so a UI can paint
 * progress.
 */

import type { PointCloud } from '../model/PointCloud';
import { convertCloud } from './convertCloud';
import type { ConvertOptions, ConvertedFile, ConvertReport } from './types';

/**
 * One file to convert: a name, its size (for display without a read), and a
 * LAZY byte provider. The provider is awaited one file at a time inside
 * {@link runBatch} so the batch never holds every file's ArrayBuffer in memory
 * at once — selecting ten 2 GB files no longer materialises 20 GB up front.
 */
export interface BatchInput {
  readonly name: string;
  /** Source size in bytes — shown in the list without reading the file. */
  readonly sizeBytes: number;
  /** Read the file's bytes. Called once, only when this file's turn comes. */
  readonly bytes: () => Promise<ArrayBuffer>;
}

/** Decode a file's bytes into a full-resolution PointCloud. An optional signal
 *  cancels a decode routed through a worker (see {@link runBatch}). */
export type DecodeFn = (
  buffer: ArrayBuffer,
  name: string,
  signal?: AbortSignal,
) => Promise<PointCloud>;

/** Result for one input. */
export interface BatchItemResult {
  readonly source: string;
  readonly report: ConvertReport;
  readonly file: ConvertedFile | null;
  /** A `.prj` CRS sidecar for ASCII outputs, when the source carried WKT. */
  readonly sidecar?: ConvertedFile;
}

/** Progress phases reported per file. */
export type BatchPhase = 'decoding' | 'converting' | 'done' | 'error';

export interface BatchProgress {
  readonly index: number;
  readonly total: number;
  readonly source: string;
  readonly phase: BatchPhase;
}

/** Append " (n)" before the extension to make `name` unique within `seen`. */
export function dedupeName(name: string, seen: Set<string>): string {
  if (!seen.has(name)) {
    seen.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let i = 2;
  let candidate = `${stem} (${i})${ext}`;
  while (seen.has(candidate)) {
    i++;
    candidate = `${stem} (${i})${ext}`;
  }
  seen.add(candidate);
  return candidate;
}

/**
 * Convert every input. Resolves with one result per input (in order). Never
 * rejects — failures are captured in each item's report.
 *
 * `signal` cancels the batch: it's forwarded to each decode (a worker-routed
 * decode aborts mid-flight) and checked before every file, so an aborted batch
 * stops before starting the next one rather than only between files.
 */
export async function runBatch(
  inputs: ReadonlyArray<BatchInput>,
  options: ConvertOptions,
  decode: DecodeFn,
  onProgress?: (p: BatchProgress) => void,
  signal?: AbortSignal,
): Promise<BatchItemResult[]> {
  const results: BatchItemResult[] = [];
  const seen = new Set<string>();
  const total = inputs.length;

  for (let index = 0; index < total; index++) {
    // Stop the batch before touching the next file once cancelled — the decode
    // in flight is aborted through the same signal below.
    if (signal?.aborted) break;
    const input = inputs[index];
    const emit = (phase: BatchPhase): void =>
      onProgress?.({ index, total, source: input.name, phase });

    try {
      emit('decoding');
      // Read this file's bytes only now, and let `buffer` fall out of scope at
      // the end of the iteration so it's collected before the next file is read.
      const buffer = await input.bytes();
      const cloud = await decode(buffer, input.name, signal);
      emit('converting');
      const { file, report } = convertCloud(cloud, options);
      const finalFile = file
        ? { ...file, filename: dedupeName(file.filename, seen) }
        : null;
      // ASCII outputs (XYZ/ASC) carry no CRS slot, so a kept georeferenced
      // file gets a `.prj` sidecar with the source WKT — the GIS-standard way
      // to keep the projection alongside a text point list.
      let sidecar: ConvertedFile | undefined;
      const isAscii = options.format === 'xyz' || options.format === 'asc';
      const wkt = cloud.metadata?.crs?.wkt;
      if (finalFile && isAscii && (options.crsMode ?? 'keep') === 'keep' && wkt) {
        const prjName = dedupeName(finalFile.filename.replace(/\.[^.]+$/, '.prj'), seen);
        sidecar = { filename: prjName, mime: 'text/plain', bytes: new TextEncoder().encode(wkt) };
      }
      results.push({ source: input.name, report, file: finalFile, sidecar });
      emit(file ? 'done' : 'error');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      results.push({
        source: input.name,
        file: null,
        report: {
          source: input.name,
          ok: false,
          pointCount: 0,
          crsNote: '—',
          log: [{ level: 'error', message: `Could not read ${input.name}: ${detail}` }],
        },
      });
      emit('error');
    }
  }

  return results;
}

/** Summarise a batch for a headline report line. */
export function summariseBatch(results: ReadonlyArray<BatchItemResult>): {
  ok: number;
  failed: number;
  points: number;
} {
  let ok = 0;
  let failed = 0;
  let points = 0;
  for (const r of results) {
    if (r.report.ok) {
      ok++;
      points += r.report.pointCount;
    } else {
      failed++;
    }
  }
  return { ok, failed, points };
}
