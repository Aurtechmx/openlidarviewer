/**
 * catchmentMorphometrics.ts — the size, shape, relief and hypsometry of one
 * catchment, with a reason attached to every figure that cannot be printed.
 *
 * A figure is either a number or a withheld reason. A report that prints a
 * made-up number is worse than one that prints "not available because...", so
 * nothing here falls back to zero or to a guess.
 *
 * Why a figure is withheld, in the order the rules are checked:
 *  - 'open-catchment': the catchment reaches the edge of the data or a NoData
 *    cell next to its flow, so its true divide lies outside what was measured.
 *    Area and relief are then lower bounds (`bound: 'minimum'`: the real
 *    catchment is at least this large and at least this tall). Everything that
 *    depends on the outline or on the whole of the terrain is withheld.
 *  - 'too-small': fewer than 9 cells, or the divide has fewer than 3 distinct
 *    vertices. Ratios of a handful of cells describe the grid, not the ground.
 *  - 'vertical-unresolved': the vertical unit is not known in metres, so a
 *    height, a slope or a relief cannot be stated in metres.
 *  - 'not-applicable': the figure has no meaning here (a flat catchment has no
 *    hypsometric curve, an outlet without an elevation has no relief).
 *
 * Definitions, all metric:
 *  - Area A is the count of valid mask cells times the cell area. `areaBandM2`
 *    is half the cells that touch the outside of the mask (4-neighbours, and
 *    the edge of the grid) times the cell area: the divide sits somewhere in
 *    the boundary cells, so the area is uncertain by about half of them.
 *  - Perimeter P is the simplified divide length from `traceDivide`. It
 *    carries up to about one cell of orientation-dependent noise.
 *  - Gravelius Kc = 0.282 P / sqrt(A). Circularity Rc = 4 pi A / P^2.
 *  - Lb is the straight line from the outlet cell centre to the farthest
 *    vertex of the outer ring. Form factor Ff = A / Lb^2. Elongation
 *    Re = 1.128 sqrt(A) / Lb.
 *  - Relief is the highest cell minus the outlet cell, in metres.
 *  - Mean elevation is `originZ + z` (native vertical units, converted) when
 *    the origin is known, otherwise the mean height above the outlet.
 *  - Mean slope is the mean over catchment cells of the Horn 3x3 slope, in
 *    percent (rise over run times 100). It uses the shared `hornSlope`, which
 *    reads the real ground beyond the divide, as any slope map does; only
 *    NoData neighbours are replaced by the centre cell.
 *  - Hypsometry. Relative height is (z - zmin) / (zmax - zmin) over the
 *    catchment cells. The curve has 20 classes: class k starts at relative
 *    height k/20, and `relArea[k]` is the share of the catchment area at or
 *    above that height, so the curve starts at (1, 0). The integral is the
 *    mean relative height of the cells (elevation-relief ratio, the same
 *    number the area under the full curve gives), taken from the cells rather
 *    than from the 20 classes so that it carries no binning error.
 *
 * Pure: no DOM. Reads the grid and the mask; changes neither.
 */

import type { FlowGrid } from '../flowTypes';
import { hornSlope } from '../../../terrain/ground/terrainDerivatives';
import type { TracedDivide } from './divideTrace';

export type WithheldReason = 'open-catchment' | 'vertical-unresolved' | 'too-small' | 'not-applicable';
export type Withheld = { readonly withheld: WithheldReason };
export type Figure<T> = { readonly value: T; readonly bound?: 'minimum' } | Withheld;

export interface Morphometrics {
  readonly areaM2: Figure<number>;
  /** ± half the divide's boundary cells × cell area. */
  readonly areaBandM2: number;
  readonly perimeterM: Figure<number>;
  /** 0.282 P / sqrt(A) */
  readonly gravelius: Figure<number>;
  /** A / Lb² */
  readonly formFactor: Figure<number>;
  /** 1.128 sqrt(A) / Lb */
  readonly elongation: Figure<number>;
  /** 4πA / P² */
  readonly circularity: Figure<number>;
  /** Lb: straight line outlet to farthest outer-ring vertex. */
  readonly basinLengthM: Figure<number>;
  /** Highest cell minus outlet cell, in metres. Minimum when open. */
  readonly reliefM: Figure<number>;
  /** Absolute only when originZ is known, otherwise above the outlet. */
  readonly meanElevationM: Figure<number>;
  readonly elevationsRelative: boolean;
  /** Horn slope per cell, mean over the catchment, in percent. */
  readonly meanSlopePct: Figure<number>;
  /** 20 classes. */
  readonly hypsometry: Figure<{
    readonly relArea: Float64Array;
    readonly relHeight: Float64Array;
    readonly integral: number;
  }>;
}

export const HYPSOMETRIC_CLASSES = 20;
/** Fewer catchment cells than this and the shape ratios describe the grid. */
const MIN_SHAPE_CELLS = 9;

const GRAVELIUS_FACTOR = 0.282;
const ELONGATION_FACTOR = 1.128;

function withheld(reason: WithheldReason): Withheld {
  return { withheld: reason };
}

/** Mask cells that carry an elevation. */
function catchmentCells(grid: FlowGrid, mask: Uint8Array): number[] {
  const cells: number[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i] !== 0 && grid.valid[i] !== 0) cells.push(i);
  return cells;
}

/** Cells of the set with a 4-neighbour outside it, or on the grid edge. */
function boundaryCellCount(grid: FlowGrid, inSet: Uint8Array, cells: readonly number[]): number {
  const { cols, rows } = grid;
  let count = 0;
  for (const i of cells) {
    const c = i % cols;
    const r = (i - c) / cols;
    if (c === 0 || r === 0 || c === cols - 1 || r === rows - 1
      || inSet[i - 1] === 0 || inSet[i + 1] === 0 || inSet[i - cols] === 0 || inSet[i + cols] === 0) {
      count++;
    }
  }
  return count;
}

/** Mean Horn slope in percent over `cells`; NaN when no cell has a slope. */
function meanHornSlopePct(grid: FlowGrid, cells: readonly number[], zReference: number, zScale: number): number {
  // Float32 is what the shared helper reads. Subtracting a reference first
  // keeps the 24-bit mantissa for the relief, not for the datum, and leaves
  // the slope untouched. NaN marks NoData: the helper takes the centre value.
  const z = new Float32Array(grid.z.length);
  for (let i = 0; i < z.length; i++) z[i] = grid.valid[i] !== 0 ? grid.z[i] - zReference : NaN;
  const slope = hornSlope(z, grid.cols, grid.rows, grid.cellMetresX, grid.cellMetresY, zScale);
  let sum = 0;
  let n = 0;
  for (const i of cells) {
    const s = slope[i];
    if (Number.isFinite(s)) { sum += s; n++; }
  }
  return n > 0 ? (sum / n) * 100 : NaN;
}

export function catchmentMorphometrics(input: {
  grid: FlowGrid;
  mask: Uint8Array;
  outlet: number;
  divide: TracedDivide;
  complete: boolean;
  verticalToMetres: number | null;
  originZ: number | null;
}): Morphometrics {
  const { grid, mask, outlet, divide, complete } = input;
  const cellArea = grid.cellMetresX * grid.cellMetresY;
  const cells = catchmentCells(grid, mask);
  const count = cells.length;
  const open = !complete;
  const tooSmall = divide.degenerate || count < MIN_SHAPE_CELLS;
  const vertical = input.verticalToMetres != null && Number.isFinite(input.verticalToMetres) && input.verticalToMetres > 0
    ? input.verticalToMetres
    : null;
  const elevationsRelative = input.originZ == null || !Number.isFinite(input.originZ);

  const area = count * cellArea;
  const inSet = new Uint8Array(mask.length);
  for (const i of cells) inSet[i] = 1;
  const areaBandM2 = (boundaryCellCount(grid, inSet, cells) / 2) * cellArea;
  const areaM2: Figure<number> = open ? { value: area, bound: 'minimum' } : { value: area };

  // --- Horizontal figures: outline and ratios ---------------------------
  // A catchment of 3 to 8 cells has an honest outline and length; only the
  // ratios and the curve are withheld for it. A degenerate divide has neither.
  const outlineGate: Withheld | null = open ? withheld('open-catchment')
    : divide.degenerate || count === 0 ? withheld('too-small') : null;
  const ratioGate: Withheld | null = open ? withheld('open-catchment') : tooSmall ? withheld('too-small') : null;

  const perimeterM: Figure<number> = outlineGate ?? { value: divide.perimeterM };

  let basinLengthM: Figure<number>;
  if (outlineGate !== null) {
    basinLengthM = outlineGate;
  } else {
    const oc = outlet % grid.cols;
    const orow = (outlet - oc) / grid.cols;
    const ox = (oc + 0.5) * grid.cellMetresX;
    const oy = (orow + 0.5) * grid.cellMetresY;
    let lb = 0;
    for (let k = 0; k < divide.outer.length; k += 2) {
      lb = Math.max(lb, Math.hypot(divide.outer[k] - ox, divide.outer[k + 1] - oy));
    }
    basinLengthM = lb > 0 ? { value: lb } : withheld('not-applicable');
  }

  let gravelius: Figure<number> = ratioGate ?? withheld('not-applicable');
  let circularity: Figure<number> = ratioGate ?? withheld('not-applicable');
  let formFactor: Figure<number> = ratioGate ?? withheld('not-applicable');
  let elongation: Figure<number> = ratioGate ?? withheld('not-applicable');
  if (ratioGate === null) {
    const p = divide.perimeterM;
    const sqrtA = Math.sqrt(area);
    if (p > 0) {
      gravelius = { value: (GRAVELIUS_FACTOR * p) / sqrtA };
      circularity = { value: (4 * Math.PI * area) / (p * p) };
    }
    if ('value' in basinLengthM) {
      const lb = basinLengthM.value;
      formFactor = { value: area / (lb * lb) };
      elongation = { value: (ELONGATION_FACTOR * sqrtA) / lb };
    } else {
      formFactor = basinLengthM;
      elongation = basinLengthM;
    }
  }

  // --- Vertical figures ---------------------------------------------------
  const outletInSet = outlet >= 0 && outlet < inSet.length && grid.valid[outlet] !== 0 && Number.isFinite(grid.z[outlet]);
  const outletZ = outletInSet ? grid.z[outlet] : NaN;

  let reliefM: Figure<number>;
  let meanElevationM: Figure<number>;
  let meanSlopePct: Figure<number>;
  let hypsometry: Figure<{ relArea: Float64Array; relHeight: Float64Array; integral: number }>;

  if (vertical === null) {
    reliefM = withheld('vertical-unresolved');
    meanElevationM = open ? withheld('open-catchment') : withheld('vertical-unresolved');
    meanSlopePct = open ? withheld('open-catchment') : withheld('vertical-unresolved');
    hypsometry = open ? withheld('open-catchment') : tooSmall ? withheld('too-small') : withheld('vertical-unresolved');
  } else {
    let zMax = -Infinity;
    let zMin = Infinity;
    let zSum = 0;
    for (const i of cells) {
      const z = grid.z[i];
      if (z > zMax) zMax = z;
      if (z < zMin) zMin = z;
      zSum += z;
    }
    if (count === 0 || !outletInSet) {
      reliefM = withheld(count === 0 ? 'too-small' : 'not-applicable');
    } else {
      const relief = (zMax - outletZ) * vertical;
      reliefM = open ? { value: relief, bound: 'minimum' } : { value: relief };
    }

    if (open) {
      meanElevationM = withheld('open-catchment');
      meanSlopePct = withheld('open-catchment');
      hypsometry = withheld('open-catchment');
    } else if (count === 0) {
      meanElevationM = withheld('too-small');
      meanSlopePct = withheld('too-small');
      hypsometry = withheld('too-small');
    } else {
      const meanZ = zSum / count;
      if (elevationsRelative) {
        meanElevationM = outletInSet ? { value: (meanZ - outletZ) * vertical } : withheld('not-applicable');
      } else {
        meanElevationM = { value: ((input.originZ as number) + meanZ) * vertical };
      }

      const slope = meanHornSlopePct(grid, cells, outletInSet ? outletZ : zMin, vertical);
      meanSlopePct = Number.isFinite(slope) ? { value: slope } : withheld('not-applicable');

      if (tooSmall) {
        hypsometry = withheld('too-small');
      } else if (!(zMax > zMin)) {
        hypsometry = withheld('not-applicable');
      } else {
        const span = zMax - zMin;
        const relArea = new Float64Array(HYPSOMETRIC_CLASSES);
        const relHeight = new Float64Array(HYPSOMETRIC_CLASSES);
        const heights = new Float64Array(count);
        let hSum = 0;
        for (let k = 0; k < count; k++) {
          const h = (grid.z[cells[k]] - zMin) / span;
          heights[k] = h;
          hSum += h;
        }
        for (let k = 0; k < HYPSOMETRIC_CLASSES; k++) {
          const lower = k / HYPSOMETRIC_CLASSES;
          relHeight[k] = lower;
          let above = 0;
          for (let j = 0; j < count; j++) if (heights[j] >= lower) above++;
          relArea[k] = above / count;
        }
        hypsometry = { value: { relArea, relHeight, integral: hSum / count } };
      }
    }
  }

  return {
    areaM2, areaBandM2, perimeterM, gravelius, formFactor, elongation, circularity,
    basinLengthM, reliefM, meanElevationM, elevationsRelative, meanSlopePct, hypsometry,
  };
}
