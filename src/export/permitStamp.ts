/**
 * permitStamp.ts
 *
 * The single mapping from an evidence-gate permit to the file-borne provenance
 * stamp, in its OWN leaf module with type-only imports.
 *
 * Why a leaf: the eager startup shell (AnalysePanel) needs to stamp a permit
 * into export provenance, but the permit RESOLVER (`resolveContourExportPermit`)
 * drags the whole evidence registry into whatever imports it. Housing the stamp
 * mapping here — which needs no runtime dependency, only the two types — lets the
 * shell import it eagerly for near-zero cost while the resolver stays behind the
 * lazy Contour Studio boundary.
 */

import type { ContourExportPermit } from './contourExportPermit';
import type { ExportPermitStamp } from '../terrain/export/exportProvenance';

/**
 * Map a permit to the provenance stamp, or null when the permit is absent /
 * blocked. Pure property reads — no imported runtime values — so this module
 * has no runtime dependencies and never pulls the resolver into the eager bundle.
 */
export function permitStamp(permit: ContourExportPermit | null): ExportPermitStamp | null {
  if (!permit || !permit.ok) return null;
  const d = permit.decision;
  return {
    status: d.status,
    label: d.badge,
    watermark: d.status === 'exploratory' ? d.watermark : null,
    caveats: d.caveats,
  };
}
