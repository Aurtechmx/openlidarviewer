/**
 * streamingLegacyEquivalence.test.ts
 *
 * The recorded streaming baseline and the gate that holds it.
 *
 * WHAT THIS ESTABLISHES. Driving the real `StreamingScheduler`, the real
 * `computeExportFrontier` and the real ancestry walk over three fixed fixtures
 * (COPC, EPT, the OLV tile store) along one scripted camera path produces a
 * document of wanted sets, queue order, dispatch order, ancestor protection,
 * refined-away sets, eviction decisions, export frontiers, resident counts and
 * node scores. The gate below fails when any of those moves for the same input.
 * That is drift detection from this commit forward.
 *
 * WHAT THIS DOES NOT ESTABLISH, stated plainly so the artifact is not read as
 * something it is not. The record compares this branch against its own
 * committed snapshot. It is NOT evidence that generalising the hierarchy walk
 * onto explicit `parentId` preserved the behaviour of the octree-key walk that
 * preceded it: that code is no longer in the tree, so it cannot be run and no
 * before-and-after comparison is available here. The side-by-side claim for
 * that change lives in `tests/streamingHierarchyGeneric.test.ts`, which runs the
 * key-shift walk as a reference implementation. Read the two together, or read
 * this one as what it is — a frozen present, not a proven past.
 *
 * DETERMINISM. Every input is seeded or scripted; the clock is injected; the
 * decoder resolves instantly. Every recorded list is either an explicit
 * insertion order the code itself produced (the wanted set, the queue) or is
 * sorted before it is written. `it('two full recordings are byte-identical')`
 * is the standing proof.
 *
 * WHY EACH FIXTURE IS RECORDED TWICE. Ancestor protection lives on the
 * deferred-eviction pass, and a coarse node is only ever a deferred-eviction
 * candidate once the selector has stopped wanting it. The memory-pressure plan
 * that also runs each tick carries no protection by design, so with both live
 * it releases the very nodes the deferred pass held back and a single trace
 * records the protection set without ever recording it deciding anything. The
 * second run switches the pressure plan off, which is how the repository's
 * existing hysteresis tests reach the same pass, and its retreat phase collapses
 * the budget so the shortfall exceeds every unprotected resident node put
 * together. Only there is a held-back ancestor visible as a held-back ancestor.
 *
 * HOW THE SCHEDULER'S OWN WANTED SET IS READ. `readinessFacts()` walks the
 * scheduler's live wanted set and calls `store.get(id)` on each member, so a
 * recording shim on `store.get` across one `readinessFacts()` call yields that
 * set in its own iteration order. Nothing is recomputed and nothing is guessed:
 * the ids are the scheduler's, in the order its selection built them.
 *
 * Regenerate after a deliberate behaviour change:
 *   UPDATE_STREAMING_BASELINE=1 npx vitest run tests/streamingLegacyEquivalence.test.ts
 * and commit the JSON with the change that explains it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  StreamingScheduler,
  buildRefinedAwayIds,
  buildRefiningCandidateIds,
} from '../src/render/streaming/StreamingScheduler';
import {
  forEachAncestorId,
  parentLookupFromStore,
  MAX_ANCESTOR_STEPS,
} from '../src/render/streaming/streamingHierarchy';
import { computeExportFrontier, type FrontierNode } from '../src/render/streaming/exportFrontier';
import type { StreamingNode } from '../src/render/streaming/StreamingNode';
import type { StreamingNodeStore } from '../src/render/streaming/StreamingNodeStore';
import type { StreamingSource } from '../src/render/streaming/StreamingSource';
import type { ScoredCandidate } from '../src/render/streaming/streamingBudget';
import {
  SCENARIO_FIXTURES,
  SCENARIO_SEED,
  instantDecoder,
  scenarioCameraPath,
  type ScenarioFixture,
} from './fixtures/streaming/legacyBaselineScenario';

const RECORD_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../validation/streaming-baseline/reference-runs-streaming.json',
);

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const sorted = (ids: Iterable<string>): string[] => [...ids].sort();

/** One scheduler tick, as recorded. */
interface TickRecord {
  tick: number;
  phase: string;
  tMs: number;
  /** Point budget in force for this tick. */
  pointBudget: number;
  /** The scheduler's own wanted set, in its selection order. */
  wantedIds: string[];
  /** Ids the tick moved into `queued`, in the order the scheduler pushed them. */
  queueOrder: string[];
  /** Ids a decode actually started for this tick, in dispatch order. */
  dispatchOrder: string[];
  /** Ids the tick evicted, in the order the callback fired. */
  evictedIds: string[];
  ancestorProtection: string[];
  /**
   * The refined-away set as the scheduler's pressure branch would read it on the
   * next tick, taken before the tick's decodes land. A wanted node still on its
   * way in supersedes every ancestor, so this is the moment the set is populated;
   * after the decodes it is almost always empty.
   */
  refinedAwayPending: string[];
  refinedAway: string[];
  refiningCandidates: string[];
  /** Export frontier over the resident set as it stands. */
  frontierPlain: string[];
  /** Export frontier with a fixed fade / additive-refinement pattern applied. */
  frontierMixed: string[];
  residentIds: string[];
  residentNodes: number;
  residentPoints: number;
  maxResidentDepth: number;
  visible: number;
  queuedCount: number;
  loading: number;
  decodedPending: number;
  cameraVelocity: number;
  isStable: boolean;
  effectiveMaxConcurrent: number;
  fpsBudgetFactor: number;
  pressureDepthReduction: number;
  fullRescoreCount: number;
  /** Every non-zero node score this tick, by id. Zero scores are culled nodes. */
  scores: [string, number][];
  zeroScoreNodes: number;
}

/**
 * One tick of the defer-path run, which records fewer fields because it exists
 * for one question: which resident nodes the hysteresis pass released, and in
 * what order.
 */
interface DeferTickRecord {
  tick: number;
  phase: string;
  pointBudget: number;
  wantedCount: number;
  residentIds: string[];
  ancestorProtection: string[];
  evictedIds: string[];
}

interface FixtureRecord {
  fixture: string;
  sourceKind: string;
  nodeCount: number;
  /**
   * Null where the source cannot say. COPC reads its total from the LAS header
   * and EPT from `ept.json`, so both always know; a 3D Tiles tileset names
   * content URIs rather than point totals. Recording null rather than zero is
   * the whole point of the nullable type: zero is a real answer meaning an
   * empty source.
   */
  sourcePoints: number | null;
  hierarchyComplete: boolean;
  budgets: { pointBudget: number; maxConcurrentDecodes: number; chunkCacheBytes: number };
  /** Local cube half-span the camera path was scaled by. */
  halfSpan: number;
  /** Local cube centre the camera path orbits. */
  centre: [number, number, number];
  /** id → parentId, sorted by id: the ancestry every recorded set is walked over. */
  parents: [string, string | null][];
  trace: TickRecord[];
  /**
   * The same camera path with the memory-pressure eviction plan switched off,
   * so the deferred-eviction pass is the only thing releasing nodes.
   *
   * The pressure plan carries no ancestor protection — it walks the whole
   * resident set in one priority order by design — so with both passes live it
   * releases the coarse nodes the deferred pass had just held back, and a trace
   * of the two together records protection without ever recording it deciding
   * anything. Isolating the deferred pass is how the repository's own
   * hysteresis tests reach it, and it is the only run in which a node held back
   * for having a resident descendant is visibly held back.
   */
  deferPathTrace: DeferTickRecord[];
}

interface CeilingRecord {
  maxAncestorSteps: number;
  cycle: { chain: string[]; visitCount: number; firstVisits: string[]; lastVisit: string };
  deepChain: { length: number; visitCount: number; lastVisit: string };
}

interface BaselineRecord {
  schema: string;
  seed: number;
  establishes: string;
  doesNotEstablish: string;
  fixtures: FixtureRecord[];
  ancestorCeiling: CeilingRecord;
}

/**
 * The frontier's fade / refinement pattern.
 *
 * A resident set read straight off the store carries neither a cross-fade nor
 * an additive node, so a frontier recorded from it exercises one branch of
 * `computeExportFrontier` and pins nothing about the other two. The pattern is
 * a function of position in the sorted resident list, so it is fixed for a
 * fixed resident set.
 */
function mixedFrontierNodes(residentIds: readonly string[]): FrontierNode[] {
  return residentIds.map((id, i) => ({
    id,
    fadingOut: i % 4 === 1,
    refine: i % 3 === 0 ? ('add' as const) : ('replace' as const),
  }));
}

/** Read the scheduler's live wanted set, in its own iteration order. */
function readWantedIds(scheduler: StreamingScheduler, store: StreamingNodeStore): string[] {
  const seen: string[] = [];
  const target = store as unknown as { get(id: string): StreamingNode | undefined };
  const real = target.get.bind(store);
  Object.defineProperty(store, 'get', {
    configurable: true,
    writable: true,
    value: (id: string) => {
      seen.push(id);
      return real(id);
    },
  });
  try {
    scheduler.readinessFacts();
  } finally {
    delete (store as unknown as Record<string, unknown>).get;
  }
  return seen;
}

/**
 * Wait out the instant decoder's microtasks.
 *
 * On in-flight decodes only, not on the queue: the dispatch pressure gate parks
 * the queue's tail when accepting another decode would push the projected
 * resident count past the hysteresis cap, and that tail is released by the next
 * `update`, never by waiting. A drain that waited for an empty queue would hang
 * on exactly the pressure behaviour this baseline exists to record. What is left
 * queued is recorded as `queuedCount`.
 */
async function drain(scheduler: StreamingScheduler): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (scheduler.stats().loading === 0) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('streaming baseline drain did not settle');
}

/**
 * The deferred-eviction pass on its own, over the same camera path.
 *
 * `memoryPressureRatio` is set beyond any reachable resident total, which is
 * what disables the pressure plan; everything else is the shipping default.
 */
async function recordDeferPath(fixture: ScenarioFixture): Promise<DeferTickRecord[]> {
  const cloud = await fixture.open();
  const store = cloud.octree.store;
  const parentOf = parentLookupFromStore(store);
  const cube = cloud.localBounds();
  const halfSpan = round6(
    Math.max(cube[3] - cube[0], cube[4] - cube[1], cube[5] - cube[2]) / 2,
  );
  const centre: [number, number, number] = [
    round6((cube[0] + cube[3]) / 2),
    round6((cube[1] + cube[4]) / 2),
    round6((cube[2] + cube[5]) / 2),
  ];

  const evicted: string[] = [];
  let clock = 0;
  const scheduler = new StreamingScheduler(
    cloud,
    instantDecoder,
    { onNodeReady: () => {}, onNodeEvicted: (n) => evicted.push(n.record.id) },
    fixture.budgets,
    { now: () => clock, memoryPressureRatio: 1e9 },
  );

  const trace: DeferTickRecord[] = [];
  let pointBudget = fixture.budgets.pointBudget;
  for (const [tick, step] of scenarioCameraPath(halfSpan, centre).entries()) {
    clock = step.tMs;
    const wantBudget = Math.max(
      1,
      Math.floor(fixture.budgets.pointBudget * step.budgetFactor),
    );
    if (wantBudget !== pointBudget) {
      pointBudget = wantBudget;
      scheduler.setBudgets({
        pointBudget,
        maxConcurrentDecodes: fixture.budgets.maxConcurrentDecodes,
      });
    }
    evicted.length = 0;
    scheduler.update({
      viewProjection: step.viewProjection,
      cameraPosition: step.cameraPosition,
    });
    const wantedCount = readWantedIds(scheduler, store).length;
    await drain(scheduler);

    const residents = store.resident();
    const protection = new Set<string>();
    for (const n of residents) {
      forEachAncestorId(n.record.id, parentOf, (a) => protection.add(a));
    }
    trace.push({
      tick,
      phase: step.phase,
      pointBudget,
      wantedCount,
      residentIds: sorted(residents.map((n) => n.record.id)),
      ancestorProtection: sorted(protection),
      evictedIds: [...evicted],
    });
  }
  scheduler.stop();
  return trace;
}

async function recordFixture(fixture: ScenarioFixture): Promise<FixtureRecord> {
  const cloud = await fixture.open();
  const store = cloud.octree.store;
  const parentOf = parentLookupFromStore(store);

  const cube = cloud.localBounds();
  const halfSpan = round6(
    Math.max(cube[3] - cube[0], cube[4] - cube[1], cube[5] - cube[2]) / 2,
  );
  const centre: [number, number, number] = [
    round6((cube[0] + cube[3]) / 2),
    round6((cube[1] + cube[4]) / 2),
    round6((cube[2] + cube[5]) / 2),
  ];

  // Dispatch order: `decodeMeta` is called once per decode start, in queue
  // order, so a shim on it records the order decodes actually left the queue.
  const dispatched: string[] = [];
  const realDecodeMeta = cloud.decodeMeta.bind(cloud);
  Object.defineProperty(cloud, 'decodeMeta', {
    configurable: true,
    writable: true,
    value: (record: Parameters<StreamingSource['decodeMeta']>[0]) => {
      dispatched.push(record.id);
      return realDecodeMeta(record);
    },
  });

  // Queue order: the scheduler pushes a node onto its queue immediately after
  // setting it `queued`, so the transitions are the queue in order.
  const queued: string[] = [];
  const realSetState = store.setState.bind(store);
  Object.defineProperty(store, 'setState', {
    configurable: true,
    writable: true,
    value: (node: StreamingNode, state: string, points = 0) => {
      if (state === 'queued') queued.push(node.record.id);
      return realSetState(node, state as Parameters<StreamingNodeStore['setState']>[1], points);
    },
  });

  const evicted: string[] = [];
  let clock = 0;
  const scheduler = new StreamingScheduler(
    cloud,
    instantDecoder,
    { onNodeReady: () => {}, onNodeEvicted: (n) => evicted.push(n.record.id) },
    fixture.budgets,
    { now: () => clock },
  );

  const path = scenarioCameraPath(halfSpan, centre);
  const trace: TickRecord[] = [];

  let pointBudget = fixture.budgets.pointBudget;
  for (let tick = 0; tick < path.length; tick++) {
    const step = path[tick];
    clock = step.tMs;
    const wantBudget = Math.max(
      1,
      Math.floor(fixture.budgets.pointBudget * step.budgetFactor),
    );
    if (wantBudget !== pointBudget) {
      pointBudget = wantBudget;
      scheduler.setBudgets({
        pointBudget,
        maxConcurrentDecodes: fixture.budgets.maxConcurrentDecodes,
      });
    }
    queued.length = 0;
    dispatched.length = 0;
    evicted.length = 0;
    scheduler.update({
      viewProjection: step.viewProjection,
      cameraPosition: step.cameraPosition,
    });

    // Read before the drain: the selection is fixed by `update`, and the
    // refined-away set is only populated while a wanted node is still arriving.
    const wantedIds = readWantedIds(scheduler, store);
    const wanted = new Set(wantedIds);
    const refinedAwayPending = sorted(buildRefinedAwayIds(wanted, cloud));

    await drain(scheduler);

    const residents = store.resident();
    const residentIds = sorted(residents.map((n) => n.record.id));

    const protection = new Set<string>();
    for (const n of residents) {
      forEachAncestorId(n.record.id, parentOf, (a) => protection.add(a));
    }

    const scoredCandidates: { node: StreamingNode; candidate: ScoredCandidate }[] = [];
    const scores: [string, number][] = [];
    let zeroScoreNodes = 0;
    for (const node of store.iterate()) {
      if (node.score > 0) {
        scores.push([node.record.id, round6(node.score)]);
        scoredCandidates.push({
          node,
          candidate: {
            id: node.record.id,
            pointCount: node.record.pointCount,
            score: node.score,
          },
        });
      } else {
        zeroScoreNodes++;
      }
    }
    scores.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

    const stats = scheduler.stats();
    let maxResidentDepth = 0;
    for (const n of residents) {
      if (n.record.key.depth > maxResidentDepth) maxResidentDepth = n.record.key.depth;
    }

    trace.push({
      tick,
      phase: step.phase,
      tMs: step.tMs,
      pointBudget,
      wantedIds,
      queueOrder: [...queued],
      dispatchOrder: [...dispatched],
      evictedIds: [...evicted],
      ancestorProtection: sorted(protection),
      refinedAwayPending,
      refinedAway: sorted(buildRefinedAwayIds(wanted, cloud)),
      refiningCandidates: sorted(buildRefiningCandidateIds(scoredCandidates, parentOf)),
      frontierPlain: sorted(
        computeExportFrontier(residentIds.map((id) => ({ id })), parentOf),
      ),
      frontierMixed: sorted(computeExportFrontier(mixedFrontierNodes(residentIds), parentOf)),
      residentIds,
      residentNodes: residents.length,
      residentPoints: store.residentPointCount,
      maxResidentDepth,
      visible: stats.visible,
      queuedCount: store.queuedCount,
      loading: stats.loading,
      decodedPending: store.decodedPendingPointCount,
      cameraVelocity: round6(stats.cameraVelocity),
      isStable: stats.isStable,
      effectiveMaxConcurrent: stats.effectiveMaxConcurrent,
      fpsBudgetFactor: round6(stats.fpsBudgetFactor),
      pressureDepthReduction: stats.pressureDepthReduction,
      fullRescoreCount: stats.fullRescoreCount,
      scores,
      zeroScoreNodes,
    });
  }

  const parents: [string, string | null][] = [];
  for (const node of store.iterate()) {
    parents.push([node.record.id, node.record.parentId ?? null]);
  }
  parents.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  scheduler.stop();
  return {
    fixture: fixture.id,
    sourceKind: cloud.kind,
    nodeCount: store.size,
    sourcePoints: cloud.sourcePointCount,
    hierarchyComplete: cloud.octree.isComplete,
    budgets: {
      pointBudget: fixture.budgets.pointBudget,
      maxConcurrentDecodes: fixture.budgets.maxConcurrentDecodes,
      chunkCacheBytes: fixture.budgets.chunkCacheBytes,
    },
    halfSpan,
    centre,
    parents,
    trace,
    deferPathTrace: await recordDeferPath(fixture),
  };
}

/**
 * The step ceiling, recorded against inputs that reach it.
 *
 * No real hierarchy does: COPC and EPT bottom out around depth 20 and the
 * ceiling sits an order of magnitude above that, so a trace over the three
 * fixtures above pins the constant at nothing. These two walks do — one over a
 * hierarchy whose parent chain closes into a cycle, one over a chain longer
 * than the ceiling — so a change to the ceiling moves a recorded number.
 */
function recordAncestorCeiling(): CeilingRecord {
  const chain = ['cyc-a', 'cyc-b', 'cyc-c'];
  const cycleParent = new Map([
    ['cyc-a', 'cyc-b'],
    ['cyc-b', 'cyc-c'],
    ['cyc-c', 'cyc-a'],
  ]);
  const cycleVisits: string[] = [];
  forEachAncestorId('cyc-a', (id) => cycleParent.get(id), (a) => cycleVisits.push(a));

  const deepLength = MAX_ANCESTOR_STEPS * 2;
  const deepParent = (id: string): string | undefined => {
    const n = Number(id.slice(5));
    return n + 1 <= deepLength ? `deep-${n + 1}` : undefined;
  };
  const deepVisits: string[] = [];
  forEachAncestorId('deep-0', deepParent, (a) => deepVisits.push(a));

  return {
    maxAncestorSteps: MAX_ANCESTOR_STEPS,
    cycle: {
      chain,
      visitCount: cycleVisits.length,
      firstVisits: cycleVisits.slice(0, 6),
      lastVisit: cycleVisits[cycleVisits.length - 1],
    },
    deepChain: {
      length: deepLength,
      visitCount: deepVisits.length,
      lastVisit: deepVisits[deepVisits.length - 1],
    },
  };
}

async function recordBaseline(): Promise<BaselineRecord> {
  const fixtures: FixtureRecord[] = [];
  for (const fixture of SCENARIO_FIXTURES) fixtures.push(await recordFixture(fixture));
  return {
    schema: 'openlidarviewer.streaming-scheduler-baseline/1',
    seed: SCENARIO_SEED,
    establishes:
      'Scheduler wanted sets, queue and dispatch order, ancestor protection, refined-away sets, ' +
      'eviction decisions, export frontiers, resident counts and node scores for three fixed ' +
      'fixtures under one scripted camera path, as they stand on this commit.',
    doesNotEstablish:
      'That the generalised parent-identity hierarchy walk reproduces the octree-key walk it ' +
      'replaced. That code is not in the tree and cannot be run, so no before-and-after ' +
      'comparison is recorded here; tests/streamingHierarchyGeneric.test.ts carries that claim ' +
      'by running the key-shift walk as a reference implementation.',
    fixtures,
    ancestorCeiling: recordAncestorCeiling(),
  };
}

/**
 * Pretty JSON that keeps a list of ids on one line.
 *
 * `JSON.stringify(doc, null, 2)` puts every id of every recorded set on its own
 * line, which quadrupled the file for no reading benefit: a wanted set is read
 * as a set, not as forty lines. Objects and lists of pairs still break, so a
 * diff still points at the tick and the field that moved. Deterministic: key
 * order is insertion order and nothing is sorted here that was not sorted at
 * the point it was recorded.
 */
function formatJson(value: unknown, depth: number): string {
  const pad = '  '.repeat(depth);
  const isScalar = (v: unknown): boolean => v === null || typeof v !== 'object';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every(isScalar)) return JSON.stringify(value);
    if (value.every((e) => Array.isArray(e) && e.every(isScalar))) {
      return `[\n${value.map((e) => pad + '  ' + JSON.stringify(e)).join(',\n')}\n${pad}]`;
    }
    return `[\n${value
      .map((e) => pad + '  ' + formatJson(e, depth + 1))
      .join(',\n')}\n${pad}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    return `{\n${entries
      .map(([k, v]) => `${pad}  ${JSON.stringify(k)}: ${formatJson(v, depth + 1)}`)
      .join(',\n')}\n${pad}}`;
  }
  return JSON.stringify(value);
}

const serialise = (doc: BaselineRecord): string => formatJson(doc, 0) + '\n';

describe('streaming scheduler baseline', () => {
  it('two full recordings are byte-identical', async () => {
    const a = serialise(await recordBaseline());
    const b = serialise(await recordBaseline());
    expect(b).toBe(a);
  }, 120_000);

  it('records a scenario that actually exercises every seam it pins', async () => {
    const doc = await recordBaseline();
    expect(doc.fixtures.map((f) => f.fixture)).toEqual(['copc', 'ept', 'tiles']);

    for (const f of doc.fixtures) {
      // The budget bit: the source is bigger than the budget, and no tick ever
      // wanted the whole hierarchy. A source that cannot state its total is
      // asserted as unknown rather than coerced to a number, because coercing
      // is the defect this nullable type exists to prevent.
      if (f.sourcePoints === null) {
        expect(f.sourceKind, 'only a source that cannot count reports null').toBe('tiles');
      } else {
        expect(f.sourcePoints).toBeGreaterThan(f.budgets.pointBudget);
      }
      expect(Math.max(...f.trace.map((t) => t.wantedIds.length))).toBeLessThan(f.nodeCount);
      // Ancestry is present and read: a protected set formed, and the tree is
      // deeper than one level.
      expect(f.trace.some((t) => t.ancestorProtection.length > 0)).toBe(true);
      expect(f.parents.some(([, p]) => p !== null)).toBe(true);
      // Queueing, dispatch, eviction and refinement all happened.
      expect(f.trace.some((t) => t.queueOrder.length > 1)).toBe(true);
      expect(f.trace.some((t) => t.dispatchOrder.length > 0)).toBe(true);
      expect(f.trace.some((t) => t.evictedIds.length > 0)).toBe(true);
      expect(f.trace.some((t) => t.refinedAwayPending.length > 0)).toBe(true);
      // The frontier dropped a covered ancestor, and the additive/fade pattern
      // produced a different answer from the plain one.
      expect(
        f.trace.some((t) => t.frontierPlain.length < t.residentIds.length),
      ).toBe(true);
      expect(
        f.trace.some(
          (t) => t.frontierMixed.join(',') !== t.frontierPlain.join(','),
        ),
      ).toBe(true);
      // Ancestor protection decided something: on the tick the budget collapsed
      // the deferred pass released nodes but held back at least one that still
      // had a resident descendant, and released it on a later tick instead.
      const releases = f.deferPathTrace.filter((t) => t.evictedIds.length > 0);
      expect(releases.length).toBeGreaterThan(1);
      const held = releases[0];
      expect(held.ancestorProtection.length).toBeGreaterThan(0);
      for (const id of held.ancestorProtection) {
        expect(held.evictedIds).not.toContain(id);
      }
    }

    // The step ceiling was reached by both pathological walks.
    expect(doc.ancestorCeiling.cycle.visitCount).toBe(MAX_ANCESTOR_STEPS);
    expect(doc.ancestorCeiling.deepChain.visitCount).toBe(MAX_ANCESTOR_STEPS);
  }, 120_000);

  it('matches the committed record (the legacy-equivalence gate)', async () => {
    const produced = serialise(await recordBaseline());

    if (process.env.UPDATE_STREAMING_BASELINE === '1') {
      mkdirSync(dirname(RECORD_PATH), { recursive: true });
      writeFileSync(RECORD_PATH, produced);
      return;
    }

    expect(
      existsSync(RECORD_PATH),
      'record missing — run UPDATE_STREAMING_BASELINE=1 npx vitest run tests/streamingLegacyEquivalence.test.ts and commit it',
    ).toBe(true);
    const committed = readFileSync(RECORD_PATH, 'utf8');

    // Compare the parsed documents first: a structural mismatch reports which
    // field moved, which a string diff of a megabyte of JSON does not.
    expect(JSON.parse(produced)).toEqual(JSON.parse(committed));
    expect(produced).toBe(committed);
  }, 120_000);
});
