/**
 * sunNormalsWorkerClient.ts: the main-thread side of sunNormalsWorker.ts.
 *
 * One worker per job, ended with the job, so an abort, a failure or a closed
 * layer leaves nothing running and frees the grid. Points go over in chunks,
 * each answered before the next is copied; the caller's buffer is only read.
 * There is no main-thread fallback: a browser without the worker is told so.
 */

import { estimateCellSize, type SurfaceFrame } from './surfaceNormals';
import type { SunNormalsReply, SunNormalsRequest } from './sunNormalsWorker';

/** Points per message: 12 MB out, 2 MB back. */
export const CHUNK_POINTS = 1_000_000;
/** Points the spacing estimate looks at. */
const SAMPLE_POINTS = 200_000;
/** Silence after which the worker counts as hung; the fit is the longest step. */
export const REPLY_DEADLINE_MS = 120_000;

/** Thrown when a cloud has no extent to take a direction from. */
export class NoSurfaceError extends Error {}

function abortError(): DOMException {
  return new DOMException('Sun shading stopped', 'AbortError');
}

/** Finite minimum per axis, read in slices so a large cloud never blocks. */
async function finiteMin(positions: Float32Array, signal: AbortSignal): Promise<[number, number, number]> {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  for (let start = 0; start < positions.length; start += CHUNK_POINTS * 3) {
    const end = Math.min(positions.length - 2, start + CHUNK_POINTS * 3);
    for (let j = start; j < end; j += 3) {
      for (let a = 0; a < 3; a++) {
        const v = positions[j + a];
        if (v < min[a] && v > -Infinity) min[a] = v;
      }
    }
    if (end < positions.length - 2) await new Promise((r) => setTimeout(r, 0));
    if (signal.aborted) throw abortError();
  }
  return min;
}

/** An evenly strided copy of at most {@link SAMPLE_POINTS} points. */
function strided(positions: Float32Array): Float32Array {
  const n = Math.floor(positions.length / 3);
  const step = Math.max(1, Math.floor(n / SAMPLE_POINTS));
  const m = Math.floor(n / step);
  const out = new Float32Array(m * 3);
  for (let i = 0; i < m; i++) {
    const j = i * step * 3;
    out[i * 3] = positions[j];
    out[i * 3 + 1] = positions[j + 1];
    out[i * 3 + 2] = positions[j + 2];
  }
  return out;
}

/**
 * The 16-bit direction code of every point. Rejects with an AbortError when
 * `signal` aborts and with NoSurfaceError for a cloud of fewer than three
 * distinct points. `onProgress` gets a share from 0 to 1.
 */
export async function computeSunNormals(
  positions: Float32Array,
  frame: SurfaceFrame,
  signal: AbortSignal,
  onProgress?: (share: number) => void,
): Promise<Uint16Array> {
  if (signal.aborted) throw abortError();
  const n = Math.floor(positions.length / 3);
  const cellSize = estimateCellSize(strided(positions), n, frame);
  if (cellSize === null) throw new NoSurfaceError('no extent');
  const min = await finiteMin(positions, signal);

  const worker = new Worker(new URL('./sunNormalsWorker.ts', import.meta.url), { type: 'module' });
  let nextId = 0;
  let settle: { resolve: (r: ArrayBuffer | undefined) => void; reject: (e: Error) => void } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (fn: (s: NonNullable<typeof settle>) => void): void => {
    const s = settle;
    settle = null;
    if (timer !== undefined) clearTimeout(timer);
    if (s) fn(s);
  };
  const fail = (message: string): void => finish((s) => s.reject(new Error(message)));
  worker.onmessage = (event: MessageEvent<SunNormalsReply>): void => {
    const reply = event.data;
    if (reply.id !== nextId) return;
    finish((s) => (reply.ok ? s.resolve(reply.codes) : s.reject(new Error(reply.error))));
  };
  worker.onerror = (): void => fail('The sun shading worker failed.');
  worker.onmessageerror = (): void => fail('The sun shading worker failed.');
  const onAbort = (): void => finish((s) => s.reject(abortError()));
  signal.addEventListener('abort', onAbort, { once: true });

  const send = (msg: SunNormalsRequest): Promise<ArrayBuffer | undefined> =>
    new Promise((resolve, reject) => {
      if (signal.aborted) { reject(abortError()); return; }
      settle = { resolve, reject };
      timer = setTimeout(() => fail('The sun shading worker did not answer.'), REPLY_DEADLINE_MS);
      const id = ++nextId;
      try {
        worker.postMessage({ ...msg, id }, 'xyz' in msg ? [msg.xyz] : []);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    });
  const chunk = (start: number): ArrayBuffer =>
    positions.slice(start * 3, Math.min(n, start + CHUNK_POINTS) * 3).buffer as ArrayBuffer;

  try {
    await send({ kind: 'begin', params: { frame, min, cellSize } });
    for (let i = 0; i < n; i += CHUNK_POINTS) {
      await send({ kind: 'add', xyz: chunk(i) });
      onProgress?.(0.3 * Math.min(1, (i + CHUNK_POINTS) / n));
    }
    await send({ kind: 'fit' });
    onProgress?.(0.6);
    const codes = new Uint16Array(n);
    for (let i = 0; i < n; i += CHUNK_POINTS) {
      const part = await send({ kind: 'encode', xyz: chunk(i) });
      if (!part) throw new Error('The sun shading worker sent no result.');
      codes.set(new Uint16Array(part), i);
      onProgress?.(0.6 + 0.4 * Math.min(1, (i + CHUNK_POINTS) / n));
    }
    return codes;
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (timer !== undefined) clearTimeout(timer);
    worker.terminate();
  }
}
