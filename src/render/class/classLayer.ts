/**
 * classLayer.ts
 *
 * Clear classifications and Restore earlier classes: the two whole-scan
 * edits of the working class layer. Both run through the Viewer's recorded
 * edit, so a single Undo brings back exactly the codes held before, and both
 * move the layer's provenance with the codes ('cleared' / 'source').
 *
 * Clearing writes class 1 (Unclassified) to every point. It never touches the
 * classification FLAGS (synthetic, key-point, withheld, overlap), which stay
 * read-only on the cloud, so a withheld point stays withheld.
 *
 * The first whole-scan replace keeps a copy of the codes it replaced (one byte
 * per point, see `PointCloud.originalClassification`), hand edits made before
 * it included; Restore earlier classes writes that copy back. Lives in the lazy
 * class-edit chunk; the Viewer holds only the generic recorded edit.
 */

import type { ClassState, ClassificationState } from '../../model/PointCloud';

/**
 * What the heuristic classifier does and does not find, stated wherever it
 * runs. A predicate: callers put "Auto-classify" or "It" in front.
 */
export const AUTO_CLASSIFY_LIMITS =
  'finds ground, vegetation and buildings only (buildings by a heuristic); ' +
  'no wires, poles, water, bridges or noise.';

/** Said when a whole-scan class action is asked of a scan that is not resident. */
export const NEEDS_LOADED_SCAN = 'needs a fully loaded scan and does not run on a streaming one.';

/** ASPRS class 1, Unclassified: what Clear writes to every point. */
export const UNCLASSIFIED = 1;

/** The cloud surface Clear and Restore read. */
export interface ClassLayerCloud {
  readonly classification?: Uint8Array;
  readonly classificationProvenance: ClassificationState;
  readonly originalClassification?: Uint8Array;
}

/** The host surface: the Viewer's cloud lookup and its recorded edit. */
export interface ClassLayerHost {
  getCloud(id: string): ClassLayerCloud | undefined;
  editClassification(id: string, edit: (buf: Uint8Array) => void, to?: ClassState): void;
}

/** Why a whole-scan class action did not run, or 'ok' when it did. */
export type ClassLayerOutcome = 'ok' | 'not-loaded' | 'no-classification' | 'already' | 'no-original';

/** Set every point of the active cloud to class 1, recorded for Undo. */
export function clearClassification(host: ClassLayerHost, id: string): ClassLayerOutcome {
  const cloud = host.getCloud(id);
  if (!cloud) return 'not-loaded';
  if (!cloud.classification) return 'no-classification';
  if (cloud.classificationProvenance === 'cleared') return 'already';
  host.editClassification(id, (buf) => buf.fill(UNCLASSIFIED), 'cleared');
  return 'ok';
}

/** Whether Restore earlier classes has something to bring back. */
export function canRestoreOriginal(cloud: ClassLayerCloud | undefined): boolean {
  return !!cloud?.originalClassification && cloud.classificationProvenance !== 'source';
}

/** Write the kept original codes back, recorded for Undo. */
export function restoreOriginalClassification(host: ClassLayerHost, id: string): ClassLayerOutcome {
  const cloud = host.getCloud(id);
  if (!cloud) return 'not-loaded';
  const original = cloud.originalClassification;
  if (!original || !canRestoreOriginal(cloud)) return 'no-original';
  host.editClassification(id, (buf) => buf.set(original), 'source');
  return 'ok';
}
