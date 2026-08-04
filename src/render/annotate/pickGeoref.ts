/**
 * pickGeoref.ts
 *
 * Turns a picked cloud + point index into the world-frame fields an annotation
 * carries: the survey `worldPosition` (local + the cloud's source origin), the
 * owning `layerId`, and an optional CRS label.
 *
 * Pure: it depends on a structural `AnnotationPickCloud` surface, not on the
 * concrete `PointCloud` (which pulls in three.js-adjacent code), so this stays
 * Node-testable alongside the rest of the annotation model. The real
 * `PointCloud` satisfies the surface structurally — `worldXYZ(index)` folds the
 * cloud's own `sourceOrigin`, exactly what `Viewer._infoForHit` already uses.
 */

import type { Vec3Object } from './types';

/**
 * The minimal cloud surface the annotation layer needs to georeference a pick.
 * `PointCloud` satisfies this structurally.
 */
export interface AnnotationPickCloud {
  /** Stable layer identity — the cloud's display name / source filename. */
  readonly name: string;
  /**
   * World coordinate of point `index`, as `positions[index] + sourceOrigin`.
   * Survey-frame, fixed for the cloud's life (float64-transform invariant).
   */
  worldXYZ(index: number, out?: [number, number, number]): [number, number, number];
}

/** The world-frame provenance an annotation stores about the point it marks. */
export interface AnnotationGeoref {
  /** Survey coordinate — local render position folded with the source origin. */
  worldPosition: Vec3Object;
  /** The cloud the point was picked on. */
  layerId: string;
  /** Human-readable CRS label (e.g. `EPSG:25830`), when the cloud declares one. */
  crs?: string;
}

/**
 * Derive the world-frame fields for an annotation from the picked cloud and the
 * hit point's index. `crs` is the caller-resolved coordinate-system label; it is
 * attached only when present so an annotation on a CRS-less scan stays honest.
 */
export function georefFromPick(
  cloud: AnnotationPickCloud,
  index: number,
  crs?: string,
): AnnotationGeoref {
  const w = cloud.worldXYZ(index);
  const georef: AnnotationGeoref = {
    worldPosition: { x: w[0], y: w[1], z: w[2] },
    layerId: cloud.name,
  };
  if (crs !== undefined && crs.length > 0) georef.crs = crs;
  return georef;
}
