/**
 * contourDownload.ts
 *
 * Integration helper — turn a contour feature model into a downloadable
 * file. The serialisation half is pure data (testable); the browser
 * trigger half is a thin, guarded DOM call kept separate so everything
 * worth testing stays testable.
 *
 * Formats: GeoJSON (cheapest real downstream path), SVG (print), DXF
 * (CAD). PDF is produced by the report subsystem, not here.
 */

import type { ContourFeatureModel } from './contourFeatureModel';
import type { ContourLabel } from './labelPlacement';
import { geojsonString } from './geojsonContours';
import { svgContours } from './svgContours';
import { dxfContours } from './dxfContours';

/** Supported pure-data export formats. */
export type ContourFormat = 'geojson' | 'svg' | 'dxf';

/** A serialised file ready to download. */
export interface ContourFile {
  readonly filename: string;
  readonly mime: string;
  readonly content: string;
}

const EXT: Record<ContourFormat, string> = { geojson: 'geojson', svg: 'svg', dxf: 'dxf' };
const MIME: Record<ContourFormat, string> = {
  geojson: 'application/geo+json',
  svg: 'image/svg+xml',
  dxf: 'application/dxf',
};

/** Serialise a model to a named file in the requested format. Pure data. */
export function serializeContours(
  model: ContourFeatureModel,
  format: ContourFormat,
  opts: { basename?: string; labels?: ReadonlyArray<ContourLabel> } = {},
): ContourFile {
  const basename = opts.basename ?? 'contours';
  let content: string;
  switch (format) {
    case 'geojson':
      content = geojsonString(model);
      break;
    case 'svg':
      content = svgContours(model, { labels: opts.labels });
      break;
    case 'dxf':
      content = dxfContours(model);
      break;
  }
  return { filename: `${basename}.${EXT[format]}`, mime: MIME[format], content };
}

/**
 * Trigger a browser download for a serialised file. DOM-only; no-op
 * outside a browser (returns false so callers can detect it). Kept out
 * of the pure path on purpose.
 */
export function triggerBrowserDownload(file: ContourFile): boolean {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
    return false;
  }
  const blob = new Blob([file.content], { type: file.mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return true;
}
