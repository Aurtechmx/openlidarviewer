/**
 * export/types.ts
 *
 * Visual Export Studio — pure types and contracts.
 *
 * The Studio is the user-facing image-export surface: take the live scan and
 * produce a publication-ready PNG of one of four "modes" — orthographic RGB,
 * height map, intensity, or classification. Every mode shares this contract;
 * only the body of `render()` differs.
 *
 * The Studio is lazy-loaded — these types are the type-only edge the rest of
 * the codebase imports without pulling in any rendering code. They contain no
 * DOM, no three.js, and no Viewer reference (only a narrow adapter interface).
 */

import type * as THREE from 'three/webgpu';
import type { ColorMode } from '../render/colorModes';

// ─────────────────────────────────────────────────────────────────────────────
// Mode identifiers
// ─────────────────────────────────────────────────────────────────────────────

/** The set of export modes the Studio can produce. */
export type ExportMode =
  | 'orthographic-rgb'
  | 'height-map'
  | 'intensity'
  | 'classification'
  /** Camera-relative depth raster (near=white, far=black, invertible). */
  | 'depth'
  /** Top-down RGB-encoded surface normals. */
  | 'normal'
  /** Topographic-style contour lines over the elevation raster. */
  | 'contour';

// ─────────────────────────────────────────────────────────────────────────────
// Figure provenance — what the Viewer can honestly assert about the live view
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The live perspective camera's pose at export time, for the `olv:camera`
 * provenance chunk. Target and fov are optional because not every caller can
 * honestly supply them (a bare context camera has no orbit target) — absent
 * fields are omitted from the chunk, never fabricated.
 */
export interface FigureCameraPose {
  readonly position: readonly [number, number, number];
  readonly target?: readonly [number, number, number] | null;
  readonly fovDeg?: number;
}

/** The active clip box at export time, for the `olv:clip` provenance chunk. */
export interface FigureClipSummary {
  readonly mode: 'keep-inside' | 'keep-outside';
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/**
 * Everything the Viewer can honestly assert about the live view for a
 * figure's PNG provenance. Fields the app cannot vouch for are null — the
 * provenance builder then omits the corresponding chunk entirely.
 */
export interface FigureViewContext {
  readonly crs: { name: string; unit: string; epsg?: number } | null;
  readonly colorMode: string;
  readonly camera: FigureCameraPose | null;
  readonly clip: FigureClipSummary | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scene adapter — what every exporter needs from the Viewer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A narrow read/write slice of the Viewer that exporters use. Defining it as
 * an interface (rather than importing the full Viewer class) keeps the export
 * module free of a circular dependency on `render/Viewer.ts` and makes every
 * exporter trivially unit-testable with a hand-rolled stub.
 */
export interface ExportSceneAdapter {
  /** Force the runtime colour mode for the duration of a render call. */
  setExportColorMode(mode: ColorMode): void;
  /** The colour mode the runtime was in before the export started. */
  currentColorMode(): ColorMode;
  /** Does any loaded cloud carry per-point RGB? */
  hasRgb(): boolean;
  /** Does any loaded cloud carry per-point intensity? */
  hasIntensity(): boolean;
  /** Does any loaded cloud carry per-point classification? */
  hasClassification(): boolean;
  /**
   * Does any loaded cloud carry per-point normals? Drives the Normal Map
   * exporter's `isAvailable` gate. Streaming COPC + EPT sources never carry
   * normals (LAS/LAZ doesn't reserve a field for them and EPT writers rarely
   * emit them); static loaders (PCD with `_normal_` fields, PTX, GLTF)
   * sometimes do.
   */
  hasNormals(): boolean;
  /**
   * Combined local-space AABB of every loaded cloud as
   * `[minX, minY, minZ, maxX, maxY, maxZ]` in render coordinates, or `null`
   * when no clouds are loaded.
   */
  localBoundsAabb(): readonly [number, number, number, number, number, number] | null;
  /**
   * The live-snapshot pipeline — renders the scene through the active EDL
   * path (matching what the user sees) and optionally composites measurement
   * geometry and annotation markers as SVG overlays. Reused by every Studio
   * exporter so the export is WYSIWYG with the on-screen view.
   */
  snapshot(options: {
    measurements: boolean;
    annotations: boolean;
    /** Bake the active Inspect tool's selected-point marker + info card. */
    inspector: boolean;
    /** Bake the LiveProbe's last-known readout when probe mode is active. */
    probe: boolean;
  }): Promise<Blob>;
  /** Display name of the loaded scan(s) — used in the scan-report card. */
  sourceName(): string;
  /**
   * Total source point count across every loaded cloud (the on-disk count,
   * not the GPU-resident count). For streaming COPC, this is the full source
   * cloud's point total.
   */
  sourcePointCount(): number;
  /** Currently displayed point count (resident on GPU). */
  residentPointCount(): number;
  /**
   * the source CRS name + linear-unit label, when the loaded
   * cloud carries a parseable LASF_Projection VLR. Returns `null` for clouds
   * without recoverable georeference (raw drone exports, PLY, PCD, PTX,
   * GLTF). Surfaced in the scan-report card so the exported PNG records
   * what coordinate system its measurements live in.
   */
  crsLabel(): { name: string; unit: string; epsg?: number } | null;
  /**
   * Capture-type label from the provenance classifier — e.g.
   * "Aerial / airborne LiDAR" or "iPhone / handheld LiDAR", paired with
   * the confidence band the classifier emitted. Returns `null` when no
   * cloud is loaded or the classifier produced no verdict. Surfaced in
   * the scan-report card so the exported PNG records what kind of scan
   * it came from — the same Research-Derived ribbon the Inspector and
   * PDF reports carry. Optional so callers that don't implement it
   * (older tests, simulators) still type-check; the renderer no-ops
   * when undefined.
   */
  captureLabel?(): { label: string; confidence: 'low' | 'medium' | 'high' } | null;
  /**
   * Georeference context for the world-file path (v0.4.5, workplan C4):
   * the load-time world origin (the recentre shift the loaders applied)
   * and the source CRS WKT. Returns null fields when the app cannot
   * honestly assert either — multiple clouds with conflicting origins, a
   * local-frame scan, or no CRS VLR. Optional so older adapters / test
   * stubs keep type-checking; the ortho exporter treats "absent" as
   * "not georeferenceable" and ships the plain WYSIWYG PNG.
   */
  georefContext?(): {
    worldOrigin: { x: number; y: number } | null;
    wkt: string | null;
  } | null;
  /**
   * Render the loaded cloud through a TRUE top-down orthographic camera
   * framing the full XY footprint (north-up, +Y at the image top) and
   * return the capture plus the exact local-frame extent the camera
   * framed. This is the only render an affine world file can describe —
   * the live perspective snapshot cannot be georeferenced. Returns null
   * when no cloud is loaded or the device cannot complete the framed
   * render; the caller falls back to the WYSIWYG snapshot path.
   */
  framedTopDownSnapshot?(options: { widthPx?: number }): Promise<{
    blob: Blob;
    widthPx: number;
    heightPx: number;
    extent: { minX: number; minY: number; maxX: number; maxY: number };
  } | null>;
  /**
   * TRUE offscreen re-render of the LIVE perspective view at an explicit
   * pixel size — the honest-resolution path behind `options.width`/`height`.
   * Unlike `snapshot()` (which can only copy the on-screen drawing buffer,
   * so a "2048 px" request used to silently ship the canvas size), this
   * re-renders the scene with the live camera re-aspected to the target.
   * DIRECT render: no EDL post pass and no overlay bakes — the offscreen
   * pass is bound to a bare scene render. Returns the blob plus the ACTUAL
   * rendered size, or null when the device cannot complete the re-render
   * (caller falls back to the WYSIWYG snapshot and reports its real size).
   * Optional so older adapters / test stubs keep type-checking.
   */
  renderFigure?(options: { widthPx?: number; heightPx?: number }): Promise<{
    blob: Blob;
    widthPx: number;
    heightPx: number;
  } | null>;
  /**
   * The live view facts a figure's PNG provenance chunks record — camera
   * pose, active clip, CRS, colour mode. Optional for the same
   * compatibility reason as above; when absent, the export still embeds
   * build + CRS + colormap provenance from the other adapter methods and
   * simply omits the camera/clip chunks.
   */
  figureViewContext?(): FigureViewContext | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Render context handed to exporters
// ─────────────────────────────────────────────────────────────────────────────

/** What every exporter needs at `render()` time. */
export interface ExportContext {
  /** The live renderer — drives all GPU work. */
  readonly renderer: THREE.WebGPURenderer;
  /** The active scene graph at capture time. */
  readonly scene: THREE.Scene;
  /** The live perspective camera — modes that frame off the user view use it. */
  readonly camera: THREE.PerspectiveCamera;
  /** The on-screen canvas — default capture size, fallback when no aabb. */
  readonly canvas: HTMLCanvasElement;
  /** Narrow adapter into the Viewer for mode swap + capability queries. */
  readonly adapter: ExportSceneAdapter;
  /**
   * Active class-filter scope stamp — e.g.
   * `"Ground + Building · 2 of 5 classes"`. Present ONLY while a class filter
   * hides at least one class at export time. When set, the Studio export
   * draws a "showing N of M classes" banner into the raster so a filtered
   * image is self-describing about the filter it was captured under. Absent /
   * empty for an unfiltered export, in which case the output is byte-identical
   * to the pre-feature image.
   */
  readonly classScopeStamp?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mode-specific options
// ─────────────────────────────────────────────────────────────────────────────

/** The colour ramps supported by the height-map exporter. */
export type HeightMapRamp = 'terrain' | 'grayscale' | 'heatmap' | 'topo';

/** Common options every exporter accepts. */
export interface CommonExportOptions {
  /** Pixel width of the output. Default: live canvas width or 2048 if framed. */
  width?: number;
  /** Pixel height of the output. Default: live canvas height or square if framed. */
  height?: number;
  /** PNG today; WebP in a future release. */
  format?: 'png';
  /**
   * Transparent background instead of a solid colour. NOT HONOURED YET:
   * the live renderer is constructed with `alpha: false`, so every capture
   * path (snapshot copy and offscreen re-render alike) produces opaque
   * pixels. The field stays for API stability, but nothing may advertise it
   * until an offscreen render-target path makes it real — the pre-v0.5.21
   * presets claimed "transparent background" and shipped opaque PNGs.
   */
  transparent?: boolean;
  /**
   * CSS-compatible background colour when `transparent` is false. NOT
   * HONOURED YET, for the same reason as `transparent`: no capture path
   * reads it — the offscreen re-render and the snapshot copy both ship
   * pixels cleared to the scene's own background. The field stays for API
   * stability, but presets must not set it until a capture path actually
   * applies the colour (test-pinned in exportStudio.test.ts).
   */
  background?: string;
  /** Bake measurement overlay into the export. */
  includeMeasurements?: boolean;
  /** Bake annotation markers into the export. */
  includeAnnotations?: boolean;
}

/** Options unique to the orthographic-RGB exporter. */
export interface OrthographicRgbOptions extends CommonExportOptions {
  /** Optional focal distance override (m) — for camera-rig framing. */
  focalDistance?: number;
}

/** Options unique to the height-map exporter. */
export interface HeightMapOptions extends CommonExportOptions {
  /** Colour ramp. Default: `terrain`. */
  ramp?: HeightMapRamp;
}

/** Options unique to the intensity exporter. */
export interface IntensityOptions extends CommonExportOptions {
  /** Invert the grayscale (high = dark). Default: false. */
  invert?: boolean;
  /** Apply histogram normalisation. Default: true. */
  normalize?: boolean;
}

/** Options unique to the classification exporter. */
export interface ClassificationOptions extends CommonExportOptions {
  /** Render a swatch legend alongside the image. Default: false. */
  legend?: boolean;
}

/** options for the depth-map exporter. */
export interface DepthMapOptions extends CommonExportOptions {
  /**
   * When true (default), near = white / far = black. When false, the
   * polarity flips. Off-by-one bit so the same flag works as a literal
   * "invert the grayscale" toggle in the UI.
   */
  invert?: boolean;
  /**
   * Override the depth range to map into the grayscale. When omitted, the
   * exporter uses the active camera's near/far. Useful for QA tasks that
   * compare depth maps across captures.
   */
  nearOverride?: number;
  farOverride?: number;
}

/** options for the normal-map exporter. */
export interface NormalMapOptions extends CommonExportOptions {
  /**
   * When true (default), normals are approximated from a small Gaussian-
   * smoothed depth gradient. When false, raw per-point normals are used
   * (requires the cloud to carry a `normal` attribute — most LiDAR
   * captures don't, so the exporter falls back to the depth-gradient
   * approximation regardless if `cloud.hasNormals === false`).
   */
  smooth?: boolean;
}

/** colour palette presets the height-map + contour exporters share. */
export type LegendPalette = 'terrain' | 'heatmap' | 'topographic' | 'grayscale';

/** options for the contour exporter. */
export interface ContourOptions extends CommonExportOptions {
  /** Vertical interval between major contour lines, in metres. Default: 5. */
  interval?: number;
  /** Show elevation labels along contour lines. Default: true. */
  labels?: boolean;
  /** Overlay the contours over the height-map raster (or transparent). Default: 'transparent'. */
  overlay?: 'transparent' | 'height-map' | 'rgb';
  /** Colour palette for the underlying raster when overlay !== 'transparent'. */
  palette?: LegendPalette;
}

/** Union of all mode-specific options. */
export type ExportOptions =
  | OrthographicRgbOptions
  | HeightMapOptions
  | IntensityOptions
  | ClassificationOptions
  | DepthMapOptions
  | NormalMapOptions
  | ContourOptions
  | CommonExportOptions;

// ─────────────────────────────────────────────────────────────────────────────
// Result + factory contract
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything the host needs to package a top-down ortho PNG with its
 * `.pgw` + `.prj` sidecars (`buildStudioPngPackage` in
 * `render/export/pngWorldFile.ts`). Present ONLY when the raster was a
 * true top-down orthographic framing AND both the world origin and the
 * CRS WKT are known — a world file on a perspective snapshot would lie.
 */
export interface ExportWorldFile {
  /** Local-frame extent the orthographic camera framed exactly. */
  readonly extent: {
    readonly minX: number;
    readonly minY: number;
    readonly maxX: number;
    readonly maxY: number;
  };
  /** Raster size in pixels — the world file's per-pixel scale divisors. */
  readonly widthPx: number;
  readonly heightPx: number;
  /** Load-time world origin to add back (mirrors the DEM package). */
  readonly worldOrigin: { readonly x: number; readonly y: number };
  /** Horizontal CRS WKT for the `.prj` sidecar. */
  readonly wkt: string;
}

/** The structured product of one export — handed back for download. */
export interface ExportResult {
  blob: Blob;
  mode: ExportMode;
  width: number;
  height: number;
  /** MIME type matching `format` — handy for the filename / download dialog. */
  mimeType: string;
  /** Free-form details an exporter may surface (e.g. minZ/maxZ for height map). */
  metadata?: Readonly<Record<string, number | string>>;
  /**
   * World-file sidecar data (v0.4.5) — when present, the host downloads
   * a `PNG + .pgw + .prj` ZIP instead of the bare PNG so GIS tools place
   * the raster. Absent on every non-georeferenceable export.
   */
  worldFile?: ExportWorldFile;
}

/** Reason an exporter is unavailable on this device + cloud. */
export interface ExportUnavailableReason {
  readonly mode: ExportMode;
  readonly reason: string;
}

/** One mode in the registry. */
export interface ExportFactory {
  readonly mode: ExportMode;
  /** Human-readable label shown in the Studio panel. */
  readonly label: string;
  /**
   * Capability gate. Returns true when this mode can run against the given
   * context. Exporters MUST be conservative — if the data isn't there, this
   * returns false so the UI disables the option with an explicit message
   * instead of silently producing a blank image.
   */
  isAvailable(context: ExportContext): boolean;
  /** Human-readable reason when `isAvailable` returns false. */
  unavailableReason?(context: ExportContext): string;
  /** Produce the exported image. */
  render(context: ExportContext, options: ExportOptions): Promise<ExportResult>;
}
