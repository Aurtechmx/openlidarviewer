#!/usr/bin/env node
/**
 * generate-observatory-fixtures.mjs — deterministic analytic scenes for
 * Observatory (docs/observatory/SPEC.md §9.1), at the level O1 needs: F1's
 * geometry (consumed starting the ray builder, O3) and F8's DDA cases
 * (consumed by validation/observatory/oracle/ray_aabb_traversal.py now, and
 * by the TypeScript DDA itself starting O4).
 *
 * Every coordinate F8 emits is an exact dyadic rational (a small multiple of
 * a power of two) relative to the declared voxel edge, so the oracle's
 * rational-stepping traversal never has to round: a "grazing corner" case
 * lands ON the corner in Float64 by construction, not by luck.
 *
 * Pure functions (`buildF1Scene`, `buildF8Cases`) are exported for
 * tests/observatoryFixtureF8.test.ts to call directly, so "the fixture
 * generator's inputs" in that test means this module's actual return value,
 * not a second transcription of it. The CLI below writes that same value to
 * validation/observatory/fixtures/, which is what the Python oracle reads.
 *
 *   node scripts/generate-observatory-fixtures.mjs --write
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isCliEntry } from './lib/isCliEntry.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES_DIR = join(ROOT, 'validation', 'observatory', 'fixtures');

/**
 * F1: one station, a wall in front of an open room (SPEC §9.1). Geometry
 * only — O1 does not score F1's pass condition (states, shadow), which
 * belongs to O5. The angular extent deliberately leaves a region above the
 * declared elevation band unaddressed, which is F1's own "outside the
 * angular extent" clause for the phase that scores it.
 */
export function buildF1Scene() {
  return {
    id: 'F1',
    description: 'One station, wall in front of an open room, room behind the wall.',
    station: {
      id: 'station-1',
      origin: [0, 0, 0],
      status: 'DECLARED',
    },
    angularExtent: {
      azimuthDeg: [0, 360],
      elevationDeg: [-30, 45],
    },
    wall: {
      // A rectangular slab, thin along X, spanning Y and Z.
      minCorner: [5, -2, 0],
      maxCorner: [5.2, 2, 3],
    },
    room: {
      // The open volume behind the wall.
      minCorner: [5.2, -5, 0],
      maxCorner: [15, 5, 5],
    },
    domain: {
      // The ROI voxelised for the evidence ledger; encloses the station, the
      // wall and the room with margin on every side.
      minCorner: [-1, -6, -1],
      maxCorner: [16, 6, 6],
    },
    voxelEdge: 0.5,
  };
}

/**
 * F8: the four DDA cases SPEC §9.1 names, on a shared 4x4x4 voxel grid
 * (voxel edge 1, domain [0,4]^3), so a reader can compare cases directly. Each
 * ray is given as `origin` + raw `direction` (not normalised — the oracle
 * steps in parameter `t` along this vector using exact rational arithmetic,
 * which needs the vector's components to be rational, not unit length) plus
 * an explicit `tMax` when the ray's own extent, not the domain clip, decides
 * where traversal stops.
 */
export function buildF8Cases() {
  const domain = { minCorner: [0, 0, 0], maxCorner: [4, 4, 4] };
  const voxelEdge = 1;
  return {
    domain,
    voxelEdge,
    tieRule:
      'OB-LED-01: a coordinate exactly on a voxel boundary belongs to the voxel on the POSITIVE '
      + 'side of that boundary along that axis alone — the half-open interval [i*h, (i+1)*h) that '
      + 'already indexes every voxel, applied per axis independently. A ray grazing a shared corner '
      + 'or edge is resolved by applying this same per-axis rule on each axis at once; no separate '
      + 'corner or edge rule exists.',
    cases: [
      {
        id: 'F8-axis-aligned',
        description: 'A ray parallel to +X, held at cell-centre Y and Z so it never meets a Y or Z boundary.',
        origin: [0.5, 1.5, 2.5],
        direction: [1, 0, 0],
        tMax: 3,
      },
      {
        id: 'F8-along-face',
        description: 'A ray parallel to +X running exactly on the Y=1 face shared by the y=0 and y=1 voxel rows.',
        origin: [0.5, 1, 2.5],
        direction: [1, 0, 0],
        tMax: 3,
      },
      {
        id: 'F8-grazing-corner',
        description:
          'A diagonal ray in X and Y (Z held at cell-centre) that passes exactly through the '
          + 'corner shared by four voxels at (1, 1, z).',
        origin: [0.5, 0.5, 0.5],
        direction: [1, 1, 0],
        tMax: 2.5,
      },
      {
        id: 'F8-zero-length',
        description: 'A ray whose declared extent is zero, entirely inside one voxel.',
        origin: [1.5, 1.5, 1.5],
        direction: [1, 0, 0],
        tMax: 0,
      },
    ],
  };
}

/**
 * F5: a PTX-shaped grid whose top row is `0 0 0` sky samples (SPEC §9.1,
 * O3's ray-level slice). Ray-level pass condition: a sky cell's ray is a
 * returned ray with `NaN` range, never a not-read ray and never "no ray"
 * (`docs/observatory/SPEC.md` OB-RAY-01, `NO_RETURN` gives a no-return ray).
 */
export function buildF5Scene() {
  return {
    id: 'F5',
    description: 'PTX grid with declared 0 0 0 sky cells: NO_RETURN rays, never OBSERVED_EMPTY.',
    sourceKind: 'ptx-grid',
    width: 4,
    height: 3,
    station: { id: 'block-1', origin: [0, 0, 0] },
    coverage: { azimuth0: 0, azimuthStep: 0.2, polar0: 0.3, polarStep: 0.25 },
    // Row-major [row, column] pairs; every other cell is a valid return.
    noReturnCells: [
      [0, 0],
      [0, 1],
      [0, 2],
      [0, 3],
    ],
  };
}

/**
 * F6: a structured-E57-shaped grid decoded at a stride, so every cell off the
 * stride is `NOT_DECODED` (`structuredFrames.ts` — only structured E57 fills
 * `NOT_DECODED` for a strided-away cell; PTX and PCD have no stride
 * mechanism). Ray-level pass condition: a `NOT_DECODED` cell's ray is a
 * not-read ray, never a returned one.
 */
export function buildF6Scene() {
  return {
    id: 'F6',
    description: 'Structured-E57 grid decoded at a stride: skipped cells give a not-read ray, never a returned one.',
    sourceKind: 'e57-structured',
    width: 4,
    height: 4,
    station: { id: 'scan-1', origin: [1, 2, 3] },
    coverage: { azimuth0: 0.1, azimuthStep: 0.15, polar0: 0.4, polarStep: 0.2 },
    // A cell is NOT_DECODED when row % stride !== 0 || column % stride !== 0.
    stride: 2,
  };
}

/**
 * F16: a structured-E57-shaped canopy, four cells each declaring one to three
 * ordered returns at increasing range (first return nearest the canopy top),
 * on exactly representable coordinates (F8's dyadic-rational style, so no
 * oracle needs floating rounding tolerance). Ray-level pass condition: one
 * ray per cell, not one per return; the ray's own range is the first
 * (smallest-`returnIndex`) return.
 */
export function buildF16Scene() {
  return {
    id: 'F16',
    description: 'Structured-E57 canopy: a multi-return cell contributes one ray, not one per return.',
    sourceKind: 'e57-structured',
    width: 2,
    height: 2,
    station: { id: 'scan-1', origin: [0, 0, 10] },
    coverage: { azimuth0: 0, azimuthStep: 0.3, polar0: 1.4, polarStep: 0.1 },
    cells: [
      {
        row: 0,
        column: 0,
        returns: [
          { returnIndex: 0, range: 8 },
          { returnIndex: 1, range: 8.5 },
        ],
      },
      { row: 0, column: 1, returns: [{ returnIndex: 0, range: 7.25 }] },
      {
        row: 1,
        column: 0,
        returns: [
          { returnIndex: 0, range: 6 },
          { returnIndex: 1, range: 6.5 },
          { returnIndex: 2, range: 9 },
        ],
      },
      { row: 1, column: 1, returns: [{ returnIndex: 0, range: 5.5 }] },
    ],
  };
}

/**
 * F2: F1's own wall-and-room scene plus a second station placed inside the
 * room, looking back through the wall's far face (SPEC §9.1: "F1 plus a
 * second station behind the wall"). O5's own exit evidence, not O1/O3/O4's:
 * this scene is not scored until phase O5 has a state classifier to score it
 * with. `angularExtent` is a full sphere so station 2's own view is never the
 * thing that produces `UNADDRESSED` in this fixture; F1's own station keeps
 * its declared, narrower band.
 */
export function buildF2Scene() {
  const f1 = buildF1Scene();
  return {
    ...f1,
    id: 'F2',
    description: 'F1 plus a second station behind the wall, inside the room, looking back through it.',
    stations: [
      f1.station,
      {
        id: 'station-2',
        origin: [10, 0, 1],
        status: 'DECLARED',
        angularExtent: { azimuthDeg: [0, 360], elevationDeg: [-89, 89] },
      },
    ],
  };
}

/**
 * F3: a box present in station A's scan and absent in station B's — SPEC
 * §9.1's own reading of `CONFLICT` (SPEC §2.3): the SAME voxels, seen by two
 * declared stations, where A's rays return from the box's near face (solid,
 * `f >= p_solid`) and B's rays — aimed through the same voxels from the
 * opposite side — pass straight through with no return at all (confidently
 * empty, `f <= p_empty`), modelling an object present when A scanned and
 * removed, or never there, when B scanned. Declared here as geometry only;
 * `tests/observatoryFixturesO5.test.ts` builds each station's own ray set
 * against this box directly (A's rays clip to the box's own AABB the way
 * F1's wall clips `buildF9RaySet`'s rays; B's rays are given the box's own
 * domain as fully transparent, i.e. never clipped), and OB-ST-THRESHOLDS'
 * `n_min = 5` sets how many rays of each kind a voxel needs before this
 * phase's classifier trusts either side.
 */
export function buildF3Scene() {
  return {
    id: 'F3',
    description: "A box present in station A's scan, absent in station B's: CONFLICT, both sources listed.",
    stationA: { id: 'station-A', origin: [0, 0, 1], status: 'DECLARED', angularExtent: { azimuthDeg: [0, 360], elevationDeg: [-45, 45] } },
    stationB: { id: 'station-B', origin: [12, 0, 1], status: 'DECLARED', angularExtent: { azimuthDeg: [0, 360], elevationDeg: [-45, 45] } },
    box: { minCorner: [5, -1, 0], maxCorner: [7, 1, 2] },
    domain: { minCorner: [-1, -4, -1], maxCorner: [13, 4, 4] },
    voxelEdge: 0.5,
  };
}

/**
 * F7: an unaddressed pocket — a region strictly beyond the single declared
 * station's declared maximum range, inside the ROI domain otherwise (SPEC
 * §9.1: "Unaddressed pocket -> `UNADDRESSED`, not `SHADOWED`"). Distinct from
 * F1's own "outside the elevation band" unaddressed region: here the pocket
 * sits squarely inside the station's angular band, and is excluded only by
 * `maxRange`, so it carries no `behind` evidence at all (a ray never reaches
 * a voxel past where its own declared range window ends) — the case
 * `SHADOWED` could otherwise be confused with, since both have zero hit and
 * pass evidence.
 */
export function buildF7Scene() {
  return {
    id: 'F7',
    description: 'A pocket beyond the declared maximum range: UNADDRESSED, not SHADOWED (no behind-evidence at all).',
    station: { id: 'station-1', origin: [0, 0, 1], status: 'DECLARED', angularExtent: { azimuthDeg: [0, 360], elevationDeg: [-10, 10] }, maxRange: 5 },
    pocket: { minCorner: [8, -1, 0], maxCorner: [10, 1, 2] },
    domain: { minCorner: [-1, -4, -1], maxCorner: [11, 4, 4] },
    voxelEdge: 0.5,
  };
}

if (isCliEntry(import.meta.url)) {
  const write = process.argv.includes('--write');
  if (!write) {
    console.error('usage: node scripts/generate-observatory-fixtures.mjs --write');
    process.exit(1);
  }
  mkdirSync(FIXTURES_DIR, { recursive: true });
  const f1 = buildF1Scene();
  const f8 = buildF8Cases();
  const f5 = buildF5Scene();
  const f6 = buildF6Scene();
  const f16 = buildF16Scene();
  const f2 = buildF2Scene();
  const f3 = buildF3Scene();
  const f7 = buildF7Scene();
  writeFileSync(join(FIXTURES_DIR, 'f1-wall-room.json'), `${JSON.stringify(f1, null, 2)}\n`);
  writeFileSync(join(FIXTURES_DIR, 'f8-dda-cases.json'), `${JSON.stringify(f8, null, 2)}\n`);
  writeFileSync(join(FIXTURES_DIR, 'f5-sky-noreturn.json'), `${JSON.stringify(f5, null, 2)}\n`);
  writeFileSync(join(FIXTURES_DIR, 'f6-strided-notread.json'), `${JSON.stringify(f6, null, 2)}\n`);
  writeFileSync(join(FIXTURES_DIR, 'f16-multireturn-canopy.json'), `${JSON.stringify(f16, null, 2)}\n`);
  writeFileSync(join(FIXTURES_DIR, 'f2-second-station.json'), `${JSON.stringify(f2, null, 2)}\n`);
  writeFileSync(join(FIXTURES_DIR, 'f3-conflict-box.json'), `${JSON.stringify(f3, null, 2)}\n`);
  writeFileSync(join(FIXTURES_DIR, 'f7-unaddressed-pocket.json'), `${JSON.stringify(f7, null, 2)}\n`);
  console.log(`generate-observatory-fixtures: wrote f1-wall-room.json and f8-dda-cases.json (${f8.cases.length} F8 case(s))`);
  console.log('generate-observatory-fixtures: wrote f5-sky-noreturn.json, f6-strided-notread.json, f16-multireturn-canopy.json');
  console.log('generate-observatory-fixtures: wrote f2-second-station.json, f3-conflict-box.json, f7-unaddressed-pocket.json');
}
