/**
 * recommendGrid.ts
 *
 * Pure-data leaf — recommends a DTM grid cell size and a contour interval
 * from the dataset's own geometry, so a user doesn't have to guess. The
 * recommendation balances four pressures:
 *
 *   - Point density: a cell finer than the point spacing is mostly
 *     interpolation, so the cell should hold a few returns.
 *   - Extent + memory: (extent / cell)² cells must fit a memory budget.
 *   - Terrain relief: drives a sensible default contour interval.
 *   - A requested interval, if the user already has one in mind.
 *
 * Cell sizes snap to a canonical ladder (0.25 / 0.5 / 1 / 2 / 5 m) so the
 * suggestion reads like something a survey crew would actually pick.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

/** Canonical DTM cell sizes, metres. */
export const GRID_LADDER_M: ReadonlyArray<number> = [0.25, 0.5, 1, 2, 5];
/** Canonical contour intervals, metres. */
const INTERVAL_LADDER_M: ReadonlyArray<number> = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50];

/** Inputs to {@link recommendGrid}. */
export interface GridRecommendationInput {
  /** Total analysed point count. */
  readonly pointCount: number;
  /** Horizontal extent along the first axis, metres. */
  readonly widthM: number;
  /** Horizontal extent along the second axis, metres. */
  readonly depthM: number;
  /** Vertical relief (max − min elevation), metres. */
  readonly reliefM: number;
  /** A contour interval the user already wants, metres (optional). */
  readonly requestedIntervalM?: number | null;
  /** Maximum DTM cells to allocate. Default 4,000,000 (~16 MB of floats). */
  readonly memoryBudgetCells?: number;
}

/** A grid + interval recommendation. */
export interface GridRecommendation {
  /** Recommended cell size, metres (a member of {@link GRID_LADDER_M}). */
  readonly cellSizeM: number;
  /** Recommended contour interval, metres. */
  readonly contourIntervalM: number;
  /** The cell sizes that are feasible for this dataset (subset of the ladder). */
  readonly cellOptionsM: number[];
  /** Estimated average point spacing, metres (NaN when not derivable). */
  readonly pointSpacingM: number;
  /** Human-readable rationale. */
  readonly reasons: string[];
}

/** Snap a raw value up to the smallest ladder member ≥ it (clamped to the ends). */
function snapUp(raw: number, ladder: ReadonlyArray<number>): number {
  for (const v of ladder) if (raw <= v) return v;
  return ladder[ladder.length - 1];
}

/** Recommend a DTM grid cell size and contour interval. Deterministic. */
export function recommendGrid(input: GridRecommendationInput): GridRecommendation {
  const reasons: string[] = [];
  const width = Math.max(0, input.widthM);
  const depth = Math.max(0, input.depthM);
  const area = width * depth;
  const budget = Math.max(10_000, input.memoryBudgetCells ?? 4_000_000);

  // Average point spacing from density (√(area / points)).
  const spacing =
    input.pointCount > 0 && area > 0 ? Math.sqrt(area / input.pointCount) : Number.NaN;

  // A DTM cell wants a few returns; ~2.5× the point spacing is a good
  // density-aware starting size.
  const densityCell = Number.isFinite(spacing) ? snapUp(spacing * 2.5, GRID_LADDER_M) : GRID_LADDER_M[1];

  // Memory floor: bump the cell up the ladder until the grid fits the budget.
  const cellFits = (cell: number): boolean =>
    area === 0 || (width / cell) * (depth / cell) <= budget;
  const cellOptionsM = GRID_LADDER_M.filter(cellFits);
  let cellSizeM = densityCell;
  if (!cellFits(cellSizeM)) {
    cellSizeM = cellOptionsM.length > 0 ? cellOptionsM[0] : GRID_LADDER_M[GRID_LADDER_M.length - 1];
    reasons.push(`Grid coarsened to ${cellSizeM} m so the ${Math.round(area)} m² extent fits in memory.`);
  } else if (Number.isFinite(spacing)) {
    reasons.push(
      `Recommended grid ${cellSizeM} m — point spacing ≈ ${spacing.toFixed(2)} m (a cell holds a few returns).`,
    );
  } else {
    reasons.push(`Recommended grid ${cellSizeM} m (point density unknown; conservative default).`);
  }

  // Contour interval: aim for ~15 contours across the relief, snapped to a
  // civil ladder — unless the user requested one.
  let contourIntervalM: number;
  if (input.requestedIntervalM != null && Number.isFinite(input.requestedIntervalM) && input.requestedIntervalM > 0) {
    contourIntervalM = input.requestedIntervalM;
    reasons.push(`Using your requested ${contourIntervalM} m contour interval.`);
  } else if (input.reliefM > 0) {
    contourIntervalM = snapUp(input.reliefM / 15, INTERVAL_LADDER_M);
    reasons.push(`Recommended contour interval ${contourIntervalM} m for ${input.reliefM.toFixed(1)} m of relief.`);
  } else {
    contourIntervalM = INTERVAL_LADDER_M[4]; // 1 m fallback
    reasons.push('Recommended contour interval 1 m (relief unknown).');
  }

  return { cellSizeM, contourIntervalM, cellOptionsM, pointSpacingM: spacing, reasons };
}
