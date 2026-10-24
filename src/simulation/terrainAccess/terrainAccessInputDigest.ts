/**
 * terrainAccessInputDigest.ts — the digest of everything a Terrain Access run
 * reads, not just the terrain surface.
 *
 * `dtmProductDigest` covers the surface: geometry, heights, coverage and CRS
 * codes. It deliberately leaves out per-cell confidence and the vertical unit
 * factor, which is right for a surface product. A route, though, depends on
 * both: confidence gates weak-evidence cells, and a vertical factor of 0.3048
 * instead of 1 changes every grade and step by about 3.28×, enough to flip a
 * route between found and refused. Using the surface digest as the run's
 * input digest would let two different inputs claim the same identity.
 *
 * So the run's `analysisInputDigest` is this digest, which wraps the surface
 * digest with every other input routing reads:
 *
 *   - the surface digest (`dtmProductDigest`), unchanged;
 *   - SHA-256 of the confidence grid (explicit little-endian Float32);
 *   - the vertical unit factor the heights are converted with;
 *   - the resolved horizontal scale: geographic or not, the latitude the
 *     cell lengths are derived at, the degree-to-metre model a geographic
 *     frame is converted with (null for a projected one), the unit-to-metres
 *     factor, and whether it resolved;
 *   - SHA-256 of the ROI mask, or null for none;
 *   - the above-ground surface identity: its geometry, frame, the digest of
 *     the terrain it is bound to, the points it rests on (sampled or not, the
 *     coverage mode, points read and in the scan, noise returns left out,
 *     whether Withheld points were left out), and SHA-256 of its heights and
 *     coverage, or null for none;
 *   - the evidence-gap policy (conservative or exploratory), which decides
 *     whether cells with a synthesised-neighbour slope or no above-ground
 *     return are blocked;
 *   - every routing method as an explicit {id, version} pair read from the
 *     registry, and the model id/version, so a method version change alone
 *     moves the digest (v2 wrote the method ids only).
 *
 * v5 adds the degree-to-metre model: v4 runs on a geographic frame converted
 * degrees with 111 320 m per degree on the north-south axis, so the same
 * inputs now give different lengths and grades and must not share the v4
 * identity.
 *
 * Presentation state (camera, theme, scene axis, world origin, labels) and the
 * run's id and timestamp are not inputs and are not read. Unset numbers are
 * written as null. The scheme string
 * names the version; change the encoding only together with it.
 *
 * Pure: no DOM, no three.js, no I/O, no clock.
 */

import { sha256Hex } from '../../terrain/export/sha256';
import { dtmProductDigest } from '../../science/dtmProductDigest';
import { GEOGRAPHIC_DEGREE_MODEL } from '../../terrain/ground/horizontalScale';
import { methodRef } from '../../science/methodRegistry';
import type { AboveGroundSurface, HorizontalScale } from './dtmTerrainAccessGrid';
import { aboveGroundBasisOf } from './aboveGroundSurface';
import { resolveEvidenceGapPolicy, type EvidenceGapPolicy, type TerrainAccessProfile } from './terrainAccessTypes';
import { DEFAULT_COST_WEIGHTS, type CostWeights } from './traversabilityCost';
import type { InterpolatedPolicy } from './dtmTerrainAccessGrid';
import type { DtmGrid } from '../../terrain/ground/cellConfidence';

/**
 * The model a run record names, at the version the registry declares. Kept
 * here, with the digest that binds it, so `terrainAccessRunner.ts` can read
 * the digest without the two modules importing each other; the runner
 * re-exports it.
 */
export const TERRAIN_ACCESS_MODEL = Object.freeze(methodRef('olv.simulation.terrain-access.astar'));

/** The registered methods a run uses, in the order it uses them. Re-exported by the runner. */
export const TERRAIN_ACCESS_METHODS: readonly string[] = Object.freeze([
  'olv.simulation.terrain-access.local-step',
  'olv.simulation.terrain-access.directional-grade',
  'olv.simulation.terrain-access.cost-map',
  'olv.simulation.terrain-access.astar',
]);

/** Names this digest and its encoding version. Recorded beside the digest in the run record. */
export const TERRAIN_ACCESS_INPUT_DIGEST_SCHEME = 'olv.simulation.terrain-access.input-digest.v5';

/** Everything the digest reads. */
export interface TerrainAccessDigestInput {
  readonly dtm: DtmGrid;
  readonly scale: HorizontalScale;
  readonly dsm: AboveGroundSurface | null;
  readonly roi: Uint8Array | null;
  /** The resolved policy (`resolveEvidenceGapPolicy`), never the profile's unset field. */
  readonly evidenceGapPolicy: EvidenceGapPolicy;
}

function float32Digest(values: ArrayLike<number>): string {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) view.setFloat32(i * 4, values[i], true);
  return sha256Hex(bytes);
}

function surfaceIdentity(dtm: DtmGrid, dsm: AboveGroundSurface | null): Record<string, unknown> | null {
  if (!dsm) return null;
  const basis = aboveGroundBasisOf(dtm, dsm);
  return {
    cols: dsm.cols,
    rows: dsm.rows,
    cellSizeM: dsm.cellSizeM,
    originH1: dsm.originH1,
    originH2: dsm.originH2,
    frame: dsm.frame
      ? {
        crs: dsm.frame.crs ?? null,
        horizontalEpsg: dsm.frame.horizontalEpsg ?? null,
        verticalUnitToMetres: dsm.frame.verticalUnitToMetres ?? null,
        orientation: dsm.frame.orientation ?? null,
      }
      : null,
    terrainDigest: typeof dsm.terrainDigest === 'string' ? dsm.terrainDigest : null,
    basis: {
      sampled: basis.sampled,
      coverage: basis.coverage,
      pointsRead: basis.pointsRead ?? null,
      sourcePoints: basis.sourcePoints ?? null,
      noiseExcluded: basis.noiseExcluded,
      withheldExcluded: basis.withheldExcluded ?? null,
    },
    zDigest: float32Digest(dsm.z),
    coverageDigest: sha256Hex(dsm.coverage),
  };
}

/** SHA-256 (lowercase hex) over every input a Terrain Access run reads; see the module doc. */
export function terrainAccessSimulationInputDigest(input: TerrainAccessDigestInput): string {
  const { dtm, scale, dsm, roi, evidenceGapPolicy } = input;
  // A fixed literal, so JSON.stringify's insertion order is the canonical order.
  const header = JSON.stringify({
    scheme: TERRAIN_ACCESS_INPUT_DIGEST_SCHEME,
    surfaceDigest: dtmProductDigest(dtm),
    confidenceDigest: float32Digest(dtm.confidence),
    verticalUnitToMetres: dtm.verticalUnitToMetres ?? null,
    horizontalScale: {
      isGeographic: scale.isGeographic,
      latitudeDeg: scale.latitudeDeg ?? null,
      degreeModel: scale.isGeographic ? GEOGRAPHIC_DEGREE_MODEL : null,
      unitToMetres: scale.unitToMetres,
      resolved: scale.resolved,
    },
    roiDigest: roi ? sha256Hex(roi) : null,
    aboveGround: surfaceIdentity(dtm, dsm),
    evidenceGapPolicy,
    methods: TERRAIN_ACCESS_METHODS.map((id) => {
      const ref = methodRef(id);
      return { id: ref.id, version: ref.version };
    }),
    model: methodRef(TERRAIN_ACCESS_MODEL.id),
  });
  return sha256Hex(new TextEncoder().encode(header));
}

/** Names the preparation digest's encoding. Never recorded; it only decides whether a preview can be reused. */
export const TERRAIN_ACCESS_PREPARATION_SCHEME = 'olv.simulation.terrain-access.preparation.v1';

/** What a preparation reads besides the terrain: the run or preview parameters. */
export interface TerrainAccessPreparationParams {
  readonly interpolated: InterpolatedPolicy;
  readonly maxCells: number;
  readonly withheldExcluded: boolean | null;
  readonly dsm?: AboveGroundSurface | null;
  readonly roi?: Uint8Array | null;
  readonly weights?: CostWeights;
}

/**
 * JSON with every object's keys sorted, so two equal values always serialise
 * the same. A non-finite number is written as its name ("NaN", "Infinity"),
 * not as JSON's `null`, so it cannot stand in for a field that is null.
 */
function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (typeof value === 'number' && !Number.isFinite(value)) return JSON.stringify(String(value));
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * SHA-256 (lowercase hex) over everything `prepareTerrainAccessRun` reads:
 * the run's input digest ({@link terrainAccessSimulationInputDigest}), the
 * whole profile, the cost weights and the interpolated-cell, cell-budget and
 * Withheld parameters. Two preparations with the same digest build the same
 * grid, features, eligibility and traversability map, so a run may reuse the
 * preview's instead of building them again.
 */
export function terrainAccessPreparationDigest(
  dtm: DtmGrid,
  scale: HorizontalScale,
  profile: TerrainAccessProfile,
  params: TerrainAccessPreparationParams,
): string {
  const dsm = params.dsm ?? null;
  const roi = params.roi ?? null;
  const body = canonicalJson({
    scheme: TERRAIN_ACCESS_PREPARATION_SCHEME,
    input: terrainAccessSimulationInputDigest({
      dtm, scale, dsm, roi, evidenceGapPolicy: resolveEvidenceGapPolicy(profile),
    }),
    profile,
    weights: params.weights ?? DEFAULT_COST_WEIGHTS,
    interpolated: params.interpolated,
    maxCells: params.maxCells,
    withheldExcluded: params.withheldExcluded,
  });
  return sha256Hex(new TextEncoder().encode(body));
}
