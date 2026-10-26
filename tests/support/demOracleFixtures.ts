/**
 * tests/support/demOracleFixtures.ts — the JSON records the independent Python
 * readers check a code raster against.
 *
 * validation/terrain-evidence, terrain-attention and terrain-sensitivity each
 * hold an oracle that reads a GeoTIFF byte by byte and checks it against an
 * expected.json of the TypeScript values. Three tests wrote those records with
 * three near-identical blocks; the DEM package driver has to write the same
 * records for a committed crop, so the builders live here and both call them.
 * The output is the exact text the committed fixtures hold: key order and the
 * null-for-NoData convention are part of the contract the readers parse.
 */

import type { EvidenceGrid, EvidenceGeoreference } from '../../src/terrain/export/demEvidence';
import {
  EVIDENCE_STATE_CODE,
  EVIDENCE_STATE_PARAMS,
  TERRAIN_EVIDENCE_BANDS,
  terrainEvidenceBands,
} from '../../src/terrain/export/demEvidence';
import {
  ATTENTION_NO_DATA,
  ATTENTION_PARAMS,
  ATTENTION_REASON_CODE,
  TERRAIN_ATTENTION_BANDS,
  type AttentionBands,
  type AttentionGeoreference,
  type AttentionInputs,
  type ReconstructionResidual,
} from '../../src/terrain/export/demAttention';
import {
  SENSITIVITY_ENSEMBLE,
  TERRAIN_SENSITIVITY_BANDS,
  terrainSensitivityBands,
  type SensitivityGeoreference,
  type SensitivityMemberGrid,
} from '../../src/terrain/export/demSensitivity';
import { sha256Hex } from '../../src/terrain/export/sha256';

const num = (v: number): number | null => (Number.isFinite(v) ? v : null);

/** The record `validation/terrain-evidence/oracle/evidence_geotiff.py` checks `terrain_evidence.tif` against. */
export function evidenceExpectedJson(args: {
  readonly grid: EvidenceGrid & { readonly z: ArrayLike<number> };
  readonly geo: Pick<EvidenceGeoreference, 'xllCorner' | 'yllCorner' | 'epsg' | 'noData'> & { readonly frameResolved?: boolean };
  readonly bytes: Uint8Array;
  /** Ground return heights per cell, grid order (row 0 = south), as the rasteriser binned them. */
  readonly returns: readonly (readonly number[])[];
  readonly horizontalUnit?: string;
  readonly verticalUnit?: string;
}): string {
  const { grid, geo, bytes } = args;
  const h = args.horizontalUnit ?? 'm';
  const v = args.verticalUnit ?? 'm';
  const frameResolved = geo.frameResolved ?? true;
  const b = terrainEvidenceBands(grid, { frameResolved });
  const cell = (i: number): number | null => (grid.coverage[i] !== 0 && Number.isFinite(grid.z[i]) ? 1 : null);
  const expected = {
    note: 'TypeScript values for terrain_evidence.tif; grid order, row 0 = south. null = NoData.',
    cols: grid.cols,
    rows: grid.rows,
    cellSize: grid.cellSizeM,
    xllCorner: geo.xllCorner,
    yllCorner: geo.yllCorner,
    epsg: geo.epsg,
    noData: geo.noData,
    bandNames: [...TERRAIN_EVIDENCE_BANDS],
    bandUnits: ['returns', h, 'code', h, v, h],
    frameResolved,
    edgeAffectedWithinCells: EVIDENCE_STATE_PARAMS.edgeAffectedWithinCells,
    supportCount: Array.from(b.supportCount, (x, i) => (cell(i) ? x : null)),
    interpolationDistance: Array.from(b.interpolationDistance, (x, i) => (cell(i) ? x : null)),
    interpDistanceCells: Array.from(grid.interpDistanceCells, (x, i) => (cell(i) ? x : null)),
    cellState: Array.from(b.cellState, (x, i) => (cell(i) ? x : null)),
    nearestSupportDistance: Array.from(b.nearestSupportDistance, (x, i) => (cell(i) ? x : null)),
    verticalDispersion: Array.from(b.verticalDispersion, (x, i) => (cell(i) && Number.isFinite(x) ? x : null)),
    edgeDistance: Array.from(b.edgeDistance, (x, i) => (cell(i) && Number.isFinite(x) ? x : null)),
    returns: args.returns.map((zs) => [...zs]),
    sha256: sha256Hex(bytes),
  };
  return `${JSON.stringify(expected, null, 2)}\n`;
}

/** The record `validation/terrain-attention/oracle/attention_geotiff.py` checks `terrain_attention.tif` against. */
export function attentionExpectedJson(args: {
  readonly grid: {
    readonly z: ArrayLike<number>;
    readonly counts: ArrayLike<number>;
    readonly coverage: ArrayLike<number>;
    readonly confidence: ArrayLike<number>;
    readonly interpDistanceCells: ArrayLike<number>;
    readonly cols: number;
    readonly rows: number;
    readonly cellSizeM: number;
  };
  readonly inputs: Pick<AttentionInputs, 'cellState' | 'sensitivityRange' | 'verticalReference'>;
  readonly residual: ReconstructionResidual;
  readonly bands: AttentionBands;
  readonly geo: Pick<AttentionGeoreference, 'xllCorner' | 'yllCorner' | 'epsg'>;
  readonly bytes: Uint8Array;
}): string {
  const { grid: g, inputs, residual, bands, geo, bytes } = args;
  const RC = ATTENTION_REASON_CODE;
  const written = (i: number): boolean => g.coverage[i] !== 0 && Number.isFinite(g.z[i]);
  const n = g.cols * g.rows;
  const sens = inputs.sensitivityRange ?? new Float32Array(n);
  const expected = {
    note: 'TypeScript values for terrain_attention.tif; grid order, row 0 = south. null = NoData or no value.',
    cols: g.cols,
    rows: g.rows,
    cellSize: g.cellSizeM,
    xllCorner: geo.xllCorner,
    yllCorner: geo.yllCorner,
    epsg: geo.epsg,
    noData: ATTENTION_NO_DATA,
    bandNames: [...TERRAIN_ATTENTION_BANDS],
    bandUnits: ['level', 'code'],
    params: {
      longInterpolationCells: ATTENTION_PARAMS.longInterpolationCells,
      lowSupportConfidence: ATTENTION_PARAMS.lowSupportConfidence,
      verticalReference: inputs.verticalReference,
      levelCuts: [...ATTENTION_PARAMS.levelCuts],
      reasonOrder: Object.keys(RC).filter((k) => k !== 'NONE'),
      reasonCodes: RC,
      edgeAffectedState: EVIDENCE_STATE_CODE.edgeAffected,
    },
    heights: Array.from(g.z, (x) => num(x)),
    counts: Array.from(g.counts),
    coverage: Array.from(g.coverage),
    confidence: Array.from(g.confidence),
    interpDistanceCells: Array.from(g.interpDistanceCells, (x) => num(x)),
    cellState: Array.from(inputs.cellState),
    sensitivityRange: Array.from(sens),
    residual: Array.from(residual.residual, (x) => num(x)),
    attentionLevel: Array.from(bands.level, (x, i) => (written(i) ? x : null)),
    dominantReason: Array.from(bands.reason, (x, i) => (written(i) ? x : null)),
    sha256: sha256Hex(bytes),
  };
  return `${JSON.stringify(expected, null, 2)}\n`;
}

/** The record `validation/terrain-sensitivity/oracle/sensitivity_geotiff.py` checks `terrain_sensitivity.tif` against. */
export function sensitivityExpectedJson(args: {
  readonly grids: readonly SensitivityMemberGrid[];
  readonly geo: Pick<SensitivityGeoreference, 'xllCorner' | 'yllCorner' | 'epsg' | 'noData'>;
  readonly bytes: Uint8Array;
  readonly verticalUnit?: string;
}): string {
  const { grids, geo, bytes } = args;
  const b = terrainSensitivityBands(grids);
  const written = (i: number): boolean => grids[0].coverage[i] !== 0 && Number.isFinite(grids[0].z[i]);
  const expected = {
    note: 'TypeScript values for terrain_sensitivity.tif; grid order, row 0 = south. null = NoData or no height.',
    cols: grids[0].cols,
    rows: grids[0].rows,
    cellSize: grids[0].cellSizeM,
    xllCorner: geo.xllCorner,
    yllCorner: geo.yllCorner,
    epsg: geo.epsg,
    noData: geo.noData,
    bandNames: [...TERRAIN_SENSITIVITY_BANDS],
    bandUnits: [args.verticalUnit ?? 'm', 'members'],
    members: SENSITIVITY_ENSEMBLE.map((m) => m.label),
    memberHeights: grids.map((g) => Array.from(g.z, (v, i) => (g.coverage[i] !== 0 && Number.isFinite(v) ? v : null))),
    sensitivityRange: Array.from(b.range, (v, i) => (written(i) ? v : null)),
    sensitivityMembers: Array.from(b.members, (v, i) => (written(i) ? v : null)),
    sha256: sha256Hex(bytes),
  };
  return `${JSON.stringify(expected, null, 2)}\n`;
}
