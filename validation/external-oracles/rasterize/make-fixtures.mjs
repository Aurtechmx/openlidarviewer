#!/usr/bin/env node
/**
 * make-fixtures.mjs: build the frozen point clouds for the rasterisation study.
 *
 * Every scene comes from an explicit closed-form surface plus a deterministic
 * pseudo-random scatter, so the fixture is byte-identical on every machine and
 * no dataset licence is involved.
 *
 * One file per scene, `points/<id>.xyz`, and BOTH sides read that same file.
 * GRASS parses it with strtod and the test parses it with Number, so the two
 * legs bin the identical doubles; a second hand-maintained copy would drift and
 * the drift would surface as a disagreement that is really a typo.
 *
 * The point count is chosen so each cell holds about nine returns. That is the
 * whole reason this study exists: with roughly one return per cell a binning
 * comparison degenerates into a test of cell indexing, and mean, min and max
 * all collapse onto the same number.
 *
 * Usage:  node validation/external-oracles/rasterize/make-fixtures.mjs
 */

import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)));
const POINTS = resolve(HERE, 'points');

/** The grid every scene is rasterised on. Origin is the south-west corner. */
const GRID = { originH1: 0, originH2: 0, cols: 40, rows: 40, cellSizeM: 2 };
const EXTENT_H1 = GRID.cols * GRID.cellSizeM;
const EXTENT_H2 = GRID.rows * GRID.cellSizeM;
/** Nine returns per cell on average over 1600 cells. */
const POINT_COUNT = 14400;

/**
 * A 32-bit linear congruential generator, written out rather than imported so
 * the fixture does not depend on a library version. Numerical Recipes' ranqd1
 * constants; the top bits are the ones taken because the low bits of an LCG
 * cycle short.
 */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const TAU = Math.PI * 2;

/**
 * Scene definitions. `surface` is the closed-form ground elevation and `lift`
 * is whatever sits above it for that return, which is what separates min from
 * max inside a single cell.
 */
const SCENES = [
  {
    id: 'R01-tilted-plane',
    why: 'A plane falling in both axes. Within one 2 m cell the surface spans 0.26 m, so mean, min and max are three different numbers and a grid shifted by one cell moves every value.',
    seed: 0x5eed0001,
    surface: (x, y) => 100 + 0.08 * x - 0.05 * y,
    lift: () => 0,
  },
  {
    id: 'R02-rolling-incommensurate',
    why: 'Two wavelengths with no common period, so no translation of the grid maps the surface onto itself and a one-cell error cannot cancel.',
    seed: 0x5eed0002,
    surface: (x, y) => 60 + 3 * Math.sin((TAU * x) / 37) + 2 * Math.cos((TAU * y) / 23),
    lift: () => 0,
  },
  {
    id: 'R03-ridge-with-canopy',
    why: 'A V ridge carrying a canopy on roughly a third of the returns. The within-cell spread reaches several metres, which is where min and max stop being a restatement of the mean and start testing which return each side selected.',
    seed: 0x5eed0003,
    surface: (x, y) => 20 + 0.3 * Math.abs(x - EXTENT_H1 / 2) + 0.1 * y,
    lift: (r, x, y) => (r() < 0.35 ? 2 + 8 * (0.5 + 0.5 * Math.sin((TAU * (x + y)) / 51)) : 0),
  },
  {
    id: 'R04-variable-density',
    why: 'Returns concentrated toward one side so cell occupancy runs from a couple of returns to several dozen. A per-cell reduction that is right at nine returns and wrong at forty fails here and nowhere else.',
    seed: 0x5eed0004,
    surface: (x, y) => 90 + 6 * Math.exp(-((x - 30) ** 2 + (y - 50) ** 2) / 400),
    lift: () => 0,
    // Rejection sampling against this density, normalised to a maximum of 1.
    density: (x) => 0.08 + 0.92 * (x / EXTENT_H1) ** 2,
  },
];

mkdirSync(POINTS, { recursive: true });

const cases = [];
for (const scene of SCENES) {
  const r = lcg(scene.seed);
  const lines = [];
  let placed = 0;
  // A generous but finite draw budget: rejection sampling must terminate even
  // if a density is edited to something very peaked.
  let draws = 0;
  const counts = new Int32Array(GRID.cols * GRID.rows);
  while (placed < POINT_COUNT && draws < POINT_COUNT * 400) {
    draws++;
    const x = r() * EXTENT_H1;
    const y = r() * EXTENT_H2;
    if (scene.density && r() > scene.density(x)) continue;
    const z = scene.surface(x, y) + scene.lift(r, x, y);
    // Round-trip decimal: JS prints the shortest string that reads back as the
    // same double, and strtod on the GRASS side recovers that same double.
    lines.push(`${x},${y},${z}`);
    counts[Math.floor(y / GRID.cellSizeM) * GRID.cols + Math.floor(x / GRID.cellSizeM)]++;
    placed++;
  }

  let filled = 0;
  let maxPerCell = 0;
  for (const c of counts) {
    if (c > 0) filled++;
    if (c > maxPerCell) maxPerCell = c;
  }

  const text = `${lines.join('\n')}\n`;
  writeFileSync(resolve(POINTS, `${scene.id}.xyz`), text);
  cases.push({
    id: scene.id,
    why: scene.why,
    pointsFile: `points/${scene.id}.xyz`,
    pointCount: placed,
    pointsSha256: `sha256:${createHash('sha256').update(text).digest('hex')}`,
    filledCells: filled,
    emptyCells: counts.length - filled,
    meanPointsPerFilledCell: placed / filled,
    maxPointsInOneCell: maxPerCell,
  });
}

const fixtures = {
  schemaVersion: 1,
  generatedBy: 'validation/external-oracles/rasterize/make-fixtures.mjs',
  grid: GRID,
  separator: 'comma',
  columns: 'x,y,z',
  note: 'Grid origin is the south-west corner. Row 0 of a candidate raster is the SOUTHERNMOST row; GRASS ASCII output starts at the north, so one side is flipped when the two are compared.',
  cases,
};

writeFileSync(resolve(HERE, 'fixtures.json'), `${JSON.stringify(fixtures, null, 2)}\n`);

console.log(`make-fixtures: ${cases.length} scene(s) on a ${GRID.cols}x${GRID.rows} grid of ${GRID.cellSizeM} m cells`);
for (const c of cases) {
  console.log(
    `  ${c.id.padEnd(26)} ${String(c.pointCount).padStart(6)} pts   ${c.filledCells}/${GRID.cols * GRID.rows} cells filled   mean ${c.meanPointsPerFilledCell.toFixed(2)} pts/cell   max ${c.maxPointsInOneCell}`,
  );
}
