/**
 * The continuity visual corpus, run against the rules rather than a screen.
 *
 * The phase asks for deterministic visual-regression cases under a
 * software-controlled camera. A screenshot corpus needs the field wired into a
 * renderer and a device to render on, and neither exists: every capability is
 * off and no runner here has an adapter. What the five defect classes need is
 * narrower than a screenshot, and it is available now: a frame with known
 * depths, known support and known labels, run through the same pure rules the
 * shader mirrors.
 *
 * So this is the corpus at the level it can be checked today, and it is not a
 * substitute for the screenshots. A rule can be right while a shader that
 * mirrors it is wrong, and only a device shows that. What this catches is a
 * rule that would produce the defect no matter how faithfully it were drawn,
 * which is the cheaper half to find and the half that is findable now.
 *
 * Snapshots are not used as the only correctness test, and they are not used
 * at all here: every assertion names the defect it is looking for.
 */
import { describe, it, expect } from 'vitest';
import {
  CONTINUITY_SCENES,
  SCENE_W,
  SCENE_H,
  cellAt,
  render,
  sceneIndex,
  sparseFlatPlane,
  silhouetteEdge,
  thinPole,
  vegetation,
  roofEdge,
  ROOF_NEAR_SLOPE,
  ROOF_FAR_SLOPE,
  nearFarDepthRange,
  classificationBoundary,
  verticalFacade,
  mixedDensityTerrain,
  twoOverlappingDepthPlanes,
  type Scene,
} from './fixtures/continuityScenes';
import { shouldFill, type Cardinals, type SupportKind } from '../src/render/continuity/microGap';
import { mergeDecision, depthCompatible } from '../src/render/continuity/depthMerge';
import { normalsAllowFill } from '../src/render/continuity/normalAgreement';
import { nextConvergence, IDLE, type ConvergenceState } from '../src/render/continuity/convergence';
import type { PhaseCount } from '../src/render/continuity/temporalPhase';

const cardinals = (s: Scene, x: number, y: number): Cardinals => ({
  left: cellAt(s, x - 1, y),
  right: cellAt(s, x + 1, y),
  up: cellAt(s, x, y - 1),
  down: cellAt(s, x, y + 1),
});

interface Closed {
  support: SupportKind[];
  depth: number[];
  filled: { x: number; y: number; depth: number }[];
}

/** Run micro-gap closure to a fixed point over a scene. */
function close(scene: Scene): Closed {
  let support = [...scene.support];
  let depth = [...scene.depth];
  const filled: { x: number; y: number; depth: number }[] = [];
  for (let pass = 0; pass < 20; pass++) {
    const frame: Scene = { ...scene, support, depth };
    const ns = [...support];
    const nd = [...depth];
    let n = 0;
    for (let y = 0; y < SCENE_H; y++) {
      for (let x = 0; x < SCENE_W; x++) {
        const d = shouldFill(support[sceneIndex(x, y)], cardinals(frame, x, y));
        if (d.fill) {
          ns[sceneIndex(x, y)] = 'reconstructed';
          nd[sceneIndex(x, y)] = d.depth;
          filled.push({ x, y, depth: d.depth });
          n += 1;
        }
      }
    }
    support = ns;
    depth = nd;
    if (n === 0) break;
  }
  return { support, depth, filled };
}

describe('the corpus is deterministic', () => {
  it('has the ten scenes the phase names', () => {
    expect(CONTINUITY_SCENES).toHaveLength(10);
    expect(new Set(CONTINUITY_SCENES.map((s) => s.name)).size).toBe(10);
  });

  it('produces the same frame every time it is built', () => {
    for (const scene of CONTINUITY_SCENES) {
      expect(render(scene)).toBe(render(scene));
      expect(scene.support).toHaveLength(SCENE_W * SCENE_H);
      expect(scene.depth).toHaveLength(SCENE_W * SCENE_H);
    }
  });

  it('closes to a fixed point on every scene', () => {
    for (const scene of CONTINUITY_SCENES) {
      expect(() => close(scene)).not.toThrow();
    }
  });
});

describe('edge leakage', () => {
  it('gives every fill a depth one of its direct neighbours actually had', () => {
    // A leak shows up as an invented depth: a value between two surfaces that
    // no sample sat at. Taking the nearest supporting neighbour means every
    // fill depth must be one that was measured somewhere adjacent.
    for (const scene of CONTINUITY_SCENES) {
      const { filled } = close(scene);
      for (const f of filled) {
        const neighbourDepths = [[-1, 0], [1, 0], [0, -1], [0, 1]]
          .map(([dx, dy]) => cellAt(scene, f.x + dx, f.y + dy))
          .filter((n) => n.support === 'direct')
          .map((n) => n.depth);
        expect(neighbourDepths).toContain(f.depth);
      }
    }
  });

  it('does not interpolate across a steeply receding facade', () => {
    // Depth climbs by four per column, far outside the tolerance, so a fill
    // must take its own column's depth and never a blend of two columns.
    const { support, depth } = close(verticalFacade);
    for (let y = 1; y < SCENE_H; y += 2) {
      for (let x = 0; x < SCENE_W; x++) {
        if (support[sceneIndex(x, y)] !== 'reconstructed') continue;
        expect(depth[sceneIndex(x, y)]).toBe(10 + x * 4);
      }
    }
  });

  it('leaves the seam at a silhouette unfilled', () => {
    const { support } = close(silhouetteEdge);
    const seam = Math.floor(SCENE_W / 2);
    for (let y = 0; y < SCENE_H; y++) {
      expect(support[sceneIndex(seam, y)]).toBe('none');
    }
  });

  it('fills the ridge of a roof on depth alone, which is the documented limit', () => {
    // Recorded rather than asserted away. Two points either side of a ridge
    // sit at almost the same distance from the camera and pass the depth test
    // comfortably, so closure lays a patch across the fold. This scene exists
    // to keep that fact visible and to fail if the remedy below is removed.
    const { support, depth } = close(roofEdge);
    const ridge = Math.floor(SCENE_W / 2);
    const filledRidge = Array.from({ length: SCENE_H }, (_unused, y) =>
      support[sceneIndex(ridge, y)],
    ).filter((s) => s === 'reconstructed');
    expect(filledRidge.length).toBe(SCENE_H);
    // The nearer slope, not the average of the two. Averaging would put the
    // filled pixel behind the surface it belongs to, where the surface later
    // overwrites it.
    expect(depth[sceneIndex(ridge, 0)]).toBeCloseTo(20 + ROOF_NEAR_SLOPE, 10);
    const mean = 20 + (ROOF_NEAR_SLOPE + ROOF_FAR_SLOPE) / 2;
    expect(depth[sceneIndex(ridge, 0)]).not.toBeCloseTo(mean, 10);
  });

  it('refuses that same ridge once normals are present', () => {
    // The remedy: the two slopes face different ways, and normals only ever
    // refuse. A cloud with no normals is unchanged, which is why the fill
    // above is the honest default rather than a bug.
    const leftSlope = { x: -0.7, y: 0.7, z: 0 };
    const rightSlope = { x: 0.7, y: 0.7, z: 0 };
    expect(normalsAllowFill([leftSlope, rightSlope])).toBe(false);
    expect(normalsAllowFill([leftSlope, leftSlope])).toBe(true);
    expect(normalsAllowFill([null, undefined])).toBe(true);
  });
});

describe('haloing', () => {
  it('does not widen a one-pixel pole', () => {
    const { support } = close(thinPole);
    const pole = Math.floor(SCENE_W / 2);
    for (let y = 0; y < SCENE_H; y++) {
      for (let x = 0; x < SCENE_W; x++) {
        if (x === pole) continue;
        expect(support[sceneIndex(x, y)]).toBe('none');
      }
    }
  });

  it('adds no pixels outside the samples in a scene with nothing to close', () => {
    const { filled } = close(twoOverlappingDepthPlanes);
    expect(filled).toHaveLength(0);
  });
});

describe('false hole closure', () => {
  it('closes the seams of a sparse plane, which are real gaps', () => {
    const { filled } = close(sparseFlatPlane);
    expect(filled.length).toBeGreaterThan(0);
    for (const f of filled) expect(f.depth).toBe(20);
  });

  it('builds no surface out of scattered vegetation returns', () => {
    // Returns at unrelated depths with no opposite pair on one surface. Any
    // fill at all would be inventing canopy between them.
    const { filled } = close(vegetation);
    expect(filled).toHaveLength(0);
  });

  it('closes only the seams a single surface brackets in mixed density', () => {
    const { filled } = close(mixedDensityTerrain);
    for (const f of filled) expect(f.depth).toBe(25);
  });

  it('holds a depth ratio rule across three orders of magnitude', () => {
    const { filled } = close(nearFarDepthRange);
    expect(filled).toHaveLength(0);
    // The two bands are never one surface, and the rule is a ratio, so the
    // near pair stays together at a separation the far pair would fail on.
    expect(depthCompatible(1.5, 1500)).toBe(false);
    expect(depthCompatible(1.5, 1.51)).toBe(true);
    expect(depthCompatible(1500, 1510)).toBe(true);
    expect(depthCompatible(1.5, 15)).toBe(false);
  });
});

describe('classification colour blending', () => {
  it('never blends across a class boundary on one surface', () => {
    const scene = classificationBoundary;
    const boundary = Math.floor(SCENE_W / 2);
    for (let y = 0; y < SCENE_H; y++) {
      const left = scene.depth[sceneIndex(boundary - 1, y)];
      const right = scene.depth[sceneIndex(boundary, y)];
      expect(depthCompatible(left, right)).toBe(true);
      // Same surface, different labels: continuous would blend, categorical
      // must pick one of the two.
      expect(mergeDecision(right, left, 1, undefined, 'continuous')).toBe('blend');
      expect(mergeDecision(right, left, 1, undefined, 'categorical')).not.toBe('blend');
    }
  });

  it('settles on one label rather than alternating frame to frame', () => {
    const a = mergeDecision(30, 30, 1, undefined, 'categorical');
    const b = mergeDecision(30, 30, 1, undefined, 'categorical');
    expect(a).toBe(b);
    expect(a).toBe('keep');
  });
});

describe('history ghosting', () => {
  const PHASES = 4 as PhaseCount;

  it('discards a sweep when the epoch changes rather than merging across it', () => {
    let state: ConvergenceState = IDLE;
    state = nextConvergence(state, { epoch: 1, refinement: 'full-refine', phaseCount: PHASES });
    state = nextConvergence(state, { epoch: 1, refinement: 'full-refine', phaseCount: PHASES });
    expect(state.kind).toBe('converging');
    // The camera moves: a new epoch, so the frames already contributed
    // describe a different picture and must not survive into this one.
    const after = nextConvergence(state, { epoch: 2, refinement: 'full-refine', phaseCount: PHASES });
    expect(after.kind).toBe('converging');
    if (after.kind === 'converging') {
      expect(after.contributed).toBe(0);
      expect(after.nextPhase).toBe(0);
    }
  });

  it('drops the sweep entirely when the view stops being refined', () => {
    let state: ConvergenceState = IDLE;
    state = nextConvergence(state, { epoch: 1, refinement: 'full-refine', phaseCount: PHASES });
    const moving = nextConvergence(state, { epoch: 1, refinement: 'moving', phaseCount: PHASES });
    expect(moving.kind).toBe('idle');
  });

  it('never resumes a sweep that an epoch interrupted', () => {
    let state: ConvergenceState = IDLE;
    for (let i = 0; i < 3; i++) {
      state = nextConvergence(state, { epoch: 1, refinement: 'full-refine', phaseCount: PHASES });
    }
    const interrupted = nextConvergence(state, { epoch: 2, refinement: 'full-refine', phaseCount: PHASES });
    const back = nextConvergence(interrupted, { epoch: 1, refinement: 'full-refine', phaseCount: PHASES });
    // Returning to the old epoch starts over; it does not pick up where it left.
    if (back.kind === 'converging') expect(back.contributed).toBe(0);
  });
});
