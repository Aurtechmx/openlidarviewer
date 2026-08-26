/**
 * curatedLocations.ts
 *
 * Curated public point-cloud datasets. Each URL was reachable on the
 * date its record carries in `verifiedAt`, returning either a parseable
 * `ept.json` manifest or a streamable `.copc.laz` COPC file. The
 * reported sizes / point counts are taken from those checks; the
 * streaming pipeline only fetches the resident set the camera needs,
 * never the full file. No script in this repository re-runs the check:
 * a reachability claim here is the date and nothing more.
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
 * Provenance
 * ──────────
 * Every record states, as structured fields rather than prose, who
 * published the data, who mirrors it, under what licence, in what
 * format and native CRS, and which document in this tree those values
 * were transcribed from (`provenanceUrl`). A value the tree does not
 * record is `unknown`. `unknown` is a finding, not a formality: it
 * means nobody has written the answer down here yet, and it must never
 * be replaced by a plausible one. `licenseId` is drawn from a closed
 * vocabulary so a licence can be compared, not merely read.
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

/**
 * How the stream is served. `copc` is a single range-served `.copc.laz`
 * file, `ept` an Entwine manifest. Read off the URL when the record was
 * written, and asserted against it in the tests, so the two cannot drift.
 */
export type CuratedFormat = 'copc' | 'ept';

/**
 * Licence identities this catalog can carry. A closed vocabulary, so a
 * licence is comparable rather than a sentence to be read: free text like
 * "open data" or "Swiss federal open data" names a family of terms, not a
 * licence, and cannot be checked. `unknown` is the honest value whenever
 * this tree records no identifiable licence for the dataset.
 */
/**
 * Closed vocabulary of licence identities.
 *
 * `swisstopo-free-geodata` is not an SPDX id because the instrument has
 * none: swisstopo publishes its own terms under the Federal Act on
 * Geoinformation rather than adopting a Creative Commons licence. It is
 * named here rather than mapped onto CC-BY, which it resembles but is
 * not.
 */
export const CURATED_LICENSE_IDS = [
  'CC-BY-4.0',
  'public-domain',
  'swisstopo-free-geodata',
  'unknown',
] as const;
export type CuratedLicenseId = (typeof CURATED_LICENSE_IDS)[number];

/** Sentinel for a field this tree records no value for. */
export const UNKNOWN = 'unknown';

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
  /** Serving format of `streamUrl`. */
  readonly format: CuratedFormat;
  /**
   * EPSG code the source declares for its horizontal frame, or `unknown`
   * when no document in this tree records one. Never inferred from the
   * country: a national programme can publish in more than one frame.
   */
  readonly nativeEpsg: number | typeof UNKNOWN;
  /** Body that produced and published the survey. */
  readonly publisher: string;
  /**
   * Who serves the bytes this URL points at, when that is not the
   * publisher. Republishing in COPC does not change the licence, so the
   * two are recorded separately.
   */
  readonly mirrorProvider: string;
  /** Normalized licence identity, or `unknown`. */
  readonly licenseId: CuratedLicenseId;
  /** Licence text URL, or `unknown`. */
  readonly licenseUrl: string;
  /** Credit line the provider asks for, verbatim, or `unknown`. */
  readonly attribution: string;
  /**
   * The document in this tree the four fields above were transcribed
   * from. A reader checks the record by opening it; the tests check that
   * it resolves.
   */
  readonly provenanceUrl: string;
  /** ISO date this URL was last recorded as reachable. */
  readonly verifiedAt: string;
}

/**
 * Telemetry category for a curated pick, derived from the record.
 *
 * The picker used to report one hardcoded string, `curated:usgs-ept`, for
 * every selection, so a European COPC tile was counted as a US EPT
 * dataset. A counter that records the wrong category is worse than one
 * that records nothing, because it reads as evidence.
 */
export function curatedUsageCategory(streamUrl: string): string {
  const loc = CURATED_LOCATIONS.find((c) => c.streamUrl === streamUrl);
  return loc ? `curated:${loc.format}` : 'curated:unlisted';
}

/**
 * Shipped list, sorted smallest-first. Each entry's size and point
 * count are noted in the hint so users can pick by network budget.
 *
 * European national programmes from FLAI Open LiDAR Data
 * (https://github.com/flai-ai/open-lidar-data) are folded into the
 * smallest-first ordering. Each was checked live (CORS preflight + HEAD
 * size + ranged-GET LAS-header parse) on the date in its `verifiedAt`.
 *
 * Licence and publisher live in the records below, one field each, and
 * `provenanceUrl` names the document they were transcribed from. They
 * are deliberately not restated here: a licence written twice is a
 * licence that can disagree with itself.
 *
 * NL AHN4 was dropped: its open-data status could not be verified against
 * an authoritative AHN source, so the catalog no longer asserts it.
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
    hint: 'FLAI Open LiDAR Data · swissSURFACE3D · © swisstopo, free geodata terms.',
    bbox: [6.10, 46.20, 6.15, 46.25],
    displayName: 'swisssurface3D 2022',
    streamUrl:
      'https://open-lidar-data.s3.eu-central-1.amazonaws.com/data/CH/Swiss_federal_authorities/swisssurface3d_2022/copc/2485_1109.copc.laz',
    format: 'copc',
    // CrsRegistry names EPSG:2056 as the frame swissSURFACE3D publishes in.
    nativeEpsg: 2056,
    publisher: 'swisstopo (Swiss Federal Office of Topography)',
    mirrorProvider: 'FLAI Open LiDAR Data',
    // swisstopo's own terms for free geodata and geoservices. Not a
    // Creative Commons licence and it carries no SPDX id, so it is named
    // on its own terms. Use, redistribution and commercial use are
    // permitted where the source is credited.
    licenseId: 'swisstopo-free-geodata',
    licenseUrl: 'https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices',
    attribution: '© swisstopo',
    provenanceUrl: 'public/credits.html',
    verifiedAt: '2026-07-19',
  },
  {
    id: 'flai-si-clss-2023',
    label: 'Slovenia — GURS CLSS (2023)',
    sizeLabel: '202 MB',
    hint: 'FLAI Open LiDAR Data · Slovenian GURS national classified · CC BY 4.0.',
    bbox: [14.50, 46.00, 14.60, 46.10],
    displayName: 'Slovenia GURS CLSS 2023',
    streamUrl:
      'https://open-lidar-data.s3.eu-central-1.amazonaws.com/data/SI/GURS/CLSS_2023/copc/GKOT_433_100.copc.laz',
    format: 'copc',
    // CrsRegistry names EPSG:3794 as the frame GURS CLSS publishes in.
    nativeEpsg: 3794,
    publisher: 'GURS',
    mirrorProvider: 'FLAI Open LiDAR Data',
    licenseId: 'CC-BY-4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    attribution: '© GURS',
    provenanceUrl: 'public/credits.html',
    verifiedAt: '2026-05-29',
  },
  {
    id: 'sf-coast-ca',
    label: 'San Francisco Coast (2010)',
    sizeLabel: '2.2B pts',
    hint: 'ARRA-funded 2010 coastal strip · EPT streamed.',
    bbox: [-122.80, 37.50, -122.30, 37.90],
    displayName: 'San Francisco Coast, CA (2010)',
    streamUrl: 'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/ARRA-CA_SanFranCoast_2010/ept.json',
    format: 'ept',
    nativeEpsg: UNKNOWN,
    publisher: 'United States Geological Survey (3DEP)',
    mirrorProvider: 'AWS Registry of Open Data',
    licenseId: 'public-domain',
    licenseUrl: 'https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits',
    attribution: 'Data available from U.S. Geological Survey, National Geospatial Program.',
    provenanceUrl: 'public/credits.html',
    verifiedAt: '2026-05-29',
  },
  {
    id: 'los-angeles-2-ca',
    label: 'Los Angeles block 2',
    sizeLabel: '3.6B pts',
    hint: 'Recent B23 LA campaign · EPT streamed.',
    bbox: [-118.50, 33.70, -118.10, 34.10],
    displayName: 'Los Angeles block 2, CA',
    streamUrl: 'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/CA_LosAngeles_2_B23/ept.json',
    format: 'ept',
    nativeEpsg: UNKNOWN,
    publisher: 'United States Geological Survey (3DEP)',
    mirrorProvider: 'AWS Registry of Open Data',
    licenseId: 'public-domain',
    licenseUrl: 'https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits',
    attribution: 'Data available from U.S. Geological Survey, National Geospatial Program.',
    provenanceUrl: 'public/credits.html',
    verifiedAt: '2026-05-29',
  },
  {
    id: 'golden-gate-ca',
    label: 'Golden Gate / SF Bay (2010)',
    sizeLabel: '8.8B pts',
    hint: 'ARRA 2010 SF Bay · EPT streamed.',
    bbox: [-122.80, 37.55, -122.35, 37.95],
    displayName: 'Golden Gate / SF Bay, CA (2010)',
    streamUrl: 'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/ARRA-CA_GoldenGate_2010/ept.json',
    format: 'ept',
    // EPSG:3857 read off this manifest and recorded in
    // validation/datasets/dataset-register.yaml, OLV-DS-019-EPT-GOLDEN-GATE-2010.
    nativeEpsg: 3857,
    publisher: 'United States Geological Survey (3DEP)',
    mirrorProvider: 'AWS Registry of Open Data',
    licenseId: 'public-domain',
    licenseUrl: 'https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits',
    attribution: 'Data available from U.S. Geological Survey, National Geospatial Program.',
    provenanceUrl: 'public/credits.html',
    verifiedAt: '2026-05-29',
  },
  {
    id: 'grand-canyon-2-az',
    label: 'Grand Canyon NP block 2',
    sizeLabel: '8.9B pts',
    hint: 'USGS 2019 block 2 · EPT streamed.',
    bbox: [-112.80, 36.00, -112.30, 36.40],
    displayName: 'Grand Canyon NP block 2, AZ',
    streamUrl: 'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/AZ_GrandCanyonNP_2_2019/ept.json',
    format: 'ept',
    nativeEpsg: UNKNOWN,
    publisher: 'United States Geological Survey (3DEP)',
    mirrorProvider: 'AWS Registry of Open Data',
    licenseId: 'public-domain',
    licenseUrl: 'https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits',
    attribution: 'Data available from U.S. Geological Survey, National Geospatial Program.',
    provenanceUrl: 'public/credits.html',
    verifiedAt: '2026-05-29',
  },
  {
    id: 'san-francisco-ca',
    label: 'San Francisco',
    sizeLabel: '13.1B pts',
    hint: 'Recent B23 SF campaign · EPT streamed.',
    bbox: [-122.55, 37.70, -122.35, 37.85],
    displayName: 'San Francisco, CA',
    streamUrl: 'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/CA_SanFrancisco_1_B23/ept.json',
    format: 'ept',
    nativeEpsg: UNKNOWN,
    publisher: 'United States Geological Survey (3DEP)',
    mirrorProvider: 'AWS Registry of Open Data',
    licenseId: 'public-domain',
    licenseUrl: 'https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits',
    attribution: 'Data available from U.S. Geological Survey, National Geospatial Program.',
    provenanceUrl: 'public/credits.html',
    verifiedAt: '2026-05-29',
  },
  {
    id: 'denver-drcog-co',
    label: 'Denver Metro DRCOG',
    sizeLabel: '19.9B pts',
    hint: 'Front-Range metro 2020 campaign · EPT streamed.',
    bbox: [-105.10, 39.65, -104.80, 39.85],
    displayName: 'Denver Metro (DRCOG block 1), CO',
    streamUrl: 'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/CO_DRCOG_1_2020/ept.json',
    format: 'ept',
    nativeEpsg: UNKNOWN,
    publisher: 'United States Geological Survey (3DEP)',
    mirrorProvider: 'AWS Registry of Open Data',
    licenseId: 'public-domain',
    licenseUrl: 'https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits',
    attribution: 'Data available from U.S. Geological Survey, National Geospatial Program.',
    provenanceUrl: 'public/credits.html',
    verifiedAt: '2026-05-29',
  },
  {
    id: 'grand-canyon-az',
    label: 'Grand Canyon National Park ★',
    sizeLabel: '22.4B pts',
    hint: 'USGS 2019 survey · ~800 m vertical relief.',
    bbox: [-112.30, 35.95, -111.80, 36.30],
    displayName: 'Grand Canyon National Park, AZ',
    streamUrl: 'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/AZ_GrandCanyonNP_1_2019/ept.json',
    format: 'ept',
    nativeEpsg: UNKNOWN,
    publisher: 'United States Geological Survey (3DEP)',
    mirrorProvider: 'AWS Registry of Open Data',
    licenseId: 'public-domain',
    licenseUrl: 'https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits',
    attribution: 'Data available from U.S. Geological Survey, National Geospatial Program.',
    provenanceUrl: 'public/credits.html',
    verifiedAt: '2026-05-29',
  },
  {
    id: 'denver-drcog-2-co',
    label: 'Denver Metro DRCOG block 2',
    sizeLabel: '39.4B pts',
    hint: 'DRCOG block 2 · EPT streamed.',
    bbox: [-105.10, 39.40, -104.50, 39.85],
    displayName: 'Denver Metro DRCOG block 2, CO',
    streamUrl: 'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/CO_DRCOG_2_2020/ept.json',
    format: 'ept',
    nativeEpsg: UNKNOWN,
    publisher: 'United States Geological Survey (3DEP)',
    mirrorProvider: 'AWS Registry of Open Data',
    licenseId: 'public-domain',
    licenseUrl: 'https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits',
    attribution: 'Data available from U.S. Geological Survey, National Geospatial Program.',
    provenanceUrl: 'public/credits.html',
    verifiedAt: '2026-05-29',
  },
  {
    id: 'denver-drcog-3-co',
    label: 'Denver Metro DRCOG block 3',
    sizeLabel: '58.4B pts',
    hint: 'DRCOG block 3 · largest Front-Range tile.',
    bbox: [-105.30, 39.50, -104.60, 39.95],
    displayName: 'Denver Metro DRCOG block 3, CO',
    streamUrl: 'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/CO_DRCOG_3_2020/ept.json',
    format: 'ept',
    nativeEpsg: UNKNOWN,
    publisher: 'United States Geological Survey (3DEP)',
    mirrorProvider: 'AWS Registry of Open Data',
    licenseId: 'public-domain',
    licenseUrl: 'https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits',
    attribution: 'Data available from U.S. Geological Survey, National Geospatial Program.',
    provenanceUrl: 'public/credits.html',
    verifiedAt: '2026-05-29',
  },
  {
    id: 'los-angeles-ca',
    label: 'Los Angeles, California (2016) ★',
    sizeLabel: '75.2B pts',
    hint: '2016 LA campaign · widest metro EPT.',
    bbox: [-118.70, 33.70, -117.95, 34.30],
    displayName: 'Los Angeles, CA (2016)',
    streamUrl: 'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/USGS_LPC_CA_LosAngeles_2016_LAS_2018/ept.json',
    format: 'ept',
    nativeEpsg: UNKNOWN,
    publisher: 'United States Geological Survey (3DEP)',
    mirrorProvider: 'AWS Registry of Open Data',
    licenseId: 'public-domain',
    licenseUrl: 'https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits',
    attribution: 'Data available from U.S. Geological Survey, National Geospatial Program.',
    provenanceUrl: 'public/credits.html',
    verifiedAt: '2026-05-29',
  },
];

/** Look up a curated location by its id. */
export function getCuratedLocation(id: string): CuratedLocation | undefined {
  return CURATED_LOCATIONS.find((c) => c.id === id);
}

/**
 * Bytes behind a record's `sizeLabel`, when that label states a file size.
 *
 * The cellular-data gate needs a number and the label is written for a
 * reader, so one of the two has to be derived from the other. Deriving
 * the number means a corrected label cannot leave a stale threshold
 * behind. Catalogue entries measured in points, not bytes, have no file
 * size to report and return undefined.
 */
export function curatedSizeBytes(loc: CuratedLocation): number | undefined {
  const m = /^([\d.]+)\s*(MB|GB)$/.exec(loc.sizeLabel.trim());
  if (!m) return undefined;
  const scale = m[2] === 'GB' ? 1_000_000_000 : 1_000_000;
  return Math.round(Number(m[1]) * scale);
}
