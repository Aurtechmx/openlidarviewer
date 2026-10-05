/**
 * measurementScanHooks.ts — the active-scan facts the measurement exports read:
 * the classification epoch for the integrity report, and the point basis and
 * class-edit state for the CSV's provenance sidecar.
 *
 * Kept out of the composition root so `main.ts` wires both with one spread.
 */

import { displaySampleOf } from '../export/exportSummary';
import { classesEdited, pointBasisOf } from '../export/exportProvenanceLines';

/** The active scan's point basis and class-edit state. */
export interface ActiveScanBasis {
  readonly pointBasis: string;
  readonly classesEdited: boolean;
}

/** The slice of a loaded cloud the hooks read. */
export interface ScanBasisCloud {
  readonly pointCount: number;
  readonly declaredPointCount?: number;
  readonly sourceDeclaredPointCount?: number;
  readonly classificationProvenance: string;
}

export interface MeasurementScanHookInput {
  readonly scans: { readonly activeId: string | null };
  readonly viewer: {
    getCloud(id: string): ScanBasisCloud | undefined;
    classificationEpoch(id: string): number;
  };
  /** Scan ids loaded as a display sample of a larger file. */
  readonly reduced: ReadonlyMap<string, boolean>;
}

/** The point basis and class-edit state of the active scan, or null with none active. */
export function activeScanBasisOf(input: MeasurementScanHookInput): ActiveScanBasis | null {
  const id = input.scans.activeId;
  if (id == null) return null;
  const cloud = input.viewer.getCloud(id);
  if (!cloud) return null;
  const sample = displaySampleOf(cloud);
  const pointBasis = pointBasisOf({
    pointCount: cloud.pointCount,
    reduced: input.reduced.get(id) === true,
    declaredPointCount: sample.source,
  });
  const edited = classesEdited({ provenance: cloud.classificationProvenance, editEpoch: input.viewer.classificationEpoch(id) });
  return { pointBasis, classesEdited: edited };
}

/** Both hooks, spread into the measurement-export deps. */
export function measurementScanHooks(input: MeasurementScanHookInput): {
  activeClassificationEpoch: () => number;
  activeScanBasis: () => ActiveScanBasis | null;
} {
  return {
    activeClassificationEpoch: () => {
      const id = input.scans.activeId;
      return id ? input.viewer.classificationEpoch(id) : 0;
    },
    activeScanBasis: () => activeScanBasisOf(input),
  };
}
