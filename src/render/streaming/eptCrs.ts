/**
 * eptCrs.ts
 *
 * Resolve a {@link CrsInfo} from an EPT manifest's `srs` — WKT and/or authority
 * codes. Kept pure (no class, no I/O) so the resolution rules are unit-testable
 * without standing up a streaming cloud.
 *
 * Rules:
 *   1. A WKT (richest) wins. If it is horizontal-only but the codes name a
 *      vertical datum, the datum is attached (the WKT richness is preserved).
 *   2. No WKT → georeference from the authority codes (`horizontal` /
 *      `vertical`) when present.
 *   3. Neither → null (raw exports often skip the SRS entirely).
 */

import { crsFromWkt, crsFromEpsg, verticalDatumLabel, type CrsInfo } from '../../io/crs';
import { isGeographicEpsg } from '../../convert/epsg';
import type { EptMetadata } from '../../io/ept/eptTypes';

/** Resolve the CRS for an EPT source from its manifest's `srs` / `srsCodes`. */
export function resolveEptCrs(metadata: Pick<EptMetadata, 'srs' | 'srsCodes'>): CrsInfo | null {
  const wkt = metadata.srs;
  const codes = metadata.srsCodes;

  if (wkt && wkt.trim().length > 0) {
    const fromWkt = crsFromWkt(wkt);
    // The WKT may be horizontal-only while the codes name a vertical datum;
    // attach the declared datum (keeping the WKT richness) rather than dropping
    // it. verticalDatumLabel rejects placeholder codes (0 / 32767).
    if (!fromWkt.verticalDatum && codes?.verticalEpsg) {
      const datum = verticalDatumLabel(codes.verticalEpsg);
      if (datum) {
        return { ...fromWkt, verticalEpsg: codes.verticalEpsg, verticalDatum: datum };
      }
    }
    return fromWkt;
  }

  // No WKT — georeference from the authority codes when present.
  if (codes?.horizontalEpsg) {
    return crsFromEpsg(codes.horizontalEpsg, {
      isGeographic: isGeographicEpsg(codes.horizontalEpsg),
      verticalEpsg: codes.verticalEpsg,
    });
  }
  return null;
}
