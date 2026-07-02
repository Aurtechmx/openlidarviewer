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
    /** Horizontal CRS unit → metres, for converting raw-unit extent/density. */
    readonly crs?: { readonly linearUnitToMetres?: number };
    /** Declared-only source metadata (see `CloudMetadata.sourceMetadata`). */
    readonly sourceMetadata?: {
      readonly standard: readonly { readonly name: string; readonly value: string }[];
      readonly extensions: readonly { readonly name: string; readonly value: string }[];
    };
  };
}

/**
 * Declared fields that may state what the scan IS, and the keyword set that
 * marks a non-physical (synthetic / procedural / reconstruction / reference)
 * origin. Case-insensitive substring match — deliberately broad, because
 * asserting a physical capture type over a file that declares itself
 * synthetic is the worse failure mode.
 */
const DECLARED_CAPTURE_FIELDS = [
  'sensorModel',
  'datasetType',
  'accuracyClass',
  'description',
  'name',
] as const;
const SYNTHETIC_KEYWORDS = /synthetic|procedural|reconstruction|reference/i;

/**
 * Scan the declared source metadata for a capture statement the classifier
 * must honour. Returns the preferred field to QUOTE (sensorModel, then
 * datasetType, then whichever field matched) when any of the candidate
 * fields carries a synthetic/procedural/reconstruction/reference keyword.
 * Returns undefined otherwise — absence leaves the classifier unchanged.
 */
export function declaredCaptureFromSourceMetadata(
  sourceMetadata:
    | {
        readonly standard: readonly { readonly name: string; readonly value: string }[];
        readonly extensions: readonly { readonly name: string; readonly value: string }[];
      }
    | undefined,
): { field: string; value: string } | undefined {
  if (!sourceMetadata) return undefined;
  const all = [...sourceMetadata.standard, ...sourceMetadata.extensions];
  const valueOf = (name: string): string | undefined =>
    all.find((f) => f.name === name && f.value.trim().length > 0)?.value;
  const matched = DECLARED_CAPTURE_FIELDS.find((name) => {
    const v = valueOf(name);
    return v !== undefined && SYNTHETIC_KEYWORDS.test(v);
  });
  if (!matched) return undefined;
  // Quote the most specific declaration: sensorModel, then datasetType,
  // then the field that actually matched.
  for (const preferred of ['sensorModel', 'datasetType'] as const) {
    const v = valueOf(preferred);
    if (v !== undefined) return { field: preferred, value: v };
  }
  return { field: matched, value: valueOf(matched) as string };
}

/** The subset of a streaming cloud the streaming-cloud signal helper uses. */
export interface StreamingCloudShape {
  readonly kind: 'copc' | 'ept';
  readonly sourcePointCount?: number;
  /** Streaming clouds expose extent through `localBounds(): Box6`. */
  readonly localBounds?: () => readonly [number, number, number, number, number, number];
  /** Horizontal CRS, for converting raw-unit extent/density to metres / pts·m⁻². */
  readonly crs?: () => { readonly linearUnitToMetres?: number } | null | undefined;
}

/** A valid linear-unit → metres factor, or 1 (treat the source as metres). */
function unitFactor(v: number | undefined): number {
  return Number.isFinite(v) && (v as number) > 0 ? (v as number) : 1;
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
  // Convert raw CRS-unit extent → metres so the capture-type / USGS-QL
  // classifier sees metres (its contract), matching the report path. A foot CRS
  // would otherwise be graded against pts/ft² density and ft² footprint.
  const f = unitFactor(cloud.metadata?.crs?.linearUnitToMetres);
  if (extent) extent = [extent[0] * f, extent[1] * f, extent[2] * f] as const;
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
    declaredCapture: declaredCaptureFromSourceMetadata(cloud.metadata?.sourceMetadata),
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
      // Convert raw CRS-unit extent → metres (see the static path) so the
      // classifier and its USGS-QL density tier are graded in metres.
      const f = unitFactor(cloud.crs?.()?.linearUnitToMetres);
      extent = [(b[3] - b[0]) * f, (b[4] - b[1]) * f, (b[5] - b[2]) * f];
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
