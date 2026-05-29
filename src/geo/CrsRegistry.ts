/**
 * src/geo/CrsRegistry.ts
 *
 * A small registry of well-known CRSs the CRS-override panel offers
 * users by name. The list is curated to cover the public-LiDAR
 * workflows v0.3.6 actually surfaces — WGS84, Web Mercator, every
 * UTM zone the U.S. uses (3DEP), the most common state-plane zones,
 * and a few Mexico / international entries because the catalog seam
 * is designed to expand.
 *
 * This is NOT a complete EPSG database. proj4js carries its own
 * universe of definitions; this list is just the picker's preset
 * menu. Users who need an EPSG not in the registry can type the
 * numeric code in the override panel and the converter will fetch
 * the proj4 definition lazily.
 *
 * Pure data — no I/O, no DOM. Loads with the shell (~3 KB gzipped).
 */

import type { CrsKind } from './CoordinateTypes';

/**
 * One registry entry. The picker shows `label`; the converter keys
 * on `epsg`. `kind` lets the UI group projected vs geographic without
 * a runtime CRS lookup.
 */
export interface CrsRegistryEntry {
  readonly epsg: number;
  readonly label: string;
  readonly kind: Extract<CrsKind, 'projected' | 'geographic'>;
  /** True for the worldwide-coverage geographic CRSs. */
  readonly worldwide: boolean;
  /** Country / region — used by the picker's grouping. */
  readonly region:
    | 'global'
    | 'united-states'
    | 'mexico'
    | 'europe'
    | 'other';
  /** One-line note shown as the option's title attribute. */
  readonly note: string;
}

const ENTRIES: readonly CrsRegistryEntry[] = [
  // ── Global geographic + Web Mercator ─────────────────────────────────────
  {
    epsg: 4326,
    label: 'WGS 84 (lat / lon)',
    kind: 'geographic',
    worldwide: true,
    region: 'global',
    note: 'World Geodetic System 1984 — the standard lat/lon CRS.',
  },
  {
    epsg: 4979,
    label: 'WGS 84 (3D, lat / lon + ellipsoidal height)',
    kind: 'geographic',
    worldwide: true,
    region: 'global',
    note: 'WGS 84 with ellipsoidal height — used by GNSS receivers.',
  },
  {
    epsg: 3857,
    label: 'Web Mercator',
    kind: 'projected',
    worldwide: true,
    region: 'global',
    note:
      'Web Mercator / Google / Bing / OSM tile projection. ' +
      'Distances are unreliable away from the equator.',
  },

  // ── United States — UTM zones (3DEP coverage) ────────────────────────────
  // The contiguous U.S. spans UTM zones 10N (West Coast) through 19N
  // (Maine). Alaska adds 1N, 2N (Aleutians wrap antimeridian), 3N-9N
  // (Alaska proper). Hawaii uses 4N + 5N. Puerto Rico + USVI use 19N + 20N.
  ...[
    { epsg: 26910, zone: 10, where: 'West Coast (CA, OR, WA)' },
    { epsg: 26911, zone: 11, where: 'Idaho, Nevada, parts of UT, AZ' },
    { epsg: 26912, zone: 12, where: 'Utah, Arizona east, Wyoming west' },
    { epsg: 26913, zone: 13, where: 'Colorado, Wyoming east, NM' },
    { epsg: 26914, zone: 14, where: 'Texas central, Oklahoma, Kansas' },
    { epsg: 26915, zone: 15, where: 'Iowa, Minnesota, Wisconsin' },
    { epsg: 26916, zone: 16, where: 'Illinois, Tennessee, KY, FL panhandle' },
    { epsg: 26917, zone: 17, where: 'Georgia, Carolinas, Virginia, OH' },
    { epsg: 26918, zone: 18, where: 'New York, New Jersey, PA' },
    { epsg: 26919, zone: 19, where: 'Maine, Vermont, New Hampshire' },
  ].map(
    (z): CrsRegistryEntry => ({
      epsg: z.epsg,
      label: `NAD83 / UTM zone ${z.zone}N`,
      kind: 'projected',
      worldwide: false,
      region: 'united-states',
      note: `Standard U.S. UTM zone ${z.zone}N — ${z.where}.`,
    }),
  ),

  // WGS84-flavoured UTM zones — also common in 3DEP deliverables.
  ...[
    { epsg: 32610, zone: 10 },
    { epsg: 32611, zone: 11 },
    { epsg: 32612, zone: 12 },
    { epsg: 32613, zone: 13 },
    { epsg: 32614, zone: 14 },
    { epsg: 32615, zone: 15 },
    { epsg: 32616, zone: 16 },
    { epsg: 32617, zone: 17 },
    { epsg: 32618, zone: 18 },
    { epsg: 32619, zone: 19 },
  ].map(
    (z): CrsRegistryEntry => ({
      epsg: z.epsg,
      label: `WGS 84 / UTM zone ${z.zone}N`,
      kind: 'projected',
      worldwide: false,
      region: 'united-states',
      note:
        `WGS84-datum UTM zone ${z.zone}N — common on USGS 3DEP COPC tiles.`,
    }),
  ),

  // ── Mexico — INEGI standard ─────────────────────────────────────────────
  {
    epsg: 6362,
    label: 'Mexico ITRF2008 / LCC',
    kind: 'projected',
    worldwide: false,
    region: 'mexico',
    note: 'INEGI standard for nationwide Mexico products.',
  },

  // ── Europe — ETRS89 and major UTM zones ─────────────────────────────────
  {
    epsg: 4258,
    label: 'ETRS89 (lat / lon)',
    kind: 'geographic',
    worldwide: false,
    region: 'europe',
    note: 'European Terrestrial Reference System 1989.',
  },
  {
    epsg: 25832,
    label: 'ETRS89 / UTM zone 32N',
    kind: 'projected',
    worldwide: false,
    region: 'europe',
    note: 'Germany, Denmark, parts of Italy and Austria.',
  },
  {
    epsg: 25833,
    label: 'ETRS89 / UTM zone 33N',
    kind: 'projected',
    worldwide: false,
    region: 'europe',
    note: 'Norway, Sweden, eastern Germany, Poland west.',
  },

  // ── Netherlands — RD New (AHN national LiDAR uses this) ─────────────────
  // The Dutch national LiDAR programme (AHN3 / AHN4) is one of the
  // densest publicly available LiDAR sources in the world. Datasets
  // sourced from AHN ship in EPSG:28992 (the Dutch national projected
  // CRS) and elevations in EPSG:5709 (NAP — Normaal Amsterdams Peil).
  // Carrying these in the registry means a user opening an AHN-derived
  // COPC sees the proper label instead of the bare EPSG number.
  {
    epsg: 28992,
    label: 'Amersfoort / RD New (Netherlands)',
    kind: 'projected',
    worldwide: false,
    region: 'europe',
    note:
      'Dutch national projection used by the AHN airborne LiDAR ' +
      'programme. Combines with NAP (EPSG:5709) for vertical reference.',
  },
];

/** Every registered entry, in display order. */
export function listCrsEntries(): readonly CrsRegistryEntry[] {
  return ENTRIES;
}

/** Look up an entry by EPSG code, or `undefined` if not registered. */
export function getCrsEntry(epsg: number): CrsRegistryEntry | undefined {
  return ENTRIES.find((e) => e.epsg === epsg);
}

/**
 * Entries grouped by region — drives the override-panel `<optgroup>`
 * layout. Empty groups are dropped so the picker isn't cluttered.
 */
export function listCrsEntriesByRegion(): readonly {
  readonly region: CrsRegistryEntry['region'];
  readonly entries: readonly CrsRegistryEntry[];
}[] {
  const regions: CrsRegistryEntry['region'][] = [
    'global',
    'united-states',
    'mexico',
    'europe',
    'other',
  ];
  return regions
    .map((region) => ({
      region,
      entries: ENTRIES.filter((e) => e.region === region),
    }))
    .filter((g) => g.entries.length > 0);
}
