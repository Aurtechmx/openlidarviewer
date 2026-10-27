/**
 * storageHistoryWorkerClient.ts: the main-thread side of `storageHistoryWorker.ts`.
 *
 * Jobs are queued and run one at a time in one lazily built worker. The request's XY buffer
 * is built for the job, so it is transferred rather than copied again. When no worker exists
 * the job runs on the main thread. When the worker fails (an error event, a reply that cannot be
 * read, an `ok: false` reply, or no answer within `JOB_TIMEOUT_MS`) the transferred buffer is gone,
 * so the job settles as "the test did not finish" and the next queued job still runs.
 *
 * Imported by `storageHistoryReport.ts`, so it rides in the analysis modules' lazy chunk
 * (`WORKER_REGISTRY` entry `storageHistory`).
 */
import { runStorageHistory, type StorageHistoryRequest } from '../science/storageHistory';
import type { StorageHistoryOutcome } from '../analysis/storageHistoryRow';

type Reply = { jobId: number; ok: true; outcome: StorageHistoryOutcome } | { jobId: number; ok: false; error: string };

interface Job {
  readonly id: number;
  readonly request: StorageHistoryRequest;
  readonly resolve: (o: StorageHistoryOutcome) => void;
  readonly reject: (err: unknown) => void;
}

/**
 * How long one job may run before the worker is terminated and the job settles as not finished.
 * The test costs about 1.2 s per million points and the request is capped at 2 million points
 * (`MAX_RECOVERED_POINTS`), so a healthy job ends in under 3 s. 60 s is twenty times that: a slow
 * or busy device still finishes, and a worker that never answers cannot hold the queue for long.
 */
export const JOB_TIMEOUT_MS = 60_000;

const didNotFinish = (): StorageHistoryOutcome => ({ kind: 'not-tested', reason: 'the test did not finish' });

let worker: Worker | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let nextId = 0;
let running: Job | null = null;
const queue: Job[] = [];

function terminate(): void {
  worker?.terminate();
  worker = null;
}

function stopTimer(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

/** Settle the running job as not finished, drop the worker and start the next job. */
function failRunning(): void {
  const done = running;
  running = null;
  stopTimer();
  terminate();
  if (done) done.resolve(didNotFinish());
  startNext();
}

/**
 * Finish `job` on the main thread; a throw rejects it so the caller always settles. A buffer
 * already transferred to a worker that then failed is detached (byteLength 0) and cannot be
 * re-read, so that job ends as not tested rather than as a false "too few points".
 */
function inThread(job: Job): void {
  if (job.request.xy.buffer.byteLength === 0 && job.request.xy.length === 0) {
    job.resolve(didNotFinish());
    return;
  }
  try { job.resolve(runStorageHistory(job.request)); } catch (err) { job.reject(err); }
}

function startNext(): void {
  if (running || queue.length === 0) return;
  const job = queue.shift() as Job;
  running = job;
  if (typeof Worker === 'undefined') {
    running = null;
    inThread(job);
    startNext();
    return;
  }
  try {
    if (!worker) {
      worker = new Worker(new URL('./storageHistoryWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<Reply>) => {
        const reply = event.data;
        if (!running || reply.jobId !== running.id) return;
        const done = running;
        running = null;
        stopTimer();
        if (reply.ok) done.resolve(reply.outcome);
        else inThread(done);
        startNext();
      };
      worker.onerror = failRunning;
      worker.onmessageerror = failRunning;
    }
    const xy = job.request.xy.buffer as ArrayBuffer;
    worker.postMessage({ jobId: job.id, request: job.request }, [xy]);
    timer = setTimeout(failRunning, JOB_TIMEOUT_MS);
  } catch {
    running = null;
    stopTimer();
    terminate();
    inThread(job);
    startNext();
  }
}

/** Run the test in the worker, falling back to the main thread when no worker is available or it fails. */
export function runStorageHistoryInWorker(request: StorageHistoryRequest): Promise<StorageHistoryOutcome> {
  return new Promise((resolve, reject) => {
    queue.push({ id: ++nextId, request, resolve, reject });
    startNext();
  });
}
