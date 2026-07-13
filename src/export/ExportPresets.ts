/**
 * ExportPresets.ts
 *
 * Curated one-click bundles of `mode + options` for the Visual Export Studio.
 * Each preset is a pure data record — no runtime — so the Studio panel can
 * list them as buttons and the orchestrator can apply them straight to
 * `renderExport`.
 *
 * The presets are the "show me what this thing does" moment for new users:
 * the first time someone opens the Studio, they don't yet know what mode +
 * options combination is going to look right. The presets pick reasonable
 * defaults for the four high-frequency use cases we hear from professional
 * users.
 */

import type {
  ClassificationOptions,
  ExportMode,
  ExportOptions,
  HeightMapOptions,
  IntensityOptions,
  NormalMapOptions,
  OrthographicRgbOptions,
} from './types';

/** One bundled preset — mode + options + a short description. */
export interface ExportPreset {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly mode: ExportMode;
  readonly options: ExportOptions;
}

// Honesty rules the presets below obey — a preset's description is a promise,
// and every option it sets must actually flow through the pipeline:
//
//   • No preset sets or advertises `transparent`. The live renderer is
//     constructed with `alpha: false`, so a transparent export is IMPOSSIBLE
//     today; the old "transparent background" preset shipped an opaque PNG.
//     Transparency returns when an offscreen render-target path lands.
//   • An explicit `width` means a TRUE re-render at that size
//     (`adapter.renderFigure` via `runStudioExport`) — a direct render that
//     cannot bake measurement/annotation overlays. Presets therefore either
//     request a size (with overlays off) or bake overlays (at the live
//     view's resolution), never both.
//   • No preset sets `background`. The field has zero consumers — the
//     offscreen re-render and the snapshot copy both ship pixels cleared to
//     the scene's own background — so a preset colour would be exactly the
//     promise-the-pixels-ignore mistake the transparent flag made. The
//     field survives on CommonExportOptions for API stability; presets may
//     touch it only once a capture path actually applies the colour.

const terrainReview: ExportPreset = {
  id: 'terrain-review',
  label: 'Terrain Review',
  description: 'Elevation colouring of the current view, re-rendered at a true 2048 px width.',
  mode: 'height-map',
  options: {
    ramp: 'terrain',
    width: 2048,
    includeAnnotations: false,
    includeMeasurements: false,
  } satisfies HeightMapOptions,
};

const qaInspection: ExportPreset = {
  id: 'qa-inspection',
  label: 'QA Inspection',
  description: 'Classification map at the live view resolution with annotations + measurements baked in.',
  mode: 'classification',
  options: {
    includeAnnotations: true,
    includeMeasurements: true,
    legend: true,
  } satisfies ClassificationOptions,
};

const classificationReview: ExportPreset = {
  id: 'classification-review',
  label: 'Classification Review',
  description: 'High-res classification re-rendered at a true 4096 px width, with the ASPRS legend.',
  mode: 'classification',
  options: {
    width: 4096,
    includeAnnotations: false,
    includeMeasurements: false,
    legend: true,
  } satisfies ClassificationOptions,
};

const technicalReport: ExportPreset = {
  id: 'technical-report',
  label: 'Technical Report',
  description: 'RGB capture of the current view at the live resolution with annotations + measurements baked in.',
  mode: 'orthographic-rgb',
  options: {
    includeAnnotations: true,
    includeMeasurements: true,
  } satisfies OrthographicRgbOptions,
};

const intensityScan: ExportPreset = {
  id: 'intensity-scan',
  label: 'Intensity Scan',
  description: 'Grayscale intensity re-rendered at a true 2048 px width with histogram normalisation.',
  mode: 'intensity',
  options: {
    width: 2048,
    includeAnnotations: false,
    includeMeasurements: false,
    normalize: true,
    invert: false,
  } satisfies IntensityOptions,
};

const normalQa: ExportPreset = {
  id: 'normal-qa',
  label: 'Normal Map (QA)',
  description: 'RGB-encoded surface normals re-rendered at a true 2048 px width. Requires per-point normals (PCD / PTX / GLTF).',
  mode: 'normal',
  options: {
    width: 2048,
    includeAnnotations: false,
    includeMeasurements: false,
    smooth: true,
  } satisfies NormalMapOptions,
};

// Depth and contour presets intentionally absent. Their underlying modes
// are not registered in the default export registry yet (see
// `export/index.ts`); restoring the presets is part of the proper depth-
// buffer + marching-squares contour implementation in a future release.

/** The full preset catalogue, in default display order. */
export const EXPORT_PRESETS: readonly ExportPreset[] = [
  terrainReview,
  qaInspection,
  classificationReview,
  technicalReport,
  intensityScan,
  normalQa,
];

/** Look up a preset by id, or `undefined` if unknown. */
export function getExportPreset(id: string): ExportPreset | undefined {
  return EXPORT_PRESETS.find((p) => p.id === id);
}
