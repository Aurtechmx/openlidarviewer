/**
 * provenanceSignals.ts
 *
 * Wiring helpers that translate the runtime's two cloud shapes — the static
 * `PointCloud` and the streaming `StreamingPointCloud` / `EptStreamingPointCloud`
 * — into the `ScanSignals` payload that `diagnostics/provenance.classify`
 * consumes.
 *
 * These used to live inline in main.ts and silently rotted twice:
 *
 *   1. Static path read `cloud.bounds` as a property; `PointCloud.bounds` is a
 *      METHOD. The function reference passed the truthy guard, then `b.max[0]`
 *      threw TypeError, and the post-load try/catch swallowed it. The
 *      Inspector's Provenance section stuck on its placeholder.
 *
 *   2. Static path read `cloud.metadata.sensorString` / `softwareString`. The
 *      actual `CloudMetadata` fields are `captureSensor` / `sourceSoftware`
 *      (filled from the LAS header's System Identifier + Generating Software
 *      VLR). Silently undefined every load — no exception — so the classifier
 *      always fell back to weaker signals.
 *
 * Extracted here so the contract is unit-testable in isolation and the two
 * regressions cannot come back unnoticed.
 */
import type { ScanSignals } from './provenance';

/** The subset of `PointCloud` the static-cloud signal helper uses. */
export interface StaticCloudShape {
  readonly sourceFormat: string;
  readonly pointCount: number;
  /**
   * The file's declared total, when larger than `pointCount` (the loader strides
   * huge clouds for display). Used so the capture-type density reflects the file,
   * not the rendered subset — matching the Scan Report and inspection PDF.
   */
  readonly declaredPointCount?: number;
  /** PointCloud.bounds is a method — not an object. */
  readonly bounds?: () => {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  };
  readonly metadata?: {
    readonly captureSensor?: string;
    readonly sourceSoftware?: string;
  };
}

/** The subset of a streaming cloud the streaming-cloud signal helper uses. */
export interface StreamingCloudShape {
  readonly kind: 'copc' | 'ept';
  readonly sourcePointCount?: number;
  /** Streaming clouds expose extent through `localBounds(): Box6`. */
  readonly localBounds?: () => readonly [number, number, number, number, number, number];
}

/**
 * Build a `ScanSignals` payload from a freshly loaded static cloud.
 *
 * Tolerant of partial cloud shapes by design — every field on
 * `StaticCloudShape` is optional, and a thrown `bounds()` is caught and
 * converted to a missing-extent signal rather than allowed to abort the
 * post-load chain.
 */
export function signalsForStaticCloud(cloud: StaticCloudShape): ScanSignals {
  let extent: readonly [number, number, number] | undefined;
  if (typeof cloud.bounds === 'function') {
    try {
      const b = cloud.bounds();
      extent = [
        b.max[0] - b.min[0],
        b.max[1] - b.min[1],
        b.max[2] - b.min[2],
      ] as const;
    } catch {
      extent = undefined;
    }
  }
  // File scale: prefer the declared total over the strided display count so the
  // density (and the capture-type call it drives) describes the whole file.
  const fileN =
    cloud.declaredPointCount !== undefined && cloud.declaredPointCount > cloud.pointCount
      ? cloud.declaredPointCount
      : cloud.pointCount;
  const density =
    extent && extent[0] > 0 && extent[1] > 0
      ? fileN / (extent[0] * extent[1])
      : undefined;
  return {
    sourceFormat: cloud.sourceFormat,
    pointCount: fileN,
    extent,
    densityPerSqM: density,
    sensorString: cloud.metadata?.captureSensor,
    softwareString: cloud.metadata?.sourceSoftware,
  };
}

/**
 * Build a `ScanSignals` payload from a freshly attached streaming cloud.
 *
 * Streaming sources are tagged so the classifier knows the resident set
 * is partial; the source-declared point count + the cloud's local extent
 * carry the signal even though only a thin shell is in memory.
 */
export function signalsForStreamingCloud(cloud: StreamingCloudShape): ScanSignals {
  let extent: readonly [number, number, number] | undefined;
  let density: number | undefined;
  if (typeof cloud.localBounds === 'function') {
    try {
      const b = cloud.localBounds();
      extent = [b[3] - b[0], b[4] - b[1], b[5] - b[2]];
      if (extent[0] > 0 && extent[1] > 0 && cloud.sourcePointCount) {
        density = cloud.sourcePointCount / (extent[0] * extent[1]);
      }
    } catch {
      extent = undefined;
      density = undefined;
    }
  }
  return {
    sourceFormat: cloud.kind === 'ept' ? 'ept' : 'copc',
    pointCount: cloud.sourcePointCount ?? 0,
    extent,
    densityPerSqM: density,
    streamingSource: true,
  };
}
