/**
 * export/index.ts
 *
 * Visual Export Studio — barrel module + default registry + orchestrator.
 *
 * The Viewer imports this through `loadExportStudio()` so the Studio's
 * implementations land in their own code-split chunk, never the initial
 * bundle. The registry below pre-registers every mode the Studio ships:
 * orthographic-rgb, height-map, intensity, classification, depth, normal,
 * contour.
 *
 * Consumers call `renderExport(mode, context, options)` — the orchestrator
 * looks up the factory, gates on `isAvailable`, and forwards to `render`.
 * The registry is exported too for the Studio panel's "available / disabled
 * modes" listing.
 */

export { ExportRegistry, ImageExportRegistry } from './ExportRegistry';
export {
  captureCanvasToBlob,
  topDownOrthoCameraForAabb,
  withColorMode,
  baseReportRows,
  buildScanReport,
  runStudioExport,
} from './BaseExportMode';
export {
  blobToImage,
  composeScanReportOntoBlob,
  drawScanReport,
  formatInt,
  formatMetres,
  formatTimestamp,
  measureScanReport,
} from './ScanReportRenderer';
export type {
  ScanReportCorner,
  ScanReportData,
  ScanReportRow,
} from './ScanReportRenderer';
export type {
  CommonExportOptions,
  ClassificationOptions,
  ExportContext,
  ExportFactory,
  ExportMode,
  ExportOptions,
  ExportResult,
  ExportSceneAdapter,
  ExportUnavailableReason,
  HeightMapOptions,
  HeightMapRamp,
  ImageExportContext,
  ImageExportFactory,
  ImageExportMode,
  ImageExportOptions,
  ImageExportResult,
  IntensityOptions,
  OrthographicRgbOptions,
} from './types';
export { orthographicRgbExporter, orthoCameraForPerspective } from './OrthographicRgbExporter';
export { heightMapExporter, HEIGHT_MAP_RAMPS, HEIGHT_MAP_RESOLUTIONS } from './HeightMapExporter';
export { intensityExporter } from './IntensityExporter';
export { classificationExporter } from './ClassificationExporter';
export { depthMapExporter } from './DepthMapExporter';
export { normalMapExporter } from './NormalMapExporter';
export { contourMapExporter } from './ContourMapExporter';
export {
  asprsLabel,
  DEFAULT_LEGEND_CODES,
  measureLegend,
  renderLegend,
} from './ExportLegendRenderer';
export type { LegendSwatch } from './ExportLegendRenderer';
export { EXPORT_PRESETS, getExportPreset } from './ExportPresets';
export type { ExportPreset } from './ExportPresets';

import { ExportRegistry } from './ExportRegistry';
import type {
  ExportContext,
  ExportMode,
  ExportOptions,
  ExportResult,
} from './types';
import { orthographicRgbExporter } from './OrthographicRgbExporter';
import { heightMapExporter } from './HeightMapExporter';
import { intensityExporter } from './IntensityExporter';
import { classificationExporter } from './ClassificationExporter';
import { depthMapExporter } from './DepthMapExporter';
import { normalMapExporter } from './NormalMapExporter';
import { contourMapExporter } from './ContourMapExporter';

/**
 * The default registry, pre-populated with every Studio mode.
 */
export const defaultExportRegistry = new ExportRegistry();
defaultExportRegistry.register(orthographicRgbExporter);
defaultExportRegistry.register(heightMapExporter);
defaultExportRegistry.register(intensityExporter);
defaultExportRegistry.register(classificationExporter);
defaultExportRegistry.register(depthMapExporter);
defaultExportRegistry.register(normalMapExporter);
defaultExportRegistry.register(contourMapExporter);

/** @deprecated Use {@link defaultExportRegistry}. */
export const defaultImageExportRegistry = defaultExportRegistry;

/**
 * Orchestrator: pick the factory, gate on availability, render. Throws a
 * clear error when the mode is unknown or unavailable on this device so the
 * Studio panel's error UX has something specific to surface. Defaults to
 * the singleton registry above.
 */
export async function renderExport(
  mode: ExportMode,
  context: ExportContext,
  options: ExportOptions = {},
  registry: ExportRegistry = defaultExportRegistry,
): Promise<ExportResult> {
  const factory = registry.get(mode);
  if (!factory) {
    throw new Error(`renderExport: unknown mode "${mode}"`);
  }
  if (!factory.isAvailable(context)) {
    const reason = factory.unavailableReason?.(context) ?? 'unavailable on this cloud';
    throw new Error(`renderExport: mode "${mode}" is not available — ${reason}`);
  }
  return factory.render(context, options);
}

/** @deprecated Use {@link renderExport}. */
export const renderImageExport = renderExport;
