/**
 * observatoryWorkerClient.ts: the main-thread side of `observatoryWorker.ts`.
 * One job at a time: a new job terminates the worker running the old one
 * (the pipeline is one synchronous task inside the worker, so termination is
 * the only cancellation that reaches it), and the worker is rebuilt lazily.
 *
 * The caller's positions are never detached: a copy is transferred.
 * If the worker cannot start or fails, the job runs on the main thread
 * instead, so a run is never lost (OB-INV-08).
 *
 * Imported by `observatoryRunner.ts`, so it rides in the Observatory's own
 * lazy chunk (`WORKER_REGISTRY` entry `observatory`).
 */
import { localPositionsOf, runObservatoryOverCloud, type ObservatoryCloudInput, type ObservatoryRunOptions, type ObservatoryRunOutcome } from './observatoryFromCloud';

type Reply = { jobId: number; ok: true; outcome: ObservatoryRunOutcome } | { jobId: number; ok: false; error: string };

let worker: Worker | null = null;
let jobId = 0;
let pending: { id: number; resolve: (o: ObservatoryRunOutcome) => void; fallback: () => void } | null = null;

function terminate(): void {
  worker?.terminate();
  worker = null;
}

/** Stop the job in flight, if any; its promise never settles. */
export function cancelObservatoryJob(): void {
  if (pending) {
    pending = null;
    terminate();
  }
}

/** Run the pipeline in the worker, falling back to the main thread when no worker is available or it fails. */
export function computeObservatoryInWorker(cloud: ObservatoryCloudInput, options: ObservatoryRunOptions): Promise<ObservatoryRunOutcome> {
  cancelObservatoryJob();
  const id = ++jobId;
  const inThread = () => runObservatoryOverCloud(cloud, options);
  if (typeof Worker === 'undefined') return Promise.resolve().then(inThread);
  return new Promise((resolve, reject) => {
    // A throw from the in-thread run rejects the job, so the caller always settles.
    const fallback = () => {
      if (pending?.id !== id) return;
      pending = null;
      terminate();
      try { resolve(inThread()); } catch (err) { reject(err); }
    };
    pending = { id, resolve, fallback };
    try {
      if (!worker) {
        worker = new Worker(new URL('./observatoryWorker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (event: MessageEvent<Reply>) => {
          const reply = event.data;
          if (!pending || reply.jobId !== pending.id) return;
          if (!reply.ok) { pending.fallback(); return; }
          const done = pending;
          pending = null;
          done.resolve(reply.outcome);
        };
        worker.onerror = () => { pending?.fallback(); };
      }
      const positions = localPositionsOf(cloud).slice().buffer;
      const b = cloud.bounds();
      worker.postMessage({
        jobId: id,
        pointBuffer: positions,
        sourceOrigin: cloud.sourceOrigin,
        bounds: { min: [...b.min], max: [...b.max] },
        acquisitionStations: cloud.acquisitionStations,
        options,
      }, [positions]);
    } catch {
      fallback();
    }
  });
}
