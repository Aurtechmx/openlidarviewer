/**
 * outputCrsKind.ts — whether a converted file's coordinates are degrees.
 *
 * The answer picks the GeoKey that carries the EPSG code (Geographic or
 * ProjectedCSType), the default LAS scale (1e-7 degree or 1 mm) and the ASCII
 * decimal count. It used to fall back to "projected" whenever a code was not
 * known to be geographic, so a geographic code missing from an old table was
 * written as a projected CRS at millidegree precision. A code whose kind
 * cannot be determined now refuses the export instead.
 *
 * Pure data — no DOM.
 */

import type { CrsInfo } from '../io/crs';
import type { ResolvedCrs } from '../geo/CoordinateTypes';
import { EPSG_TABLE_VERSION, epsgCrsKind, epsgToProj4, isGeographicProj4, type EpsgCrsUnit } from './epsg';

export type OutputCrsKind =
  | { readonly ok: true; readonly geographic: boolean; readonly unit: EpsgCrsUnit | null }
  | { readonly ok: false; readonly message: string };

export interface OutputCrsKindInput {
  readonly mode: 'keep' | 'assign' | 'reproject';
  readonly reprojectApplied: boolean;
  readonly outEpsg: number | null;
  readonly sourceEpsg: number | null;
  /** The resolved source CRS, when there is one. */
  readonly sourceCrs: CrsInfo | ResolvedCrs | null | undefined;
}

/**
 * The source CRS's own statement of being geographic, or null when it makes
 * none a writer can rely on: a CrsInfo built from a bare code ('epsg') takes a
 * default of "not geographic", and a resolved CRS of unknown kind says nothing.
 */
function statedGeographic(crs: CrsInfo | ResolvedCrs | null | undefined): boolean | null {
  if (crs == null) return null;
  if ('kind' in crs) {
    if (crs.kind === 'geographic') return true;
    if (crs.kind === 'projected' || crs.kind === 'geocentric') return false;
    return null;
  }
  if (crs.source === 'epsg') return null;
  return crs.isGeographic;
}

const KIND_PHRASE: Record<string, string> = {
  geocentric: 'a geocentric (ECEF) CRS',
  compound: 'a compound (horizontal + vertical) CRS',
  vertical: 'a vertical CRS',
  engineering: 'an engineering (local) CRS',
};

/** Decide the kind of the output CRS, or refuse when it cannot be determined. */
export function outputCrsKind(input: OutputCrsKindInput): OutputCrsKind {
  const { mode, reprojectApplied, outEpsg, sourceEpsg, sourceCrs } = input;
  const inSourceCrs =
    mode === 'keep' || (mode === 'reproject' && !reprojectApplied) || (outEpsg != null && outEpsg === sourceEpsg);
  // A CRS read from the file (WKT or GeoKeys) states its own kind; a CRS known
  // only by a code (e.g. an override) is resolved from the code below.
  const stated = inSourceCrs ? statedGeographic(sourceCrs) : null;
  if (stated != null) return { ok: true, geographic: stated, unit: null };
  if (outEpsg == null) return { ok: true, geographic: false, unit: null };
  if (reprojectApplied) {
    const def = epsgToProj4(outEpsg);
    if (def != null) return { ok: true, geographic: isGeographicProj4(def), unit: null };
  }
  const info = epsgCrsKind(outEpsg);
  const verb = mode === 'assign' ? 'assigned' : 'exported';
  if (info.kind === 'geographic') return { ok: true, geographic: true, unit: info.unit };
  if (info.kind === 'projected') return { ok: true, geographic: false, unit: info.unit };
  if (info.kind === 'unknown') {
    return {
      ok: false,
      message:
        `EPSG:${outEpsg} was not ${verb}: it is not in the built-in registry or the EPSG ${EPSG_TABLE_VERSION} table, ` +
        'so whether it is a geographic or a projected CRS, and its units, cannot be determined. ' +
        'Check the code, or export without assigning a CRS.',
    };
  }
  if (mode === 'assign') {
    return {
      ok: false,
      message:
        `EPSG:${outEpsg} was not assigned: it is ${KIND_PHRASE[info.kind]}, and a point cloud export records a ` +
        'geographic or projected horizontal CRS. Assign the horizontal CRS (for a compound CRS, its horizontal part); ' +
        'a vertical datum the source declares is carried separately.',
    };
  }
  // Kept or skipped-reproject code-only source of another kind: not degrees.
  return { ok: true, geographic: false, unit: info.unit };
}
