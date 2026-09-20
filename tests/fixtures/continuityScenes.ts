/**
 * continuityScenes.ts
 *
 * Deterministic synthetic frames for the continuity visual corpus.
 *
 * A screenshot corpus needs the field wired into a renderer and a device to
 * render on, and neither exists yet. What the defect classes actually need is
 * narrower: a frame of pixels with known depths, known support and known
 * labels, which the pure rules can be run over. Every scene here is built from
 * arithmetic with no randomness, so a failure names a rule rather than a
 * driver.
 *
 * These are scenes rather than cases. Each one is the smallest arrangement of
 * geometry that can produce one of the defects the corpus is looking for, and
 * the grid is kept small enough that a failing frame can be printed and read.
 */
import type { SupportKind } from '../../src/render/continuity/microGap';

export const SCENE_W = 15;
export const SCENE_H = 15;

/** One synthetic frame. Parallel arrays, row-major, `SCENE_W * SCENE_H` long. */
export interface Scene {
  readonly name: string;
  readonly support: SupportKind[];
  readonly depth: number[];
  /** ASPRS-style class per pixel, or 0 where nothing is drawn. */
  readonly classId: number[];
}

const idx = (x: number, y: number): number => y * SCENE_W + x;

interface Builder {
  (x: number, y: number): { support: SupportKind; depth: number; classId?: number };
}


function build(name: string, f: Builder): Scene {
  const support: SupportKind[] = [];
  const depth: number[] = [];
  const classId: number[] = [];
  for (let y = 0; y < SCENE_H; y++) {
    for (let x = 0; x < SCENE_W; x++) {
      const cell = f(x, y);
      support.push(cell.support);
      depth.push(cell.depth);
      classId.push(cell.classId ?? (cell.support === 'none' ? 0 : 2));
    }
  }
  return { name, support, depth, classId };
}

const EMPTY = { support: 'none' as SupportKind, depth: 0 };

/** A flat surface sampled every other pixel: seams a viewer wants closed. */
export const sparseFlatPlane: Scene = build('sparse flat plane', (x, y) =>
  x % 2 === 0 && y % 2 === 0 ? { support: 'direct', depth: 20 } : EMPTY,
);

/** Two surfaces, one well in front of the other, interleaved across the frame. */
export const twoOverlappingDepthPlanes: Scene = build(
  'two overlapping depth planes',
  (x) => ({ support: 'direct', depth: x < SCENE_W / 2 ? 10 : 40 }),
);

/** A foreground block against a far background, with a one-pixel gap at the join. */
export const silhouetteEdge: Scene = build('silhouette edge', (x) => {
  if (x === Math.floor(SCENE_W / 2)) return EMPTY; // the seam at the boundary
  return { support: 'direct', depth: x < SCENE_W / 2 ? 5 : 60 };
});

/** A surface seen almost edge-on: depth climbs steeply across the frame. */
export const verticalFacade: Scene = build('vertical facade', (x, y) =>
  y % 2 === 0 ? { support: 'direct', depth: 10 + x * 4 } : EMPTY,
);

/** A one-pixel-wide column of samples against empty background. */
export const thinPole: Scene = build('thin pole', (x) =>
  x === Math.floor(SCENE_W / 2) ? { support: 'direct', depth: 12 } : EMPTY,
);

/** Scattered samples at unrelated depths: no surface to be found. */
export const vegetation: Scene = build('vegetation', (x, y) => {
  // Deterministic scatter: a fixed pattern, not a random one.
  const on = (x * 7 + y * 13) % 5 === 0;
  return on ? { support: 'direct', depth: 8 + ((x * 3 + y * 5) % 11), classId: 5 } : EMPTY;
});

/**
 * Two planes meeting at a ridge, close in depth and facing opposite ways.
 *
 * The slopes are deliberately unequal. A symmetric ridge puts both sides at
 * one depth, where taking the nearest supporting neighbour and averaging them
 * give the same answer, and a scene that cannot tell those apart cannot notice
 * if one is swapped for the other.
 */
export const ROOF_NEAR_SLOPE = 0.08;
export const ROOF_FAR_SLOPE = 0.12;
export const roofEdge: Scene = build('roof edge', (x) => {
  const c = Math.floor(SCENE_W / 2);
  if (x === c) return EMPTY; // the ridge line itself
  const slope = x < c ? ROOF_NEAR_SLOPE : ROOF_FAR_SLOPE;
  return { support: 'direct', depth: 20 + Math.abs(x - c) * slope, classId: 6 };
});

/** Dense on one side, sparse on the other, one surface throughout. */
export const mixedDensityTerrain: Scene = build('mixed-density terrain', (x, y) => {
  const dense = x < SCENE_W / 2;
  const on = dense ? true : x % 3 === 0 && y % 3 === 0;
  return on ? { support: 'direct', depth: 25 } : EMPTY;
});

/** Depths spanning three orders of magnitude, where a ratio rule must hold. */
export const nearFarDepthRange: Scene = build('near/far depth range', (_x, y) => {
  const near = y < SCENE_H / 2;
  return { support: 'direct', depth: near ? 1.5 : 1500 };
});

/** One flat surface carrying two classes, meeting down the middle. */
export const classificationBoundary: Scene = build('classification boundary', (x) => ({
  support: 'direct',
  depth: 30,
  classId: x < SCENE_W / 2 ? 2 : 6,
}));

/** The corpus, in the order the phase lists it. */
export const CONTINUITY_SCENES: readonly Scene[] = [
  sparseFlatPlane,
  twoOverlappingDepthPlanes,
  silhouetteEdge,
  verticalFacade,
  thinPole,
  vegetation,
  roofEdge,
  mixedDensityTerrain,
  nearFarDepthRange,
  classificationBoundary,
];

/** A cell, with out-of-bounds reading as empty background. */
export function cellAt(scene: Scene, x: number, y: number): { depth: number; support: SupportKind } {
  if (x < 0 || y < 0 || x >= SCENE_W || y >= SCENE_H) return { depth: 0, support: 'none' };
  return { depth: scene.depth[idx(x, y)], support: scene.support[idx(x, y)] };
}

/** A scene printed as one character per pixel, for reading a failure. */
export function render(scene: Scene): string {
  let out = '';
  for (let y = 0; y < SCENE_H; y++) {
    for (let x = 0; x < SCENE_W; x++) {
      const s = scene.support[idx(x, y)];
      out += s === 'none' ? '.' : s === 'reconstructed' ? 'R' : s === 'accumulated' ? 'a' : '#';
    }
    out += '\n';
  }
  return out;
}

export { idx as sceneIndex };
