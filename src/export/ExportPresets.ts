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
  ContourOptions,
  DepthMapOptions,
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

const terrainReview: ExportPreset = {
  id: 'terrain-review',
  label: 'Terrain Review',
  description: 'Top-down elevation map at 2048 px, transparent background.',
  mode: 'height-map',
  options: {
    ramp: 'terrain',
    width: 2048,
    transparent: true,
    includeAnnotations: false,
    includeMeasurements: false,
  } satisfies HeightMapOptions,
};

const qaInspection: ExportPreset = {
  id: 'qa-inspection',
  label: 'QA Inspection',
  description: 'Classification map at 2048 px with annotations + measurements baked in.',
  mode: 'classification',
  options: {
    width: 2048,
    transparent: false,
    background: '#ffffff',
    includeAnnotations: true,
    includeMeasurements: true,
    legend: true,
  } satisfies ClassificationOptions,
};

const classificationReview: ExportPreset = {
  id: 'classification-review',
  label: 'Classification Review',
  description: 'High-res 4096 px classification with the ASPRS legend.',
  mode: 'classification',
  options: {
    width: 4096,
    transparent: false,
    background: '#ffffff',
    includeAnnotations: false,
    includeMeasurements: false,
    legend: true,
  } satisfies ClassificationOptions,
};

const technicalReport: ExportPreset = {
  id: 'technical-report',
  label: 'Technical Report',
  description: 'Orthographic RGB of the current view at 2048 px, opaque.',
  mode: 'orthographic-rgb',
  options: {
    width: 2048,
    transparent: false,
    background: '#ffffff',
    includeAnnotations: true,
    includeMeasurements: true,
  } satisfies OrthographicRgbOptions,
};

const intensityScan: ExportPreset = {
  id: 'intensity-scan',
  label: 'Intensity Scan',
  description: 'Top-down grayscale intensity at 2048 px with histogram normalisation.',
  mode: 'intensity',
  options: {
    width: 2048,
    transparent: false,
    background: '#000000',
    normalize: true,
    invert: false,
  } satisfies IntensityOptions,
};

// three new presets covering the new exporters.

const depthMl: ExportPreset = {
  id: 'depth-ml',
  label: 'Depth (ML)',
  description: 'Top-down depth raster at 2048 px, near = white. ML / QA / geometry review.',
  mode: 'depth',
  options: {
    width: 2048,
    transparent: false,
    background: '#000000',
    invert: false,
  } satisfies DepthMapOptions,
};

const normalQa: ExportPreset = {
  id: 'normal-qa',
  label: 'Normal Map (QA)',
  description: 'RGB-encoded surface normals at 2048 px. Requires per-point normals (PCD / PTX / GLTF).',
  mode: 'normal',
  options: {
    width: 2048,
    transparent: false,
    background: '#808080',
    smooth: true,
  } satisfies NormalMapOptions,
};

const contourReview: ExportPreset = {
  id: 'contour-review',
  label: 'Contour Review',
  description: 'Topographic contours at 5 m intervals over the elevation raster, 2048 px.',
  mode: 'contour',
  options: {
    width: 2048,
    transparent: false,
    background: '#ffffff',
    interval: 5,
    labels: true,
    overlay: 'height-map',
    palette: 'topographic',
  } satisfies ContourOptions,
};

/** The full preset catalogue, in default display order. */
export const EXPORT_PRESETS: readonly ExportPreset[] = [
  terrainReview,
  qaInspection,
  classificationReview,
  technicalReport,
  intensityScan,
  depthMl,
  normalQa,
  contourReview,
];

/** Look up a preset by id, or `undefined` if unknown. */
export function getExportPreset(id: string): ExportPreset | undefined {
  return EXPORT_PRESETS.find((p) => p.id === id);
}
