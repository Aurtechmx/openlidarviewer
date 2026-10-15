/**
 * pointExportRequest.ts: the quick-format point export (PLY, OBJ, XYZ, CSV in
 * the Export panel), lifted out of main.ts.
 *
 * The export is one request, captured synchronously when the button is
 * pressed and before anything is awaited: the active cloud, the clip and
 * placement applied to it (through the same {@link prepareExportScope} step
 * the conversion export takes), the format, the resolved CRS, the
 * lat/lon precision, the source the digest is hashed from and the file name.
 * Loading the writer chunk and hashing the source both yield, and another scan
 * can open or become active meanwhile; nothing after the first await reads the
 * live app, so the file always describes the scan that was asked for.
 */

import { prepareExportScope } from '../render/clip/clipExportScope';
import type { ExportSourceRef } from '../export/exportDigests';
import type { ResolvedCrs } from '../geo/CoordinateTypes';
import type { ExportFormat, PointExportScope } from '../io/exporters';
import type { PointCloud } from '../model/PointCloud';
import type { ClipBox } from '../render/clip/clipBox';
import type { loadExporters } from '../lazyChunks';
import { geoContextForCloud } from './reportExport';

type Vec3 = readonly [number, number, number];

/** Refusal for a clip box that keeps none of the active scan. */
export const EMPTY_CLIP_EXPORT_REFUSAL =
  'The clip box keeps no points of this scan, so there is nothing to export. Move or turn off the clip box and export again.';

/** Accessors over the live app, read once, at the click. */
export interface PointExportRequestDeps {
  /** The active static cloud, or null. */
  readonly activeCloud: () => PointCloud | null;
  /** The active clip box, or null. */
  readonly clip: () => ClipBox | null;
  /** The active layer's offset into the project frame the clip box is drawn in. */
  readonly clipOffset: () => Vec3 | null;
  /** The resolved CRS of the active scan. */
  readonly crs: () => ResolvedCrs | null;
  /** Whether the resolved CRS is geographic (lat/lon precision). */
  readonly isGeographic: () => boolean;
  /** A file name without its extension. */
  readonly baseName: (name: string) => string;
}

/** Everything a quick point export writes, frozen at the click. */
export interface PointExportRequest {
  readonly format: ExportFormat;
  /** The cloud the points come from, before any clip. */
  readonly source: PointCloud;
  /** The points to write: `source`, or the part of it the clip keeps. */
  readonly cloud: PointCloud;
  /** How `cloud` relates to `source`, for the header and the file name. */
  readonly scope: PointExportScope;
  readonly isGeographic: boolean;
  /** The source the SHA-256 is computed from: the one that supplied the coordinates. */
  readonly digestSource: ExportSourceRef;
  /** The resolved CRS of `source`, for the CRS origin line. */
  readonly crs: ResolvedCrs | null;
  /** The download name's stem. */
  readonly base: string;
}

/**
 * Capture the request for the active scan, or say why there is none. Pure
 * reads, no await: what this returns is what the file will hold.
 */
export function capturePointExportRequest(
  format: ExportFormat,
  deps: PointExportRequestDeps,
): { readonly request: PointExportRequest } | { readonly refusal: string } | null {
  const source = deps.activeCloud();
  if (!source) return null;
  const { cloud, scopeNote } = prepareExportScope(source, {
    clip: deps.clip(),
    clipOffset: deps.clipOffset(),
    displayOrigin: source.sourceOrigin,
  });
  if (cloud.pointCount === 0 && source.pointCount > 0) return { refusal: EMPTY_CLIP_EXPORT_REFUSAL };
  const geo = geoContextForCloud(source, deps.crs());
  return {
    request: {
      format,
      source,
      cloud,
      scope: { basis: source, note: scopeNote },
      isGeographic: deps.isGeographic(),
      digestSource: geo.source ?? { key: source, streamed: false },
      crs: geo.crs ?? null,
      base: deps.baseName(source.name),
    },
  };
}

/** Write a captured request: load the writer, hash the source, serialise. Reads nothing live. */
export async function writePointExport(
  request: PointExportRequest,
  io: {
    readonly loadExporters: typeof loadExporters;
    readonly download: (filename: string, bytes: Uint8Array, mime: string) => void;
  },
): Promise<void> {
  const m = await io.loadExporters();
  const r = request;
  const bytes = await m.exportCloudBytesWithDigests(r.cloud, r.format, r.isGeographic, { source: r.digestSource, crs: r.crs }, r.scope);
  io.download(m.pointExportFileName(r.base, r.cloud, r.format, r.scope), bytes, 'text/plain');
}

