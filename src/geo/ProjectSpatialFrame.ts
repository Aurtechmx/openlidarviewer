/**
 * ProjectSpatialFrame.ts
 *
 * The authoritative frame every layer of a multi-scan project is expressed in.
 *
 * Today each cloud is recentred about its OWN `floor(min)` origin, so two
 * georeferenced clouds with different source origins both land near local zero
 * and appear overlaid even when they occupy different places in the world (see
 * docs/architecture/project-spatial-frame.md, and the "Known limits" note in
 * docs/coordinate-precision.md). This module is the foundation that fixes it: a
 * single project origin shared by every layer, plus each layer's transform from
 * its source-local frame into that shared project-local frame.
 *
 * It does NOT change where Float64 ends and Float32 begins — it makes the
 * boundary project-wide instead of per-cloud. The GPU still receives small
 * Float32 project-local residuals; CPU/measurement/export recover absolute
 * coordinates as `projectLocal + projectOrigin` in Float64, exactly the rule a
 * single cloud follows today.
 *
 * v0.6 scope: the layers already share a CRS, so a layer's transform is a pure
 * Float64 TRANSLATION (`sourceOrigin − projectOrigin`). Mixed-CRS reprojection —
 * rotating/scaling one CRS into another — is out of scope and stays a downstream
 * tool's job; the translation vectors reserve the seam without pulling in a
 * matrix dependency the foundation doesn't need yet.
 *
 * Pure — no DOM, no three.js — fully unit-tested in Node.
 */

import type { CrsLinearUnit } from '../io/crs';

type Vec3 = readonly [number, number, number];

/** The project's authoritative frame — one origin every layer maps into. */
export interface ProjectSpatialFrame {
  /** The project origin, in source-CRS units (Float64). */
  readonly projectOrigin: Vec3;
  /** The project CRS label, when the layers agree on one. */
  readonly crs?: string;
  readonly horizontalUnit: CrsLinearUnit;
  readonly verticalUnit: CrsLinearUnit;
}

/** How one layer's source-local frame maps into the shared project frame. */
export interface LayerSpatialTransform {
  /** The layer's own source origin (its `floor(min)`), Float64. */
  readonly sourceOrigin: Vec3;
  /**
   * source-local → project-local. A pure translation in v0.6 (the layers share
   * a CRS); a Matrix4 later when reprojection lands. Equals
   * `sourceOrigin − projectOrigin`.
   */
  readonly sourceToProject: Vec3;
  /** project-local → source-local — the exact negation of {@link sourceToProject}. */
  readonly projectToSource: Vec3;
}

/** Options for {@link createProjectFrame}; units default to metres/metres. */
export interface ProjectFrameOptions {
  readonly crs?: string;
  readonly horizontalUnit?: CrsLinearUnit;
  readonly verticalUnit?: CrsLinearUnit;
}

/** Build a project frame about an explicit origin. */
export function createProjectFrame(
  projectOrigin: Vec3,
  options: ProjectFrameOptions = {},
): ProjectSpatialFrame {
  return {
    projectOrigin: [projectOrigin[0], projectOrigin[1], projectOrigin[2]],
    crs: options.crs,
    horizontalUnit: options.horizontalUnit ?? 'metre',
    verticalUnit: options.verticalUnit ?? options.horizontalUnit ?? 'metre',
  };
}

/**
 * Choose a shared project origin from the layers' source origins: the per-axis
 * `floor(min)`. Because each source origin is already the `floor(min)` of its
 * own cloud, this sits at or below every cloud's minimum, so every layer's
 * project-local residual stays non-negative and small — the same Float32
 * sub-mm range a single cloud keeps. Throws on an empty set: a project with no
 * layers has no origin to anchor.
 */
export function chooseProjectOrigin(origins: readonly Vec3[]): Vec3 {
  if (origins.length === 0) {
    throw new Error('chooseProjectOrigin: at least one source origin is required.');
  }
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  for (const o of origins) {
    for (let a = 0; a < 3; a++) if (o[a] < min[a]) min[a] = o[a];
  }
  return [Math.floor(min[0]), Math.floor(min[1]), Math.floor(min[2])];
}

/** Build the transform that maps a layer at `sourceOrigin` into `frame`. */
export function layerTransform(
  frame: ProjectSpatialFrame,
  sourceOrigin: Vec3,
): LayerSpatialTransform {
  const dx = sourceOrigin[0] - frame.projectOrigin[0];
  const dy = sourceOrigin[1] - frame.projectOrigin[1];
  const dz = sourceOrigin[2] - frame.projectOrigin[2];
  return {
    sourceOrigin: [sourceOrigin[0], sourceOrigin[1], sourceOrigin[2]],
    sourceToProject: [dx, dy, dz],
    projectToSource: [-dx, -dy, -dz],
  };
}

/** Map a source-local position into the shared project-local frame. */
export function sourceLocalToProjectLocal(t: LayerSpatialTransform, sourceLocal: Vec3): Vec3 {
  return [
    sourceLocal[0] + t.sourceToProject[0],
    sourceLocal[1] + t.sourceToProject[1],
    sourceLocal[2] + t.sourceToProject[2],
  ];
}

/** Map a project-local position back into a layer's source-local frame. */
export function projectLocalToSourceLocal(t: LayerSpatialTransform, projectLocal: Vec3): Vec3 {
  return [
    projectLocal[0] + t.projectToSource[0],
    projectLocal[1] + t.projectToSource[1],
    projectLocal[2] + t.projectToSource[2],
  ];
}

/** Recover absolute world coordinates from a project-local position (Float64). */
export function projectLocalToWorld(frame: ProjectSpatialFrame, projectLocal: Vec3): Vec3 {
  return [
    projectLocal[0] + frame.projectOrigin[0],
    projectLocal[1] + frame.projectOrigin[1],
    projectLocal[2] + frame.projectOrigin[2],
  ];
}

/** Express an absolute world position in the project-local frame (Float64). */
export function worldToProjectLocal(frame: ProjectSpatialFrame, world: Vec3): Vec3 {
  return [
    world[0] - frame.projectOrigin[0],
    world[1] - frame.projectOrigin[1],
    world[2] - frame.projectOrigin[2],
  ];
}
