/**
 * sunNormalsWorker.ts: runs the surface-direction passes (surfaceNormals.ts)
 * off the main thread, one chunk of points per message. The whole cloud is
 * never held here twice: a chunk is dropped once it is answered.
 *
 *   in  { id, kind: 'begin', params } | { id, kind: 'add' | 'encode', xyz } | { id, kind: 'fit' }
 *   out { id, ok: true, codes? } | { id, ok: false, error }
 */

import { SurfaceNormals, type SurfaceNormalsParams } from './surfaceNormals';

export type SunNormalsRequest =
  | { readonly kind: 'begin'; readonly params: SurfaceNormalsParams }
  | { readonly kind: 'add' | 'encode'; readonly xyz: ArrayBuffer }
  | { readonly kind: 'fit' };

export type SunNormalsReply =
  | { readonly id: number; readonly ok: true; readonly codes?: ArrayBuffer }
  | { readonly id: number; readonly ok: false; readonly error: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let job: SurfaceNormals | null = null;

ctx.onmessage = (event: MessageEvent<SunNormalsRequest & { readonly id: number }>): void => {
  if (event.origin && event.origin !== ctx.location.origin) return;
  const msg = event.data;
  try {
    if (msg.kind === 'begin') {
      job = new SurfaceNormals(msg.params);
    } else if (!job) {
      throw new Error('no job');
    } else if (msg.kind === 'fit') {
      job.fit();
    } else if (msg.kind === 'add') {
      job.add(new Float32Array(msg.xyz));
    } else {
      const codes = job.encode(new Float32Array(msg.xyz)).buffer as ArrayBuffer;
      ctx.postMessage({ id: msg.id, ok: true, codes } satisfies SunNormalsReply, [codes]);
      return;
    }
    ctx.postMessage({ id: msg.id, ok: true } satisfies SunNormalsReply);
  } catch (err) {
    job = null;
    ctx.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies SunNormalsReply);
  }
};
