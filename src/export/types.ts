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

// Legacy alias retained so any downstream import that still reaches for
// `ImageExportMode` keeps compiling.
/** @deprecated Use {@link ExportMode}. */
export type ImageExportMode = ExportMode;

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
}

/**
 * @deprecated Use {@link ExportContext}. The legacy alias remains so existing
 * downstream image-export consumers continue to type-check.
 */
export type ImageExportContext = ExportContext;

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
  /** Transparent background instead of a solid colour. */
  transparent?: boolean;
  /** CSS-compatible background colour when `transparent` is false. */
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

/**
 * @deprecated Use {@link CommonExportOptions} or a mode-specific variant.
 */
export type ImageExportOptions = CommonExportOptions;

// ─────────────────────────────────────────────────────────────────────────────
// Result + factory contract
// ─────────────────────────────────────────────────────────────────────────────

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
}

/**
 * @deprecated Use {@link ExportResult}.
 */
export type ImageExportResult = ExportResult;

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

/** @deprecated Use {@link ExportFactory}. */
export type ImageExportFactory = ExportFactory;
