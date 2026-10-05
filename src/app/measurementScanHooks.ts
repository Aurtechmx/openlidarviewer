/**
 * measurementScanHooks.ts — the active scan's point basis and class-edit
 * state, for the measurement CSV's provenance sidecar.
 *
 * Read from the export frame's own source reference (the loaded cloud, or the
 * streaming snapshot) and the active scan's classification epoch, both of
 * which the measurement-export deps already carry.
 */

import { pointBasisLine } from '../export/exportSummary';
import { classesEdited } from '../export/exportProvenanceLines';

/** The active scan's point basis and class-edit state. */
export interface ActiveScanBasis {
  readonly pointBasis: string;
  readonly classesEdited: boolean;
}

/** The fields a loaded cloud or a streaming snapshot may carry. */
interface SourceCounts {
  readonly pointCount?: number;
  readonly sourceDeclaredPointCount?: number;
  readonly declaredPointCount?: number;
  readonly classificationProvenance?: string;
  readonly residentPointCount?: number;
  readonly sourcePointCount?: number | null;
}

const finite = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

/** "Point basis: …" for a loaded cloud (display sample when the file declares more) or a streaming snapshot. */
function basisLine(c: SourceCounts, streamed: boolean): string | null {
  if (streamed) {
    if (!finite(c.residentPointCount)) return null;
    const total = finite(c.sourcePointCount) ? c.sourcePointCount : null;
    if (total !== null && c.residentPointCount >= total) return pointBasisLine(true, total, null);
    return pointBasisLine(false, c.residentPointCount, total);
  }
  if (!finite(c.pointCount)) return null;
  const declared = c.sourceDeclaredPointCount ?? c.declaredPointCount;
  if (finite(declared) && declared > c.pointCount) return pointBasisLine(false, c.pointCount, declared);
  return pointBasisLine(true, c.pointCount, null);
}

/**
 * The basis of the scan the export frame names, or null when the frame has no
 * source. A streaming snapshot carries no class provenance, so its codes count
 * as the source's unless the edit epoch moved.
 */
export function activeScanBasisOf(
  source: { readonly key: object; readonly streamed: boolean } | undefined,
  editEpoch: number,
): ActiveScanBasis | null {
  if (!source) return null;
  const c = source.key as SourceCounts;
  const pointBasis = basisLine(c, source.streamed);
  if (pointBasis === null) return null;
  const provenance = c.classificationProvenance ?? 'source';
  return { pointBasis, classesEdited: classesEdited({ provenance, editEpoch }) };
}
