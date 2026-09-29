/**
 * lightProvenance.ts — the provenance record for single-file vector exports
 * (measurement GeoJSON, site KML) that have no processing chain of their own.
 *
 * It carries what a reader needs to reproduce a figure from the input file:
 * the build that wrote it, the generation time, the source basename (the same
 * basename the file is already named after; never a path), the resolved CRS
 * label and where it came from, the probe interpretation level and the data basis. Measurement
 * geometry is not a registered method, so `methods` is empty and the record
 * says so rather than inventing an id.
 *
 * Pure data: no DOM, no I/O.
 */

import { BUILD_IDENTITY, type BuildIdentity } from '../build/buildIdentity';
import { crsOriginLine, crsOriginOf, type CrsOriginInput, type CrsOriginRecord } from '../science/crsOrigin';
import { sourceInterpretationOf, type SourceInterpretationRecord } from '../science/sourceInterpretation';

export interface LightProvenance {
  readonly software: 'OpenLiDARViewer';
  readonly version: string;
  readonly commit: string;
  readonly dirty: boolean;
  readonly generatedAt: string;
  readonly source: string | null;
  readonly crs: string;
  /** Where the CRS came from; every field `'unknown'` when the caller did not resolve one. */
  readonly crsOrigin: CrsOriginRecord;
  readonly interpretationLevel: string;
  readonly dataBasis: string;
  readonly methods: readonly string[];
  readonly methodNote: string;
}

export interface LightProvenanceInput {
  readonly generatedAt: string;
  /** Source basename (extension already stripped by the caller), or null. */
  readonly source: string | null;
  readonly crsName: string | null | undefined;
  readonly interpretation?: SourceInterpretationRecord | null;
  /** The resolved CRS (`CrsService.current()`), or null when none resolved. */
  readonly crs?: CrsOriginInput | null;
  readonly build?: BuildIdentity;
}

/** Strip any directory part so a record can never carry a host path. */
function basenameOnly(name: string | null): string | null {
  if (!name) return null;
  const parts = name.split(/[\\/]/);
  return parts[parts.length - 1] || null;
}

export function lightProvenance(input: LightProvenanceInput): LightProvenance {
  const b = input.build ?? BUILD_IDENTITY;
  const interp = input.interpretation ?? sourceInterpretationOf(undefined, undefined);
  return {
    software: 'OpenLiDARViewer',
    version: b.version,
    commit: b.commit,
    dirty: b.dirty,
    generatedAt: input.generatedAt,
    source: basenameOnly(input.source),
    crs: input.crsName ?? 'unknown',
    crsOrigin: interp.crsOrigin ?? crsOriginOf(input.crs),
    interpretationLevel: interp.interpretationLevel,
    dataBasis: interp.dataBasis,
    methods: [],
    methodNote: 'Measurement geometry is computed from the placed vertices; it is not a registered method id.',
  };
}

/** One plain-text line for formats whose only slot is a description. */
export function lightProvenanceLine(p: LightProvenance): string {
  return `Provenance: ${p.software} ${p.version} (${p.commit}${p.dirty ? '+dirty' : ''}); generated ${p.generatedAt}; `
    + `source ${p.source ?? 'unknown'}; CRS ${p.crs}; ${crsOriginLine(p.crsOrigin)}; interpretation level ${p.interpretationLevel}; data basis ${p.dataBasis}.`;
}
