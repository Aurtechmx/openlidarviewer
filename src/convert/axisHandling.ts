/**
 * axisHandling.ts — what the converter may do with the source axes.
 *
 * The written coordinates are the source coordinates. Neither the scan's shape
 * (a vertical facade and a Y-up phone scan can look alike) nor the viewer's
 * display orientation decides a coordinate transformation. The only axis change
 * the converter makes is the rotation of a local Y-up model into the Z-up frame,
 * (x, y, z) to (x, -z, y), and only when the export request asks for it.
 *
 * Refusals come from metadata, never from shape:
 * - the rotation is refused when the export keeps or assigns a CRS, because the
 *   coordinates then already mean easting, northing and height;
 * - the rotation is refused for a source format that is Z-up by specification;
 * - a glTF source, Y-up by specification, is refused under a CRS, because its
 *   Y column is a height and cannot be written as a northing without an axis
 *   change the request has to make explicitly.
 *
 * Pure: no DOM, no I/O.
 */

import type { CrsInfo } from '../io/crs';
import type { ResolvedCrs } from '../geo/CoordinateTypes';
import { isZUpFormat, type SourceFormat } from '../io/sniffFormat';
import type { ConversionEvent } from './conversionEvents';
import { Y_UP_TO_Z_UP_OPT_IN, type AxisHandling, type CrsMode } from './types';

/** The axes the request asks for, after the metadata checks. */
export type AxisPlan =
  | { readonly ok: true; readonly rotate: boolean }
  | { readonly ok: false; readonly message: string };

/** The facts {@link planAxisHandling} judges. */
export interface AxisPlanInput {
  readonly format: SourceFormat;
  readonly handling: AxisHandling;
  readonly mode: CrsMode;
  /** The source CRS the conversion uses (resolved, else declared). */
  readonly sourceCrs: CrsInfo | ResolvedCrs | null | undefined;
  /** The source EPSG the conversion uses, when one is known. */
  readonly sourceEpsg: number | null;
  readonly targetEpsg: number | null;
}

/** Formats whose specification fixes +Y as up (glTF 2.0, section 3.4). */
function isYUpBySpec(format: SourceFormat): boolean {
  return format === 'glb' || format === 'gltf';
}

/**
 * Whether a source CRS establishes real-world axes: an EPSG code, a WKT, a
 * vertical datum, or a resolved projected, geographic or geocentric kind. A
 * resolution to Local or Unknown with none of those does not.
 */
export function hasEstablishedCrs(crs: CrsInfo | ResolvedCrs | null | undefined): boolean {
  if (crs == null) return false;
  if (crs.epsg != null || crs.verticalEpsg != null) return true;
  if (typeof crs.wkt === 'string' && crs.wkt.trim() !== '') return true;
  if ('kind' in crs) return crs.kind === 'projected' || crs.kind === 'geographic' || crs.kind === 'geocentric';
  // A declared CrsInfo is a georeference even without a code.
  return true;
}

/** The CRS the output carries, named for a message. */
function outputCrsLabel(input: AxisPlanInput): string {
  if (input.mode !== 'keep' && input.targetEpsg != null) return `EPSG:${input.targetEpsg}`;
  if (input.sourceEpsg != null) return `EPSG:${input.sourceEpsg}`;
  const name = input.sourceCrs?.name?.trim();
  return name ? name : 'the scan’s CRS';
}

/** Decide the axes for one conversion. */
export function planAxisHandling(input: AxisPlanInput): AxisPlan {
  // Assign and reproject both write a CRS; keep writes the source's when it has one.
  const crsInPlay = input.mode !== 'keep' || input.sourceEpsg != null || hasEstablishedCrs(input.sourceCrs);
  const label = outputCrsLabel(input);
  if (input.handling === 'y-up-to-z-up') {
    if (isZUpFormat(input.format)) {
      return {
        ok: false,
        message:
          `Nothing was written. ${input.format.toUpperCase()} is Z-up by specification, so "${Y_UP_TO_Z_UP_OPT_IN}" does not apply. ` +
          'Untick it to write the coordinates as stored.',
      };
    }
    if (crsInPlay) {
      return {
        ok: false,
        message:
          `Nothing was written. This export writes ${label}, so the coordinates are already easting, northing and height and are not rotated. ` +
          `"${Y_UP_TO_Z_UP_OPT_IN}" is for local models with no CRS. Untick it to write the coordinates as stored.`,
      };
    }
    return { ok: true, rotate: true };
  }
  if (isYUpBySpec(input.format) && crsInPlay) {
    return {
      ok: false,
      message:
        `Nothing was written. glTF stores Y as the up axis by specification, so its coordinates cannot be written as easting, northing and height under ${label} without an axis change. ` +
        `Reconcile the axes first: set the scan's coordinate system to Local, export with "${Y_UP_TO_Z_UP_OPT_IN}", then open that file and assign the CRS.`,
    };
  }
  return { ok: true, rotate: false };
}

/** Rotate Y-up coordinates into the Z-up frame in place: (x, y, z) to (x, -z, y). */
export function rotateYUpToZUp(g: { readonly count: number; readonly y: Float64Array; readonly z: Float64Array }): void {
  const { y, z } = g;
  for (let i = 0; i < g.count; i++) {
    const yv = y[i];
    y[i] = -z[i];
    z[i] = yv;
  }
}

/** The conversion event that records the rotation in the report and the file. */
export function yUpRotationEvent(points: number): ConversionEvent {
  const text =
    'The local Y-up model was rotated into the Z-up frame at the export request: source (x, y, z) is written as (x, -z, y), ' +
    'so the written coordinates differ from the source.';
  return { id: 'axes-y-up-to-z-up', kind: 'translated', level: 'warn', points, message: text, record: text, acknowledged: true };
}
