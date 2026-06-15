/**
 * preloadSummary.ts
 *
 * Builds the universal "file understood" summary shown before a decode begins.
 * It is driven entirely by {@link SourceMetadata} — the cheap preflight — so
 * every format, not just LAS/LAZ, shows what the viewer detected: the format,
 * the source size, the point count where the header reveals one, and the
 * chosen load mode. Seeing the viewer recognise the file before it works is
 * what makes a professional load feel trustworthy.
 *
 * Pure — no DOM, no three.js — unit-tested in Node.
 */

import type { SourceMetadata } from './PointCloudSource';
import { formatPointCount } from './loadPlan';
// Re-exported for back-compat: existing callers import formatByteSize from here.
// The implementation now lives in its own leaf module so the UI panels can
// share it without pulling in loadPlan.
export { formatByteSize } from './formatByteSize';
import { formatByteSize } from './formatByteSize';

/**
 * The preload-summary lines for a source's metadata — what the viewer detected
 * about the file before committing to the decode. Always at least the format
 * and the size; the point count and load mode are added when the metadata
 * reveals them.
 */
export function buildPreloadSummary(meta: SourceMetadata): string[] {
  const lines = [`${meta.label} detected`];
  if (meta.estimatedPointCount !== undefined) {
    lines.push(`${formatPointCount(meta.estimatedPointCount)} source points`);
  }
  lines.push(formatByteSize(meta.byteSize));
  if (meta.loadModeSummary) lines.push(meta.loadModeSummary);
  return lines;
}
