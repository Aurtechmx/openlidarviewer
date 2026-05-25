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

/** Render a byte count compactly: 12_400_000 → "11.8 MB". */
export function formatByteSize(bytes: number): string {
  const v = Math.max(0, bytes);
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(1)} GB`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${Math.round(v)} B`;
}

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
