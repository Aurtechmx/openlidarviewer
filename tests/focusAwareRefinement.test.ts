/**
 * focusAwareRefinement.test.ts
 *
 * Focus-aware ordering WITHIN a refinement level: during `center-refine` the
 * scheduler prefers nodes that project near the viewed centre, without ever
 * breaking the coarse-first invariant that a shallower node outranks a deeper
 * one. Everything under test is pure — the projection maths, the phase tables,
 * and the phase tracker the Viewer delegates its bookkeeping to.
 */

import { readFileSync } from 'node:fs';
import {
  DEPTH_WEIGHT,
  SIZE_TERM_MAX,
  nodeScore,
  projectedBoxCenterWeight,
} from '../src/render/streaming/streamingScore';
import {
  PHASE_FOCUS_STRENGTH,
  phaseFocusStrength,
  phaseSelectionFactor,
} from '../src/render/refinementPhase';
import { RefinementPhaseTracker } from '../src/render/refinementPhaseState';
import type { Box6 } from '../src/io/copc/copcTypes';

/**
 * A column-major view-projection that maps world XY straight to NDC XY and
 * leaves `w = 1` — the simplest matrix that still exercises the perspective
 * divide path.
 */
const FLAT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** A small box centred on (cx, cy) in the FLAT frame. */
const boxAt = (cx: number, cy: number, half = 0.02): Box6 => [
  cx - half, cy - half, -half, cx + half, cy + half, half,
];

/** Score one node with the focus inputs the scheduler passes. */
function score(bounds: Box6, depth: number, focusStrength: number): number {
  return nodeScore({
    bounds,
    depth,
    cameraPos: [0, 0, 5],
    depthCap: 10,
    focusStrength,
    viewProjection: FLAT,
    viewportWidthPx: 1000,
    viewportHeightPx: 1000,
  });
}

// --- centre weighting --------------------------------------------------------

test('a box straddling the viewport centre gets the maximum centre weight', () => {
  // Geometric centre well off to the right, but the AABB covers (0, 0).
  const w = projectedBoxCenterWeight([-0.1, -0.9, -1, 0.9, 0.1, 1], FLAT, 1000, 1000);
  expect(w).toBe(1);
});

test('centre weight falls off toward the edge', () => {
  const middle = projectedBoxCenterWeight(boxAt(0, 0), FLAT, 1000, 1000);
  const halfway = projectedBoxCenterWeight(boxAt(0.5, 0), FLAT, 1000, 1000);
  const edge = projectedBoxCenterWeight(boxAt(0.98, 0), FLAT, 1000, 1000);
  expect(middle).toBeGreaterThan(halfway);
  expect(halfway).toBeGreaterThan(edge);
  expect(edge).toBeGreaterThanOrEqual(0);
});

test('centre weight is symmetric left/right and top/bottom', () => {
  const left = projectedBoxCenterWeight(boxAt(-0.4, 0), FLAT, 1600, 900);
  const right = projectedBoxCenterWeight(boxAt(0.4, 0), FLAT, 1600, 900);
  expect(left).toBeCloseTo(right, 12);
  const up = projectedBoxCenterWeight(boxAt(0, 0.4), FLAT, 1600, 900);
  const down = projectedBoxCenterWeight(boxAt(0, -0.4), FLAT, 1600, 900);
  expect(up).toBeCloseTo(down, 12);
});

test('an unusable projection or viewport yields the neutral maximum weight', () => {
  const behind = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0];
  expect(projectedBoxCenterWeight(boxAt(0.9, 0.9), behind, 1000, 1000)).toBe(1);
  const nan = FLAT.slice();
  nan[0] = Number.NaN;
  expect(projectedBoxCenterWeight(boxAt(0.9, 0.9), nan, 1000, 1000)).toBe(1);
  expect(projectedBoxCenterWeight(boxAt(0.9, 0.9), FLAT, 0, 1000)).toBe(1);
  expect(projectedBoxCenterWeight(boxAt(0.9, 0.9), FLAT, 1000, Number.NaN)).toBe(1);
  expect(projectedBoxCenterWeight(boxAt(0.9, 0.9), FLAT.slice(0, 8), 1000, 1000)).toBe(1);
});

// --- ordering within a level -------------------------------------------------

/**
 * Two boxes at the SAME distance from the camera — so `projectedSize`, and
 * therefore the unbiased size term, is identical — one on the centre line and
 * one out toward the corner.
 */
const EDGE_Z = 5 - Math.sqrt(25 - 2 * 0.9 * 0.9);
const CENTRE_BOX = boxAt(0, 0);
const EDGE_BOX: Box6 = [
  0.9 - 0.02, 0.9 - 0.02, EDGE_Z - 0.02, 0.9 + 0.02, 0.9 + 0.02, EDGE_Z + 0.02,
];

test('the two comparison boxes project to the same size', () => {
  expect(score(CENTRE_BOX, 4, 0)).toBe(score(EDGE_BOX, 4, 0));
});

test('center-refine orders a centred node above an equal edge node', () => {
  const f = phaseFocusStrength('center-refine');
  expect(score(CENTRE_BOX, 4, f)).toBeGreaterThan(score(EDGE_BOX, 4, f));
});

test('coverage, moving and full-refine apply no centre bias', () => {
  for (const phase of ['moving', 'coverage', 'full-refine'] as const) {
    const f = phaseFocusStrength(phase);
    expect(f).toBe(0);
    expect(score(CENTRE_BOX, 4, f)).toBe(score(EDGE_BOX, 4, f));
  }
});

test('a node with no phase supplied scores exactly as the legacy scorer did', () => {
  const legacy = nodeScore({ bounds: boxAt(0.9, 0.9), depth: 4, cameraPos: [0, 0, 5], depthCap: 10 });
  expect(score(boxAt(0.9, 0.9), 4, 0)).toBe(legacy);
});

test('coarse-first survives every focus weight in [0, 1)', () => {
  for (let f = 0; f < 1; f += 0.01) {
    const shallowEdge = score(boxAt(0.99, 0.99), 3, f);
    const deepCentre = score(boxAt(0, 0), 4, f);
    expect(shallowEdge).toBeGreaterThan(deepCentre);
    expect(Number.isFinite(shallowEdge)).toBe(true);
  }
});

test('the focused size term stays strictly below DEPTH_WEIGHT', () => {
  // A box that fills the view saturates the size term; the depth contribution
  // for depth === depthCap is exactly one DEPTH_WEIGHT, so the whole score must
  // stay under two.
  const huge: Box6 = [-1, -1, -1, 1, 1, 1];
  for (const f of [0, 0.32, 0.99]) {
    const s = nodeScore({
      bounds: huge,
      depth: 10,
      cameraPos: [0, 0, 0.001],
      depthCap: 10,
      focusStrength: f,
      viewProjection: FLAT,
      viewportWidthPx: 1000,
      viewportHeightPx: 1000,
    });
    expect(s - DEPTH_WEIGHT).toBeGreaterThanOrEqual(0);
    expect(s - DEPTH_WEIGHT).toBeLessThanOrEqual(SIZE_TERM_MAX);
    expect(s - DEPTH_WEIGHT).toBeLessThan(DEPTH_WEIGHT);
  }
});

test('a bad projection never poisons the score', () => {
  const s = nodeScore({
    bounds: boxAt(0, 0),
    depth: 4,
    cameraPos: [0, 0, 5],
    depthCap: 10,
    focusStrength: 0.32,
    viewProjection: [Number.NaN, ...FLAT.slice(1)],
    viewportWidthPx: 1000,
    viewportHeightPx: 1000,
  });
  expect(Number.isFinite(s)).toBe(true);
  expect(s).toBeGreaterThan(0);
});

// --- phase tables ------------------------------------------------------------

test('the selection budget grows monotonically across the phases', () => {
  expect(phaseSelectionFactor('moving')).toBeLessThan(phaseSelectionFactor('coverage'));
  expect(phaseSelectionFactor('coverage')).toBeLessThan(phaseSelectionFactor('center-refine'));
  expect(phaseSelectionFactor('center-refine')).toBeLessThan(phaseSelectionFactor('full-refine'));
});

test('only center-refine carries a focus strength, and it is bounded', () => {
  expect(PHASE_FOCUS_STRENGTH['center-refine']).toBeGreaterThan(0);
  for (const v of Object.values(PHASE_FOCUS_STRENGTH)) {
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  }
});

// --- phase bookkeeping is independent of the DPR decision --------------------

test('the tracker advances moving → coverage → center-refine → full-refine', () => {
  const t = new RefinementPhaseTracker();
  expect(t.phase).toBe('moving');
  expect(t.advance({ moving: true, nowMs: 0, readiness: null })).toBe('moving');
  expect(t.advance({ moving: false, nowMs: 10, readiness: null })).toBe('coverage');
  expect(t.advance({ moving: false, nowMs: 10_000, readiness: null })).toBe('full-refine');
  // Any motion drops straight back to coarse.
  expect(t.advance({ moving: true, nowMs: 10_100, readiness: null })).toBe('moving');
});

test('the tracker prefers the readiness verdict over the elapsed-time proxy', () => {
  const t = new RefinementPhaseTracker();
  t.advance({ moving: false, nowMs: 0, readiness: { phase: 'loading' } });
  // Far past both proxy windows, but the verdict says nothing is resident yet.
  expect(t.advance({ moving: false, nowMs: 10_000, readiness: { phase: 'loading' } })).toBe(
    'coverage',
  );
  expect(t.advance({ moving: false, nowMs: 10_016, readiness: { phase: 'settling' } })).toBe(
    'center-refine',
  );
  expect(t.advance({ moving: false, nowMs: 10_032, readiness: { phase: 'settled' } })).toBe(
    'full-refine',
  );
});

test('Viewer advances the phase before the adaptive-DPR early return', () => {
  // §4 regression guard: the phase used to be advanced inside the adaptive-DPR
  // branch, so with `?adaptiveDpr=0` it stayed 'moving' forever. Harmless while
  // nothing else read it; wrong now that the scheduler does.
  const src = readFileSync(new URL('../src/render/Viewer.ts', import.meta.url), 'utf8');
  const advance = src.indexOf('this._phases.advance(');
  const dprGuard = src.indexOf('if (!this._adaptiveDpr');
  expect(advance).toBeGreaterThan(-1);
  expect(dprGuard).toBeGreaterThan(-1);
  expect(advance).toBeLessThan(dprGuard);
  // And exactly one phase state, read by both consumers.
  expect(src).not.toMatch(/schedulerPhase|dprPhase/);
});
