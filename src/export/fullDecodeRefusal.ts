/**
 * fullDecodeRefusal.ts: when a full-resolution re-decode is not the full file.
 *
 * The single export and the batch converter both judge a re-decode here, so a
 * strided, truncated or short decode is refused the same way in each.
 */

import { compactPointCount } from '../terrain/datasetIntelligence';

/**
 * The refusal for a full-resolution re-decode that did not read every point,
 * or null when it did. Three shortfalls count: a strided decode, a file that
 * ended before its declared count (`metadata.truncation`), and a decode that
 * holds fewer points than it declares. Such a cloud is never written or
 * labelled as the full file.
 */
export function fullDecodeRefusal(cloud: {
  readonly pointCount: number;
  readonly loadStride?: number;
  readonly declaredPointCount?: number;
  readonly metadata?: { readonly truncation?: { readonly read: number; readonly declared: number } } | null;
}): string | null {
  const stride = cloud.loadStride ?? 1;
  if (stride > 1) {
    const of = cloud.declaredPointCount !== undefined ? ` of ${compactPointCount(cloud.declaredPointCount)}` : '';
    return `The full-resolution re-decode read ${compactPointCount(cloud.pointCount)}${of} points (one record in ${stride}) to fit memory, so nothing was exported.`;
  }
  const t = cloud.metadata?.truncation;
  if (t && t.read < t.declared) {
    return `The source file ends after ${compactPointCount(t.read)} of its ${compactPointCount(t.declared)} declared points, so nothing was exported as the full file.`;
  }
  const declared = cloud.declaredPointCount;
  if (declared !== undefined && cloud.pointCount < declared) {
    return `The full-resolution re-decode read ${compactPointCount(cloud.pointCount)} of ${compactPointCount(declared)} declared points, so nothing was exported as the full file.`;
  }
  return null;
}
