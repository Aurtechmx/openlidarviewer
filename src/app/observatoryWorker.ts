/**
 * observatoryWorker.ts: runs the Observatory pipeline
 * (`runObservatoryOverCloud`, rays through planning) off the main thread
 * (OB-RT-03). The O11 benchmark measured the pipeline at well over 50 ms on
 * every room scenario, so it no longer runs inside a UI task.
 *
 * Contract:
 *   in  { jobId, pointBuffer: ArrayBuffer, sourceOrigin, bounds, acquisitionStations, options }
 *   out { jobId, ok: true, outcome } | { jobId, ok: false, error }
 *
 * The pipeline is pure and DOM-free (OB-INT-01), so it imports cleanly here,
 * and the outcome it returns is plain data (Maps, arrays, typed arrays) that
 * structured-clones back unchanged. Worker count never changes a result:
 * the same inputs give the same `fieldDigest` here as on the main thread.
 */
import { runObservatoryOverCloud, type ObservatoryRunOptions } from './observatoryFromCloud';
import type { AcquisitionStationSet } from '../model/AcquisitionStations';

type Vec3 = readonly [number, number, number];

export interface ObservatoryWorkerRequest {
  readonly jobId: number;
  /** The cloud's LOCAL-frame Float32 positions, copied and transferred by the client. */
  readonly pointBuffer: ArrayBuffer;
  readonly sourceOrigin: Vec3;
  readonly bounds: { readonly min: Vec3; readonly max: Vec3 };
  readonly acquisitionStations?: AcquisitionStationSet;
  readonly options: ObservatoryRunOptions;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent<ObservatoryWorkerRequest>): void => {
  const msg = event.data;
  try {
    const outcome = runObservatoryOverCloud({
      positions: new Float32Array(msg.pointBuffer),
      sourceOrigin: msg.sourceOrigin,
      acquisitionStations: msg.acquisitionStations,
      bounds: () => msg.bounds,
    }, msg.options);
    ctx.postMessage({ jobId: msg.jobId, ok: true, outcome });
  } catch (err) {
    ctx.postMessage({ jobId: msg.jobId, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
