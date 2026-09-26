/**
 * formatProbeWorker.ts
 *
 * Runs the progressive format probe off the main thread. The caller posts the
 * `File` (structured-cloneable, no byte copy); this worker reads bounded
 * slices of it (never past MAX_PROBE_BYTES), decides, and posts back the
 * chosen decoder or the failure report facts. It never posts an exception:
 * a failed read becomes an OPAQUE report with the reason.
 */
import { probeProgressively } from './progressiveProbe';
import { buildOpenFailureFacts } from './openFailureReport';
import type { ProbeWorkerReply, ProbeWorkerRequest } from './formatProbeWorkerClient';

self.onmessage = async (event: MessageEvent<ProbeWorkerRequest>): Promise<void> => {
  const { file } = event.data;
  const read = async (n: number): Promise<Uint8Array> => new Uint8Array(await file.slice(0, n).arrayBuffer());
  const { decision, sample, bound } = await probeProgressively(read, file.size, file.name);
  const reply: ProbeWorkerReply = decision.decoderId
    ? { type: 'format', decoderId: decision.decoderId }
    : { type: 'failure', facts: buildOpenFailureFacts(decision, sample, file.size, file.name, bound) };
  self.postMessage(reply);
};
