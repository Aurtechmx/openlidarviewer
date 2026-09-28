/**
 * formatProbeWorkerClient.ts
 *
 * Resolves a file `sniffFormat` could not name. The 16 KiB head the loader
 * already holds is probed here first, which settles almost every file without
 * another read. Only when that head is not decisive and the file is longer
 * does the probe widen, and then it runs in `formatProbeWorker.ts` so the
 * wider reads and the byte statistics stay off the main thread.
 *
 * Bounds are hard: at most MAX_PROBE_BYTES read, at most
 * PROBE_WORKER_TIME_CAP_MS of probe time on the worker and the inline paths
 * alike, and cancellable through the load's AbortSignal. Hitting a bound, or
 * a worker failure, yields an OPAQUE report stating the reason; it never
 * surfaces as an unexplained exception.
 *
 * Holds the `new Worker(new URL(...))` literal, so it is registered in
 * `src/workers/workerRegistry.ts`. Loaded lazily from `loadFile.ts`.
 */
import type { SourceFormat } from '../sniffFormat';
import { LoadError } from '../loadErrors';
import {
  decideWindow,
  MAX_PROBE_BYTES,
  PROBE_WINDOWS,
  PROBE_WORKER_TIME_CAP_MS,
  probeProgressively,
  type ProbeBound,
} from './progressiveProbe';
import { isDecisive, type InterpretationLevel, type ProbeDecision } from './formatProbes';
import {
  buildOpenFailureFacts,
  openFailureReportText,
  openFailureSummary,
  type OpenFailureFacts,
} from './openFailureReport';

export interface ProbeWorkerRequest {
  readonly file: File;
}

export type ProbeWorkerReply =
  | { type: 'format'; decoderId: SourceFormat; level: InterpretationLevel }
  | { type: 'failure'; facts: OpenFailureFacts };

type ProbeWorkerFactory = () => Worker;
const defaultFactory: ProbeWorkerFactory = () =>
  new Worker(new URL('./formatProbeWorker.ts', import.meta.url), { type: 'module' });
let factory: ProbeWorkerFactory | null = defaultFactory;
let timeCapMs = PROBE_WORKER_TIME_CAP_MS;

/** Test seam: inject a fake worker, or `null` to force the inline path; optionally shorten the time cap. */
export function __setProbeWorkerFactoryForTests(f?: ProbeWorkerFactory | null, capMs?: number): void {
  factory = f === undefined ? defaultFactory : f;
  timeCapMs = capMs ?? PROBE_WORKER_TIME_CAP_MS;
}

/** Thrown when the load's signal aborts mid-probe; `loadFile` maps it to its own cancel. */
export class ProbeCancelledError extends Error {
  constructor() {
    super('Format probe cancelled');
    this.name = 'ProbeCancelledError';
  }
}

/** What the reply needs of the file: its size and name, never its bytes. */
type FileFacts = Pick<File, 'size' | 'name'>;

function replyFor(decision: ProbeDecision, sample: Uint8Array, file: FileFacts, bound?: ProbeBound): ProbeWorkerReply {
  return decision.decoderId
    ? { type: 'format', decoderId: decision.decoderId, level: decision.level }
    : { type: 'failure', facts: buildOpenFailureFacts(decision, sample, file.size, file.name, bound) };
}

/** The OPAQUE report for a probe that stopped on a bound before deciding. */
function boundReply(head: Uint8Array, file: FileFacts, bound: ProbeBound): ProbeWorkerReply {
  const d = decideWindow(head, file.size, file.name);
  return replyFor({ ...d, decoderId: null, level: d.level === 'NOT_POINT_CLOUD' ? d.level : 'OPAQUE' }, head, file, bound);
}

function viaWorker(file: File, head: Uint8Array, signal?: AbortSignal): Promise<ProbeWorkerReply> {
  return new Promise((resolve, reject) => {
    const worker = (factory as ProbeWorkerFactory)();
    let done = false;
    const finish = (action: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      action();
    };
    const onAbort = (): void => finish(() => reject(new ProbeCancelledError()));
    const timer = setTimeout(() => finish(() => resolve(boundReply(head, file, 'time-cap'))), timeCapMs);
    signal?.addEventListener('abort', onAbort);
    worker.onmessage = (e: MessageEvent<ProbeWorkerReply>): void => finish(() => resolve(e.data));
    worker.onerror = (): void => finish(() => resolve(boundReply(head, file, 'worker-failed')));
    try {
      worker.postMessage({ file } satisfies ProbeWorkerRequest);
    } catch {
      finish(() => resolve(boundReply(head, file, 'worker-failed')));
    }
  });
}

/**
 * Race `work` against the time cap. On the cap the probe resolves to the
 * OPAQUE report for `head` with the `time-cap` reason; the abandoned work is
 * left to settle unobserved (it only reads bounded slices).
 */
function capped(work: Promise<ProbeWorkerReply>, head: Uint8Array, size: number, name: string): Promise<ProbeWorkerReply> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<ProbeWorkerReply>((resolve) => {
    timer = setTimeout(() => resolve(boundReply(head, { size, name }, 'time-cap')), timeCapMs);
  });
  return Promise.race([work, cap]).finally(() => clearTimeout(timer));
}

async function inline(file: File, head: Uint8Array, signal?: AbortSignal): Promise<ProbeWorkerReply> {
  const read = async (n: number): Promise<Uint8Array> => new Uint8Array(await file.slice(0, n).arrayBuffer());
  const work = probeProgressively(read, file.size, file.name, head, signal).then(({ decision, sample, bound }) =>
    replyFor(decision, sample, file, bound),
  );
  const reply = await capped(work, head, file.size, file.name);
  if (signal?.aborted) throw new ProbeCancelledError();
  return reply;
}

/** The refusal for a file nothing opens, carrying the copyable report. */
export function openFailureError(facts: OpenFailureFacts): LoadError {
  return new LoadError('unsupported-format', openFailureSummary(facts), openFailureReportText(facts));
}

/** The decoder chosen for a file, with the interpretation level it was chosen at. */
export interface ResolvedFormat {
  readonly format: SourceFormat;
  readonly level: InterpretationLevel;
}

/**
 * The decoder to open `file` with and its level, or a thrown
 * `LoadError('unsupported-format')` carrying the failure report. Throws
 * `ProbeCancelledError` only when `signal` aborts.
 */
export async function resolveUnknownFormat(
  file: File,
  headBuffer: ArrayBuffer,
  signal?: AbortSignal,
): Promise<ResolvedFormat> {
  const head = new Uint8Array(headBuffer, 0, Math.min(headBuffer.byteLength, MAX_PROBE_BYTES));
  const first = decideWindow(head, file.size, file.name);
  let reply: ProbeWorkerReply;
  if (isDecisive(first.level) || head.length >= file.size) {
    reply = replyFor(first, head, file);
  } else if (factory && typeof Worker !== 'undefined') {
    reply = await viaWorker(file, head, signal);
  } else {
    reply = await inline(file, head, signal);
  }
  if (reply.type === 'format') return { format: reply.decoderId, level: reply.level };
  throw openFailureError(reply.facts);
}

/**
 * Same decision over a whole buffer already in memory (a re-decode). Bounded
 * to MAX_PROBE_BYTES and to the same time cap as the file paths.
 */
export async function resolveUnknownBuffer(buffer: ArrayBuffer, name: string): Promise<ResolvedFormat> {
  const size = buffer.byteLength;
  const whole = new Uint8Array(buffer);
  const read = async (n: number): Promise<Uint8Array> => whole.subarray(0, Math.min(n, size, MAX_PROBE_BYTES));
  const head = whole.subarray(0, Math.min(size, PROBE_WINDOWS[0]));
  const work = probeProgressively(read, size, name, head).then(({ decision, sample, bound }) =>
    replyFor(decision, sample, { size, name }, bound),
  );
  const reply = await capped(work, head, size, name);
  if (reply.type === 'format') return { format: reply.decoderId, level: reply.level };
  throw openFailureError(reply.facts);
}
