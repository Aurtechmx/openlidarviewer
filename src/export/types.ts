/**
 * export/types.ts
 *
 * v0.3.2 Visual Export Studio — pure types and contracts.
 *
 * The Studio is the user-facing image-export surface: take the live scan and
 * produce a publication-ready PNG of one of four "modes" — orthographic RGB,
 * height map, intensity, or classification. Every mode shares this contract;
 * only the body of `render()` differs.
 *
 * The Studio is lazy-loaded — these types are the type-only edge the rest of
 * the codebase imports without pulling in any rendering code. They contain no
 * DOM, no three.js, and no Viewer reference (only a narrow adapter interface).
 *
 * v0.3.2 → ships orthographic-rgb, height-map, intensity, classification.
 * v0.3.3 → adds depth, contours, normals to this same surface.
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
  /** Reserved for v0.3.3 — declared so the registry slot is type-stable. */
  | 'depth';

// Legacy alias retained for one release so any downstream import that still
// reaches for `ImageExportMode` keeps compiling. Removed in v0.3.3.
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
   * v0.3.2-Georef — the source CRS name + linear-unit label, when the loaded
   * cloud carries a parseable LASF_Projection VLR. Returns `null` for clouds
   * without recoverable georeference (raw drone exports, PLY, PCD, PTX,
   * GLTF). Surfaced in the scan-report card so the exported PNG records
   * what coordinate system its measurements live in.
   */
  crsLabel(): { name: string; unit: string; epsg?: number } | null;
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
 * @deprecated Use {@link ExportContext}. The legacy alias remains for a single
 * release so the v0.3.2 image-export consumers continue to type-check while
 * the rename to Studio rolls out.
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

/** Union of all mode-specific options. */
export type ExportOptions =
  | OrthographicRgbOptions
  | HeightMapOptions
  | IntensityOptions
  | ClassificationOptions
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
