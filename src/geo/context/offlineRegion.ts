/**
 * offlineRegion.ts
 *
 * The pure model for Context View offline map regions: a named lon/lat box a
 * user could later choose to download basemap tiles for, the arithmetic that
 * says how many tiles such a box would cost, and the validation that refuses a
 * region before anyone acts on it.
 *
 * AN ESTIMATE IS NOT PERMISSION. `estimateRegionTileCount` is slippy-map
 * arithmetic and nothing more: learning that a box costs 12,000 tiles says
 * nothing whatsoever about whether those 12,000 tiles may be fetched. Any real
 * download remains subject to BOTH gates that already exist — the session
 * consent machine in `consent.ts`, which permits network access only in the
 * 'granted' state, and the tile provider's own usage policy, which is the
 * provider's rule and not ours to reinterpret. Some providers, OpenStreetMap's
 * standard tile server among them, prohibit bulk downloading outright; for
 * those the honest count is zero however small this module reports the region
 * to be. This build performs no download of any kind: no module under
 * src/geo/context does I/O, and this one adds none — it computes numbers about
 * a region a user described, and stops there.
 *
 * The estimate counts every tile the box TOUCHES, including tiles it only
 * grazes along an edge, so it over-counts rather than under-counts. A budget
 * that is too small is the failure mode worth avoiding.
 *
 * Pure and deterministic: no I/O, no DOM, no three.js, no proj4. Non-finite
 * and structurally impossible input is a caller bug and throws a TypeError
 * naming the argument (house style); `validateOfflineRegion` is the total
 * function that tolerates anything and answers with problems instead.
 */

import { OSM_PROVIDER } from './providerInterface';

/** A lon/lat bounding box in WGS84 degrees. */
export interface OfflineRegionBbox {
  /** Western edge, degrees longitude. */
  readonly west: number;
  /** Southern edge, degrees latitude. */
  readonly south: number;
  /** Eastern edge, degrees longitude. Must be strictly east of `west`. */
  readonly east: number;
  /** Northern edge, degrees latitude. Must be strictly north of `south`. */
  readonly north: number;
}

/** One named offline region: a box plus the zoom range it would be stored at. */
export interface OfflineRegion {
  /** Stable identifier, chosen by the caller. */
  readonly id: string;
  /** Human-readable name, as the user typed it. */
  readonly name: string;
  /** The area, in WGS84 degrees. */
  readonly bbox: OfflineRegionBbox;
  /** Shallowest tile zoom to include (inclusive). */
  readonly minZoom: number;
  /** Deepest tile zoom to include (inclusive). */
  readonly maxZoom: number;
}

/** The region may be offered to a download flow (which has its own gates). */
export interface OfflineRegionValid {
  readonly ok: true;
}

/** The region must be refused; `problems` are vocabulary strings, in a fixed order. */
export interface OfflineRegionInvalid {
  readonly ok: false;
  readonly problems: readonly OfflineRegionProblemText[];
}

export type OfflineRegionValidation = OfflineRegionValid | OfflineRegionInvalid;

/**
 * Every reason a region can be refused, frozen so no caller can mutate the
 * vocabulary. These are deliberately NOT in `CONTEXT_STATUS` (statusVocabulary
 * .ts): that vocabulary holds the full-sentence explanations the Context View
 * panel already shows, and these describe a download flow that does not exist
 * yet. If and when a region editor ships a user-facing surface, they belong
 * there instead, so the panel and this model cannot describe the same refusal
 * in two voices.
 *
 * The strings name the rule, not the numbers: the concrete limits are exported
 * as {@link OFFLINE_REGION_TILE_CEILING}, {@link MAX_TILE_ZOOM_LEVEL} and
 * {@link WEB_MERCATOR_MAX_LATITUDE_DEG}, so a caller can compose a richer
 * sentence without this module guessing at its phrasing.
 */
export const OFFLINE_REGION_PROBLEM = Object.freeze({
  /** A longitude edge is not a finite number within ±180°. */
  lonOutOfRange: 'Longitude bounds must be finite numbers between -180 and 180 degrees.',
  /** A latitude edge is not a finite number within the Web Mercator limit. */
  latOutOfRange:
    'Latitude bounds must be finite numbers within the Web Mercator limit of ±85.0511 degrees; the tile grid does not reach the poles.',
  /** west is not strictly west of east. */
  bboxInvertedLon:
    'The west edge must be strictly west of the east edge. A box that wraps the antimeridian is not supported here, because guessing which way round the world it runs could turn a small region into a planet-sized one.',
  /** south is not strictly south of north. */
  bboxInvertedLat: 'The south edge must be strictly south of the north edge.',
  /** A zoom is not a whole number inside the tile grid's zoom range. */
  zoomNotWhole:
    'Zoom levels must be whole numbers from 0 to 24; a tile pyramid exists only at those levels.',
  /** minZoom is deeper than maxZoom. */
  zoomInverted: 'The minimum zoom must not be greater than the maximum zoom.',
  /** maxZoom is deeper than the provider publishes. */
  zoomAboveProviderMax:
    'The maximum zoom is deeper than the tile provider publishes, so those tiles do not exist to be stored.',
  /** The estimated tile count exceeds the guard ceiling. */
  tileCountAboveCeiling:
    'This region would need more tiles than the download ceiling allows. Narrow the area or reduce the maximum zoom.',
} as const);

/** One of the refusal strings in {@link OFFLINE_REGION_PROBLEM}. */
export type OfflineRegionProblemText =
  (typeof OFFLINE_REGION_PROBLEM)[keyof typeof OFFLINE_REGION_PROBLEM];

/**
 * The latitude limit of the Web Mercator tile grid, in degrees.
 *
 * The exact value is 85.05112877980659°, where the projected y reaches ±π and
 * the tile grid becomes square. The conventional rounded 85.0511 used here sits
 * just INSIDE that, so refusing anything beyond it can never admit a latitude
 * the grid cannot represent — the rounding errs toward refusal, which is the
 * direction this codebase rounds.
 */
export const WEB_MERCATOR_MAX_LATITUDE_DEG = 85.0511;

/**
 * The deepest zoom level this model will reason about at all.
 *
 * At z24 the grid is 16,777,216 tiles across and one pixel covers roughly 9 mm
 * at the equator; no public provider serves anywhere near it. The bound exists
 * less as a geodetic statement than as a structural one: the tile count is a
 * sum over zoom levels, and without an upper bound a nonsense `maxZoom` would
 * turn that sum into an unbounded loop.
 */
export const MAX_TILE_ZOOM_LEVEL = 24;

/**
 * The largest tile count {@link validateOfflineRegion} will accept for one
 * region.
 *
 * This number is a guard against an accidental continent-sized download. It is
 * NOT a licence claim: it says nothing about what any provider permits, and a
 * provider that forbids bulk downloading forbids it at one tile as firmly as at
 * twenty-five thousand. It was chosen by measuring what real shapes cost, with
 * "whole world" meaning ±180° longitude and ±85.0511° latitude:
 *
 *   - a 1.5 km survey site, zooms 0-19 (the deepest OSM serves)  ~2,000 tiles
 *   - a 20 km city, zooms 0-17                                  ~11,800 tiles
 *   - an 8° country, zooms 0-12                                 ~16,300 tiles
 *   - the whole world, zooms 0-7                                  21,845 tiles
 *   - Europe (60° x 35°), zooms 0-10                            ~40,900 tiles
 *   - the whole world, zooms 0-8                                  87,381 tiles
 *
 * 25,000 admits every case a scan viewer plausibly wants — a site at full
 * detail, a city at street zoom, the planet at overview zoom — and refuses the
 * continent-scale ones. It is also, at a nominal 20 KB per 256-pixel tile,
 * roughly 500 MB and twenty-five thousand separate requests: far enough past
 * "a slip of the mouse" to be worth stopping and asking again.
 */
export const OFFLINE_REGION_TILE_CEILING = 25_000;

/**
 * The provider zoom ceiling {@link validateOfflineRegion} assumes when the
 * caller names none. Read from {@link OSM_PROVIDER} rather than written as a
 * literal so the two cannot drift; a caller using a different provider passes
 * that provider's own `maxZoom`.
 */
export const DEFAULT_PROVIDER_MAX_ZOOM = OSM_PROVIDER.maxZoom;

/** A longitude that names a real meridian. */
function isUsableLon(deg: number): boolean {
  return Number.isFinite(deg) && Math.abs(deg) <= 180;
}

/** A latitude the Web Mercator tile grid can represent. */
function isUsableLat(deg: number): boolean {
  return Number.isFinite(deg) && Math.abs(deg) <= WEB_MERCATOR_MAX_LATITUDE_DEG;
}

/** A zoom level the tile pyramid actually has. */
function isUsableZoom(z: number): boolean {
  return Number.isInteger(z) && z >= 0 && z <= MAX_TILE_ZOOM_LEVEL;
}

/** Keep a tile index inside the grid; an edge at exactly 180° indexes off the end. */
function clampTileIndex(index: number, gridSize: number): number {
  if (index < 0) return 0;
  if (index > gridSize - 1) return gridSize - 1;
  return index;
}

/** Standard slippy-map column for a longitude at a zoom level. */
function tileColumn(lonDeg: number, zoom: number): number {
  const gridSize = 2 ** zoom;
  return clampTileIndex(Math.floor(((lonDeg + 180) / 360) * gridSize), gridSize);
}

/**
 * Standard slippy-map row for a latitude at a zoom level. Rows count southward
 * from the top, so a NORTHERN latitude yields the SMALLER row index.
 */
function tileRow(latDeg: number, zoom: number): number {
  const gridSize = 2 ** zoom;
  const latRad = (latDeg * Math.PI) / 180;
  const y = ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * gridSize;
  return clampTileIndex(Math.floor(y), gridSize);
}

/**
 * Every structural problem with a region: the ones that make the tile
 * arithmetic meaningless, in a fixed order so the same region always reads the
 * same way. Provider limits and the download ceiling are NOT here — they are
 * policy applied on top of a sound region, and live in
 * {@link validateOfflineRegion}.
 *
 * An ordering problem is only reported for values that are themselves usable:
 * saying "west must be west of east" about a NaN adds noise to a refusal that
 * already said the longitude is not a number.
 */
function collectStructuralProblems(region: OfflineRegion): OfflineRegionProblemText[] {
  const problems: OfflineRegionProblemText[] = [];
  const { west, south, east, north } = region.bbox;

  const lonUsable = isUsableLon(west) && isUsableLon(east);
  if (!lonUsable) {
    problems.push(OFFLINE_REGION_PROBLEM.lonOutOfRange);
  }
  const latUsable = isUsableLat(south) && isUsableLat(north);
  if (!latUsable) {
    problems.push(OFFLINE_REGION_PROBLEM.latOutOfRange);
  }
  if (lonUsable && west >= east) {
    problems.push(OFFLINE_REGION_PROBLEM.bboxInvertedLon);
  }
  if (latUsable && south >= north) {
    problems.push(OFFLINE_REGION_PROBLEM.bboxInvertedLat);
  }

  const zoomsUsable = isUsableZoom(region.minZoom) && isUsableZoom(region.maxZoom);
  if (!zoomsUsable) {
    problems.push(OFFLINE_REGION_PROBLEM.zoomNotWhole);
  }
  if (zoomsUsable && region.minZoom > region.maxZoom) {
    problems.push(OFFLINE_REGION_PROBLEM.zoomInverted);
  }

  return problems;
}

/**
 * How many tiles this region spans, summed over every zoom level from
 * `minZoom` to `maxZoom` inclusive.
 *
 * Standard slippy-map arithmetic: at each zoom the box's west/east edges give a
 * column range and its north/south edges give a row range, and the product is
 * that level's tile count. An edge lying exactly on a tile boundary counts the
 * adjacent tile as well, so the answer is an upper bound, never an under-count.
 *
 * This is a COST ESTIMATE, not a decision and not a permission — see the module
 * header. It requires a structurally sound region and throws a TypeError naming
 * `region` otherwise; call {@link validateOfflineRegion} first, which is the
 * total function for untrusted input and never calls this before its own
 * structural checks pass.
 */
export function estimateRegionTileCount(region: OfflineRegion): number {
  const problems = collectStructuralProblems(region);
  if (problems.length > 0) {
    throw new TypeError(
      `estimateRegionTileCount: "region" is not structurally sound: ${problems.join(' ')}`,
    );
  }

  const { west, south, east, north } = region.bbox;
  let total = 0;
  for (let zoom = region.minZoom; zoom <= region.maxZoom; zoom += 1) {
    const columns = tileColumn(east, zoom) - tileColumn(west, zoom) + 1;
    // North is the smaller row index, so the southern edge bounds the range.
    const rows = tileRow(south, zoom) - tileRow(north, zoom) + 1;
    total += columns * rows;
  }
  return total;
}

/**
 * Decide whether a region may be offered to a download flow at all.
 *
 * Total over the numbers: every numeric value a region can carry — NaN, ±∞,
 * absurd zooms, an inside-out box — is tolerated and answered with problems
 * rather than an exception. Two things remain caller bugs rather than facts
 * about the region, and still throw: a non-finite `providerMaxZoom`, and a
 * `region` that does not have the shape its type promises. Like every other
 * permit in this codebase this function can only downgrade — nothing is
 * guessed, defaulted upward, or waved through.
 *
 * An `{ ok: true }` answer means the region is well formed and inside the local
 * guard ceiling. It is NOT consent and NOT a provider's permission; both of
 * those are checked elsewhere, and this build downloads nothing regardless.
 */
export function validateOfflineRegion(
  region: OfflineRegion,
  providerMaxZoom: number = DEFAULT_PROVIDER_MAX_ZOOM,
): OfflineRegionValidation {
  if (!Number.isFinite(providerMaxZoom)) {
    throw new TypeError('validateOfflineRegion: "providerMaxZoom" must be a finite number');
  }

  const structural = collectStructuralProblems(region);
  const problems: OfflineRegionProblemText[] = [...structural];

  if (isUsableZoom(region.maxZoom) && region.maxZoom > providerMaxZoom) {
    problems.push(OFFLINE_REGION_PROBLEM.zoomAboveProviderMax);
  }

  // The ceiling is only computable once the region is structurally sound; a
  // provider-zoom complaint does not stop us also reporting the size, because
  // knowing both at once saves the user a second round of corrections.
  if (
    structural.length === 0 &&
    estimateRegionTileCount(region) > OFFLINE_REGION_TILE_CEILING
  ) {
    problems.push(OFFLINE_REGION_PROBLEM.tileCountAboveCeiling);
  }

  if (problems.length > 0) {
    return { ok: false, problems };
  }
  return { ok: true };
}
