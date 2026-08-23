import { describe, it, expect } from 'vitest';
import {
  buildProfileHitTestIndex,
  queryProfileHitTest,
  createProfileHitTestStats,
  type ProfileSectionPlacement,
  type ProfileProjectionFn,
  type ProfileAffineProjection,
} from '../src/render/measure/profileHitTest';

/**
 * tests/profileHitTest.test.ts
 *
 * The hit-test index is only worth having if it agrees with a full scan on
 * every query and costs far less than one, so both halves are pinned here: a
 * brute-force reference decides the expected answer, and a candidate counter
 * decides the cost.
 *
 * Every input is deterministic. Positions come from the R2 low-discrepancy
 * sequence and radii from a fixed cycle, so a failure reproduces exactly and
 * a passing run is not a lucky sample.
 */

// ---------------------------------------------------------------------------
// Deterministic sampling
// ---------------------------------------------------------------------------

/** Additive recurrences on the plastic number: the 2D R2 sequence. */
const R2_ALPHA_X = 0.7548776662466927;
const R2_ALPHA_Y = 0.5698402909980532;
/** Golden-ratio recurrence, for the places that need one stream. */
const PHI_ALPHA = 0.6180339887498949;

function r2x(k: number): number {
  return (0.5 + R2_ALPHA_X * k) % 1;
}
function r2y(k: number): number {
  return (0.5 + R2_ALPHA_Y * k) % 1;
}
function golden(k: number): number {
  return (0.5 + PHI_ALPHA * k) % 1;
}

// ---------------------------------------------------------------------------
// Section fixtures
// ---------------------------------------------------------------------------

function sectionOf(chainage: readonly number[], height: readonly number[]): ProfileSectionPlacement {
  expect(chainage.length).toBe(height.length);
  return {
    count: chainage.length,
    chainage: Float32Array.from(chainage),
    height: Float64Array.from(height),
  };
}

function allDisplayed(section: ProfileSectionPlacement): Uint32Array {
  const d = new Uint32Array(section.count);
  for (let i = 0; i < section.count; i++) d[i] = i;
  return d;
}

/** Deterministic permutation of a displayed set, from the golden sequence. */
function permute(displayed: Uint32Array): Uint32Array {
  const out = Uint32Array.from(displayed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(golden(i + 1) * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

const CANVAS_W = 960;
const CANVAS_H = 420;

/**
 * The chart transform used by both the index and the reference.
 *
 * Placement is not what these tests are about; agreement is. Driving both
 * sides from one function keeps the projected floats bit-identical, so a
 * disagreement can only come from the bucketing.
 */
const projection: ProfileProjectionFn = (chainage, height, out) => {
  out[0] = 40 + chainage * 4.5;
  out[1] = CANVAS_H - 30 - (height - 100) * 2.75;
};

// ---------------------------------------------------------------------------
// Brute-force reference
// ---------------------------------------------------------------------------

/**
 * Nearest displayed point within the radius, by scanning everything.
 *
 * Same acceptance rules as the index: a non-finite or off-canvas projection is
 * not a candidate, the radius is inclusive, and an exact distance tie goes to
 * the smaller section index.
 */
function bruteForceNearest(
  section: ProfileSectionPlacement,
  displayed: Uint32Array,
  project: ProfileProjectionFn,
  widthPx: number,
  heightPx: number,
  xPx: number,
  yPx: number,
  radiusPx: number,
): number | null {
  const out = new Float64Array(2);
  const r2 = radiusPx * radiusPx;
  let bestId = -1;
  let best2 = Infinity;
  for (let k = 0; k < displayed.length; k++) {
    const id = displayed[k]!;
    if (id >= section.count) continue;
    project(section.chainage[id]!, section.height[id]!, out);
    const px = out[0]!;
    const py = out[1]!;
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
    if (px < 0 || px > widthPx || py < 0 || py > heightPx) continue;
    const dx = px - xPx;
    const dy = py - yPx;
    const d2 = dx * dx + dy * dy;
    if (d2 > r2) continue;
    if (d2 < best2 || (d2 === best2 && id < bestId)) {
      best2 = d2;
      bestId = id;
    }
  }
  return bestId < 0 ? null : bestId;
}

// ---------------------------------------------------------------------------
// Point sets
// ---------------------------------------------------------------------------

/** Chainage/height domains that map onto roughly the whole canvas. */
const CHAINAGE_SPAN = 200;
const HEIGHT_BASE = 100;
const HEIGHT_SPAN = 140;

function spreadSet(n: number): ProfileSectionPlacement {
  const c: number[] = [];
  const h: number[] = [];
  for (let k = 1; k <= n; k++) {
    c.push(r2x(k) * CHAINAGE_SPAN);
    h.push(HEIGHT_BASE + r2y(k) * HEIGHT_SPAN);
  }
  return sectionOf(c, h);
}

function clusteredSet(n: number, clusters: number): ProfileSectionPlacement {
  const c: number[] = [];
  const h: number[] = [];
  for (let k = 1; k <= n; k++) {
    const cluster = k % clusters;
    const cc = r2x(cluster + 1) * CHAINAGE_SPAN;
    const ch = HEIGHT_BASE + r2y(cluster + 1) * HEIGHT_SPAN;
    c.push(cc + (r2x(k * 7) - 0.5) * 1.2);
    h.push(ch + (r2y(k * 7) - 0.5) * 0.9);
  }
  return sectionOf(c, h);
}

/** Exactly collinear: every point on one straight line in data space. */
function lineSet(n: number): ProfileSectionPlacement {
  const c: number[] = [];
  const h: number[] = [];
  for (let k = 0; k < n; k++) {
    const t = (k / (n - 1)) * CHAINAGE_SPAN;
    c.push(t);
    h.push(HEIGHT_BASE + 0.35 * t);
  }
  return sectionOf(c, h);
}

/** Coincident pairs, so most queries land on an exact tie. */
function coincidentSet(pairs: number): ProfileSectionPlacement {
  const c: number[] = [];
  const h: number[] = [];
  for (let k = 1; k <= pairs; k++) {
    const cc = r2x(k) * CHAINAGE_SPAN;
    const ch = HEIGHT_BASE + r2y(k) * HEIGHT_SPAN;
    c.push(cc, cc);
    h.push(ch, ch);
  }
  return sectionOf(c, h);
}

/**
 * Finite on-canvas points mixed with non-finite and off-canvas ones.
 *
 * Some of the off-canvas points sit only a few pixels past an edge, inside a
 * hover radius of positions that are on the canvas. Those are the ones that
 * separate dropping an off-canvas point from clamping it into an edge cell.
 */
function hostileSet(n: number): ProfileSectionPlacement {
  const c: number[] = [];
  const h: number[] = [];
  // Chainage and height that land exactly on each canvas edge under
  // `projection`, so a nudge past one is stated in pixels.
  const chainageAtRightEdge = (CANVAS_W - 40) / 4.5;
  const heightAtBottomEdge = 100 + (CANVAS_H - 30 - CANVAS_H) / 2.75;
  for (let k = 1; k <= n; k++) {
    const mode = k % 9;
    if (mode === 0) {
      c.push(r2x(k) * CHAINAGE_SPAN);
      h.push(Number.NaN);
    } else if (mode === 1) {
      c.push(Number.POSITIVE_INFINITY);
      h.push(HEIGHT_BASE + r2y(k) * HEIGHT_SPAN);
    } else if (mode === 2) {
      // Far right of the canvas.
      c.push(CHAINAGE_SPAN + 50 + r2x(k) * 500);
      h.push(HEIGHT_BASE + r2y(k) * HEIGHT_SPAN);
    } else if (mode === 3) {
      // Above the canvas top, and to the left of x = 0.
      c.push(-40 - r2x(k) * 20);
      h.push(HEIGHT_BASE + HEIGHT_SPAN + 60 + r2y(k) * 90);
    } else if (mode === 4) {
      c.push(r2x(k) * CHAINAGE_SPAN);
      h.push(Number.NEGATIVE_INFINITY);
    } else if (mode === 5) {
      // 0.5 to 5.5 px past the right edge.
      c.push(chainageAtRightEdge + (0.5 + r2x(k) * 5) / 4.5);
      h.push(HEIGHT_BASE + r2y(k) * HEIGHT_SPAN);
    } else if (mode === 6) {
      // 0.5 to 5.5 px below the bottom edge.
      c.push(r2x(k) * CHAINAGE_SPAN);
      h.push(heightAtBottomEdge - (0.5 + r2y(k) * 5) / 2.75);
    } else {
      c.push(r2x(k) * CHAINAGE_SPAN);
      h.push(HEIGHT_BASE + r2y(k) * HEIGHT_SPAN);
    }
  }
  return sectionOf(c, h);
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

describe('profile hit-test index — bucket layout', () => {
  const section = spreadSet(3000);
  const displayed = allDisplayed(section);
  const index = buildProfileHitTestIndex({
    section,
    displayed,
    projection,
    widthPx: CANVAS_W,
    heightPx: CANVAS_H,
  });

  it('is a counting-sort layout in typed arrays', () => {
    expect(index.cellStart).toBeInstanceOf(Uint32Array);
    expect(index.itemX).toBeInstanceOf(Float64Array);
    expect(index.itemY).toBeInstanceOf(Float64Array);
    expect(index.itemId).toBeInstanceOf(Uint32Array);
    expect(index.cellStart.length).toBe(index.cols * index.rows + 1);
    expect(index.cellStart[0]).toBe(0);
    expect(index.cellStart[index.cols * index.rows]).toBe(index.liveCount);
    expect(index.itemId.length).toBe(index.liveCount);
  });

  it('has a non-decreasing prefix sum', () => {
    for (let c = 0; c < index.cols * index.rows; c++) {
      expect(index.cellStart[c + 1]!).toBeGreaterThanOrEqual(index.cellStart[c]!);
    }
  });

  it('places every item in the cell its own coordinates name', () => {
    const { cellSizePx, cols, rows } = index;
    for (let c = 0; c < cols * rows; c++) {
      for (let i = index.cellStart[c]!; i < index.cellStart[c + 1]!; i++) {
        const cx = Math.min(cols - 1, Math.floor(index.itemX[i]! / cellSizePx));
        const cy = Math.min(rows - 1, Math.floor(index.itemY[i]! / cellSizePx));
        expect(cy * cols + cx).toBe(c);
      }
    }
  });

  it('accounts for every displayed point as live or skipped', () => {
    expect(index.liveCount + index.skippedCount).toBe(displayed.length);
    expect(index.skippedCount).toBe(0);
  });

  it('caps the cell count on an implausibly large canvas', () => {
    const huge = buildProfileHitTestIndex({
      section,
      displayed,
      projection,
      widthPx: 4_000_000,
      heightPx: 4_000_000,
      cellSizePx: 1,
    });
    expect(huge.cols * huge.rows).toBeLessThanOrEqual(1 << 20);
    expect(huge.cellSizePx).toBeGreaterThan(1);
  });

  it('reads an affine descriptor the same way as the equivalent function', () => {
    const affine: ProfileAffineProjection = {
      chainageAtOrigin: 0,
      heightAtOrigin: 100,
      originXPx: 40,
      originYPx: CANVAS_H - 30,
      pxPerChainage: 4.5,
      pxPerHeight: 2.75,
    };
    const viaAffine = buildProfileHitTestIndex({
      section,
      displayed,
      projection: affine,
      widthPx: CANVAS_W,
      heightPx: CANVAS_H,
    });
    expect(viaAffine.liveCount).toBe(index.liveCount);
    expect(Array.from(viaAffine.itemId)).toEqual(Array.from(index.itemId));
    expect(Array.from(viaAffine.itemX)).toEqual(Array.from(index.itemX));
    expect(Array.from(viaAffine.itemY)).toEqual(Array.from(index.itemY));
  });
});

// ---------------------------------------------------------------------------
// Nearest, radius, ties
// ---------------------------------------------------------------------------

/** Screen-space identity, so a test can state pixel positions directly. */
const identityProjection: ProfileProjectionFn = (chainage, height, out) => {
  out[0] = chainage;
  out[1] = height;
};

describe('profile hit-test query — nearest and radius', () => {
  it('returns the nearest point by screen distance', () => {
    const section = sectionOf([100, 140, 300], [100, 100, 100]);
    const index = buildProfileHitTestIndex({
      section,
      displayed: allDisplayed(section),
      projection: identityProjection,
      widthPx: 400,
      heightPx: 200,
    });
    expect(queryProfileHitTest(index, 105, 100, 40)).toBe(0);
    expect(queryProfileHitTest(index, 135, 100, 40)).toBe(1);
  });

  it('returns null rather than a far point when nothing is inside the radius', () => {
    const section = sectionOf([100, 300], [100, 100]);
    const index = buildProfileHitTestIndex({
      section,
      displayed: allDisplayed(section),
      projection: identityProjection,
      widthPx: 400,
      heightPx: 200,
    });
    expect(queryProfileHitTest(index, 200, 100, 40)).toBeNull();
    // The same position with a radius that does reach finds the nearer one.
    expect(queryProfileHitTest(index, 200, 100, 101)).toBe(0);
  });

  it('counts a point exactly on the radius as inside', () => {
    const section = sectionOf([100], [100]);
    const index = buildProfileHitTestIndex({
      section,
      displayed: allDisplayed(section),
      projection: identityProjection,
      widthPx: 400,
      heightPx: 200,
    });
    expect(queryProfileHitTest(index, 110, 100, 10)).toBe(0);
    expect(queryProfileHitTest(index, 110, 100, 9.999)).toBeNull();
  });

  it('finds a point in a neighbouring cell, not only in the query cell', () => {
    const section = sectionOf([100], [100]);
    const index = buildProfileHitTestIndex({
      section,
      displayed: allDisplayed(section),
      projection: identityProjection,
      widthPx: 400,
      heightPx: 200,
      cellSizePx: 8,
    });
    // 100 is in column 12; the query at 116 is in column 14, two cells away.
    expect(queryProfileHitTest(index, 116, 100, 20)).toBe(0);
    // And diagonally, across both axes at once.
    expect(queryProfileHitTest(index, 112, 112, 20)).toBe(0);
  });

  it('rejects a non-finite or negative query', () => {
    const section = sectionOf([100], [100]);
    const index = buildProfileHitTestIndex({
      section,
      displayed: allDisplayed(section),
      projection: identityProjection,
      widthPx: 400,
      heightPx: 200,
    });
    expect(queryProfileHitTest(index, Number.NaN, 100, 10)).toBeNull();
    expect(queryProfileHitTest(index, 100, Number.POSITIVE_INFINITY, 10)).toBeNull();
    expect(queryProfileHitTest(index, 100, 100, -1)).toBeNull();
    expect(queryProfileHitTest(index, 100, 100, 0)).toBe(0);
  });
});

describe('profile hit-test query — tie break', () => {
  it('resolves an exact tie to the smaller section index', () => {
    // Two points mirrored about the query x, at the same y. Both offsets are
    // integers exactly representable in float64, so the two squared distances
    // are the same float, not merely close.
    const leftD2 = (190 - 200) * (190 - 200) + (100 - 100) * (100 - 100);
    const rightD2 = (210 - 200) * (210 - 200) + (100 - 100) * (100 - 100);
    expect(Object.is(leftD2, rightD2)).toBe(true);
    expect(leftD2).toBe(100);

    // Section index 3 sits on the right, index 7 on the left, so "smaller
    // index" and "smaller x" disagree and the rule is the only thing that can
    // decide the winner.
    const chainage = [0, 0, 0, 210, 0, 0, 0, 190];
    const heights = [400, 400, 400, 100, 400, 400, 400, 100];
    const section = sectionOf(chainage, heights);

    // Height 400 is off a 200 px canvas, so only 3 and 7 are live.
    const forward = buildProfileHitTestIndex({
      section,
      displayed: Uint32Array.from([3, 7]),
      projection: identityProjection,
      widthPx: 400,
      heightPx: 200,
    });
    const reversed = buildProfileHitTestIndex({
      section,
      displayed: Uint32Array.from([7, 3]),
      projection: identityProjection,
      widthPx: 400,
      heightPx: 200,
    });
    expect(forward.liveCount).toBe(2);
    expect(reversed.liveCount).toBe(2);

    // Confirm the index really is comparing equal distances: both points are
    // inside the radius on their own.
    expect(queryProfileHitTest(forward, 205, 100, 20)).toBe(3);
    expect(queryProfileHitTest(forward, 195, 100, 20)).toBe(7);

    expect(queryProfileHitTest(forward, 200, 100, 20)).toBe(3);
    expect(queryProfileHitTest(reversed, 200, 100, 20)).toBe(3);
  });

  it('resolves coincident points to the smaller section index', () => {
    const section = sectionOf([150, 150, 150], [90, 90, 90]);
    const displayed = Uint32Array.from([2, 0, 1]);
    const index = buildProfileHitTestIndex({
      section,
      displayed,
      projection: identityProjection,
      widthPx: 400,
      heightPx: 200,
    });
    expect(queryProfileHitTest(index, 151, 91, 10)).toBe(0);
  });

  it('gives the same answer whatever order the displayed set arrives in', () => {
    const section = coincidentSet(400);
    const displayed = allDisplayed(section);
    const a = buildProfileHitTestIndex({
      section,
      displayed,
      projection,
      widthPx: CANVAS_W,
      heightPx: CANVAS_H,
    });
    const b = buildProfileHitTestIndex({
      section,
      displayed: permute(displayed),
      projection,
      widthPx: CANVAS_W,
      heightPx: CANVAS_H,
    });
    for (let k = 1; k <= 1200; k++) {
      const x = r2x(k) * CANVAS_W;
      const y = r2y(k) * CANVAS_H;
      expect(queryProfileHitTest(a, x, y, 9)).toBe(queryProfileHitTest(b, x, y, 9));
    }
  });
});

// ---------------------------------------------------------------------------
// Rejection rules
// ---------------------------------------------------------------------------

describe('profile hit-test index — rejection', () => {
  it('never returns a point that projects outside the canvas', () => {
    // One point past the right edge, one above the top, one inside.
    const section = sectionOf([460, 120, 120], [100, -30, 100]);
    const index = buildProfileHitTestIndex({
      section,
      displayed: allDisplayed(section),
      projection: identityProjection,
      widthPx: 400,
      heightPx: 200,
    });
    expect(index.liveCount).toBe(1);
    expect(index.skippedCount).toBe(2);
    expect(Array.from(index.itemId)).toEqual([2]);
    // A hover where the off-canvas point would have been clamped to must not
    // report it.
    expect(queryProfileHitTest(index, 398, 100, 12)).toBeNull();
    expect(queryProfileHitTest(index, 120, 2, 12)).toBeNull();
    expect(queryProfileHitTest(index, 122, 100, 12)).toBe(2);
  });

  it('keeps a point exactly on the far edge, in the last cell', () => {
    const section = sectionOf([400], [200]);
    const index = buildProfileHitTestIndex({
      section,
      displayed: allDisplayed(section),
      projection: identityProjection,
      widthPx: 400,
      heightPx: 200,
      cellSizePx: 16,
    });
    expect(index.liveCount).toBe(1);
    expect(queryProfileHitTest(index, 396, 196, 8)).toBe(0);
  });

  it('skips non-finite projections without disturbing the rest', () => {
    const section = sectionOf(
      [100, Number.NaN, 140, Number.POSITIVE_INFINITY, 180],
      [100, 100, Number.NaN, 100, 100],
    );
    const index = buildProfileHitTestIndex({
      section,
      displayed: allDisplayed(section),
      projection: identityProjection,
      widthPx: 400,
      heightPx: 200,
    });
    expect(index.liveCount).toBe(2);
    expect(index.skippedCount).toBe(3);
    expect(Array.from(index.itemId).sort((p, q) => p - q)).toEqual([0, 4]);
    expect(queryProfileHitTest(index, 101, 100, 10)).toBe(0);
    expect(queryProfileHitTest(index, 141, 100, 10)).toBeNull();
    expect(queryProfileHitTest(index, 179, 100, 10)).toBe(4);
  });

  it('handles an empty displayed set', () => {
    const section = spreadSet(50);
    const index = buildProfileHitTestIndex({
      section,
      displayed: new Uint32Array(0),
      projection,
      widthPx: CANVAS_W,
      heightPx: CANVAS_H,
    });
    expect(index.liveCount).toBe(0);
    expect(index.cellStart[index.cols * index.rows]).toBe(0);
    expect(queryProfileHitTest(index, 100, 100, 50)).toBeNull();
  });

  it('ignores a displayed index past the end of the section', () => {
    const section = sectionOf([100], [100]);
    const index = buildProfileHitTestIndex({
      section,
      displayed: Uint32Array.from([0, 9]),
      projection: identityProjection,
      widthPx: 400,
      heightPx: 200,
    });
    expect(index.liveCount).toBe(1);
    expect(queryProfileHitTest(index, 100, 100, 5)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Differential test against the brute-force reference
// ---------------------------------------------------------------------------

const RADII = [0, 1.5, 4, 7.5, 12, 30];

const DIFFERENTIAL_SETS: readonly { name: string; section: ProfileSectionPlacement }[] = [
  { name: 'spread', section: spreadSet(4000) },
  { name: 'clustered', section: clusteredSet(3000, 12) },
  { name: 'collinear', section: lineSet(1500) },
  { name: 'coincident pairs', section: coincidentSet(600) },
  { name: 'non-finite and off-canvas', section: hostileSet(900) },
  { name: 'single point', section: sectionOf([73.5], [162.25]) },
  { name: 'empty', section: sectionOf([], []) },
];

const QUERIES_PER_SET = 2000;

describe('profile hit-test query — differential against a full scan', () => {
  for (const { name, section } of DIFFERENTIAL_SETS) {
    it(`agrees exactly on ${QUERIES_PER_SET} queries over the ${name} set`, () => {
      const displayed = allDisplayed(section);
      const index = buildProfileHitTestIndex({
        section,
        displayed,
        projection,
        widthPx: CANVAS_W,
        heightPx: CANVAS_H,
      });
      // Queries range 60 px beyond every edge, so the off-canvas and
      // edge-clamped paths are exercised as well as the interior.
      const pad = 60;
      for (let k = 1; k <= QUERIES_PER_SET; k++) {
        const x = -pad + r2x(k) * (CANVAS_W + 2 * pad);
        const y = -pad + r2y(k) * (CANVAS_H + 2 * pad);
        const radius = RADII[k % RADII.length]!;
        const got = queryProfileHitTest(index, x, y, radius);
        const want = bruteForceNearest(
          section,
          displayed,
          projection,
          CANVAS_W,
          CANVAS_H,
          x,
          y,
          radius,
        );
        if (got !== want) {
          throw new Error(
            `${name}: query ${k} at (${x}, ${y}) r=${radius} gave ${got}, full scan gave ${want}`,
          );
        }
      }
      expect(true).toBe(true);
    });
  }

  it('agrees across cell sizes on the clustered set', () => {
    const section = clusteredSet(2500, 9);
    const displayed = allDisplayed(section);
    for (const cellSizePx of [1, 3, 8, 16, 64, 4096]) {
      const index = buildProfileHitTestIndex({
        section,
        displayed,
        projection,
        widthPx: CANVAS_W,
        heightPx: CANVAS_H,
        cellSizePx,
      });
      for (let k = 1; k <= 500; k++) {
        const x = r2x(k) * CANVAS_W;
        const y = r2y(k) * CANVAS_H;
        const radius = RADII[k % RADII.length]!;
        const got = queryProfileHitTest(index, x, y, radius);
        const want = bruteForceNearest(
          section,
          displayed,
          projection,
          CANVAS_W,
          CANVAS_H,
          x,
          y,
          radius,
        );
        if (got !== want) {
          throw new Error(
            `cell ${cellSizePx}: query ${k} at (${x}, ${y}) r=${radius} gave ${got}, full scan gave ${want}`,
          );
        }
      }
    }
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

describe('profile hit-test query — cost', () => {
  const DISPLAYED_COUNT = 200_000;
  const HOVER_RADIUS = 8;
  /**
   * Ceiling on the points one hover may distance-test.
   *
   * 200,000 points on a 960x420 canvas fill a 60x27 grid at the default 16 px
   * pitch, around 123 points per cell. An 8 px radius reaches a 2x2 or 3x3
   * neighbourhood, and 4000 hover positions across the canvas measure a worst
   * case of 598 candidates and a mean of 504. The bound sits above that
   * measurement and 250 times below the 200,000 a full scan tests.
   */
  const CANDIDATE_BOUND = 800;

  const section = spreadSet(DISPLAYED_COUNT);
  const displayed = allDisplayed(section);
  const index = buildProfileHitTestIndex({
    section,
    displayed,
    projection,
    widthPx: CANVAS_W,
    heightPx: CANVAS_H,
  });

  it('tests a small bounded number of candidates per hover', () => {
    expect(index.liveCount).toBeGreaterThan(DISPLAYED_COUNT * 0.9);
    const stats = createProfileHitTestStats();
    let worst = 0;
    let total = 0;
    for (let k = 1; k <= 4000; k++) {
      const x = r2x(k) * CANVAS_W;
      const y = r2y(k) * CANVAS_H;
      queryProfileHitTest(index, x, y, HOVER_RADIUS, stats);
      if (stats.candidatesTested > worst) worst = stats.candidatesTested;
      total += stats.candidatesTested;
    }
    const mean = total / 4000;
    expect(worst).toBeLessThan(CANDIDATE_BOUND);
    expect(mean).toBeLessThan(CANDIDATE_BOUND);
    // Sanity: the query did look at something, so the bound is not passing by
    // finding nothing at all.
    expect(worst).toBeGreaterThan(0);
  });

  it('visits only the cells the radius reaches', () => {
    const stats = createProfileHitTestStats();
    queryProfileHitTest(index, CANVAS_W / 2, CANVAS_H / 2, HOVER_RADIUS, stats);
    const span = Math.ceil((2 * HOVER_RADIUS) / index.cellSizePx) + 1;
    expect(stats.cellsVisited).toBeLessThanOrEqual(span * span);
  });

  it('reports zero candidates when the query cannot reach the canvas', () => {
    const stats = createProfileHitTestStats();
    expect(queryProfileHitTest(index, -500, -500, 4, stats)).toBeNull();
    expect(stats.candidatesTested).toBe(0);
  });
});
