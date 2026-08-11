/**
 * exportCrsResolver.ts
 *
 * The seam that hands the export adapter a RESOLVED CRS per static cloud, so the
 * ortho georeference (`.prj` / world file) describes the CRS the user actually
 * chose — never the file's rejected declared one (release blocker #2 / pass-5
 * C10). Extracted from the composition root so `main.ts` wires it in one line and
 * the resolution rule is unit-testable without a Viewer.
 *
 * The rule: the ACTIVE scan's definitive resolved CRS is `crsService.current()`
 * (the override, when the user set one). Any other visible cloud resolves its own
 * declared CRS via `resolveFor` — a global override applies to the active scan,
 * not to a co-loaded layer. A CRS that does not resolve to a known projected /
 * geographic frame (a local or unknown one) yields a null WKT AND a null key, so
 * it neither georeferences nor forces a false CRS conflict in the equality gate.
 */

import type { PointCloud } from '../model/PointCloud';
import type { ExportCloudCrs } from '../render/exportAdapter';
import type { ResolvedCrs } from '../geo/CoordinateTypes';
import { crsIsKnown } from './kmlActions';
import { linearUnitLabel } from '../io/crs';

export interface ExportCrsResolverDeps {
  /** The active scan's resolved CRS (override applied), or null. */
  readonly current: () => ResolvedCrs | null;
  /** Resolve a non-active cloud's declared CRS (no override applies to it). */
  readonly resolveForCloud: (cloud: PointCloud) => ResolvedCrs;
  /** The active scan's cloud instance, for identity comparison, or null. */
  readonly activeCloud: () => PointCloud | null;
}

/** A stable equality key for a resolved CRS: EPSG when known, else the label. */
function crsKeyOf(resolved: ResolvedCrs): string {
  return resolved.epsg != null
    ? `epsg:${resolved.epsg}`
    : `name:${resolved.name.trim().toLowerCase()}`;
}

/** Build the `resolveCloudCrs` accessor the export host wires into the adapter. */
export function makeExportCrsResolver(
  deps: ExportCrsResolverDeps,
): (cloud: PointCloud) => ExportCloudCrs {
  return (cloud) => {
    const resolved =
      cloud === deps.activeCloud() ? deps.current() : deps.resolveForCloud(cloud);
    // A local / unknown / unresolved CRS must not georeference OR label: every
    // field null (no .prj, no false conflict, no CRS name/unit in the export
    // report). This is the C10/1C guard — a rejected override resolves to local
    // here, so its declared CRS never ships in any form.
    if (!resolved || !crsIsKnown(resolved)) {
      return { wkt: null, key: null, name: null, unit: null, epsg: null };
    }
    return {
      wkt: resolved.wkt ?? null,
      key: crsKeyOf(resolved),
      name: resolved.name,
      unit: linearUnitLabel(resolved.linearUnit),
      epsg: resolved.epsg ?? null,
    };
  };
}
