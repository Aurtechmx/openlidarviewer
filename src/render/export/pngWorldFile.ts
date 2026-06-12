/**
 * pngWorldFile.ts
 *
 * Georeferencing sidecars for the Visual Export Studio's TOP-DOWN
 * orthographic PNG rasters (height / intensity / classification / normal /
 * ortho-RGB framed from above): an ESRI world file (`.pgw`) plus an optional
 * `.prj` (CRS WKT), bundled with the PNG into one store-only ZIP so the
 * download drops straight into QGIS / ArcGIS as a placed raster.
 *
 * Before v0.4.5 the Studio shipped bare PNGs with no world file anywhere, so
 * a GIS could not place them despite the exporter knowing the exact world
 * extent it framed (workplan C4). The origin/CRS handling mirrors the DEM
 * package (`demPackage.ts`): render-space extents are LOCAL (recentred by the
 * load-time origin), so the world origin is added back before anything is
 * stamped, and when no real CRS is known the `.prj` is simply omitted — we
 * never stamp a frame we don't have.
 *
 * Pure data: no DOM, no three.js, no canvas. Deterministic.
 */

import { buildZip, type ZipEntry } from '../../convert/zipStore';

/** World-space extent of the rendered raster (render/local frame). */
export interface OrthoExtent {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface WorldFileParams {
  /** Extent the orthographic camera framed, in the cloud's LOCAL frame. */
  readonly extent: OrthoExtent;
  /** Raster size in pixels. */
  readonly widthPx: number;
  readonly heightPx: number;
  /**
   * Load-time world origin to add back (the same shift the DEM package and
   * contour exports apply). Null/absent ⇒ the raster is georeferenced in the
   * local frame only — still useful for relative placement, but the caller
   * should omit the `.prj` (see {@link buildStudioPngPackage}).
   */
  readonly worldOrigin?: { readonly x: number; readonly y: number } | null;
}

/**
 * Build the 6-line ESRI world-file text for a north-up raster:
 *
 *   A  x pixel size            (line 1)
 *   D  row rotation = 0        (line 2)
 *   B  column rotation = 0     (line 3)
 *   E  y pixel size, NEGATIVE  (line 4 — image rows run north→south)
 *   C  x of the CENTRE of the top-left pixel (line 5)
 *   F  y of the CENTRE of the top-left pixel (line 6)
 *
 * Returns null when the inputs cannot georeference a raster (degenerate
 * extent or non-positive pixel size) — the caller then ships the bare PNG
 * rather than a lying sidecar.
 */
export function buildWorldFileText(params: WorldFileParams): string | null {
  const { extent, widthPx, heightPx } = params;
  if (!Number.isInteger(widthPx) || !Number.isInteger(heightPx) || widthPx <= 0 || heightPx <= 0) {
    return null;
  }
  const vals = [extent.minX, extent.minY, extent.maxX, extent.maxY];
  if (vals.some((v) => !Number.isFinite(v))) return null;
  if (!(extent.maxX > extent.minX) || !(extent.maxY > extent.minY)) return null;

  const ox = params.worldOrigin?.x ?? 0;
  const oy = params.worldOrigin?.y ?? 0;
  const pixelW = (extent.maxX - extent.minX) / widthPx;
  const pixelH = (extent.maxY - extent.minY) / heightPx;
  // World-file C/F reference the CENTRE of the top-left pixel, not its corner.
  const cx = ox + extent.minX + pixelW / 2;
  const cy = oy + extent.maxY - pixelH / 2;
  // One value per line, trailing newline — the format GDAL/QGIS write & read.
  return [pixelW, 0, 0, -pixelH, cx, cy].map((v) => String(v)).join('\n') + '\n';
}

export interface StudioPngPackageParams extends WorldFileParams {
  /** Base filename (no extension) for the entries. */
  readonly basename: string;
  /** The encoded PNG bytes (the host converts its Blob via arrayBuffer()). */
  readonly png: Uint8Array;
  /**
   * Horizontal CRS WKT for the `.prj` sidecar. Omitted/null ⇒ no `.prj` is
   * written (a world file alone still places the raster in a local frame;
   * stamping a real CRS on local coordinates is the v0.4.3 contour bug and is
   * deliberately impossible here: the `.prj` is only written when a world
   * origin was supplied too).
   */
  readonly wkt?: string | null;
}

/** What {@link buildStudioPngPackage} produced, for the host's download UI. */
export interface StudioPngPackage {
  /** `<basename>.zip` bytes (PNG + .pgw [+ .prj]). */
  readonly zip: Uint8Array;
  readonly filename: string;
  /** True when the `.prj` made it in (real CRS + world origin known). */
  readonly georeferenced: boolean;
}

/**
 * Bundle a top-down Studio PNG with its `.pgw` (+ `.prj` when the CRS AND the
 * world origin are both known) into one ZIP. Returns null when no world file
 * can be derived — the host should fall back to the plain PNG download.
 */
export function buildStudioPngPackage(params: StudioPngPackageParams): StudioPngPackage | null {
  const pgw = buildWorldFileText(params);
  if (pgw == null) return null;
  const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
  const entries: ZipEntry[] = [
    { name: `${params.basename}.png`, bytes: params.png },
    { name: `${params.basename}.pgw`, bytes: utf8(pgw) },
  ];
  // Honesty gate: a .prj asserts "these world-file numbers are coordinates in
  // THIS CRS" — only true when the local→world origin shift was applied.
  const georeferenced =
    params.wkt != null && params.wkt.trim().length > 0 && params.worldOrigin != null;
  if (georeferenced) {
    entries.push({ name: `${params.basename}.prj`, bytes: utf8((params.wkt as string).trim()) });
  }
  return {
    zip: buildZip(entries),
    filename: `${params.basename}.zip`,
    georeferenced,
  };
}
