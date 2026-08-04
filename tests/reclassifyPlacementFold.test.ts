/**
 * reclassifyPlacementFold.test.ts
 *
 * The reclassify-lasso, reclassify-polygon and clip kept-count paths edit /
 * count against a layer's RAW `entry.cloud.positions`, which are source-local
 * for a non-anchor mounted layer — while the lasso, the clip box and the
 * rendered cloud all live in the project/render frame. Before the fix those
 * paths saw points at a different place than the screen showed, so a
 * destructive class edit hit the wrong points (or none) and the kept-count
 * disagreed with the rendered cloud (float64-transform.md step 3, the fold
 * picking and the volume lasso already apply).
 *
 * A full Viewer can't be built in Node (it needs a WebGPU/WebGL renderer + a
 * real canvas — see viewerListenerHarness.test.ts), so this pins the extracted
 * projection + clip predicate + kept-count fold against a fixture with a known
 * placement, wiring the SAME production helpers Viewer.reclassifyLasso /
 * reclassifyInPolygon / clipKeptCount now wire. The camera's world→screen map
 * is stood in for by a top-down orthographic projector (screen = project-frame
 * XY), exactly as estimatorPlacementFold.test.ts stands in for the camera.
 *
 * Each property is proved BOTH ways: the folded pipeline edits/counts the
 * points the user actually sees, and the old raw-position pipeline edits/counts
 * a DIFFERENT, wrong set — so the test fails if the fold is ever dropped.
 */

import { describe, it, expect } from 'vitest';
import {
  selectByLasso,
  filterSelectionToVisible,
  type ScreenProjector,
  type Vec2,
} from '../src/render/measure/lassoVolume';
import {
  applyIndexReclassify,
  applyPolygonReclassify,
} from '../src/render/measure/classificationEditor';
import { clipKeepsPoint, countKept, type ClipBox } from '../src/render/clip/clipBox';
import type { BoxBounds } from '../src/render/measure/geometry';
import { accumulatorOffset } from '../src/render/layerPlacement';
import { stridePlacedPositions } from '../src/render/measure/lassoVolumeCompute';
import type { LayerSpatialTransform } from '../src/geo/ProjectSpatialFrame';

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A pure-translation placement — the only shape a v0.6 layer carries. */
function placed(dx: number, dy: number, dz: number): LayerSpatialTransform {
  return {
    sourceOrigin: [0, 0, 0],
    sourceToProject: [dx, dy, dz],
    projectToSource: [-dx, -dy, -dz],
  };
}

/** N interleaved xyz points with exactly-representable coordinates. */
function points(coords: ReadonlyArray<readonly [number, number, number]>): Float32Array {
  const out = new Float32Array(coords.length * 3);
  coords.forEach(([x, y, z], i) => {
    out[i * 3] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z;
  });
  return out;
}

/** Top-down orthographic projector: screen == project-frame XY. Stands in for the camera. */
const topDown: ScreenProjector = (x, y) => ({ x, y });

/** An axis-aligned screen box as a lasso ring. */
function lassoBox(minX: number, maxX: number, minY: number, maxY: number): Vec2[] {
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
}

function clipKeepInside(box: BoxBounds): ClipBox {
  return { box, mode: 'keep-inside', enabled: true };
}

// The scan: four points a unit apart along +X, all initially class 1.
const SRC = points([
  [0, 0, 0],
  [1, 0, 0],
  [2, 0, 0],
  [3, 0, 0],
]);
const ORIG = 1;
const NEW = 6;
// Mounted 2 m east: rendered X becomes 2, 3, 4, 5.
const OFF = placed(2, 0, 0);

function freshClass(): Uint8Array {
  return new Uint8Array(SRC.length / 3).fill(ORIG);
}

// ── The reclassify-lasso pipeline, mirrored both ways ────────────────────────

interface LassoArgs {
  readonly classification: Uint8Array;
  readonly lasso: ReadonlyArray<Vec2>;
  readonly placement: LayerSpatialTransform | null;
  readonly clip: ClipBox | null;
}

/** Folded (fixed) body of Viewer.reclassifyLasso: placement folded into the
 *  projector AND the clip predicate, so both run in the project frame. */
function reclassifyLassoFolded(a: LassoArgs): void {
  const off = accumulatorOffset(a.placement);
  const project: ScreenProjector = (x, y, z) => topDown(x + off[0], y + off[1], z + off[2]);
  const indices = selectByLasso({ lasso: a.lasso, positions: SRC, project });
  const clip = a.clip;
  filterSelectionToVisible(indices, SRC, {
    keepPoint: clip?.enabled
      ? (x, y, z) => clipKeepsPoint(clip, [x + off[0], y + off[1], z + off[2]])
      : undefined,
  });
  applyIndexReclassify(a.classification, indices, NEW);
}

/** Old (buggy) body: projector and clip predicate run on raw source-local coords. */
function reclassifyLassoRaw(a: LassoArgs): void {
  const project: ScreenProjector = (x, y, z) => topDown(x, y, z);
  const indices = selectByLasso({ lasso: a.lasso, positions: SRC, project });
  const clip = a.clip;
  filterSelectionToVisible(indices, SRC, {
    keepPoint: clip?.enabled ? (x, y, z) => clipKeepsPoint(clip, [x, y, z]) : undefined,
  });
  applyIndexReclassify(a.classification, indices, NEW);
}

describe('reclassifyLasso placement fold (projector)', () => {
  // Lasso over screen x∈[1.5,3.5]: the points rendered there are the mounted
  // P0 (x=2) and P1 (x=3). The RAW-frame points at x∈[1.5,3.5] are P2 and P3,
  // rendered off to the right at x=4,5 — a disjoint set.
  const lasso = lassoBox(1.5, 3.5, -1, 1);

  it('folded selection reclassifies exactly the points rendered inside the lasso', () => {
    const cls = freshClass();
    reclassifyLassoFolded({ classification: cls, lasso, placement: OFF, clip: null });
    expect(Array.from(cls)).toEqual([NEW, NEW, ORIG, ORIG]);
  });

  it('the old raw-position path reclassifies a DIFFERENT, wrong set', () => {
    const cls = freshClass();
    reclassifyLassoRaw({ classification: cls, lasso, placement: OFF, clip: null });
    expect(Array.from(cls)).toEqual([ORIG, ORIG, NEW, NEW]);
  });

  it('the folded and raw edits are disjoint — proof the fold changes which points are hit', () => {
    const folded = freshClass();
    const raw = freshClass();
    reclassifyLassoFolded({ classification: folded, lasso, placement: OFF, clip: null });
    reclassifyLassoRaw({ classification: raw, lasso, placement: OFF, clip: null });
    const changed = (before: number, after: Uint8Array) =>
      new Set([...after].flatMap((c, i) => (c !== before ? [i] : [])));
    const foldedIdx = changed(ORIG, folded);
    const rawIdx = changed(ORIG, raw);
    expect([...foldedIdx]).toEqual([0, 1]);
    expect([...rawIdx]).toEqual([2, 3]);
    for (const i of foldedIdx) expect(rawIdx.has(i)).toBe(false);
  });

  it('the anchor (null placement) is unchanged — folded and raw agree', () => {
    const folded = freshClass();
    const raw = freshClass();
    reclassifyLassoFolded({ classification: folded, lasso, placement: null, clip: null });
    reclassifyLassoRaw({ classification: raw, lasso, placement: null, clip: null });
    // With no placement, the rendered frame IS the source frame: P2,P3 sit at x=2,3.
    expect(Array.from(folded)).toEqual([ORIG, ORIG, NEW, NEW]);
    expect(Array.from(folded)).toEqual(Array.from(raw));
  });
});

describe('reclassifyLasso placement fold (clip predicate)', () => {
  // A wide lasso selects every rendered point; a clip box keeps only the two
  // mounted points rendered at x=2,3. The edit must stop at the clip.
  const lasso = lassoBox(1.5, 5.5, -1, 1);
  const clip = clipKeepInside({ min: [1.5, -1, -1], max: [3.5, 1, 1] });

  it('the folded clip predicate restricts the edit to the points visible inside the box', () => {
    const cls = freshClass();
    reclassifyLassoFolded({ classification: cls, lasso, placement: OFF, clip });
    // Rendered X = 2,3,4,5; box keeps 2,3 → P0,P1.
    expect(Array.from(cls)).toEqual([NEW, NEW, ORIG, ORIG]);
  });

  it('the old raw clip predicate keeps the wrong points (source-frame box test)', () => {
    const cls = freshClass();
    reclassifyLassoRaw({ classification: cls, lasso, placement: OFF, clip });
    // Raw X = 0,1,2,3; box[1.5,3.5] keeps raw 2,3 → P2,P3.
    expect(Array.from(cls)).toEqual([ORIG, ORIG, NEW, NEW]);
  });
});

describe('clipKeptCount placement fold', () => {
  // Box keeps rendered X∈[3.5,5.5]: mounted P2 (x=4), P3 (x=5) → 2 kept.
  // Raw X = 0..3 never reaches 3.5 → the old count is 0. Counts differ, so a
  // dropped fold can't hide behind a coincidental match.
  const clip = clipKeepInside({ min: [3.5, -1, -1], max: [5.5, 1, 1] });
  const total = SRC.length / 3;

  it('counts against the PLACED cloud — matches what the box renders', () => {
    const kept = countKept(clip, stridePlacedPositions(SRC, 1, OFF));
    expect({ kept, total }).toEqual({ kept: 2, total: 4 });
  });

  it('the old raw-position count disagrees with the rendered cloud', () => {
    const keptRaw = countKept(clip, SRC);
    expect(keptRaw).toBe(0);
  });

  it('identity placement returns the source buffer untouched (anchor no-op)', () => {
    expect(stridePlacedPositions(SRC, 1, null)).toBe(SRC);
  });
});

describe('reclassifyInPolygon placement fold', () => {
  // Polygon over project-frame x∈[1.5,3.5]: rendered P0 (x=2), P1 (x=3) fall in.
  const polygon: [number, number, number][] = [
    [1.5, -1, 0],
    [3.5, -1, 0],
    [3.5, 1, 0],
    [1.5, 1, 0],
  ];

  it('folded positions reclassify the points rendered inside the polygon', () => {
    const cls = freshClass();
    applyPolygonReclassify({
      classification: cls,
      positions: stridePlacedPositions(SRC, 1, OFF),
      polygon,
      newClass: NEW,
    });
    expect(Array.from(cls)).toEqual([NEW, NEW, ORIG, ORIG]);
  });

  it('the old raw positions reclassify a different, wrong set', () => {
    const cls = freshClass();
    applyPolygonReclassify({
      classification: cls,
      positions: SRC,
      polygon,
      newClass: NEW,
    });
    expect(Array.from(cls)).toEqual([ORIG, ORIG, NEW, NEW]);
  });
});
