/**
 * evictionPolicy.ts
 *
 * Which resident nodes to drop when the streaming working set overshoots its
 * point budget, and in what order.
 *
 * The problem this exists for: on a streamed scan the resident set settles near
 * the budget, and small camera or budget noise moves the selection boundary by
 * a node or two every tick. Whenever the boundary node was dropped and pulled
 * back it paid a decode and a fresh fade-in, which reads as regions pulsing.
 * The cure is on the eviction side. Two rules:
 *
 *   1. A CLEAR MARGIN. Nothing is evicted for a marginal overshoot. Eviction
 *      starts only past `triggerRatio × budget` and then releases down to
 *      `releaseRatio × budget`, which is above the budget itself. The gap
 *      between the two ratios is the hysteresis band: a set inside it is left
 *      alone, so boundary noise cannot drive an evict/re-admit cycle.
 *   2. A DWELL. A node that is visible on screen is not dropped inside
 *      `minVisibleDwellMs` of becoming resident, so a node cannot be taken
 *      away while it is still fading in.
 *
 * Order matters as much as the thresholds. Cheap-to-lose nodes go first: ones
 * out of frustum, then ones in view but not selected, then ones superseded by
 * finer detail already arriving, and only last the nodes the user is looking at
 * with nothing waiting on them.
 *
 * WHY THIS CANNOT FREEZE THE LEVEL OF DETAIL. An earlier attempt at the same
 * flicker worked on the ADMISSION side: it gave an already-resident node a
 * score bonus so boundary noise could not bump it out of the selection. When it
 * was enabled the scene stopped refining, because a node that should have been
 * refined away kept its bonus and never yielded its slot. The protection had
 * become a veto. Two properties here keep that from happening again:
 *
 *   • The refined-away exemption. A node with finer detail arriving below it
 *     (`supersededByFiner`) gets NO dwell protection and is ranked FIRST for
 *     eviction. The one case where holding a node blocks refinement is the one
 *     case where the policy hurries it out.
 *   • Hysteresis is a preference, never a veto. `planEviction` walks ONE
 *     ordered list and exempts no class of node from being reached, so it
 *     always hits its release target when the candidates hold enough points to
 *     get there. The dwell moves a node down the order; it cannot remove it
 *     from the order. So the resident set always shrinks under real pressure,
 *     and the scheduler's dispatch gate is never held shut against the finer
 *     nodes queued behind it. That is the eviction-side shape of the same
 *     freeze, and it is the property that carries the guarantee.
 *
 * Pure — no DOM, no three.js, no clock, no randomness. The caller supplies the
 * facts and the current time; the same facts always produce the same plan.
 */

/** What the policy needs to know about one resident node. */
export interface EvictionCandidate {
  /** Node id. Also the final, total tie-break, so a plan is order-independent. */
  readonly id: string;
  /** Points this node contributes to the resident total. */
  readonly pointCount: number;
  /** Octree depth. Deeper is finer, and finer is dropped first within a class. */
  readonly depth: number;
  /** Distance from the camera to the node's centre, in render units. */
  readonly distance: number;
  /** Inside the view frustum on the tick this plan is for. */
  readonly visible: boolean;
  /** In the selected (wanted) set on the tick this plan is for. */
  readonly wanted: boolean;
  /**
   * Finer detail inside this node's subtree is wanted this tick and has not
   * arrived yet, or the node has itself left the selection while a finer
   * descendant stayed in it. Either way the level below is replacing it.
   *
   * This is the LOD-freeze exemption. Such a node is never dwell-protected at
   * any residency age, and never ranks in the protected bottom band, so no
   * amount of hysteresis can hold the budget that the refinement behind it is
   * waiting for.
   */
  readonly supersededByFiner: boolean;
  /** Wall-clock time (ms, same clock as `nowMs`) the node became resident. */
  readonly residentSinceMs: number;
}

/** The thresholds that shape the hysteresis band and the dwell. */
export interface EvictionHysteresis {
  /** Resident/budget ratio above which eviction runs at all. */
  readonly triggerRatio: number;
  /** Resident/budget ratio a run releases down to. Must sit below the trigger. */
  readonly releaseRatio: number;
  /** How long a visible node holds its place after becoming resident, ms. */
  readonly minVisibleDwellMs: number;
}

/**
 * Defaults.
 *
 * `triggerRatio` keeps the scheduler's long-standing 1.5× memory-pressure
 * threshold: this change is about WHAT is evicted and HOW FAR, not about
 * firing earlier.
 *
 * `releaseRatio` is the part that moved. Eviction used to release all the way
 * down to 1.0× the budget, so every pressure run cut a third of the resident
 * set and the very next selection asked for most of it back. Stopping at 1.15×
 * leaves the set inside the band the next tick's selection is already sized
 * for, which is what turns a repeating evict/re-admit cycle into a single step.
 * The resident set is no less bounded: it is still capped by the 1.5× trigger.
 *
 * `minVisibleDwellMs` is 1 s, about four and a half times the 220 ms node
 * fade-in, so a visible node is never taken away while it is materialising or
 * immediately after. It is also half the scheduler's 2 s evict-defer window, so
 * the pressure path can never drop a visible node faster than half the speed of
 * an ordinary lapse.
 */
export const DEFAULT_EVICTION_HYSTERESIS: EvictionHysteresis = {
  triggerRatio: 1.5,
  releaseRatio: 1.15,
  minVisibleDwellMs: 1_000,
};

/** One eviction plan. */
export interface EvictionPlan {
  /** Ids to evict, in the order they should be dropped. */
  readonly evict: readonly string[];
  /** Points the plan releases. */
  readonly releasedPoints: number;
  /** Resident points left once the whole plan is applied. */
  readonly projectedResidentPoints: number;
  /**
   * True when the plan had to take a node still inside its dwell window.
   * Surfaced rather than hidden: it is the signal that the working set is
   * genuinely too large for the budget, not that the camera is jittering.
   */
  readonly brokeDwell: boolean;
}

/** Everything one call needs. */
export interface EvictionPlanInput {
  readonly candidates: readonly EvictionCandidate[];
  /** Points currently resident across the whole scan. */
  readonly residentPointCount: number;
  /** The configured resident-point budget. */
  readonly pointBudget: number;
  /** Wall-clock now, same clock as `EvictionCandidate.residentSinceMs`. */
  readonly nowMs: number;
  /** Overrides; omitted fields fall back to {@link DEFAULT_EVICTION_HYSTERESIS}. */
  readonly hysteresis?: Partial<EvictionHysteresis>;
}

/**
 * Fill in and sanity-clamp a hysteresis setting.
 *
 * A release ratio at or above the trigger is refused rather than honoured: it
 * would make every run a no-op while still reading like a configured band, and
 * a silently inert hysteresis is precisely the failure the earlier admission
 * attempt shipped with. It is pulled to just under the trigger instead.
 */
export function resolveEvictionHysteresis(
  overrides: Partial<EvictionHysteresis> | undefined,
): EvictionHysteresis {
  const merged = { ...DEFAULT_EVICTION_HYSTERESIS, ...overrides };
  const triggerRatio = Math.max(1, finiteOr(merged.triggerRatio, DEFAULT_EVICTION_HYSTERESIS.triggerRatio));
  const requested = Math.max(0, finiteOr(merged.releaseRatio, DEFAULT_EVICTION_HYSTERESIS.releaseRatio));
  // Keep a real band between the two edges — 5 % of the trigger, or the whole
  // way to 1.0 if the trigger itself is that tight.
  const ceiling = Math.max(0, triggerRatio * 0.95);
  return {
    triggerRatio,
    releaseRatio: Math.min(requested, ceiling),
    minVisibleDwellMs: Math.max(0, finiteOr(merged.minVisibleDwellMs, 0)),
  };
}

/**
 * How eagerly a candidate should be evicted. Higher goes first. The bands read
 * as increasing cost of losing the node:
 *
 *   3  out of frustum — the user cannot see it at all, so it costs nothing
 *   2  in view but not selected this tick — including a node the selector has
 *      dropped in favour of the level below it
 *   1  selected, but finer detail is arriving below it — the points it holds
 *      are the points that refinement is queued against
 *   0  on screen and selected, with nothing waiting on it — dropped last
 *
 * Band 1 is the LOD-freeze exemption in the ranking. A superseded node can
 * never sit in the protected bottom band no matter how recently it arrived or
 * how central it is, so the one node whose eviction unblocks refinement is
 * always ahead of the nodes whose eviction only costs.
 *
 * It sits BELOW the two cheap bands on purpose. A coarse node with children on
 * the way is still the coverage the user is looking at, and shedding an
 * off-screen region instead frees the same budget for the same refinement at
 * no visual cost. Ranking it top would have blanked coverage on every camera
 * move, which is a worse artefact than the one this file exists to remove.
 */
export function evictionRank(candidate: EvictionCandidate): number {
  if (!candidate.visible) return 3;
  if (!candidate.wanted) return 2;
  if (candidate.supersededByFiner) return 1;
  return 0;
}

/**
 * Whether the dwell rule holds this candidate back within its band.
 *
 * Only visible nodes are dwell-protected: an off-screen node costs nothing to
 * lose and re-fades off-screen if it comes back. A superseded node is never
 * protected at any age — that exemption is the LOD-freeze guard and is checked
 * before anything else here.
 */
export function isDwellProtected(
  candidate: EvictionCandidate,
  nowMs: number,
  minVisibleDwellMs: number,
): boolean {
  if (candidate.supersededByFiner) return false;
  if (!candidate.visible) return false;
  const age = nowMs - candidate.residentSinceMs;
  // A non-finite or future timestamp reads as "just arrived" rather than as
  // "infinitely old", so a clock glitch cannot strip a node's protection.
  if (!Number.isFinite(age)) return true;
  return age < minVisibleDwellMs;
}

/**
 * Order candidates for eviction: rank band, then the dwell, then deepest, then
 * farthest, then id.
 *
 * The band leads and the dwell breaks ties inside it, rather than the dwell
 * holding a node back across bands. That ordering matters: a node the selector
 * has dropped should go before one it still wants, whether or not it happens to
 * have arrived recently. Letting the dwell jump the queue would have meant
 * evicting a node the user is looking at in order to spare one that had just
 * faded in and was already unselected.
 *
 * Depth before distance matches the ordering the scheduler's lapsed-eviction
 * pass already uses, so both eviction paths shed a region the same way: fine
 * detail steps down before coarse coverage disappears. The id is a total
 * tie-break, which is what makes a plan a function of the candidate SET rather
 * than of the order it happened to be iterated in.
 */
function byEvictionPriority(
  a: EvictionCandidate,
  b: EvictionCandidate,
  nowMs: number,
  minVisibleDwellMs: number,
): number {
  const ap = isDwellProtected(a, nowMs, minVisibleDwellMs) ? 1 : 0;
  const bp = isDwellProtected(b, nowMs, minVisibleDwellMs) ? 1 : 0;
  let idOrder = 0;
  if (a.id < b.id) idOrder = -1;
  else if (a.id > b.id) idOrder = 1;
  return (
    evictionRank(b) - evictionRank(a) ||
    ap - bp ||
    b.depth - a.depth ||
    b.distance - a.distance ||
    idOrder
  );
}

/**
 * Plan the eviction for one tick.
 *
 * Returns an empty plan while the resident total sits inside the hysteresis
 * band — that is the flicker fix, and it is the common case. Past the trigger,
 * candidates are walked in one priority order and taken until the projected
 * resident total reaches the release target.
 *
 * One ordered walk, with no class of node exempt from being reached, is what
 * makes hysteresis a preference and never a veto. The dwell moves a node down
 * the order; it cannot remove it from the order. So the resident set always
 * shrinks under real pressure and the scheduler's dispatch gate is never held
 * shut against the finer nodes queued behind it.
 */
export function planEviction(input: EvictionPlanInput): EvictionPlan {
  const h = resolveEvictionHysteresis(input.hysteresis);
  const budget = Math.max(0, finiteOr(input.pointBudget, 0));
  const resident = Math.max(0, finiteOr(input.residentPointCount, 0));
  const nowMs = finiteOr(input.nowMs, 0);

  if (resident <= budget * h.triggerRatio) {
    return {
      evict: [],
      releasedPoints: 0,
      projectedResidentPoints: resident,
      brokeDwell: false,
    };
  }

  const target = budget * h.releaseRatio;
  const ordered = [...input.candidates].sort((a, b) =>
    byEvictionPriority(a, b, nowMs, h.minVisibleDwellMs),
  );

  const evict: string[] = [];
  let remaining = resident;
  let brokeDwell = false;
  for (const candidate of ordered) {
    if (remaining <= target) break;
    evict.push(candidate.id);
    remaining -= Math.max(0, finiteOr(candidate.pointCount, 0));
    if (isDwellProtected(candidate, nowMs, h.minVisibleDwellMs)) brokeDwell = true;
  }

  return {
    evict,
    releasedPoints: resident - remaining,
    projectedResidentPoints: Math.max(0, remaining),
    brokeDwell,
  };
}

/**
 * Resident/budget ratio at or below which a node whose defer window has lapsed
 * is KEPT rather than dropped.
 *
 * The scheduler's other eviction path drops a node once it has been out of the
 * selection for the whole defer window, and it used to do that unconditionally.
 * That is the larger half of the churn on a real navigation: the camera leaves
 * a region, the window lapses, the node is dropped and re-faded when the camera
 * comes back, and none of it bought anything, because the resident set had room
 * for it the whole time.
 *
 * At 1.0 a lapsed node is kept while the whole resident set still fits the
 * budget, and is shed the moment it does not. That is what makes the rule safe:
 * the scheduler's dispatch gate admits up to `triggerRatio × budget`, and this
 * trims back to 1.0 × budget, so there is always headroom being freed and
 * refinement is never starved by nodes kept for a return that may not come.
 */
export const DEFAULT_LAPSED_KEEP_RATIO = 1.0;

/**
 * Which of the nodes whose defer window has lapsed to actually drop.
 *
 * Returns nothing while the resident set fits its budget — a lapsed node that
 * costs nothing to keep is worth keeping, because dropping it costs a decode
 * and a fade if the camera returns. Over the budget, they are shed in the same
 * priority order the pressure plan uses (out of frustum first, then deepest,
 * then farthest) until the set fits again.
 *
 * The dwell plays no part here: every candidate has already been out of the
 * selection for a full defer window, which is a longer wait than the dwell
 * asks for.
 */
export function selectLapsedEvictions(
  lapsed: readonly EvictionCandidate[],
  residentPointCount: number,
  pointBudget: number,
  keepRatio: number = DEFAULT_LAPSED_KEEP_RATIO,
): string[] {
  const limit = Math.max(0, finiteOr(pointBudget, 0)) * Math.max(0, finiteOr(keepRatio, 1));
  let remaining = Math.max(0, finiteOr(residentPointCount, 0));
  if (remaining <= limit) return [];
  const ordered = [...lapsed].sort((a, b) => byEvictionPriority(a, b, 0, 0));
  const evict: string[] = [];
  for (const candidate of ordered) {
    if (remaining <= limit) break;
    evict.push(candidate.id);
    remaining -= Math.max(0, finiteOr(candidate.pointCount, 0));
  }
  return evict;
}

/** A finite number, or the fallback. */
function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}
