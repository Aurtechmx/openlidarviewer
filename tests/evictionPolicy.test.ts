/**
 * evictionPolicy.test.ts — the pure eviction-side hysteresis rule.
 *
 * These tests are the contract for the decision logic behind the residual
 * budget-boundary flicker ("regions pulsing"): a resident, visible node must
 * not be dropped for a marginal budget overshoot, and the nodes that are cheap
 * to lose — out of view, farther, superseded by detail arriving below them —
 * must go first.
 *
 * The second block is the load-bearing one. An earlier ADMISSION-side attempt
 * at this froze the level of detail: the protection it gave a resident node
 * became a veto, so nothing ever yielded and the scene stopped refining. Every
 * test here that asserts a node is protected is paired with one that asserts
 * the protection can always be overridden, so hysteresis stays a preference and
 * never becomes a veto.
 */

import { describe, it, expect } from 'vitest';
import {
  planEviction,
  evictionRank,
  resolveEvictionHysteresis,
  DEFAULT_EVICTION_HYSTERESIS,
  type EvictionCandidate,
  type EvictionHysteresis,
} from '../src/render/streaming/evictionPolicy';

/** A resident, visible, wanted, long-settled node — the hardest to evict. */
function cand(id: string, over: Partial<EvictionCandidate> = {}): EvictionCandidate {
  return {
    id,
    pointCount: 1_000,
    depth: 3,
    distance: 10,
    visible: true,
    wanted: true,
    supersededByFiner: false,
    residentSinceMs: 0,
    ...over,
  };
}

/** Total points across a candidate set. */
function total(cs: readonly EvictionCandidate[]): number {
  return cs.reduce((n, c) => n + c.pointCount, 0);
}

const H = DEFAULT_EVICTION_HYSTERESIS;
/** A wall-clock instant well past the dwell window for a node resident at 0. */
const SETTLED = H.minVisibleDwellMs * 10;

// --- 1. The flicker case ----------------------------------------------------

describe('a node oscillating at the budget boundary is not churned', () => {
  it('plans no eviction at all while the overshoot stays inside the margin', () => {
    const budget = 100_000;
    // Just past the budget, but nowhere near the trigger margin.
    for (const ratio of [1.0, 1.05, 1.2, 1.4, 1.49]) {
      const plan = planEviction({
        candidates: [cand('a'), cand('b'), cand('c')],
        residentPointCount: Math.round(budget * ratio),
        pointBudget: budget,
        nowMs: SETTLED,
      });
      expect(plan.evict).toEqual([]);
      expect(plan.brokeDwell).toBe(false);
    }
  });

  it('never evicts the boundary node across many ticks of wanted-flag noise', () => {
    // The flicker: score noise flips one node in and out of the wanted set on
    // successive ticks while the resident total wobbles a couple of percent
    // around the budget. Before the fix each flip could cost an evict and a
    // re-admit, and every re-admit costs a re-fade.
    const budget = 1_000_000;
    const boundary = 'boundary';
    let evictions = 0;
    for (let tick = 0; tick < 200; tick++) {
      // ±2 % of noise around the budget, and the boundary node's wanted flag
      // flips every tick.
      const wobble = 1 + (tick % 5) * 0.01 - 0.02;
      const plan = planEviction({
        candidates: [
          cand(boundary, { wanted: tick % 2 === 0, residentSinceMs: 0 }),
          cand('near', { distance: 1 }),
          cand('far', { distance: 500 }),
        ],
        residentPointCount: Math.round(budget * wobble),
        pointBudget: budget,
        nowMs: SETTLED + tick * 16,
      });
      if (plan.evict.includes(boundary)) evictions += 1;
    }
    expect(evictions).toBe(0);
  });

  it('stops inside the band instead of cutting all the way to the budget', () => {
    // The other half of the churn. Releasing down to the budget itself left the
    // resident set exactly where the next selection would ask most of it back,
    // so every pressure run bought another round of decode and fade. The plan
    // stops as soon as it is inside the band and no sooner.
    const budget = 10_000;
    const candidates = Array.from({ length: 40 }, (_, i) =>
      cand(`n${i}`, { pointCount: 500, visible: false, wanted: false, distance: i }),
    );
    const plan = planEviction({
      candidates,
      residentPointCount: 20_000,
      pointBudget: budget,
      nowMs: SETTLED,
    });
    expect(plan.projectedResidentPoints).toBeGreaterThan(budget);
    expect(plan.projectedResidentPoints).toBeLessThanOrEqual(budget * H.releaseRatio);
  });

  it('leaves the boundary node alone even under pressure while cheaper nodes exist', () => {
    const budget = 3_000;
    // 6 000 resident points against a 3 000 budget: pressure is real. The two
    // out-of-view nodes cover the whole overshoot, so the visible boundary node
    // is never reached.
    const plan = planEviction({
      candidates: [
        cand('boundary', { pointCount: 1_500, visible: true, wanted: false }),
        cand('offscreen-far', { pointCount: 1_500, visible: false, distance: 900 }),
        cand('offscreen-near', { pointCount: 1_500, visible: false, distance: 5 }),
        cand('onscreen', { pointCount: 1_500 }),
      ],
      residentPointCount: 6_000,
      pointBudget: budget,
      nowMs: SETTLED,
    });
    expect(plan.evict).toEqual(['offscreen-far', 'offscreen-near']);
    expect(plan.evict).not.toContain('boundary');
  });
});

// --- 2. The LOD-freeze regression guard (the important one) -----------------

describe('a node being refined away stays fully evictable', () => {
  it('evicts a resident, visible, freshly-arrived node when finer detail is arriving below it', () => {
    // Every protection this policy grants is off for this node: it is visible,
    // it is wanted, and it became resident this instant, so the dwell window
    // has not begun to elapse. It must still be evicted, first, because the
    // detail replacing it is already on its way.
    const plan = planEviction({
      candidates: [
        cand('parent', {
          supersededByFiner: true,
          visible: true,
          wanted: true,
          residentSinceMs: SETTLED,
        }),
        cand('settled-sibling', { residentSinceMs: 0 }),
      ],
      residentPointCount: 4_000,
      pointBudget: 2_000,
      nowMs: SETTLED,
    });
    expect(plan.evict[0]).toBe('parent');
    // And it did not need the dwell-breaking second pass to get there.
    expect(plan.brokeDwell).toBe(false);
  });

  it('never leaves a superseded node in the protected bottom band', () => {
    const superseded = cand('s', { supersededByFiner: true, visible: true, wanted: true });
    const offscreen = cand('o', { visible: false, wanted: false });
    const unwanted = cand('u', { visible: true, wanted: false });
    const onscreen = cand('w', { visible: true, wanted: true });
    // A superseded node always outranks a plain on-screen selected node, so
    // hysteresis can never hold the budget refinement is queued against.
    expect(evictionRank(superseded)).toBeGreaterThan(evictionRank(onscreen));
    // It stays below the two cheap classes: shedding an off-screen region frees
    // the same budget for the same refinement without touching coverage.
    expect(evictionRank(offscreen)).toBeGreaterThan(evictionRank(unwanted));
    expect(evictionRank(unwanted)).toBeGreaterThan(evictionRank(superseded));
  });

  it('sheds an off-screen region before a coarse node whose children are arriving', () => {
    // The camera has just moved: the region behind is out of frustum and the
    // coarse node in front is superseded by children still loading. Blanking
    // the coverage in front would be a worse artefact than the flicker this
    // policy exists to remove, so the off-screen region goes instead.
    const plan = planEviction({
      candidates: [
        cand('coverage-in-front', {
          pointCount: 1_000,
          supersededByFiner: true,
          visible: true,
          wanted: true,
        }),
        cand('region-behind', { pointCount: 1_000, visible: false, wanted: false }),
      ],
      residentPointCount: 2_000,
      pointBudget: 1_000,
      nowMs: SETTLED,
    });
    expect(plan.evict).toEqual(['region-behind']);
  });

  it('never dwell-protects a superseded node, at any residency age', () => {
    for (const age of [0, 1, 10, H.minVisibleDwellMs - 1]) {
      const plan = planEviction({
        candidates: [
          cand('fresh-superseded', {
            supersededByFiner: true,
            residentSinceMs: SETTLED - age,
          }),
          cand('fresh-plain', { residentSinceMs: SETTLED - age }),
        ],
        // Trigger at 3 000, release target 2 300: dropping the superseded node
        // alone clears it, so the dwell-breaking pass is never reached.
        residentPointCount: 3_200,
        pointBudget: 2_000,
        nowMs: SETTLED,
      });
      expect(plan.evict).toEqual(['fresh-superseded']);
      expect(plan.brokeDwell).toBe(false);
    }
  });

  it('frees room for pending refinement instead of holding the resident set full', () => {
    // The eviction-side shape of the LOD freeze: hysteresis holds every
    // resident node, the resident total never falls, and the scheduler's
    // dispatch gate refuses to start the decode of any finer node, so the
    // scene stops refining. Whatever the protections say, a pressured plan
    // must release points.
    const candidates = [
      cand('a', { pointCount: 900, residentSinceMs: SETTLED }),
      cand('b', { pointCount: 900, residentSinceMs: SETTLED }),
      cand('c', { pointCount: 900, residentSinceMs: SETTLED }),
      cand('d', { pointCount: 900, residentSinceMs: SETTLED }),
    ];
    const plan = planEviction({
      candidates,
      residentPointCount: total(candidates),
      pointBudget: 1_800,
      nowMs: SETTLED,
    });
    expect(plan.releasedPoints).toBeGreaterThan(0);
    expect(plan.projectedResidentPoints).toBeLessThanOrEqual(1_800 * H.releaseRatio);
    // It had to break dwell to get there, and it says so.
    expect(plan.brokeDwell).toBe(true);
  });
});

// --- 3. Preference order ----------------------------------------------------

describe('cheap-to-lose nodes are evicted before resident visible ones', () => {
  it('takes out-of-view before in-view, and unwanted before wanted', () => {
    const plan = planEviction({
      candidates: [
        cand('onscreen-wanted', { pointCount: 1_000 }),
        cand('onscreen-unwanted', { pointCount: 1_000, wanted: false }),
        cand('offscreen', { pointCount: 1_000, visible: false, wanted: false }),
      ],
      residentPointCount: 3_000,
      // Trigger at 1.5 × 1 000 = 1 500; release target 1 150, so two must go.
      pointBudget: 1_000,
      nowMs: SETTLED,
    });
    expect(plan.evict).toEqual(['offscreen', 'onscreen-unwanted']);
  });

  it('within one class takes the deeper node, then the farther one', () => {
    const plan = planEviction({
      candidates: [
        cand('shallow-far', { depth: 1, distance: 900, visible: false, wanted: false }),
        cand('deep-near', { depth: 9, distance: 1, visible: false, wanted: false }),
        cand('deep-far', { depth: 9, distance: 900, visible: false, wanted: false }),
      ],
      residentPointCount: 3_000,
      pointBudget: 1_000,
      nowMs: SETTLED,
    });
    // Deepest first; within a depth, farthest first. Same ordering the
    // scheduler's lapsed-eviction pass already uses.
    expect(plan.evict).toEqual(['deep-far', 'deep-near']);
  });

  it('protects a freshly-arrived visible node in favour of a settled one', () => {
    const plan = planEviction({
      candidates: [
        cand('just-faded-in', { wanted: false, residentSinceMs: SETTLED - 10 }),
        cand('long-settled', { wanted: false, residentSinceMs: 0 }),
      ],
      // Trigger at 1 500, release target 1 150: one of the two has to go, and
      // the policy picks the one that has been on screen long enough to settle.
      residentPointCount: 2_000,
      pointBudget: 1_000,
      nowMs: SETTLED,
    });
    expect(plan.evict).toEqual(['long-settled']);
  });
});

// --- 4. The budget is still respected --------------------------------------

describe('hysteresis is a preference, never a veto', () => {
  it('reaches the release target even when every candidate is dwell-protected', () => {
    const candidates = Array.from({ length: 20 }, (_, i) =>
      cand(`n${i}`, { pointCount: 500, residentSinceMs: SETTLED }),
    );
    const plan = planEviction({
      candidates,
      residentPointCount: 10_000,
      pointBudget: 2_000,
      nowMs: SETTLED,
    });
    expect(plan.projectedResidentPoints).toBeLessThanOrEqual(2_000 * H.releaseRatio);
    expect(plan.brokeDwell).toBe(true);
  });

  it('keeps the resident set bounded across a long run of pressured ticks', () => {
    // Drive the policy the way the scheduler does: admit up to the budget each
    // tick, plan, apply. The resident total must not drift upward.
    const budget = 10_000;
    let resident = 0;
    let nextId = 0;
    let live: EvictionCandidate[] = [];
    let peak = 0;
    for (let tick = 0; tick < 300; tick++) {
      const nowMs = tick * 16;
      // Admission keeps pushing: three new nodes per tick, freshly resident and
      // visible, which is the worst case for a dwell rule.
      for (let k = 0; k < 3; k++) {
        live.push(
          cand(`n${nextId++}`, {
            pointCount: 800,
            residentSinceMs: nowMs,
            visible: true,
            wanted: k === 0,
            distance: (nextId % 17) * 10,
            depth: nextId % 7,
          }),
        );
        resident += 800;
      }
      peak = Math.max(peak, resident);
      const plan = planEviction({
        candidates: live,
        residentPointCount: resident,
        pointBudget: budget,
        nowMs,
      });
      const dropped = new Set(plan.evict);
      live = live.filter((c) => !dropped.has(c.id));
      resident -= plan.releasedPoints;
      expect(resident).toBe(total(live));
    }
    // Bounded by the trigger margin plus one tick of admissions — never
    // unbounded growth.
    expect(peak).toBeLessThanOrEqual(budget * H.triggerRatio + 3 * 800);
    expect(resident).toBeLessThanOrEqual(budget * H.triggerRatio);
  });

  it('a zero or negative budget still yields a finite, sane plan', () => {
    const plan = planEviction({
      candidates: [cand('a'), cand('b')],
      residentPointCount: 2_000,
      pointBudget: 0,
      nowMs: SETTLED,
    });
    expect(plan.projectedResidentPoints).toBeGreaterThanOrEqual(0);
    expect(plan.evict.length).toBeLessThanOrEqual(2);
  });

  it('refuses a release ratio at or above the trigger ratio', () => {
    // A release target above the trigger would evict nothing and read as a
    // working hysteresis band, so it is clamped rather than honoured.
    const bad: EvictionHysteresis = {
      triggerRatio: 1.2,
      releaseRatio: 1.9,
      minVisibleDwellMs: 500,
    };
    const resolved = resolveEvictionHysteresis(bad);
    expect(resolved.releaseRatio).toBeLessThan(resolved.triggerRatio);
  });
});

// --- 5. Determinism ---------------------------------------------------------

describe('the same inputs produce the same plan', () => {
  const candidates: EvictionCandidate[] = [
    cand('a', { pointCount: 700, depth: 4, distance: 30, visible: false, wanted: false }),
    cand('b', { pointCount: 700, depth: 4, distance: 30, visible: false, wanted: false }),
    cand('c', { pointCount: 700, depth: 2, distance: 30, wanted: false }),
    cand('d', { pointCount: 700, depth: 4, distance: 90, supersededByFiner: true }),
    cand('e', { pointCount: 700, depth: 4, distance: 90 }),
  ];
  const input = {
    candidates,
    residentPointCount: total(candidates),
    pointBudget: 1_400,
    nowMs: SETTLED,
  };

  it('repeats byte-for-byte across calls', () => {
    const first = planEviction(input);
    for (let i = 0; i < 25; i++) expect(planEviction(input)).toEqual(first);
  });

  it('does not depend on the order the candidates arrive in', () => {
    const first = planEviction(input);
    // Every rotation of the same set — ties are broken on id, so the plan is a
    // function of the set, not of its iteration order.
    for (let shift = 1; shift < candidates.length; shift++) {
      const rotated = [...candidates.slice(shift), ...candidates.slice(0, shift)];
      expect(planEviction({ ...input, candidates: rotated })).toEqual(first);
    }
  });

  it('does not mutate its input', () => {
    const snapshot = JSON.stringify(candidates);
    planEviction(input);
    expect(JSON.stringify(candidates)).toBe(snapshot);
  });
});
