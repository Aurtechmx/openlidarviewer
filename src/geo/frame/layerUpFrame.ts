/**
 * layerUpFrame.ts — the one rule for which stored axis of a layer is up.
 *
 * Every consumer that reads a height, a grade or a horizontal plane out of a
 * layer asks this module: measurement (the owner frame of each measurement,
 * active layer or not), the terrain gather, the converter, navigation (scene
 * up, standard views, view cube, orbit) and the measurement and map exports.
 * Before this module the measurement path read the source format alone, so a
 * georeferenced PLY was analysed Z-up by terrain and measured Y-up.
 *
 * The rule, in order:
 *
 * - Survey formats (LAS, LAZ, XYZ, E57, PCD, PTX, PTS, PNTS) are Z-up by
 *   specification.
 * - A PLY or OBJ under an established horizontal CRS stores easting, northing
 *   and height in X, Y and Z. Its coordinates are never rotated: a surveyed
 *   facade can look like a Y-up model.
 * - A glTF or GLB under a CRS is unresolved. glTF is Y-up by specification, so
 *   its Y cannot also be a northing; every axis-dependent figure is withheld
 *   with the reason.
 * - A glTF or GLB with no CRS is Y-up by specification. A reading of the
 *   point layout does not change that: a wall stored Y-up is still Y-up.
 * - A PLY or OBJ with no CRS has no specified axis: when the caller read the up
 *   axis from the point layout (the terrain gather) that reading is used
 *   (`detected`); otherwise it is read Y-up by the app's stated rule for those
 *   formats (`explicit`).
 *
 * Nothing here moves a coordinate. Pure: no DOM, no three.js.
 */

import type { CrsInfo } from '../../io/crs';
import type { ResolvedCrs } from '../CoordinateTypes';
import { isZUpFormat, type SourceFormat } from '../../io/sniffFormat';
import { Y_UP_TO_Z_UP_OPT_IN } from '../../convert/types';
import type { SpatialContext, SpatialUpAxis } from '../SpatialContext';

/** The stored axis that is up. */
export type LayerUpAxis = 'z' | 'y';

/**
 * What settled the axis: the format's specification, the layer's CRS, a reading
 * of the point layout, the app's explicit rule for a mesh format with no CRS,
 * or nothing (a conflict; see {@link LayerUpFrame}).
 */
export type LayerUpBasis = 'specification' | 'crs' | 'detected' | 'explicit' | 'unresolved';

export type LayerUpFrame =
  | { readonly ok: true; readonly axis: LayerUpAxis; readonly basis: Exclude<LayerUpBasis, 'unresolved'> }
  | {
      readonly ok: false;
      readonly basis: 'unresolved';
      /** Why no axis can be claimed, and what to do about it. */
      readonly reason: string;
      /** The axis the layer is drawn and navigated with meanwhile; never a metric claim. */
      readonly drawAxis: LayerUpAxis;
    };

/** The CRS shapes the rule reads: a declared `CrsInfo` or a `ResolvedCrs`. */
export type LayerCrs = CrsInfo | ResolvedCrs;

export interface LayerUpFrameInput {
  readonly format: SourceFormat;
  /** The layer's resolved CRS (override applied), else its declared one. */
  readonly crs?: LayerCrs | null;
  /**
   * Whether a CRS is in play, for a caller that decides it itself (the
   * converter counts a CRS the export assigns). Wins over {@link crs}.
   */
  readonly crsInPlay?: boolean;
  /** Names the CRS in a refusal; defaults to the code or name of {@link crs}. */
  readonly crsLabel?: string;
  /**
   * The up axis read from the point layout, when the caller ran that reading.
   * Used only for a PLY or OBJ with no CRS; every other case has an axis from
   * its format or its CRS.
   */
  readonly detected?: LayerUpAxis;
}

/**
 * Whether a CRS establishes real-world horizontal axes: a projected, geographic
 * or geocentric resolution, or an EPSG code or WKT on one that is not Local. A
 * declared CRS from the file is a georeference even without a code. A Local
 * resolution, which is also what the user picks to opt out, is not.
 */
export function hasHorizontalCrs(crs: LayerCrs | null | undefined): boolean {
  if (crs == null) return false;
  if ('kind' in crs) {
    if (crs.kind === 'local') return false;
    if (crs.kind === 'projected' || crs.kind === 'geographic' || crs.kind === 'geocentric') return true;
  }
  if (crs.epsg != null) return true;
  if (typeof crs.wkt === 'string' && crs.wkt.trim() !== '') return true;
  return !('kind' in crs);
}

/** A CRS named for a sentence: its EPSG code, else its name. */
export function crsLabelOf(crs: LayerCrs | null | undefined): string {
  if (crs?.epsg != null) return `EPSG:${crs.epsg}`;
  const name = crs?.name?.trim();
  return name ? name : 'the scan’s CRS';
}

/** Formats whose specification fixes +Y as up (glTF 2.0, section 3.4). */
export function isYUpBySpec(format: SourceFormat): boolean {
  return format === 'glb' || format === 'gltf';
}

/** Why a glTF or GLB under a CRS has no up axis to measure along. */
export function gltfUnderCrsAxisReason(label: string): string {
  return (
    `glTF stores Y as the up axis by specification, so its coordinates cannot be read as easting, northing and height under ${label}. ` +
    `Reconcile the axes first: set the scan's coordinate system to Local, export with "${Y_UP_TO_Z_UP_OPT_IN}", then open that file and assign the CRS.`
  );
}

/** Resolve one layer's up axis and its basis. */
export function resolveLayerUpFrame(input: LayerUpFrameInput): LayerUpFrame {
  const { format } = input;
  if (isZUpFormat(format)) return { ok: true, axis: 'z', basis: 'specification' };
  const crsInPlay = input.crsInPlay ?? hasHorizontalCrs(input.crs);
  if (crsInPlay) {
    if (isYUpBySpec(format)) {
      return { ok: false, basis: 'unresolved', reason: gltfUnderCrsAxisReason(input.crsLabel ?? crsLabelOf(input.crs)), drawAxis: 'y' };
    }
    return { ok: true, axis: 'z', basis: 'crs' };
  }
  if (isYUpBySpec(format)) return { ok: true, axis: 'y', basis: 'specification' };
  if (input.detected) return { ok: true, axis: input.detected, basis: 'detected' };
  return { ok: true, axis: 'y', basis: 'explicit' };
}

/**
 * The CRS facts of a resolved spatial context, shaped for {@link resolveLayerUpFrame}.
 * The context is derived from the layer's resolved CRS (override applied), so its
 * kind and EPSG code carry the same answer to "is a horizontal CRS in play".
 */
export function layerCrsFromContext(ctx: SpatialContext): LayerCrs {
  return { kind: ctx.kind, name: ctx.crsName, ...(ctx.epsg != null ? { epsg: ctx.epsg } : {}) } as LayerCrs;
}

/** A layer's up frame from its format and the spatial context resolved for it. */
export function layerUpFrameFromContext(format: SourceFormat, ctx: SpatialContext): LayerUpFrame {
  return resolveLayerUpFrame({ format, crs: layerCrsFromContext(ctx) });
}

/** The up vector a layer is drawn, navigated and measured along. */
export function upVectorOf(frame: LayerUpFrame): [number, number, number] {
  const axis = frame.ok ? frame.axis : frame.drawAxis;
  return axis === 'z' ? [0, 0, 1] : [0, 1, 0];
}

/**
 * The up axis a lon/lat placement, a footprint or the coordinate readout may
 * rely on. The app's rule for a mesh with no CRS is a convention, not a
 * determination, so it stays `'unknown'` there, as does an unresolved frame.
 */
export function spatialUpAxisOf(frame: LayerUpFrame | null): SpatialUpAxis {
  return frame?.ok && frame.basis !== 'explicit' ? frame.axis : 'unknown';
}

/** The refusal an axis-dependent figure prints on this layer, or null. */
export function upFrameRefusal(frame: LayerUpFrame | null): string | null {
  return frame && !frame.ok ? `not available: no up axis; ${frame.reason}` : null;
}

/** One line naming the axis and its basis, for the layer details. */
export function describeLayerUpFrame(frame: LayerUpFrame, format: SourceFormat): string {
  if (!frame.ok) return `not resolved. ${frame.reason}`;
  const axis = frame.axis.toUpperCase();
  const name = format.toUpperCase();
  switch (frame.basis) {
    case 'specification':
      return `${axis} up (${name} specification)`;
    case 'crs':
      return `${axis} up (coordinate system: X, Y, Z read as easting, northing, height)`;
    case 'detected':
      return `${axis} up (read from the point layout; no coordinate system)`;
    case 'explicit':
      return `${axis} up (${name} with no coordinate system is read Y-up; assign a CRS if X, Y, Z are easting, northing, height)`;
  }
}
