/**
 * formatInfo.ts
 *
 * Lightweight, pure facts about each supported point-cloud format — a display
 * label, whether it is a line-text format, and whether its header reveals a
 * point count. Deliberately separate from `loaderRegistry.ts`: this module
 * imports no decoder, so the preflight and the main-thread UI can read format
 * facts without pulling every heavy loader (laz-perf, PCDLoader, loaders.gl)
 * into the main bundle.
 *
 * Pure data — no DOM, no three.js, no loaders.
 */

import type { SourceFormat } from './sniffFormat';

/** Facts the pipeline and the UI need about a format, with no decoder attached. */
export interface FormatInfo {
  /** Human-readable label for the preload summary, e.g. "LAS scan". */
  label: string;
  /**
   * True for whitespace/line text formats — drives the chunked-text parsing
   * path and the "this is a text cloud" preflight wording.
   */
  isText: boolean;
  /**
   * True when the format's header reveals a point count before the body is
   * decoded (LAS/LAZ). Used to size the budget-aware preflight.
   */
  hasHeaderCount: boolean;
}

/** Per-format facts — one entry per decodable format. */
const FORMAT_INFO: Record<SourceFormat, FormatInfo> = {
  las: { label: 'LAS scan', isText: false, hasHeaderCount: true },
  laz: { label: 'LAZ scan', isText: false, hasHeaderCount: true },
  e57: { label: 'E57 scan', isText: false, hasHeaderCount: false },
  ply: { label: 'PLY cloud', isText: false, hasHeaderCount: false },
  obj: { label: 'OBJ model', isText: false, hasHeaderCount: false },
  glb: { label: 'glTF model', isText: false, hasHeaderCount: false },
  gltf: { label: 'glTF model', isText: false, hasHeaderCount: false },
  xyz: { label: 'XYZ / CSV cloud', isText: true, hasHeaderCount: false },
  pcd: { label: 'PCD cloud', isText: false, hasHeaderCount: false },
  // PTX is text, but its per-scan block structure is not line-uniform, so it
  // is decoded whole rather than through the chunked line reader.
  ptx: { label: 'PTX scan', isText: false, hasHeaderCount: false },
  pts: { label: 'PTS scan', isText: true, hasHeaderCount: false },
};

/** The facts for a format. Throws on an unregistered format. */
export function formatInfo(format: SourceFormat): FormatInfo {
  const info = FORMAT_INFO[format];
  if (!info) throw new Error(`No format info registered for: ${String(format)}`);
  return info;
}

/** Whether a string names a registered, decodable format. */
export function isRegisteredFormat(format: string): format is SourceFormat {
  return Object.prototype.hasOwnProperty.call(FORMAT_INFO, format);
}

/** Every registered format, for tests and diagnostics. */
export function registeredFormats(): SourceFormat[] {
  return Object.keys(FORMAT_INFO) as SourceFormat[];
}
