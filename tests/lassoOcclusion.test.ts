/**
 * lassoOcclusion.test.ts — the depth decision behind a lasso selection.
 *
 * The lasso's polygon test takes every point along the camera ray, so a lasso
 * around a building also takes the ground under it and the far wall behind it.
 * `rejectOccluded` is what narrows that to what the camera can see, and the
 * whole of it is the tolerance: too tight and one continuous surface comes back
 * with holes punched in it, too loose and the far wall returns.
 *
 * These cases pin both ends of that, and pin them at two point densities, since
 * a tolerance tuned to one density is not a tolerance, it is a constant.
 */

import { describe, it, expect } from 'vitest';
import { rejectOccluded, describeLassoSelectionBasis } from '../src/render/measure/lassoOcclusion';
import type { LassoDepthField } from '../src/render/measure/lassoOcclusion';

/** Deterministic uniform noise in [-1, 1) — no dependence on Math.random. */
function noise(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 0x100000000) * 2 - 1;
  };
}

interface Sample {
  x: number;
  y: number;
  d: number;
}

function field(samples: readonly Sample[]): LassoDepthField {
  const n = samples.length;
  const screenX = new Float64Array(n);
  const screenY = new Float64Array(n);
  const depth = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    screenX[i] = samples[i].x;
    screenY[i] = samples[i].y;
    depth[i] = samples[i].d;
  }
  return { screenX, screenY, depth, count: n };
}

/**
 * A planar surface sampled on an `n`×`n` screen grid spanning `extentPx`.
 * `depthAt` is the view-axis depth in cloud units; `jitter` is the scatter a
 * real return has about the surface, as a fraction of the point spacing in
 * depth units.
 */
function surface(
  n: number,
  extentPx: number,
  depthAt: (u: number, v: number) => number,
  jitter = 0,
  seed = 7,
): Sample[] {
  const rand = noise(seed);
  const out: Sample[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const u = c / (n - 1);
      const v = r / (n - 1);
      out.push({ x: u * extentPx, y: v * extentPx, d: depthAt(u, v) + rand() * jitter });
    }
  }
  return out;
}

describe('rejectOccluded — two surfaces, one behind the other', () => {
  it('keeps the near surface and drops the far one', () => {
    // A wall at depth 10 and a second wall at depth 25, both filling the lasso.
    // The gap is many times the per-cell depth step of either wall (both are
    // flat), so the far wall is unambiguously hidden.
    const near = surface(24, 480, () => 10, 0.02, 1);
    const far = surface(24, 480, () => 25, 0.02, 2);
    const decision = rejectOccluded(field([...near, ...far]));

    expect(decision.applied).toBe(true);
    expect(decision.keptCount).toBe(near.length);
    for (let i = 0; i < near.length; i++) expect(decision.keep[i]).toBe(1);
    for (let i = near.length; i < near.length + far.length; i++) {
      expect(decision.keep[i]).toBe(0);
    }
  });

  it('drops a far surface even when the near one covers only part of the lasso', () => {
    // The near wall covers the left half. The right half has nothing in front
    // of it, so the ground there stays — occlusion is per cell, not global.
    const ground = surface(30, 600, () => 40, 0.05, 3);
    const near = surface(15, 600, (u) => 12 + u * 0, 0.05, 4).map((s) => ({ ...s, x: s.x / 2 }));
    const decision = rejectOccluded(field([...ground, ...near]));

    expect(decision.applied).toBe(true);
    let groundKeptLeft = 0;
    let groundKeptRight = 0;
    for (let i = 0; i < ground.length; i++) {
      if (decision.keep[i] === 1) {
        if (ground[i].x <= 300) groundKeptLeft++;
        else groundKeptRight++;
      }
    }
    expect(groundKeptLeft).toBe(0);
    expect(groundKeptRight).toBeGreaterThan(ground.length * 0.4);
    for (let i = ground.length; i < ground.length + near.length; i++) {
      expect(decision.keep[i]).toBe(1);
    }
  });
});

describe('rejectOccluded — one continuous surface is not carved up', () => {
  // The case that matters most. A road seen at a steep angle spans a huge depth
  // range across the lasso, and a tolerance measured against that RANGE would
  // reject most of it. The tolerance has to be the depth step across ONE CELL.
  it('keeps every point of a steeply-viewed plane', () => {
    // Depth runs 5 → 205 across the lasso: a 40× spread, far larger than the
    // 15-unit gap the two-wall case above resolves as occlusion.
    const steep = surface(40, 800, (u, v) => 5 + u * 120 + v * 80, 0.3, 5);
    const decision = rejectOccluded(field(steep));

    expect(decision.applied).toBe(true);
    expect(decision.keptCount).toBe(steep.length);
  });

  it('keeps every point of a noisy flat surface', () => {
    // A flat surface with scatter of the same order as its point spacing. The
    // per-cell minimum is biased low by the scatter, so a tolerance that did
    // not allow for it would reject the upper half of every cell.
    const flat = surface(40, 800, () => 60, 1.2, 6);
    const decision = rejectOccluded(field(flat));

    expect(decision.applied).toBe(true);
    expect(decision.keptCount).toBe(flat.length);
  });

  it('keeps every point of a curved surface', () => {
    const dome = surface(40, 800, (u, v) => 50 - 20 * Math.cos(u * 2) - 15 * Math.sin(v * 2), 0.2, 8);
    const decision = rejectOccluded(field(dome));

    expect(decision.applied).toBe(true);
    expect(decision.keptCount).toBe(dome.length);
  });
});

describe('rejectOccluded — the tolerance adapts to point density', () => {
  // Same geometry, same screen extent, 16× the points. A tolerance tuned to one
  // density fails one of these two: the sparse cloud gets carved (its cells are
  // wider, so its per-cell depth step is larger), or the dense cloud stops
  // separating the walls (its step is smaller than the tolerance allows for).
  const cases: ReadonlyArray<readonly [string, number]> = [
    ['sparse', 15],
    ['dense', 60],
  ];

  for (const [label, n] of cases) {
    it(`${label}: separates two walls`, () => {
      const near = surface(n, 600, () => 10, 0.05, 11);
      const far = surface(n, 600, () => 30, 0.05, 12);
      const decision = rejectOccluded(field([...near, ...far]));
      expect(decision.applied).toBe(true);
      expect(decision.keptCount).toBe(near.length);
    });

    it(`${label}: does not carve one steep surface`, () => {
      const steep = surface(n, 600, (u, v) => 5 + u * 90 + v * 60, 0.2, 13);
      const decision = rejectOccluded(field(steep));
      expect(decision.applied).toBe(true);
      expect(decision.keptCount).toBe(steep.length);
    });
  }

  it('scales the cell and the tolerance with the point spacing', () => {
    const sparse = rejectOccluded(field(surface(15, 600, (u, v) => 5 + u * 90 + v * 60, 0.2, 13)));
    const dense = rejectOccluded(field(surface(60, 600, (u, v) => 5 + u * 90 + v * 60, 0.2, 13)));
    // 4× the linear density means a quarter of the cell size, and a quarter of
    // the depth step across a cell of a plane. Neither is a fixed number.
    expect(sparse.cellSizePx).toBeGreaterThan(dense.cellSizePx * 3);
    expect(sparse.depthTolerance).toBeGreaterThan(dense.depthTolerance * 2);
  });
});

describe('rejectOccluded — refuses to guess', () => {
  it('keeps everything when there are too few candidates to estimate from', () => {
    const few = surface(4, 100, (u) => 10 + u * 30, 0, 21);
    const decision = rejectOccluded(field(few));
    expect(decision.applied).toBe(false);
    expect(decision.outcome).toBe('too-few-points');
    expect(decision.keptCount).toBe(few.length);
  });

  it('keeps everything when the candidates have no screen extent', () => {
    const line: Sample[] = [];
    for (let i = 0; i < 200; i++) line.push({ x: 10, y: 10, d: i });
    const decision = rejectOccluded(field(line));
    expect(decision.applied).toBe(false);
    expect(decision.outcome).toBe('degenerate-extent');
    expect(decision.keptCount).toBe(line.length);
  });

  it('keeps a point whose depth the projector could not resolve', () => {
    const flat = surface(30, 600, () => 20, 0.05, 22);
    const samples = [...flat, { x: 300, y: 300, d: Number.NaN }];
    const decision = rejectOccluded(field(samples));
    expect(decision.applied).toBe(true);
    expect(decision.keep[samples.length - 1]).toBe(1);
  });

  it('counts an unapplied rejection as a through-surfaces basis in the clause', () => {
    expect(describeLassoSelectionBasis('occluded-excluded', 'applied')).toBe('visible surfaces only');
    expect(describeLassoSelectionBasis('occluded-excluded', 'too-few-points')).toContain(
      'all depths taken',
    );
    expect(describeLassoSelectionBasis('through-surfaces')).toBe('all depths along the ray');
  });
});

describe('rejectOccluded — a selection too thin to grid', () => {
  /**
   * The cell comes from the bounding box AREA, so a wide, near-flat selection
   * sends the cell towards zero while the width stays long, and the column count
   * grows as the square root of the aspect ratio with nothing in the geometry to
   * stop it. These pin the grid to the point count instead: a handful of points
   * may not ask for a grid larger than itself, whatever shape they arrive in.
   */
  function ribbon(n: number, width: number, height: number): Sample[] {
    const out: Sample[] = [];
    for (let i = 0; i < n; i++) {
      out.push({ x: (i / (n - 1)) * width, y: i % 2 === 0 ? 0 : height, d: 10 + (i % 3) });
    }
    return out;
  }

  /** Cells the grid would hold at the cell size the decision reports. */
  function gridCells(cellSizePx: number, width: number, height: number): number {
    return (Math.floor(width / cellSizePx) + 1) * (Math.floor(height / cellSizePx) + 1);
  }

  it('does not build a grid larger than the candidate set', () => {
    // 1000 px of width, 32 points, a height at the noise floor of a projected
    // coordinate. The unbounded cell size here is about 1.7e-4 px, which is
    // about 6e6 columns: five Float64 slots each, so gigabytes of typed array
    // for 32 returns. Measured as bytes of array buffer rather than as elapsed
    // time, which would be a machine-speed assertion and not a bound.
    const samples = ribbon(32, 1000, 1e-10);
    expect(gridCells(3 * Math.sqrt((1000 * 1e-10) / 32), 1000, 1e-10)).toBeGreaterThan(1e6);

    const before = process.memoryUsage().arrayBuffers;
    const decision = rejectOccluded(field(samples));
    const grown = process.memoryUsage().arrayBuffers - before;

    expect(grown).toBeLessThan(4 * 1024 * 1024);
    expect(decision.applied).toBe(false);
    expect(decision.outcome).toBe('degenerate-aspect');
  });

  it('declines rather than returning a quietly degraded selection', () => {
    const samples = ribbon(64, 1000, 1e-6);
    const decision = rejectOccluded(field(samples));

    expect(decision.applied).toBe(false);
    expect(decision.outcome).toBe('degenerate-aspect');
    expect(decision.keptCount).toBe(samples.length);
    for (let i = 0; i < samples.length; i++) expect(decision.keep[i]).toBe(1);
    // An unapplied outcome must read as a through-surfaces figure in the clause,
    // exactly as the other refusals do.
    expect(describeLassoSelectionBasis('occluded-excluded', decision.outcome)).toContain(
      'all depths taken',
    );
  });

  it('holds the bound to the point count, not to a fixed grid size', () => {
    // Same shape, 64× the points. A fixed cell cap would decline both or accept
    // both; the bound is the candidate count, so the denser ribbon is the one
    // that gets a grid.
    const shape = (n: number) => ribbon(n, 1000, 0.5);
    const sparse = rejectOccluded(field(shape(32)));
    const dense = rejectOccluded(field(shape(2048)));

    expect(gridCells(sparse.cellSizePx, 1000, 0.5)).toBeGreaterThan(32);
    expect(sparse.applied).toBe(false);
    expect(sparse.outcome).toBe('degenerate-aspect');
    expect(gridCells(dense.cellSizePx, 1000, 0.5)).toBeLessThanOrEqual(2048);
    expect(dense.outcome).not.toBe('degenerate-aspect');
  });

  it('leaves an ordinary selection on exactly the path it took before', () => {
    // The bound must not touch what a normal lasso selects: a well-shaped
    // selection spends about N / 9 cells, far under one cell per point. Both
    // ends of the module's behaviour are pinned here, point for point.
    const near = surface(24, 480, () => 10, 0.02, 1);
    const far = surface(24, 480, () => 25, 0.02, 2);
    const both = [...near, ...far];
    const decision = rejectOccluded(field(both));

    expect(decision.outcome).toBe('applied');
    expect(gridCells(decision.cellSizePx, 480, 480)).toBeLessThan(both.length);
    expect(decision.keptCount).toBe(near.length);
    for (let i = 0; i < both.length; i++) {
      expect(decision.keep[i]).toBe(i < near.length ? 1 : 0);
    }

    const steep = surface(40, 800, (u, v) => 5 + u * 120 + v * 80, 0.3, 5);
    const uncarved = rejectOccluded(field(steep));
    expect(uncarved.outcome).toBe('applied');
    expect(uncarved.keptCount).toBe(steep.length);
  });

  it('still reports an exactly-zero extent as a degenerate extent', () => {
    // The zero case was handled before the bound existed and keeps its own
    // reason: no extent at all is not the same finding as an extent so thin the
    // grid outruns the points.
    const line: Sample[] = [];
    for (let i = 0; i < 200; i++) line.push({ x: i, y: 10, d: i });
    const decision = rejectOccluded(field(line));
    expect(decision.applied).toBe(false);
    expect(decision.outcome).toBe('degenerate-extent');
    expect(decision.keptCount).toBe(line.length);
  });
});
