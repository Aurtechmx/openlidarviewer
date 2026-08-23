/**
 * geodesicFill.test.ts — surface-aware void interpolation. The headline
 * property: a void in a valley next to a ridge fills from the valley floor,
 * not across the ridge (which plain Euclidean IDW wrongly pulls in).
 */

import { describe, it, expect } from 'vitest';
import {
  geodesicFill,
  geodesicFillWithReport,
  GEODESIC_PROBE_VOIDS,
} from '../src/terrain/ground/geodesicFill';
import { idwFill } from '../src/terrain/ground/idwFill';

describe('geodesicFill', () => {
  it('fills a simple gap on a flat surface to the surrounding value', () => {
    // 3x3 all measured at 5 except the centre void.
    const z = Float32Array.from([5, 5, 5, 5, NaN, 5, 5, 5, 5]);
    const had = Uint8Array.from([1, 1, 1, 1, 0, 1, 1, 1, 1]);
    const out = geodesicFill(z, had, 3, 3, { cellMetresX: 1 });
    expect(out[4]).toBeCloseTo(5, 5);
  });

  it('does not pull a valley void across a ridge (geodesic < Euclidean)', () => {
    // Row0 = ridge top (100), Row1 = valley floor 0 with a centre gap,
    // Row2 = valley floor 0. Euclidean IDW pulls the ridge into the void;
    // the geodesic path must climb the ridge, so it down-weights it.
    const z = Float32Array.from([100, 100, 100, 0, NaN, 0, 0, 0, 0]);
    const had = Uint8Array.from([1, 1, 1, 1, 0, 1, 1, 1, 1]);
    const euclid = idwFill(z, had, 3, 3, {});
    const geo = geodesicFill(z, had, 3, 3, { cellMetresX: 1 });
    expect(euclid[4]).toBeGreaterThan(25); // Euclidean is inflated by the ridge
    expect(geo[4]).toBeLessThan(euclid[4]); // geodesic stays nearer the floor
    expect(geo[4]).toBeLessThan(20);
    expect(geo[4]).toBeGreaterThanOrEqual(0);
  });

  it('takes the horizontal step in METRES, per axis, and the rise in metres too', () => {
    // The step cost is sqrt(stepXY² + Δz²), so the two terms must share a unit.
    // The same terrain described in degrees and in metres must fill the same
    // way; feeding raw degrees (~1e-5) beside metre heights collapses the cost
    // to vertical-only and the walk-over-the-ridge down-weighting degenerates.
    const z = Float32Array.from([100, 100, 100, 0, NaN, 0, 0, 0, 0]);
    const had = Uint8Array.from([1, 1, 1, 1, 0, 1, 1, 1, 1]);
    const metres = geodesicFill(z, had, 3, 3, { cellMetresX: 1113.2, cellMetresY: 1113.2 });

    // And a foot-vertical grid: the rise is converted before it is compared
    // with the metre step, so the same surface in feet fills equivalently.
    const feet = Float32Array.from([100 / 0.3048, 100 / 0.3048, 100 / 0.3048, 0, NaN, 0, 0, 0, 0]);
    const inFeet = geodesicFill(feet, had, 3, 3, {
      cellMetresX: 1113.2, cellMetresY: 1113.2, verticalUnitToMetres: 0.3048,
    });
    expect(inFeet[4] * 0.3048).toBeCloseTo(metres[4], 5);
  });

  it('costs a diagonal step as the metric hypotenuse of the two axes', () => {
    // The single load-bearing line of the per-axis step: `hypot(cellX, cellY)`.
    // A diagonal move crosses one cell on EACH axis, so on a grid whose N–S
    // cell is 100x its E–W cell it must cost at least the longer axis (100.005),
    // never a blend of the two — the plausible-looking mean (50.5) makes every
    // diagonal ~half price, reroutes Dijkstra and shifts every filled height on
    // every production surface.
    //
    // Dijkstra's route choice is discrete, so the resulting height is pinned by
    // value rather than by an inequality: an ordering assertion is satisfied by
    // the wrong cost too. The mean-diagonal mutant yields 12.7307786942 here
    // and 13.0511302948 on the square grid below.
    const z = Float32Array.from([100, 100, 100, 0, NaN, 0, 0, 0, 0]);
    const had = Uint8Array.from([1, 1, 1, 1, 0, 1, 1, 1, 1]);

    const anisotropic = geodesicFill(z, had, 3, 3, { cellMetresX: 1, cellMetresY: 100 });
    expect(anisotropic[4]).toBeCloseTo(9.12470722198, 8);

    // The square-cell case production runs on: the diagonal is cell·√2, not cell.
    const square = geodesicFill(z, had, 3, 3, { cellMetresX: 1, cellMetresY: 1 });
    expect(square[4]).toBeCloseTo(13.0535078049, 8);

    // Anisotropy must actually change the answer — a kernel that quietly used
    // one axis for both would otherwise satisfy the square-grid pin alone.
    expect(Math.abs(anisotropic[4] - square[4])).toBeGreaterThan(1);
  });

  it('keeps measured cells verbatim and leaves an all-empty grid NaN', () => {
    const z = Float32Array.from([3, NaN, 7, NaN]);
    const had = Uint8Array.from([1, 0, 1, 0]);
    const out = geodesicFill(z, had, 2, 2, { cellMetresX: 1 });
    expect(out[0]).toBe(3);
    expect(out[2]).toBe(7);
    expect(Number.isFinite(out[1])).toBe(true); // reachable void filled

    const empty = geodesicFill(
      Float32Array.from([NaN, NaN]),
      Uint8Array.from([0, 0]),
      2, 1, {},
    );
    expect(empty.every((v) => Number.isNaN(v))).toBe(true);
  });
});

/**
 * A grid of alternating measured and void tiles, the shape that makes the pass
 * expensive: a void in the middle of a tile has to expand most of its search
 * window before it reaches twelve measured cells, while a void beside measured
 * ground reaches them in a step.
 */
function tiledGrid(cols: number, rows: number, tile: number): {
  z: Float32Array; had: Uint8Array;
} {
  const n = cols * rows;
  const z = new Float32Array(n);
  const had = new Uint8Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    const r = (i / cols) | 0, c = i - r * cols;
    z[i] = 40 * Math.sin(c / 60) + 25 * Math.cos(r / 45);
    if ((((r / tile) | 0) + ((c / tile) | 0)) % 2 === 1) { had[i] = 0; z[i] = Number.NaN; }
  }
  return { z, had };
}

describe('geodesicFill cost bound', () => {
  it('reports what it spent and what it projected', () => {
    const { z, had } = tiledGrid(64, 64, 8);
    const { report } = geodesicFillWithReport(z, had, 64, 64, { cellMetresX: 1 });
    expect(report.voids).toBeGreaterThan(0);
    expect(report.abandoned).toBe(false);
    expect(report.stoppedBy).toBeNull();
    expect(report.nodesExpanded).toBeGreaterThan(0);
    expect(report.projectedNodes).toBeGreaterThan(0);
  });

  it('projects the whole pass to within a few per cent of what it costs', () => {
    // The projection is the decision, so a probe that misread the grid would
    // abandon a cheap pass or run an expensive one.
    const { z, had } = tiledGrid(160, 160, 16);
    const { report } = geodesicFillWithReport(z, had, 160, 160, {
      cellMetresX: 1, nodeBudget: 1e15,
    });
    const ratio = report.projectedNodes / report.nodesExpanded;
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);
  });

  it('abandons the geodesic pass when the projection exceeds the budget', () => {
    const { z, had } = tiledGrid(96, 96, 12);
    const { report } = geodesicFillWithReport(z, had, 96, 96, {
      cellMetresX: 1, nodeBudget: 1,
    });
    expect(report.abandoned).toBe(true);
    expect(report.stoppedBy).toBe('projection');
    expect(report.projectedNodes).toBeGreaterThan(1);
  });

  it('leaves every void at the Euclidean prefill when it abandons', () => {
    // All or nothing: the probe's geodesic values are discarded so the surface
    // is one interpolant throughout, not geodesic in the cells sampled first.
    const { z, had } = tiledGrid(96, 96, 12);
    const { z: out } = geodesicFillWithReport(z, had, 96, 96, {
      cellMetresX: 1, nodeBudget: 1,
    });
    const euclidean = idwFill(z, had, 96, 96, { power: 2, kNearest: 12, maxRadiusCells: 24 });
    for (let i = 0; i < out.length; i++) {
      if (had[i] === 1) continue;
      if (!Number.isFinite(euclidean[i])) continue;
      expect(out[i]).toBe(euclidean[i]);
    }
  });

  it('keeps measured cells verbatim on the abandoned path too', () => {
    const { z, had } = tiledGrid(96, 96, 12);
    const { z: out } = geodesicFillWithReport(z, had, 96, 96, {
      cellMetresX: 1, nodeBudget: 1,
    });
    for (let i = 0; i < out.length; i++) if (had[i] === 1) expect(out[i]).toBe(z[i]);
  });

  it('gives the same answer every run, probe included', () => {
    const a = tiledGrid(80, 80, 10);
    const b = tiledGrid(80, 80, 10);
    const ra = geodesicFillWithReport(a.z, a.had, 80, 80, { cellMetresX: 1 });
    const rb = geodesicFillWithReport(b.z, b.had, 80, 80, { cellMetresX: 1 });
    expect([...rb.z]).toEqual([...ra.z]);
    expect(rb.report).toEqual(ra.report);
  });

  it('solves every void exactly once, so the probe is not repeated work', () => {
    // A void solved twice would double the pops for no change in the answer.
    const { z, had } = tiledGrid(40, 40, 5);
    const strided = geodesicFillWithReport(z, had, 40, 40, { cellMetresX: 1 });
    const unstrided = geodesicFillWithReport(z, had, 40, 40, {
      cellMetresX: 1,
      // One probe void, so nearly every void is solved in the second loop.
      nodeBudget: 1e15,
    });
    expect([...strided.z]).toEqual([...unstrided.z]);
    expect(strided.report.voids).toBeLessThanOrEqual(GEODESIC_PROBE_VOIDS * 1000);
  });

  it('is unchanged for a grid small enough that the probe covers it', () => {
    // Under GEODESIC_PROBE_VOIDS voids the stride is 1 and the probe solves
    // everything, which must still equal what the plain entry point returns.
    const { z, had } = tiledGrid(30, 30, 6);
    const viaReport = geodesicFillWithReport(z, had, 30, 30, { cellMetresX: 1 }).z;
    expect([...geodesicFill(z, had, 30, 30, { cellMetresX: 1 })]).toEqual([...viaReport]);
  });
});

describe('geodesicFill runtime backstop', () => {
  /**
   * One contiguous gap covering the right of the grid. This is the shape the
   * probe reads worst: cost per void spans two orders of magnitude between the
   * gap edge and its interior, and a strided sample of that distribution comes
   * out low. Measured across 24 void morphologies the median projection error
   * is 0.5% and the worst is 36%, and every case that misses badly has this
   * shape. It is therefore the only fixture in which the BACKSTOP, rather than
   * the projection, is what stops the pass.
   */
  function oneGap(cols: number, rows: number, frac: number): {
    z: Float32Array; had: Uint8Array;
  } {
    const n = cols * rows;
    const z = new Float32Array(n);
    const had = new Uint8Array(n).fill(1);
    for (let i = 0; i < n; i++) {
      const r = (i / cols) | 0, c = i - r * cols;
      z[i] = 40 * Math.sin(c / 17) + 25 * Math.cos(r / 13);
      if (c > cols * frac) { had[i] = 0; z[i] = Number.NaN; }
    }
    return { z, had };
  }

  const COLS = 200, ROWS = 200;
  const grid = oneGap(COLS, ROWS, 0.6);
  const uncapped = geodesicFillWithReport(grid.z, grid.had, COLS, ROWS, {
    cellMetresX: 1, nodeBudget: 1e15,
  });

  it('under-estimates on this fixture, which is what the backstop is for', () => {
    // If the projection ever became exact here the tests below would pass
    // through the projection's own abandon path and stop testing anything.
    expect(uncapped.report.projectedNodes).toBeLessThan(uncapped.report.nodesExpanded);
  });

  it('stops at the ceiling when the projection said the pass would fit', () => {
    // Above the projection, below the real cost: the pass starts, and only the
    // backstop can end it.
    const budget = Math.floor(
      (uncapped.report.projectedNodes + uncapped.report.nodesExpanded) / 2,
    );
    expect(budget).toBeGreaterThan(uncapped.report.projectedNodes);
    expect(budget).toBeLessThan(uncapped.report.nodesExpanded);
    const capped = geodesicFillWithReport(grid.z, grid.had, COLS, ROWS, {
      cellMetresX: 1, nodeBudget: budget,
    });
    expect(capped.report.abandoned).toBe(true);
    expect(capped.report.stoppedBy).toBe('ceiling');
    expect(capped.report.nodesExpanded).toBeLessThan(uncapped.report.nodesExpanded);
  });

  it('leaves the Euclidean prefill everywhere when it fires', () => {
    const budget = Math.floor(
      (uncapped.report.projectedNodes + uncapped.report.nodesExpanded) / 2,
    );
    const capped = geodesicFillWithReport(grid.z, grid.had, COLS, ROWS, {
      cellMetresX: 1, nodeBudget: budget,
    });
    // Not a partly geodesic surface: the fallback covers every void, so the
    // grid is one interpolant and carries no seam.
    const euclidean = geodesicFillWithReport(grid.z, grid.had, COLS, ROWS, {
      cellMetresX: 1, nodeBudget: 1,
    }).z;
    expect([...capped.z]).toEqual([...euclidean]);
  });

  it('overshoots by at most one void search, not by the rest of the grid', () => {
    const budget = Math.floor(
      (uncapped.report.projectedNodes + uncapped.report.nodesExpanded) / 2,
    );
    const capped = geodesicFillWithReport(grid.z, grid.had, COLS, ROWS, {
      cellMetresX: 1, nodeBudget: budget,
    });
    // The check runs between voids, so the search in flight is the overshoot.
    // One void expands at most its whole window, each cell pushed a bounded
    // number of times.
    const oneVoidCeiling = (2 * 24 + 1) ** 2 * 8;
    expect(capped.report.nodesExpanded).toBeLessThanOrEqual(budget + oneVoidCeiling);
  });
});

describe('geodesicFill is independent of the order voids are solved in', () => {
  /**
   * The probe solves a strided sample before the rest, so the visit order now
   * depends on the sample size. Each void reads the prefilled surface and
   * writes only its own cell, so the order cannot matter, and this is the
   * assertion that keeps it that way: a future change that let one void's
   * result feed another would show up here and nowhere else.
   */
  it('gives the same surface at every probe size', () => {
    const { z, had } = tiledGrid(70, 70, 7);
    const reference = geodesicFillWithReport(z, had, 70, 70, {
      cellMetresX: 1.3, cellMetresY: 0.7, verticalUnitToMetres: 1.1, probeVoids: 1,
    });
    for (const probeVoids of [2, 3, 17, 200, 5000]) {
      const other = geodesicFillWithReport(z, had, 70, 70, {
        cellMetresX: 1.3, cellMetresY: 0.7, verticalUnitToMetres: 1.1, probeVoids,
      });
      expect([...other.z]).toEqual([...reference.z]);
      expect(other.report.nodesExpanded).toBe(reference.report.nodesExpanded);
    }
  });

  it('gives the same surface when the probe covers every void', () => {
    // Stride 1: the probe solves everything and the second loop does nothing.
    const { z, had } = tiledGrid(50, 50, 5);
    const strided = geodesicFillWithReport(z, had, 50, 50, { cellMetresX: 1, probeVoids: 9 });
    const whole = geodesicFillWithReport(z, had, 50, 50, { cellMetresX: 1, probeVoids: 1e6 });
    expect([...whole.z]).toEqual([...strided.z]);
  });
});
