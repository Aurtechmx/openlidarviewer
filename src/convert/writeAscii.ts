/**
 * writeAscii.ts — XYZ and ASC text writers for the converter.
 *
 * Both write global coordinates one point per line. XYZ stays
 * round-trippable with the existing `loadXyz` reader (3 or 6 columns: x y z
 * and optional r g b). ASC writes x y z plus intensity when present, with a
 * short comment header that records the CRS so the georeference travels with
 * the file even though ASCII has no formal CRS slot.
 *
 * Pure data — no DOM.
 */

import type { GlobalPoints } from './globalPoints';

function fmt(v: number, precision: number): string {
  return v.toFixed(precision);
}

/**
 * Decimals for the HORIZONTAL axes. Three is millimetres in a projected CRS and
 * about 110 m in a geographic one, so a reprojected WGS84 export was snapping
 * every point to a lattice roughly 55 m across. Seven decimals is ~1.1 cm at the
 * equator, the survey convention — and the same rule `exporters.ts` and
 * `writeLas.ts` already apply. Z is unaffected: a height is a linear unit even
 * when the horizontal frame is degrees.
 */
function horizontalPrecision(precision: number, geographic?: boolean): number {
  return geographic === true ? 7 : precision;
}

/** Write space-delimited `x y z` (+ `r g b` when the cloud has colour). */
export function writeXyz(g: GlobalPoints, precision = 3, geographic?: boolean): string {
  const lines: string[] = [];
  const c = g.colors;
  const h = horizontalPrecision(precision, geographic);
  for (let i = 0; i < g.count; i++) {
    const base = `${fmt(g.x[i], h)} ${fmt(g.y[i], h)} ${fmt(g.z[i], precision)}`;
    if (c) {
      lines.push(`${base} ${c[i * 3]} ${c[i * 3 + 1]} ${c[i * 3 + 2]}`);
    } else {
      lines.push(base);
    }
  }
  return lines.join('\n') + (g.count > 0 ? '\n' : '');
}

/**
 * Write ASC: a `# crs:` / `# columns:` comment header, then `x y z`
 * (+ `intensity` when present). The header lets a reader recover the CRS that
 * ASCII otherwise can't carry.
 */
export function writeAsc(
  g: GlobalPoints,
  opts: {
    precision?: number;
    crsName?: string | null;
    epsg?: number | null;
    /** True when the output frame is geographic (lon/lat degrees). */
    geographic?: boolean;
  } = {},
): string {
  const precision = opts.precision ?? 3;
  const h = horizontalPrecision(precision, opts.geographic);
  const hasI = g.intensity != null;
  const header: string[] = ['# OpenLiDARViewer ASC export'];
  if (opts.epsg != null) header.push(`# crs: EPSG:${opts.epsg}`);
  else if (opts.crsName) header.push(`# crs: ${opts.crsName}`);
  else header.push('# crs: unknown (local coordinates)');
  header.push(`# columns: x y z${hasI ? ' intensity' : ''}`);

  const lines: string[] = [header.join('\n')];
  const it = g.intensity;
  for (let i = 0; i < g.count; i++) {
    const base = `${fmt(g.x[i], h)} ${fmt(g.y[i], h)} ${fmt(g.z[i], precision)}`;
    lines.push(it ? `${base} ${it[i]}` : base);
  }
  return lines.join('\n') + '\n';
}
