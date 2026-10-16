/**
 * pcCatalogueCrs.ts — a Planetary Computer pick records the item's catalogue
 * EPSG for that item only.
 *
 * The pick happens before the file is opened, so the record cannot hold the
 * file's own facts (declaration, point count, position). It holds the
 * catalogue item instead (STAC id and WGS84 bbox), keyed by the asset file
 * name the stream opens under. The open tags a stream whose URL was picked
 * from the catalogue with the same item ({@link catalogueItemFor}), and the CRS
 * service applies the record only to a stream carrying that item. A same-named
 * stream not opened from the catalogue is offered it as a suggestion.
 *
 * The record is catalogue metadata, not a user choice: it applies only to a
 * stream that declares no CRS of its own, and resolves labelled as the
 * catalogue's ({@link PC_CATALOGUE_LABEL}), not as confirmed by the user.
 */
import { keyForDataset, type CrsOverride } from '../geo/CrsOverrideStore';
import { DEFAULT_CRS_OVERRIDE_PORT, OVERRIDE_IDENTITY_VERSION, type CatalogItemIdentity, type CrsOverridePort } from '../geo/CrsService';
import type { PcStacItem } from '../io/catalog/planetaryComputer';
import { remoteCopcName } from './remoteSourceNaming';

/** Names the Planetary Computer catalogue wherever a CRS it supplied is shown. */
export const PC_CATALOGUE_LABEL = 'Planetary Computer STAC';

/** Items picked this session, by asset URL without query or fragment. */
const picks = new Map<string, CatalogItemIdentity>();

/** The asset URL without its signing query or fragment, or null when it does not parse. */
function assetKey(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

/** The override record a pick writes, or null when the item states no EPSG. */
export function catalogueOverrideFor(item: PcStacItem): {
  readonly datasetKey: string;
  readonly override: Omit<CrsOverride, 'updatedAt'>;
} | null {
  if (!item.epsg) return null;
  const [w, s, e, n] = item.bbox;
  return {
    datasetKey: keyForDataset(remoteCopcName(item.assetUrl)),
    override: {
      epsg: item.epsg,
      kind: 'projected',
      identity: { catalogItem: { id: item.id, bbox: [w, s, e, n] } },
      identityVersion: OVERRIDE_IDENTITY_VERSION,
      catalogue: PC_CATALOGUE_LABEL,
    },
  };
}

/**
 * Remember the pick so the stream opened from it is tagged with the item, and
 * write its catalogue EPSG record.
 */
export function recordCatalogueCrs(item: PcStacItem, port: Pick<CrsOverridePort, 'set'> = DEFAULT_CRS_OVERRIDE_PORT): void {
  const key = assetKey(item.assetUrl);
  const [w, s, e, n] = item.bbox;
  if (key) picks.set(key, { id: item.id, bbox: [w, s, e, n] });
  const rec = catalogueOverrideFor(item);
  if (rec) port.set(rec.datasetKey, rec.override);
}

/** The catalogue item a URL was picked from this session, if any. */
export function catalogueItemFor(url: string): CatalogItemIdentity | undefined {
  const key = assetKey(url);
  return key ? picks.get(key) : undefined;
}
