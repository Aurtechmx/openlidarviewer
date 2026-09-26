/**
 * demAttention.ts
 *
 * The terrain attention raster written beside the DEM: a two-band uint8
 * GeoTIFF on exactly the DEM's grid, origin, cell size, CRS and NoData mask,
 * saying where to inspect first and why.
 *
 *   band 1  attention_level   0 none, 1 low, 2 medium, 3 high
 *   band 2  dominant_reason   ATTENTION_REASON_CODE of the input that set the
 *                             level; 0 on a level 0 cell
 *
 * Every value that decides a level or a reason is fixed by
 * validation/protocols/evidencedem-attention-v1.md, committed before any
 * raster was computed. Each input is normalised to [0, 1]; the level is the
 * highest input banded by fixed cut-offs, and the reason is the input that
 * set it (ties to the earlier input in the vocabulary). No weighted blend, so
 * every flagged cell has one stated cause.
 *
 * The reconstruction residual (one of the inputs) holds out each measured
 * cell and rebuilds it with the canonical geodesic fill from its measured
 * 8-neighbours only. It shows how well neighbours predict a cell, not how
 * close any height is to the ground. It is reported in the passport and
 * README, not as a band.
 *
 * This file also derives the DEM evidence tier (T0 to T3) of a package.
 *
 * Pure data; deterministic.
 */

import { EVIDENCE_THRESHOLDS } from '../ground/cellConfidence';
import { rebuildHeldOutCell, isMeasuredCell, type ResidualGrid, type ResidualScale } from '../ground/leaveLocalOut';
import { writeGeoTiff } from './demGeoTiff';
import { EVIDENCE_STATE_CODE, demWrittenMask } from './demEvidence';
import type { SensitivityMemberGrid } from './demSensitivity';

/** Registered method id for the attention raster. */
export const TERRAIN_ATTENTION_METHOD_ID = 'olv.terrain.evidence.attention';
/** Registered method id for the reconstruction residual. */
export const TERRAIN_RESIDUAL_METHOD_ID = 'olv.terrain.evidence.residual';

/** Band names in band order, as written to GDAL_METADATA. */
export const TERRAIN_ATTENTION_BANDS = ['attention_level', 'dominant_reason'] as const;

/** The reason vocabulary in tie-break order, with its band 2 codes. 0 = no reason. */
export const ATTENTION_REASON_CODE = {
  NONE: 0,
  LONG_INTERPOLATION: 1,
  LOW_SUPPORT: 2,
  EDGE_AFFECTED: 3,
  MODEL_SENSITIVITY: 4,
  RECONSTRUCTION_RESIDUAL: 5,
  TERRAIN_COMPLEXITY: 6,
  CLASSIFICATION_AMBIGUITY: 7,
  UNRESOLVED: 8,
} as const;

/** Pre-registered values (validation/protocols/evidencedem-attention-v1.md). */
export const ATTENTION_PARAMS = {
  /** LONG_INTERPOLATION = interpolation distance in cells / this (the edge risk distance). */
  longInterpolationCells: 3,
  /** LOW_SUPPORT = 1 - confidence / this (the low confidence threshold, 0 to 100 scale). */
  lowSupportConfidence: EVIDENCE_THRESHOLDS.dashed,
  /** Vertical reference R in metres for MODEL_SENSITIVITY and RECONSTRUCTION_RESIDUAL. */
  verticalReferenceM: 0.3,
  /** Lower score bound of levels 1, 2 and 3. */
  levelCuts: [0.33, 0.67, 1.0],
  /** Every measured cell is rebuilt up to this many; above it, every k-th. */
  residualSampleLimit: 250_000,
} as const;

/** The uint8 NoData value of the attention raster (outside every code). */
export const ATTENTION_NO_DATA = 255;

// ── reconstruction residual ─────────────────────────────────────────────────

export { rebuildHeldOutCell, type ResidualGrid, type ResidualScale };

/** The residual per cell (NaN where none) and how it was sampled. */
export interface ReconstructionResidual {
  readonly residual: Float32Array;
  /** Measured cells in the grid. */
  readonly measuredCells: number;
  /** Sampling stride: every k-th measured cell in row-major order. */
  readonly stride: number;
  /** Measured cells rebuilt (sampled). */
  readonly sampledCells: number;
  /** Sampled cells that had a measured neighbour and so received a residual. */
  readonly residualCells: number;
}

/** The sampling stride for `measured` measured cells. */
export function residualStride(measured: number, limit: number = ATTENTION_PARAMS.residualSampleLimit): number {
  return measured <= limit ? 1 : Math.ceil(measured / limit);
}

/** Leave-local-out residual |Z_held - Z_rebuilt| over the sampled measured cells. */
export function reconstructionResidual(
  g: ResidualGrid,
  scale: ResidualScale = {},
  sampleLimit: number = ATTENTION_PARAMS.residualSampleLimit,
): ReconstructionResidual {
  const n = g.cols * g.rows;
  const residual = new Float32Array(n).fill(Number.NaN);
  let measuredCells = 0;
  for (let i = 0; i < n; i++) if (isMeasuredCell(g, i)) measuredCells++;
  const stride = residualStride(measuredCells, sampleLimit);
  let seen = 0;
  let sampledCells = 0;
  let residualCells = 0;
  for (let i = 0; i < n; i++) {
    if (!isMeasuredCell(g, i)) continue;
    const take = seen % stride === 0;
    seen++;
    if (!take) continue;
    sampledCells++;
    const rebuilt = rebuildHeldOutCell(g, i, scale);
    if (!Number.isFinite(rebuilt)) continue;
    residual[i] = Math.abs(g.z[i] - rebuilt);
    residualCells++;
  }
  return { residual, measuredCells, stride, sampledCells, residualCells };
}

// ── attention ───────────────────────────────────────────────────────────────

/** Per-cell inputs to the attention score, row-major on the DTM grid. */
export interface AttentionInputs {
  readonly cols: number;
  readonly rows: number;
  readonly coverage: ArrayLike<number>;
  readonly interpDistanceCells: ArrayLike<number>;
  /** 0 to 100. */
  readonly confidence: ArrayLike<number>;
  /** Extended cell_state (demEvidence.ts). */
  readonly cellState: ArrayLike<number>;
  /** Vertical unit; NaN where none. */
  readonly residual: ArrayLike<number>;
  /** Sensitivity range, vertical unit; null when sensitivity was not requested. */
  readonly sensitivityRange: ArrayLike<number> | null;
  /**
   * R in the vertical unit of the file, or null when the vertical unit is
   * unresolved: then the two vertical inputs are not scored.
   */
  readonly verticalReference: number | null;
  /** False when the vertical unit or CRS is unresolved. */
  readonly frameResolved: boolean;
}

/** The band arrays. */
export interface AttentionBands {
  readonly level: Uint8Array;
  readonly reason: Uint8Array;
}

const clip01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/** Level for a score in [0, 1]. */
export function attentionLevel(score: number): number {
  const [l1, l2, l3] = ATTENTION_PARAMS.levelCuts;
  if (score >= l3) return 3;
  if (score >= l2) return 2;
  if (score >= l1) return 1;
  return 0;
}

/** Compute the level and reason bands. */
export function terrainAttentionBands(inp: AttentionInputs): AttentionBands {
  const n = inp.cols * inp.rows;
  const level = new Uint8Array(n);
  const reason = new Uint8Array(n);
  const R = inp.verticalReference;
  const vertical = R != null && Number.isFinite(R) && R > 0;
  const P = ATTENTION_PARAMS;
  const RC = ATTENTION_REASON_CODE;
  for (let i = 0; i < n; i++) {
    if (inp.coverage[i] === 0) continue;
    // Scores in vocabulary order; strict > keeps the earlier input on a tie.
    const scores: [number, number][] = [
      [RC.LONG_INTERPOLATION, clip01(inp.interpDistanceCells[i] / P.longInterpolationCells)],
      [RC.LOW_SUPPORT, clip01(1 - inp.confidence[i] / P.lowSupportConfidence)],
      [RC.EDGE_AFFECTED, inp.cellState[i] === EVIDENCE_STATE_CODE.edgeAffected ? 1 : 0],
      [RC.MODEL_SENSITIVITY, vertical && inp.sensitivityRange ? clip01(inp.sensitivityRange[i] / (R as number)) : 0],
      [RC.RECONSTRUCTION_RESIDUAL, vertical ? clip01(inp.residual[i] / (R as number)) : 0],
    ];
    let best = 0;
    let bestCode: number = RC.NONE;
    for (const [code, s] of scores) {
      if (s > best) {
        best = s;
        bestCode = code;
      }
    }
    const lv = attentionLevel(best);
    level[i] = lv;
    if (lv > 0) reason[i] = bestCode;
    else if (!inp.frameResolved) reason[i] = RC.UNRESOLVED;
  }
  return { level, reason };
}

/** R in the file's vertical unit, or null when the unit is unresolved. */
export function verticalReferenceInUnit(verticalUnitToMetres: number | null): number | null {
  if (verticalUnitToMetres == null || !Number.isFinite(verticalUnitToMetres) || verticalUnitToMetres <= 0) return null;
  return ATTENTION_PARAMS.verticalReferenceM / verticalUnitToMetres;
}

/** Georeference and NoData for the attention raster: the DEM's own. */
export interface AttentionGeoreference {
  readonly xllCorner: number;
  readonly yllCorner: number;
  readonly epsg: number | null;
  readonly isGeographic: boolean;
  /** The DEM's written heights; a cell the DEM writes as NoData is NoData here too. */
  readonly demValues: ArrayLike<number>;
}

/** Write the two-band attention GeoTIFF. */
export function writeTerrainAttentionGeoTiff(
  bands: AttentionBands,
  grid: { readonly cols: number; readonly rows: number; readonly cellSizeM: number; readonly coverage: ArrayLike<number> },
  geo: AttentionGeoreference,
): Uint8Array {
  return writeGeoTiff({
    coverage: demWrittenMask(grid.coverage, geo.demValues),
    cols: grid.cols,
    rows: grid.rows,
    cellSize: grid.cellSizeM,
    xllCorner: geo.xllCorner,
    yllCorner: geo.yllCorner,
    noData: ATTENTION_NO_DATA,
    epsg: geo.epsg,
    isGeographic: geo.isGeographic,
    bands: [
      { values: bands.level, type: 'uint8', description: TERRAIN_ATTENTION_BANDS[0], unit: 'level' },
      { values: bands.reason, type: 'uint8', description: TERRAIN_ATTENTION_BANDS[1], unit: 'code' },
    ],
  });
}

// ── sensitivity members and tiers ───────────────────────────────────────────

/** Ensemble members 1 and up whose grid differs from member 0 at any cell. */
export function membersDifferingFromCanonical(grids: readonly SensitivityMemberGrid[]): number {
  if (grids.length === 0) return 0;
  const g0 = grids[0];
  let differ = 0;
  for (let k = 1; k < grids.length; k++) {
    const g = grids[k];
    for (let i = 0; i < g0.z.length; i++) {
      const a = g0.coverage[i] !== 0 && Number.isFinite(g0.z[i]) ? g0.z[i] : null;
      const b = g.coverage[i] !== 0 && Number.isFinite(g.z[i]) ? g.z[i] : null;
      if (a !== b) {
        differ++;
        break;
      }
    }
  }
  return differ;
}

/** DEM evidence tier, from what the package contains. */
export type DemEvidenceTier = 'T0' | 'T1' | 'T2' | 'T3';

export function demEvidenceTier(has: {
  readonly passport: boolean;
  readonly evidence: boolean;
  readonly sensitivity: boolean;
  readonly attention: boolean;
}): DemEvidenceTier {
  if (!has.passport) return 'T0';
  if (!has.evidence) return 'T1';
  if (!has.sensitivity || !has.attention) return 'T2';
  return 'T3';
}

const TIER_MEANING: Record<DemEvidenceTier, string> = {
  T0: 'raster only',
  T1: 'provenanced: source, method, parameters and build are bound in the passport',
  T2: 'evidence-mapped: cell-level support is present',
  T3: 'internally examined: sensitivity and reconstruction residual are present',
};

/** The attention record the passport carries. */
export interface DemEvidenceRecord {
  readonly tier: DemEvidenceTier;
  readonly tierMeaning: string;
  readonly protocol: string;
  readonly attention: {
    readonly method: string;
    readonly residualMethod: string;
    readonly verticalReference: { readonly metres: number; readonly inFileUnit: number | null; readonly unit: string };
    readonly longInterpolationCells: number;
    readonly lowSupportConfidence: number;
    readonly levelCuts: readonly number[];
    readonly scoredInputs: readonly string[];
    readonly residual: {
      readonly measuredCells: number;
      readonly sampleLimit: number;
      readonly stride: number;
      readonly sampledCells: number;
      readonly residualCells: number;
    };
  } | null;
  readonly sensitivity: { readonly members: number; readonly membersDifferingFromCanonical: number } | null;
}

export const ATTENTION_PROTOCOL = 'validation/protocols/evidencedem-attention-v1.md';

export function demEvidenceRecord(args: {
  readonly tier: DemEvidenceTier;
  readonly residual: ReconstructionResidual | null;
  readonly verticalReference: number | null;
  readonly verticalUnit: string;
  readonly sensitivityGrids: readonly SensitivityMemberGrid[] | null;
}): DemEvidenceRecord {
  const vertical = args.verticalReference != null;
  const scored = ['LONG_INTERPOLATION', 'LOW_SUPPORT', 'EDGE_AFFECTED'];
  if (vertical && args.sensitivityGrids) scored.push('MODEL_SENSITIVITY');
  if (vertical) scored.push('RECONSTRUCTION_RESIDUAL');
  const r = args.residual;
  return {
    tier: args.tier,
    tierMeaning: TIER_MEANING[args.tier],
    protocol: ATTENTION_PROTOCOL,
    attention: r
      ? {
          method: TERRAIN_ATTENTION_METHOD_ID,
          residualMethod: TERRAIN_RESIDUAL_METHOD_ID,
          verticalReference: {
            metres: ATTENTION_PARAMS.verticalReferenceM,
            inFileUnit: args.verticalReference,
            unit: args.verticalUnit,
          },
          longInterpolationCells: ATTENTION_PARAMS.longInterpolationCells,
          lowSupportConfidence: ATTENTION_PARAMS.lowSupportConfidence,
          levelCuts: [...ATTENTION_PARAMS.levelCuts],
          scoredInputs: scored,
          residual: {
            measuredCells: r.measuredCells,
            sampleLimit: ATTENTION_PARAMS.residualSampleLimit,
            stride: r.stride,
            sampledCells: r.sampledCells,
            residualCells: r.residualCells,
          },
        }
      : null,
    sensitivity: args.sensitivityGrids
      ? {
          members: args.sensitivityGrids.length,
          membersDifferingFromCanonical: membersDifferingFromCanonical(args.sensitivityGrids),
        }
      : null,
  };
}

/** README lines for the attention raster (when written) and the tier. */
export function terrainAttentionReadmeLines(
  filename: string | null,
  record: DemEvidenceRecord,
): string[] {
  const out: string[] = [];
  const a = record.attention;
  if (filename && a) {
    const ref = a.verticalReference.inFileUnit;
    out.push(
      `Terrain attention (${filename})`,
      `  Two byte bands on the same grid, origin, cell size, CRS and NoData`,
      `  cells as the DTM (NoData ${ATTENTION_NO_DATA}). They say where to inspect first`,
      `  and why. They do not say how close a height is to the ground.`,
      `  Band 1 attention_level  0 none, 1 low, 2 medium, 3 high.`,
      `  Band 2 dominant_reason  The input that set the level: 1 long`,
      `                          interpolation, 2 low support, 3 edge affected,`,
      `                          4 model sensitivity, 5 reconstruction residual,`,
      `                          8 unresolved (6 and 7 are reserved). 0 on a`,
      `                          level 0 cell.`,
      `  Each input is scored from 0 to 1 and the level is the highest score:`,
      `    long interpolation       interpolation distance / ${a.longInterpolationCells} cells`,
      `    low support              1 - confidence / ${a.lowSupportConfidence} (0 to 100 scale)`,
      `    edge affected            1 when cell_state is 5`,
      `    model sensitivity        sensitivity_range / R, when requested`,
      `    reconstruction residual  residual / R`,
      ref != null
        ? `  R is ${a.verticalReference.metres} m (${Number(ref.toFixed(6))} ${a.verticalReference.unit}).`
        : `  The vertical unit is unresolved, so R has no value and the two`,
      ...(ref != null ? [] : [`  vertical inputs are not scored. Level 0 cells carry reason 8.`]),
      `  Level 1 from 0.33, level 2 from 0.67, level 3 at 1. Ties go to the`,
      `  input listed first.`,
      `  Reconstruction residual: each measured cell is held out and rebuilt`,
      `  by the canonical fill from its measured 8-neighbours; the residual is`,
      `  the absolute difference. It shows how well neighbours predict a cell.`,
      `  ${a.residual.sampledCells} of ${a.residual.measuredCells} measured cells rebuilt, sampling stride`,
      `  ${a.residual.stride}; ${a.residual.residualCells} had a measured neighbour.`,
      `  Rules fixed before any result: ${record.protocol}`,
      `  Method ${a.method}, ${a.residualMethod}`,
      ``,
    );
  }
  out.push(`DEM evidence tier`, `  ${record.tier}: ${record.tierMeaning}.`);
  if (record.sensitivity) {
    out.push(
      `  ${record.sensitivity.membersDifferingFromCanonical} of ${record.sensitivity.members - 1} ensemble members other than the`,
      `  canonical run produced a different grid.`,
    );
  }
  out.push(
    `  Tiers state what this package contains. T4, independent checkpoints,`,
    `  cannot be reached from the point cloud alone.`,
    ``,
  );
  return out;
}
