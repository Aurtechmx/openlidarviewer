/**
 * reproject.ts — coordinate transformation via proj4.
 *
 * Transforms the horizontal X/Y of a GlobalPoints set from a source EPSG to a
 * target EPSG. Z (elevation) is passed through unchanged — a vertical-datum
 * transform is a separate concern this converter does not claim to perform.
 *
 * Isolated here so proj4 only enters the bundle through the converter chunk,
 * and so the pure EPSG resolver in `epsg.ts` stays dependency-free.
 */

import proj4 from 'proj4';
import type { GlobalPoints } from './globalPoints';
import { epsgToProj4, datumShiftCaveat } from './epsg';

export interface ReprojectResult {
  readonly points: GlobalPoints;
  readonly transformed: boolean;
  readonly note: string;
  /**
   * Non-null when the transform "succeeded" but its DATUM leg is known to be
   * missing or degenerate (grid-less NAD27, identity GDA94↔GDA2020 — see
   * `datumShiftCaveat`). The caller MUST surface this as a warning: a silent
   * "reprojected ✓" on such a pair ships coordinates metres-to-tens-of-metres
   * off. Always null when `transformed` is false (nothing moved).
   */
  readonly datumCaveat: string | null;
}

/**
 * Reproject `g` from `srcEpsg` to `dstEpsg`. Returns the (possibly unchanged)
 * points plus a human note. If either CRS can't be resolved to a proj4 def,
 * the points are returned untouched with an explanatory note so the caller
 * can downgrade to "assign" or surface a warning rather than corrupt data.
 */
export function reprojectGlobal(
  g: GlobalPoints,
  srcEpsg: number,
  dstEpsg: number,
): ReprojectResult {
  if (srcEpsg === dstEpsg) {
    return { points: g, transformed: false, note: 'source and target CRS are identical — no transform needed', datumCaveat: null };
  }
  const srcDef = epsgToProj4(srcEpsg);
  const dstDef = epsgToProj4(dstEpsg);
  if (!srcDef) {
    return { points: g, transformed: false, note: `cannot resolve source EPSG:${srcEpsg} — coordinates left unchanged`, datumCaveat: null };
  }
  if (!dstDef) {
    return { points: g, transformed: false, note: `cannot resolve target EPSG:${dstEpsg} — coordinates left unchanged`, datumCaveat: null };
  }

  try {
    const fwd = proj4(srcDef, dstDef);
    const n = g.count;
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    // Z passes through; clone so the result owns its buffers.
    const z = g.z.slice();
    for (let i = 0; i < n; i++) {
      const out = fwd.forward([g.x[i], g.y[i]]);
      x[i] = out[0];
      y[i] = out[1];
    }
    return {
      points: { ...g, x, y, z },
      transformed: true,
      note: `reprojected EPSG:${srcEpsg} → EPSG:${dstEpsg}`,
      // Datum honesty: proj4 has now "succeeded", but for grid-less / identity
      // datum pairs that success is only the PROJECTION math — flag it.
      datumCaveat: datumShiftCaveat(srcEpsg, dstEpsg),
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      points: g,
      transformed: false,
      note: `reprojection failed (${detail}) — coordinates left unchanged`,
      datumCaveat: null,
    };
  }
}
