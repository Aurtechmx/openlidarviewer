/**
 * scanFacts.ts — the pure loaded-scan → fingerprint adapters split out of
 * `sessionIo.ts`.
 *
 * `scanFactsFromStatic` is called synchronously from the hot scan-open path
 * (`openScan.ts`, layer-identity binding) on every static load, so it must
 * stay in the eager shell. `sessionIo.ts`'s own `importSession` — the bulk of
 * that module — only runs on a deliberate "load session file" action and is
 * lazy-loaded from `main.ts`; keeping these adapters here (not there) means
 * `openScan.ts` never has to pull in the whole session-restore module just for
 * a fingerprint. `sessionIo.ts` re-exports both names so its public API is
 * unchanged.
 */

import { isZUpFormat } from '../io/sniffFormat';
import type { SourceFormat } from '../io/sniffFormat';
import type { CrsLinearUnit } from '../io/crs';
import type { DeclaredSpatialFacts, ScanFacts } from '../io/session';

/** The streaming-source slice `scanFactsFromStreaming` reads — a structural subset of {@link StreamingSource}. */
export interface StreamingScanSource {
  readonly name: string;
  readonly sourcePointCount: number | null;
  dataBounds(): readonly [number, number, number, number, number, number];
  crs():
    | { readonly name?: string; readonly epsg?: number; readonly linearUnit?: CrsLinearUnit }
    | null
    | undefined;
}

/** The static-cloud slice `scanFactsFromStatic` reads — a structural subset of {@link PointCloud}. */
export interface StaticScanCloud {
  readonly name: string;
  readonly pointCount: number;
  /**
   * Source-truth counts, preferred over the display-sampled `pointCount` for
   * identity. `declaredPointCount` is the file header's own total;
   * `decodedPointCount` is what the decoder read before any voxel downsample.
   * Both survive stride / downsample (see PointCloud), so a fingerprint built
   * from them does not shift with a device's point budget.
   */
  readonly declaredPointCount?: number;
  readonly decodedPointCount?: number;
  bounds(): {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  };
  /** Source file format — drives the file's own up-axis (`isZUpFormat`). */
  readonly sourceFormat?: SourceFormat;
  readonly metadata?: {
    readonly crs?:
      | { readonly name?: string; readonly epsg?: number; readonly linearUnit?: CrsLinearUnit }
      | null;
  };
}

/**
 * Build the loaded-scan fingerprint from a streaming source — the input the
 * matcher compares a session's stored summary against. Pure: reads the source's
 * extent spans, point count, name and CRS, no DOM or render state. Extents come
 * from `dataBounds()` (the true data extent, not the footprint span).
 */
export function scanFactsFromStreaming(cloud: StreamingScanSource): ScanFacts {
  const b = cloud.dataBounds();
  const crs = cloud.crs();
  return {
    fileName: cloud.name,
    // `sourcePoints` is optional in the session schema, so an unknown total
    // is an absent field rather than a stored zero.
    sourcePoints: cloud.sourcePointCount ?? undefined,
    width: b[3] - b[0],
    depth: b[4] - b[1],
    height: b[5] - b[2],
    crs: crs?.name,
    epsg: crs?.epsg,
  };
}

/**
 * Build the loaded-scan fingerprint from a static cloud. Pure counterpart to
 * {@link scanFactsFromStreaming}: point count from the source header, CRS from
 * the cloud's own header metadata, extent spans from `bounds()`.
 *
 * The point count is SOURCE truth, not the display sample. The held
 * `pointCount` is whatever survived this device's decode stride and voxel
 * downsample, so reading it here made a scan's identity change with the point
 * budget — the same file fingerprinted differently on mobile vs desktop, and a
 * valid session failed to match across devices. The streaming sibling already
 * reads `sourcePointCount` for exactly this reason; the static analog is the
 * header's declared total, falling to the pre-downsample decode count, then the
 * held count (the header count on top of the `decodedPointCount ?? pointCount`
 * ladder the Health Check uses). Both source-truth fields survive stride /
 * downsample (see PointCloud), so the fingerprint no longer moves with the
 * device.
 *
 * Extents (`width`/`depth`/`height`) are the residual: they still come from the
 * DECIMATED `bounds()`. A source/header extent is not reachable here — the
 * LAS/LAZ header min/max are read at load (`lasHeader.ts`) but consumed for the
 * origin and never persisted onto the cloud or its metadata, and threading a
 * header extent through every loader is out of scope for this change. So the
 * spans stay decimation-sensitive (stride / voxel sampling rarely lands on the
 * exact extremes) and an exact-match consumer must compare them with a
 * tolerance, never equality — as {@link matchSessionToScan} already does (its
 * 1 %/5 % extent bands). Only the count above is source-stable.
 */
export function scanFactsFromStatic(cloud: StaticScanCloud): ScanFacts {
  const b = cloud.bounds();
  return {
    fileName: cloud.name,
    sourcePoints: cloud.declaredPointCount ?? cloud.decodedPointCount ?? cloud.pointCount,
    width: b.max[0] - b.min[0],
    depth: b.max[1] - b.min[1],
    height: b.max[2] - b.min[2],
    crs: cloud.metadata?.crs?.name,
    epsg: cloud.metadata?.crs?.epsg,
  };
}

/**
 * The FILE's own spatial declaration from a streaming source — the source of
 * truth a restored session may not silently redefine (roadmap P1 #5). CRS code
 * and linear unit come off the source's `crs()`. Up-axis is intentionally left
 * unknown: COPC/EPT streaming sources don't surface a source format through the
 * `StreamingSource` seam, and they are z-up by construction, so there is nothing
 * to conflict against — the CRS and unit checks still run.
 */
export function declaredSpatialFromStreaming(cloud: StreamingScanSource): DeclaredSpatialFacts {
  const crs = cloud.crs();
  return { epsg: crs?.epsg, linearUnit: crs?.linearUnit };
}

/**
 * The FILE's own spatial declaration from a static cloud. Up-axis comes from the
 * source format the same way the renderer and session exporter derive it
 * (`isZUpFormat`), so the three can never disagree; CRS code and linear unit come
 * off the header metadata.
 */
export function declaredSpatialFromStatic(cloud: StaticScanCloud): DeclaredSpatialFacts {
  const crs = cloud.metadata?.crs;
  let upAxis: 'y' | 'z' | undefined;
  if (cloud.sourceFormat) {
    upAxis = isZUpFormat(cloud.sourceFormat) ? 'z' : 'y';
  } else {
    upAxis = undefined;
  }
  return {
    upAxis,
    epsg: crs?.epsg,
    linearUnit: crs?.linearUnit,
  };
}
