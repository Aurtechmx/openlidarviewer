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
 *     east–west cell length is derived at, the unit-to-metres factor, and
 *     whether it resolved;
 *   - SHA-256 of the ROI mask, or null for none;
 *   - the above-ground surface identity: its geometry, frame, the digest of
 *     the terrain it is bound to, and SHA-256 of its heights and coverage, or
 *     null for none;
 *   - the evidence-gap policy (conservative or exploratory), which decides
 *     whether cells with a synthesised-neighbour slope or no above-ground
 *     return are blocked;
 *   - every routing method as an explicit {id, version} pair read from the
 *     registry, and the model id/version, so a method version change alone
 *     moves the digest (v2 wrote the method ids only).
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
import { methodRef } from '../../science/methodRegistry';
import { TERRAIN_ACCESS_METHODS, TERRAIN_ACCESS_MODEL } from './terrainAccessRunner';
import type { AboveGroundSurface, HorizontalScale } from './dtmTerrainAccessGrid';
import type { EvidenceGapPolicy } from './terrainAccessTypes';
import type { DtmGrid } from '../../terrain/ground/cellConfidence';

/** Names this digest and its encoding version. Recorded beside the digest in the run record. */
export const TERRAIN_ACCESS_INPUT_DIGEST_SCHEME = 'olv.simulation.terrain-access.input-digest.v3';

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

function surfaceIdentity(dsm: AboveGroundSurface | null): Record<string, unknown> | null {
  if (!dsm) return null;
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
      unitToMetres: scale.unitToMetres,
      resolved: scale.resolved,
    },
    roiDigest: roi ? sha256Hex(roi) : null,
    aboveGround: surfaceIdentity(dsm),
    evidenceGapPolicy,
    methods: TERRAIN_ACCESS_METHODS.map((id) => {
      const ref = methodRef(id);
      return { id: ref.id, version: ref.version };
    }),
    model: methodRef(TERRAIN_ACCESS_MODEL.id),
  });
  return sha256Hex(new TextEncoder().encode(header));
}
