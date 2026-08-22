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
import type { StreamingSourceKind } from '../render/streaming/StreamingSource';

/** One declared metadata field, exactly as the file states it. */
interface DeclaredField {
  readonly name: string;
  readonly value: string;
}

/** The declared-only source metadata block a scanner format carries (E57 today). */
interface DeclaredSourceMetadata {
  readonly standard: readonly DeclaredField[];
  readonly extensions: readonly DeclaredField[];
}

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
    /**
     * The scanner's registered set-up position, when the format records it
     * (the PTX per-scan transform).
     */
    readonly scannerOrigin?: readonly [number, number, number];
    /**
     * Declared-only source metadata read from the file itself. Carries the
     * instrument identity (`sensorVendor` / `sensorModel`) and the per-scan
     * set-up fields the sensor-string matcher and the ground guard read.
     */
    readonly sourceMetadata?: DeclaredSourceMetadata;
    /**
     * The file's own capture declaration, precomputed AT LOAD TIME (in the
     * lazy loader chunk, via `diagnostics/declaredCapture.ts`) from the
     * declared source metadata — including its pre-built display strings.
     * Read here as a plain field so neither the keyword scan nor the
     * wording rides the startup shell.
     */
    readonly declaredCapture?: {
      readonly field: string;
      readonly value: string;
      readonly label: string;
      readonly signal: string;
      readonly disclaimer: string;
    };
  };
}

/** The subset of a streaming cloud the streaming-cloud signal helper uses. */
export interface StreamingCloudShape {
  readonly kind: StreamingSourceKind;
  readonly sourcePointCount?: number;
  /**
   * The TIGHT data extent — preferred for the aspect-ratio + density signals.
   * `localBounds` (the octree cube) reports a 1:1:1 aspect and a cube-area
   * density, which mis-cues the capture-type classifier for streaming scans.
   */
  readonly dataBounds?: () => readonly [number, number, number, number, number, number];
  /** The octree cube — a fallback only when `dataBounds` is unavailable. */
  readonly localBounds?: () => readonly [number, number, number, number, number, number];
  /** Horizontal CRS, for converting raw-unit extent/density to metres / pts·m⁻². */
  readonly crs?: () => { readonly linearUnitToMetres?: number } | null | undefined;
}

/**
 * A declared field by its local name. Multi-scan files prefix per-scan fields
 * ("scan 2 sensorModel"), so the suffix match covers both shapes; standard
 * fields win over extension-namespace ones of the same name. Blank values are
 * treated as absent.
 */
function declaredValue(
  meta: DeclaredSourceMetadata | undefined,
  name: string,
): string | undefined {
  if (!meta) return undefined;
  const match = (f: DeclaredField): boolean =>
    (f.name === name || f.name.endsWith(` ${name}`)) && f.value.trim().length > 0;
  return (meta.standard.find(match) ?? meta.extensions.find(match))?.value.trim();
}

/**
 * The instrument identity the file declares, vendor first. The sensor-string
 * matcher keys on make plus series ("riegl vz", "faro focus"), which a bare
 * model ("VZ-1000") does not carry; the vendor is skipped when the model
 * already names it. Undefined when the file declares no model.
 */
function declaredSensorString(meta: DeclaredSourceMetadata | undefined): string | undefined {
  const model = declaredValue(meta, 'sensorModel');
  if (!model) return undefined;
  const vendor = declaredValue(meta, 'sensorVendor');
  if (!vendor || model.toLowerCase().includes(vendor.toLowerCase())) return model;
  return `${vendor} ${model}`;
}

/** Distinct per-scan blocks in the declared metadata ("scan 3 sensorModel" → 3). */
function declaredStationCount(meta: DeclaredSourceMetadata | undefined): number {
  if (!meta) return 0;
  const ids = new Set<string>();
  for (const f of [...meta.standard, ...meta.extensions]) {
    const m = /^scan (\d+) /.exec(f.name);
    if (m) ids.add(m[1]);
  }
  return ids.size;
}

/**
 * Per-scan readings a static instrument records where it stands, for the
 * range correction its ranging electronics apply.
 */
const STATION_SETUP_FIELDS = ['temperature', 'relativeHumidity', 'atmosphericPressure'];

/**
 * Declared evidence that the instrument stood on the ground, or undefined.
 * Three facts qualify, none of which an airborne or spaceborne delivery
 * states about itself:
 *
 *   - a recorded scanner set-up position (the PTX per-scan transform): a
 *     moving platform is described by a trajectory, not by one occupied
 *     station coordinate;
 *   - two or more registered scan stations in the declared block: merging
 *     station to station is the tripod workflow, an airborne delivery is
 *     tiled or split by flight line;
 *   - per-scan atmospheric readings taken at the set-up.
 *
 * A declared sensor model on its own is NOT on the list. When it names a known
 * ground-based instrument, `matchSensorString` decides the verdict before this
 * guard runs; counting an unrecognised model would rule out aerial for every
 * instrument-tagged file, including a genuine airborne delivery. LAS / LAZ /
 * COPC / EPT carry none of these fields, so airborne deliveries in those
 * formats never reach the guard.
 */
function declaredGroundInstrument(cloud: StaticCloudShape): string | undefined {
  const meta = cloud.metadata?.sourceMetadata;
  const reasons: string[] = [];
  if (cloud.metadata?.scannerOrigin) reasons.push('a recorded scanner set-up position');
  const stations = declaredStationCount(meta);
  if (stations > 1) reasons.push(`${stations} registered scan stations`);
  const setup = STATION_SETUP_FIELDS.filter((n) => declaredValue(meta, n) !== undefined);
  if (setup.length > 0) reasons.push(`per-scan ${setup.join(' / ')}`);
  return reasons.length > 0 ? reasons.join(', ') : undefined;
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
  // Instrument identity: the file's own declaration first, `captureSensor`
  // after it. A merged multi-scan file has no single header sensor field, so
  // `captureSensor` carries a loader-composed summary; the declared
  // sensorVendor + sensorModel is the instrument, and it is what the
  // sensor-string matcher can key on.
  return {
    sourceFormat: cloud.sourceFormat,
    pointCount: fileN,
    extent,
    densityPerSqM: density,
    sensorString:
      declaredSensorString(cloud.metadata?.sourceMetadata) ?? cloud.metadata?.captureSensor,
    softwareString: cloud.metadata?.sourceSoftware,
    declaredCapture: cloud.metadata?.declaredCapture,
    declaredGroundInstrument: declaredGroundInstrument(cloud),
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
  // Prefer the tight data AABB; the cube (`localBounds`) is only a last resort.
  const boundsFn = cloud.dataBounds ?? cloud.localBounds;
  if (typeof boundsFn === 'function') {
    try {
      const b = boundsFn();
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
    sourceFormat: cloud.kind,
    pointCount: cloud.sourcePointCount ?? 0,
    extent,
    densityPerSqM: density,
    streamingSource: true,
  };
}
