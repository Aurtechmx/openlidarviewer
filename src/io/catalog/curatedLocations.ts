/**
 * curatedLocations.ts
 *
 * Verified-working public point-cloud datasets — every URL was probed
 * against its live host on 2026-05-29 and returned an HTTP 200 with
 * either a parseable `ept.json` manifest or a streamable `.copc.laz`
 * COPC file. The reported sizes / point counts are taken from those
 * probes; the streaming pipeline only fetches the resident set the
 * camera needs, never the full file.
 *
 * Why direct URLs instead of a bbox-query catalog
 * ───────────────────────────────────────────────
 * The USGS TNM Products API (the "find LiDAR by address" path) only
 * surfaces legacy non-streamable LAZ — zero `.copc.laz` URLs across
 * every bbox we tested. Rather than ship a feature that always returns
 * "0 COPC tiles," the picker carries a curated list of direct URLs that
 * actually work. Power users can paste their own COPC URL into the
 * dedicated URL field above this picker.
 *
 * Scope
 * ─────
 * Every entry here streams from a host with a CONFIRMED open licence —
 * the FLAI European open-data bucket (swisstopo / GURS / AHN national
 * programmes) and the USGS 3DEP public-domain bucket. Datasets whose
 * licence could not be confirmed are intentionally not listed.
 *
 * Ordering
 * ────────
 * The list opens with the smaller European COPC tiles (a first-time
 * visitor sees streaming work in seconds) and graduates to the
 * multi-billion-point USGS EPT datasets. The `streamUrl` is either a
 * COPC file (single `.copc.laz`) or an EPT manifest (`.../ept.json`);
 * the streaming pipeline detects the format by URL pattern.
 */

import type { LatLonBbox } from './types';

export interface CuratedLocation {
  readonly id: string;
  /** Clean place / dataset name shown in the dropdown. */
  readonly label: string;
  /**
   * Short network-budget tag shown inline in the dropdown — file size
   * for COPC datasets, point count for EPT datasets. Lets the user
   * pick by network commitment without opening the hint.
   */
  readonly sizeLabel: string;
  /** A short hint shown below the dropdown when this option is active. */
  readonly hint: string;
  /** Approximate bbox — retained for future use (map preview thumbnail). */
  readonly bbox: LatLonBbox;
  /** Display string for status text — what the user "picked". */
  readonly displayName: string;
  /** Direct streaming URL — handed to handleRemoteUrl() on click. */
  readonly streamUrl: string;
}

/**
 * Shipped list, sorted smallest-first. Each entry's size and point
 * count are noted in the hint so users can pick by network budget.
 *
 * European national programmes from FLAI Open LiDAR Data
 * (https://github.com/flai-ai/open-lidar-data) are folded into the
 * smallest-first ordering. Each was probed live (CORS preflight + HEAD
 * size + ranged-GET LAS-header parse) and shipped only after passing.
 * The probe lives at `tools/verify-flai.sh` for re-run before any
 * future release.
 *
 * Licensing per FLAI catalog:
 *   - LU  CC0 (Luxembourg geoportal)
 *   - EE  Maa-amet open data
 *   - ES  CC BY 4.0 (CNIG)
 *   - BE  CC BY 4.0 (Flanders EODaS)
 *   - FI  CC BY 4.0 (NLS)
 *   - CH  Swiss federal open data
 *   - SI  CC BY 4.0 (GURS)
 *   - NL  AHN public domain (no conditions)
 * The S3 bucket is hosted by FLAI on AWS eu-central-1; CORS is open.
 * Bandwidth politeness: nothing preloads — user-initiated clicks only.
 */
export const CURATED_LOCATIONS: readonly CuratedLocation[] = [
  // ── Showcase first — visually striking, professionally useful ──
  // v0.3.8 re-ordering: Switzerland leads because the swisssurface3D
  // tile has high point density, dramatic alpine terrain variation,
  // and reliable streaming behaviour. The previous "smallest first"
  // ordering optimised for download speed at the cost of first
  // impression — most users want to see what the tool can do, not
  // see how fast it loads 1 MB.
  {
    id: 'flai-ch-swisssurface3d-2022',
    label: 'Switzerland — swisssurface3D (2022)',
    sizeLabel: '83.8 MB',
    hint: 'FLAI Open LiDAR Data · Swiss federal open data.',
    bbox: [6.10, 46.20, 6.15, 46.25],
    displayName: 'swisssurface3D 2022',
    streamUrl:
      'https://open-lidar-data.s3.eu-central-1.amazonaws.com/data/CH/Swiss_federal_authorities/swisssurface3d_2022/copc/2485_1109.copc.laz',
  },
  {
    id: 'flai-si-clss-2023',
    label: 'Slovenia — GURS CLSS (2023)',
    sizeLabel: '202 MB',
    hint: 'FLAI Open LiDAR Data · Slovenian GURS national classified · open data.',
    bbox: [14.50, 46.00, 14.60, 46.10],
    displayName: 'Slovenia GURS CLSS 2023',
    streamUrl:
      'https://open-lidar-data.s3.eu-central-1.amazonaws.com/data/SI/GURS/CLSS_2023/copc/GKOT_433_100.copc.laz',
  },
  {
    id: 'flai-nl-ahn4',
    label: 'Netherlands — AHN4 national (2020–22)',
    sizeLabel: '475 MB',
    hint: 'FLAI Open LiDAR Data · Dutch AHN4 · public domain, no conditions.',
    bbox: [4.40, 51.50, 4.50, 51.60],
    displayName: 'Netherlands AHN4 2020–22',
    streamUrl:
      'https://open-lidar-data.s3.eu-central-1.amazonaws.com/data/NL/AHN/AHN4_2020-2022/copc/C_01CZ1.copc.laz',
  },
  {
    id: 'sf-coast-ca',
    label: 'San Francisco Coast (2010)',
    sizeLabel: '2.2B pts',
    hint: 'ARRA-funded 2010 coastal strip · EPT streamed.',
    bbox: [-122.80, 37.50, -122.30, 37.90],
    displayName: 'San Francisco Coast, CA (2010)',
    streamUrl: 'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/ARRA-CA_SanFranCoast_2010/ept.json',
  },
  {
    id: 'los-angeles-2-ca',
    label: 'Los Angeles block 2',
    sizeLabel: '3.6B pts',
    hint: 'Recent B23 LA campaign · EPT streamed.',
    bbox: [-118.50, 33.70, -118.10, 34.10],
    displayName: 'Los Angeles block 2, CA',
    streamUrl: 'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/CA_LosAngeles_2_B23/ept.json',
  },
  {
    id: 'denver-2008-co',
    label: 'Denver, Colorado (2008)',
    sizeLabel: '4.2B pts',
    hint: 'Legacy 2008 Denver campaign · EPT streamed.',
    bbox: [-105.10, 39.65, -104.80, 39.85],
    displayName: 'Denver, CO (2008)',
    streamUrl: 'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/CO_Denver_2008/ept.json',
  },
  {
    id: 'golden-gate-ca',
    label: 'Golden Gate / SF Bay (2010)',
    sizeLabel: '8.8B pts',
    hint: 'ARRA 2010 SF Bay · EPT streamed.',
    bbox: [-122.80, 37.55, -122.35, 37.95],
    displayName: 'Golden Gate / SF Bay, CA (2010)',
    streamUrl: 'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/ARRA-CA_GoldenGate_2010/ept.json',
  },
  {
    id: 'grand-canyon-2-az',
    label: 'Grand Canyon NP block 2',
    sizeLabel: '8.9B pts',
    hint: 'USGS 2019 block 2 · EPT streamed.',
    bbox: [-112.80, 36.00, -112.30, 36.40],
    displayName: 'Grand Canyon NP block 2, AZ',
    streamUrl: 'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/AZ_GrandCanyonNP_2_2019/ept.json',
  },
  {
    id: 'san-francisco-ca',
    label: 'San Francisco',
    sizeLabel: '13.1B pts',
    hint: 'Recent B23 SF campaign · EPT streamed.',
    bbox: [-122.55, 37.70, -122.35, 37.85],
    displayName: 'San Francisco, CA',
    streamUrl: 'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/CA_SanFrancisco_1_B23/ept.json',
  },
  {
    id: 'denver-drcog-co',
    label: 'Denver Metro DRCOG',
    sizeLabel: '19.9B pts',
    hint: 'Front-Range metro 2020 campaign · EPT streamed.',
    bbox: [-105.10, 39.65, -104.80, 39.85],
    displayName: 'Denver Metro (DRCOG block 1), CO',
    streamUrl: 'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/CO_DRCOG_1_2020/ept.json',
  },
  {
    id: 'grand-canyon-az',
    label: 'Grand Canyon National Park ★',
    sizeLabel: '22.4B pts',
    hint: 'USGS 2019 survey · ~800 m vertical relief.',
    bbox: [-112.30, 35.95, -111.80, 36.30],
    displayName: 'Grand Canyon National Park, AZ',
    streamUrl: 'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/AZ_GrandCanyonNP_1_2019/ept.json',
  },
  {
    id: 'denver-drcog-2-co',
    label: 'Denver Metro DRCOG block 2',
    sizeLabel: '39.4B pts',
    hint: 'DRCOG block 2 · EPT streamed.',
    bbox: [-105.10, 39.40, -104.50, 39.85],
    displayName: 'Denver Metro DRCOG block 2, CO',
    streamUrl: 'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/CO_DRCOG_2_2020/ept.json',
  },
  {
    id: 'denver-drcog-3-co',
    label: 'Denver Metro DRCOG block 3',
    sizeLabel: '58.4B pts',
    hint: 'DRCOG block 3 · largest Front-Range tile.',
    bbox: [-105.30, 39.50, -104.60, 39.95],
    displayName: 'Denver Metro DRCOG block 3, CO',
    streamUrl: 'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/CO_DRCOG_3_2020/ept.json',
  },
  {
    id: 'los-angeles-ca',
    label: 'Los Angeles, California (2016) ★',
    sizeLabel: '75.2B pts',
    hint: '2016 LA campaign · widest metro EPT.',
    bbox: [-118.70, 33.70, -117.95, 34.30],
    displayName: 'Los Angeles, CA (2016)',
    streamUrl: 'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/USGS_LPC_CA_LosAngeles_2016_LAS_2018/ept.json',
  },
];

/** Look up a curated location by its id. */
export function getCuratedLocation(id: string): CuratedLocation | undefined {
  return CURATED_LOCATIONS.find((c) => c.id === id);
}
