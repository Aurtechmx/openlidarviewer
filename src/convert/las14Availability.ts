/**
 * las14Availability.ts — whether LAS 1.4 can carry the CRS an export will write.
 *
 * LAS 1.4 stores the CRS as OGC WKT, and this build holds a verified WKT only
 * for some EPSG codes (see `io/epsgWkt.ts`). Any other code, State Plane zones
 * and many national grids among them, is refused for LAS 1.4 and written as
 * LAS 1.2 GeoTIFF keys. The panels ask here before the user presses Export so
 * the default format is one that can succeed. The answer comes from
 * `planLas14Crs`, the plan the writer itself runs, so the horizontal WKT check
 * here and in the converter agree. The vertical-datum and compound-CRS checks
 * need the decoded file and are reported when Export runs.
 *
 * Pure: no DOM, no I/O.
 */

import type { CrsMode } from './types';
import { planLas14Crs } from './writeLas';

/** The facts that decide the CRS an export writes. */
export interface Las14Request {
  readonly mode: CrsMode;
  /** The resolved source EPSG, when one is known. */
  readonly sourceEpsg: number | null;
  /** The resolved source WKT; used only when the export keeps the source CRS. */
  readonly sourceWkt: string | null;
  /** The EPSG an assign or reproject writes. */
  readonly targetEpsg: number | null;
}

export type Las14Availability =
  | { readonly ok: true }
  | { readonly ok: false; readonly epsg: number; readonly message: string };

/** The EPSG code the output carries, or null when the export writes no code. */
export function las14OutputEpsg(r: Pick<Las14Request, 'mode' | 'sourceEpsg' | 'targetEpsg'>): number | null {
  return r.mode === 'keep' ? r.sourceEpsg : r.targetEpsg;
}

/** Whether LAS 1.4 can be written for this request, and why not when it cannot. */
export function las14Availability(r: Las14Request): Las14Availability {
  const epsg = las14OutputEpsg(r);
  if (epsg == null) return { ok: true };
  // The source WKT describes the output only while the CRS is kept.
  const plan = planLas14Crs({ epsg, wkt: r.mode === 'keep' ? r.sourceWkt : null });
  if (plan.ok) return { ok: true };
  return {
    ok: false,
    epsg,
    message:
      `LAS 1.4 needs the CRS as WKT, and this build has no definition for EPSG:${epsg}. ` +
      'LAS 1.2 records the code as GeoTIFF keys.',
  };
}
