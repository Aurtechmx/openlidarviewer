#!/usr/bin/env node
/**
 * governor-ab.mjs: frame budget governor off vs on, judged by fixed criteria.
 *
 *   node scripts/governor-ab.mjs step       run the next pending session of the ABAB plan
 *   node scripts/governor-ab.mjs run        run every pending session
 *   node scripts/governor-ab.mjs evaluate   judge the finished plan and write the record
 *   node scripts/governor-ab.mjs status     list the plan
 *
 * The plan is PAIRS pairs, alternating off, on, off, on, ... Each session is
 * one @bench run of tests/e2e/navJank.spec.ts (headed, bench project) with
 * OLV_NAV_RUNS=1: every trajectory gets one cold and one warm run, and the
 * warm run is the sample. OLV_NAV_GOVERNOR=on adds `?governor=on` and the
 * `governor=on` flag. Sessions are kept per commit under
 * playwright/.cache/governor-ab/, so a plan can be run one session at a time.
 *
 * `evaluate` checks every off/on pair with the report's --ab rule (the
 * environments must match except the governor flag), runs
 * tests/presentationInvariance.test.ts (scientific results across governor
 * off and on), applies CRITERIA_V3 per trajectory and writes
 * validation/performance/governor-ab/<date>-<sha>-<machine>-v3-<A|B>.json (never overwritten) with the raw
 * runs, the per-criterion values and the verdict. Exit 0 on PASS, 1 on FAIL.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from './lib/isCliEntry.mjs';
import { runMetrics, spread } from './lib/navJankResults.mjs';
import { abRefusals } from './nav-jank-report.mjs';

/**
 * The pass criteria. Fixed before any measurement; not to be changed after
 * seeing results.
 *
 * - p95 frame time (active window) improves by at least 10% with the governor
 *   on (median of runs);
 * - frames over 50 ms (active window) do not increase (median; also report max);
 * - quality transitions per trajectory at most 6 with the governor on;
 * - scientific result digests identical on vs off (presentationInvariance with
 *   governor on/off plus any digests the runner records).
 */
export const CRITERIA = Object.freeze({
  p95MinImprovement: 0.1,
  over50MayIncrease: false,
  qualityTransitionsMaxOn: 6,
  digestsIdentical: true,
});

/**
 * The v2 criteria (render scale and presentation point budget). Fixed before
 * any v2 measurement; not to be changed after seeing results. Every clause
 * must pass on every trajectory:
 *
 * 1. p95 frame time (active window) at least 10% lower with the governor on;
 * 2. frames over 50 ms (active window) not higher (median);
 * 3. quality transitions at most 6 per trajectory with the governor on;
 * 4. time to stationary quality after the last input at most 500 ms above off
 *    (medians);
 * 5. after settling, render scale and point budget back at their configured
 *    values in every on run (governor outputs 1 and 1, no mesh still reduced,
 *    backing ratio equal to the off runs');
 * 6. scientific result digests identical (presentationInvariance, which
 *    covers the v2 outputs active).
 */
export const CRITERIA_V2 = Object.freeze({
  ...CRITERIA,
  timeToStationaryMaxExtraMs: 500,
  settledRestored: true,
});

/**
 * The v3 criteria. Pre-registered before any v3 measurement; not to be
 * changed after seeing results. PASS needs every clause on every trajectory
 * on both datasets (V3_DATASETS):
 *
 * 1. p95 frame time (active window) at least 10% lower with the governor on
 *    (median of runs per arm);
 * 2. frames over 50 ms (active window) not higher (median);
 * 3. quality transitions with the governor on at most the off arm's median + 2;
 * 4. time from the LAST CAMERA INPUT to stationary full quality (render scale
 *    1, point fraction 1, refinement phase full-refine), on the page's
 *    performance.now() clock in both arms (runMeta.fullQuality.ms): on median
 *    at most off median + 500 ms; a run that never reaches it counts as
 *    infinite;
 * 5. after settling, render scale and point budget at their configured values
 *    in every on run (as v2: outputs 1 and 1, no mesh reduced, backing ratio
 *    equal to the off runs');
 * 6. scientific result digests identical (presentationInvariance, v2 outputs
 *    active) and every off/on pair passes the report's --ab rule.
 *
 * Protocol: V3_PAIRS alternating off/on pairs, medians. Clauses 1 and 4 also
 * report a paired bootstrap 95% percentile CI of the delta (pairs resampled
 * with replacement, bootstrapResamples draws, fixed seed); the CIs are
 * reported, the verdict uses the medians.
 */
export const CRITERIA_V3 = Object.freeze({
  p95MinImprovement: 0.1,
  over50MayIncrease: false,
  qualityTransitionsMaxExtraOverOff: 2,
  fullQualityMaxExtraMs: 500,
  settledRestored: true,
  digestsIdentical: true,
  bootstrapResamples: 2000,
  bootstrapSeed: 20260925,
  ciLevel: 0.95,
});

/** Off/on pairs per trajectory in the v3 protocol. */
export const V3_PAIRS = 7;

/**
 * The v3 datasets, fixed before measuring. A is the development set; B is
 * held out (register entry OLV-DS-093, USGS 3DEP, public domain, SHA-256
 * checked against the register by the runner).
 */
export const V3_DATASETS = Object.freeze({
  A: {
    id: 'OLV-DS-090-JEMEZ-SNOWOFF-2010-FOREST',
    path: '/Users/ssid02/Documents/OpenLiDAR/Sets/PointClouds/Jemez River Basin Snow-off Lidar Survey /ot_356000_3972000_1.laz',
  },
  B: {
    id: 'OLV-DS-093-ROGUE-SISKIYOU-2019-10TDM3449',
    path: '/Users/ssid02/Documents/OpenLiDAR/Sets/PointClouds/OR_RogueRiverSiskiyouNF_B1_2019:/USGS_LPC_OR_RogueSiskiyouNF_2019_B19_10TDM3449.laz',
  },
});

/** Off/on pairs per trajectory. */
export const PAIRS = V3_PAIRS;

/** The dataset key of this run (OLV_GOV_AB_DATASET, default A). */
const DATASET_KEY = process.env.OLV_GOV_AB_DATASET ?? 'A';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MACHINE = process.env.OLV_NAV_MACHINE ?? 'mbp-local';

/** The session plan: off, on, off, on, ... */
export function plan(pairs = PAIRS) {
  const out = [];
  for (let p = 0; p < pairs; p++) for (const cond of ['off', 'on']) out.push({ index: out.length, pair: p, cond });
  return out;
}

function headSha() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
}

function stateDir(sha) {
  return join(ROOT, 'playwright', '.cache', 'governor-ab', `${sha.slice(0, 12)}-${MACHINE}-v3-${DATASET_KEY}`);
}

function sessionDir(sha, s) {
  return join(stateDir(sha), `${String(s.index).padStart(2, '0')}-${s.cond}`);
}

function sessionResult(sha, s) {
  const dir = sessionDir(sha, s);
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).find((x) => x.endsWith('.json'));
  return f ? JSON.parse(readFileSync(join(dir, f), 'utf8')) : null;
}

const TRAJECTORY_COUNT = 5;

function complete(r) {
  return r !== null && Object.values(r.trajectories).filter((t) => t.warm).length >= TRAJECTORY_COUNT;
}

/** Run one session of the plan; returns false when none was pending. */
export function step(sha = headSha()) {
  const next = plan().find((s) => !complete(sessionResult(sha, s)));
  if (!next) return false;
  const dir = sessionDir(sha, next);
  mkdirSync(dir, { recursive: true });
  console.log(`[governor-ab] session ${next.index + 1}/${PAIRS * 2}: pair ${next.pair + 1}, governor ${next.cond}`);
  const res = spawnSync('npx', ['playwright', 'test', 'tests/e2e/navJank.spec.ts', '--project=bench', '--headed', '--reporter=line'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env, OLV_NAV_DATASET: V3_DATASETS[DATASET_KEY].path, OLV_NAV_DATASET_ID: V3_DATASETS[DATASET_KEY].id, OLV_NAV_RUNS: '1', OLV_NAV_GOVERNOR: next.cond, OLV_NAV_OUT_DIR: dir, OLV_NAV_MACHINE: MACHINE },
  });
  if (res.status !== 0) throw new Error(`session ${next.index} (${next.cond}) failed with exit ${res.status}`);
  return true;
}

/** The warm-run metric row of each session, per trajectory and condition. */
function samples(sessions) {
  const out = {};
  for (const { s, r } of sessions) {
    for (const [name, t] of Object.entries(r.trajectories)) {
      if (!t.warm) continue;
      const row = runMetrics(t.warm.runs[0].summary);
      const meta = (t.runMeta ?? []).filter((m) => m.cache === 'warm').at(-1);
      ((out[name] ??= { off: [], on: [] })[s.cond]).push({
        pair: s.pair, session: s.index, ...row, presentation: meta?.presentation ?? null,
        fullQuality: meta?.fullQuality ?? null, fullQualityMs: meta?.fullQuality?.ms ?? null,
      });
    }
  }
  return out;
}

const stat = (xs) => ({ ...spread(xs), max: Math.max(...xs), values: xs });

/** Apply CRITERIA to one trajectory's off and on samples. */
export function judgeTrajectory(off, on, digestsIdentical) {
  const p95Off = stat(off.map((r) => r.frameP95Ms));
  const p95On = stat(on.map((r) => r.frameP95Ms));
  const improvement = p95Off.median > 0 ? (p95Off.median - p95On.median) / p95Off.median : 0;
  const o50Off = stat(off.map((r) => r.over50));
  const o50On = stat(on.map((r) => r.over50));
  const qOff = stat(off.map((r) => r.qualityTransitions));
  const qOn = stat(on.map((r) => r.qualityTransitions));
  const criteria = {
    p95Improvement: { off: p95Off, on: p95On, improvement, threshold: CRITERIA.p95MinImprovement, pass: improvement >= CRITERIA.p95MinImprovement },
    over50NoIncrease: { off: o50Off, on: o50On, pass: CRITERIA.over50MayIncrease || o50On.median <= o50Off.median },
    qualityTransitionsOn: { off: qOff, on: qOn, threshold: CRITERIA.qualityTransitionsMaxOn, pass: qOn.median <= CRITERIA.qualityTransitionsMaxOn },
    digestsIdentical: { pass: digestsIdentical },
  };
  const tOff = stat(off.map((r) => r.timeToStationaryQualityMs));
  const tOn = stat(on.map((r) => r.timeToStationaryQualityMs));
  criteria.timeToStationary = {
    off: tOff, on: tOn, extraMs: tOn.median - tOff.median, threshold: CRITERIA_V2.timeToStationaryMaxExtraMs,
    pass: tOn.median - tOff.median <= CRITERIA_V2.timeToStationaryMaxExtraMs,
  };
  const offRatios = new Set(off.map((r) => r.presentation?.backingRatio ?? null));
  const settled = on.map((r) => {
    const g = r.presentation?.governor ?? null;
    const ok = g !== null && g.renderScale === 1 && g.pointBudgetFraction === 1 && g.reducedMeshes === 0
      && offRatios.size === 1 && offRatios.has(r.presentation.backingRatio) && r.presentation.backingRatio !== null;
    return { pair: r.pair, governor: g, backingRatio: r.presentation?.backingRatio ?? null, ok };
  });
  criteria.settledRestored = { offBackingRatios: [...offRatios], on: settled, pass: settled.every((x) => x.ok) };
  return { criteria, failed: Object.entries(criteria).filter(([, c]) => !c.pass).map(([k]) => k) };
}

/** Deterministic PRNG (mulberry32) for the bootstrap. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A metric value for the statistics: null (never reached) counts as infinite. */
const val = (v) => (v === null || v === undefined ? Infinity : v);
const medInf = (xs) => {
  const s = xs.map(val).sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  const pos = (s.length - 1) / 2;
  const lo = s[Math.floor(pos)];
  const hi = s[Math.ceil(pos)];
  return lo === hi ? lo : lo + (hi - lo) * (pos - Math.floor(pos));
};

/**
 * Paired bootstrap percentile CI of `delta(offValues, onValues)`. Off and on
 * samples are matched by `pair`; pairs are drawn with replacement.
 */
export function pairedBootstrapCI(off, on, key, delta, { resamples = CRITERIA_V3.bootstrapResamples, seed = CRITERIA_V3.bootstrapSeed, level = CRITERIA_V3.ciLevel } = {}) {
  const onBy = new Map(on.map((r) => [r.pair, r]));
  const pairs = off.filter((r) => onBy.has(r.pair)).map((r) => [val(r[key]), val(onBy.get(r.pair)[key])]);
  if (pairs.length === 0) return { lo: null, hi: null, resamples: 0, seed, pairs: 0 };
  const rnd = mulberry32(seed);
  const ds = new Float64Array(resamples);
  for (let b = 0; b < resamples; b++) {
    const o = [];
    const n = [];
    for (let k = 0; k < pairs.length; k++) {
      const p = pairs[Math.floor(rnd() * pairs.length)];
      o.push(p[0]);
      n.push(p[1]);
    }
    ds[b] = delta(medInf(o), medInf(n));
  }
  ds.sort();
  const q = (x) => {
    const pos = (resamples - 1) * x;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    const a = ds[lo];
    const c = ds[hi];
    return a === c ? a : a + (c - a) * (pos - lo);
  };
  const fin = (x) => (Number.isFinite(x) ? x : null);
  return { lo: fin(q((1 - level) / 2)), hi: fin(q(1 - (1 - level) / 2)), resamples, seed, pairs: pairs.length };
}

const improvementOf = (offMed, onMed) => (offMed > 0 ? (offMed - onMed) / offMed : 0);
const extraOf = (offMed, onMed) => onMed - offMed;

/** Apply CRITERIA_V3 to one trajectory's off and on samples. */
export function judgeTrajectoryV3(off, on, digestsIdentical) {
  const c = CRITERIA_V3;
  const p95Off = stat(off.map((r) => r.frameP95Ms));
  const p95On = stat(on.map((r) => r.frameP95Ms));
  const improvement = improvementOf(p95Off.median, p95On.median);
  const o50Off = stat(off.map((r) => r.over50));
  const o50On = stat(on.map((r) => r.over50));
  const qOff = stat(off.map((r) => r.qualityTransitions));
  const qOn = stat(on.map((r) => r.qualityTransitions));
  const fqOffMed = medInf(off.map((r) => r.fullQualityMs));
  const fqOnMed = medInf(on.map((r) => r.fullQualityMs));
  const fqExtra = extraOf(fqOffMed, fqOnMed);
  const fin = (x) => (Number.isFinite(x) ? x : null);
  const offRatios = new Set(off.map((r) => r.presentation?.backingRatio ?? null));
  const settled = on.map((r) => {
    const g = r.presentation?.governor ?? null;
    const ok = g !== null && g.renderScale === 1 && g.pointBudgetFraction === 1 && g.reducedMeshes === 0
      && offRatios.size === 1 && offRatios.has(r.presentation.backingRatio) && r.presentation.backingRatio !== null;
    return { pair: r.pair, governor: g, backingRatio: r.presentation?.backingRatio ?? null, ok };
  });
  const criteria = {
    p95Improvement: {
      off: p95Off, on: p95On, improvement, threshold: c.p95MinImprovement, pass: improvement >= c.p95MinImprovement,
      ci95: pairedBootstrapCI(off, on, 'frameP95Ms', improvementOf),
    },
    over50NoIncrease: { off: o50Off, on: o50On, pass: c.over50MayIncrease || o50On.median <= o50Off.median },
    qualityTransitions: {
      off: qOff, on: qOn, limit: qOff.median + c.qualityTransitionsMaxExtraOverOff,
      pass: qOn.median <= qOff.median + c.qualityTransitionsMaxExtraOverOff,
    },
    fullQualityFromLastInput: {
      off: { median: fin(fqOffMed), values: off.map((r) => r.fullQualityMs) },
      on: { median: fin(fqOnMed), values: on.map((r) => r.fullQualityMs) },
      extraMs: Number.isNaN(fqExtra) ? null : fin(fqExtra), threshold: c.fullQualityMaxExtraMs,
      pass: Number.isFinite(fqOnMed) && fqExtra <= c.fullQualityMaxExtraMs,
      ci95: pairedBootstrapCI(off, on, 'fullQualityMs', extraOf),
    },
    settledRestored: { offBackingRatios: [...offRatios], on: settled, pass: settled.length > 0 && settled.every((x) => x.ok) },
    digestsIdentical: { pass: digestsIdentical },
  };
  return { criteria, failed: Object.entries(criteria).filter(([, x]) => !x.pass).map(([k]) => k) };
}

function presentationInvariance() {
  const res = spawnSync('npx', ['vitest', 'run', 'tests/presentationInvariance.test.ts'], { cwd: ROOT, encoding: 'utf8' });
  const text = `${res.stdout}\n${res.stderr}`;
  const m = /Tests\s+(\d+) passed \((\d+)\)/.exec(text);
  return { pass: res.status === 0, summary: m ? `${m[1]}/${m[2]} passed` : 'no summary' };
}

/** Judge the finished plan and write the record. */
export function evaluate(sha = headSha()) {
  const sessions = plan().map((s) => ({ s, r: sessionResult(sha, s) }));
  const missing = sessions.filter(({ r }) => !complete(r)).map(({ s }) => `${s.index}-${s.cond}`);
  if (missing.length) throw new Error(`plan incomplete: ${missing.join(', ')}`);

  const pairRefusals = [];
  for (let p = 0; p < PAIRS; p++) {
    const off = sessions.find(({ s }) => s.pair === p && s.cond === 'off').r;
    const on = sessions.find(({ s }) => s.pair === p && s.cond === 'on').r;
    for (const why of abRefusals(off, on)) pairRefusals.push(`pair ${p + 1}: ${why}`);
  }
  const invariance = presentationInvariance();
  const runnerDigests = sessions.flatMap(({ r }) => r.notes.filter((n) => /scientific result digests/.test(n)));
  const digestsIdentical = invariance.pass && pairRefusals.length === 0;

  const trajectories = {};
  for (const [name, { off, on }] of Object.entries(samples(sessions))) {
    trajectories[name] = judgeTrajectoryV3(off, on, digestsIdentical);
    trajectories[name].samples = { off, on };
  }
  const failing = Object.entries(trajectories).flatMap(([n, t]) => t.failed.map((c) => `${n}: ${c}`));
  if (pairRefusals.length) failing.push(...pairRefusals);
  const verdict = failing.length === 0 ? 'PASS' : 'FAIL';

  const first = sessions[0].r;
  const record = {
    kind: 'olv-governor-ab',
    version: 3,
    datasetKey: DATASET_KEY,
    heldOut: DATASET_KEY === 'B',
    generatedAt: new Date().toISOString(),
    commit: sha,
    machine: MACHINE,
    dataset: first.dataset,
    fingerprintOff: first.fingerprint,
    fingerprintOn: sessions[1].r.fingerprint,
    plan: { pairs: PAIRS, order: plan().map((s) => s.cond), runsPerSession: '1 cold + 1 warm per trajectory; the warm run is the sample' },
    criteria: {
      text: [
        '1. p95 frame time (active window) at least 10% lower with the governor on (median per arm); paired bootstrap 95% CI reported',
        '2. frames over 50 ms (active window) not higher (median)',
        '3. quality transitions on at most the off-arm median + 2',
        '4. last camera input to stationary full quality (render scale 1, point fraction 1, phase full-refine), same clock both arms: on median at most off median + 500 ms; paired bootstrap 95% CI reported',
        '5. after settling, render scale and point budget at their configured values in every on run',
        '6. scientific result digests identical (presentationInvariance, v2 outputs active; every pair passes the --ab rule)',
      ],
      constants: CRITERIA_V3,
    },
    scientificDigests: { presentationInvariance: invariance, runner: [...new Set(runnerDigests)], pairRefusals },
    trajectories,
    verdict,
    failing,
    sessions: sessions.map(({ s, r }) => ({ ...s, commit: r.commit, generatedAt: r.generatedAt, fingerprint: r.fingerprint, notes: r.notes, trajectories: r.trajectories })),
  };
  const outDir = join(ROOT, 'validation', 'performance', 'governor-ab');
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${record.generatedAt.slice(0, 10)}-${sha.slice(0, 8)}-${MACHINE}-v3-${DATASET_KEY}.json`);
  if (existsSync(file)) throw new Error(`refusing to overwrite ${file}`);
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  return { file, record };
}

const f1 = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

const fmt = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? 'n/a' : v.toFixed(d));

/** The per-trajectory, per-clause table with the bootstrap CIs. */
export function formatVerdict(record) {
  const rows = [['trajectory', '1 p95 off/on', '1 Δp95 [95% CI]', '2 >50 off/on', '3 q.trans off/on (limit)', '4 fullQ off/on ms', '4 extra ms [95% CI]', '5 restored', '6 digests', 'failed']];
  for (const [n, t] of Object.entries(record.trajectories)) {
    const c = t.criteria;
    const p = c.p95Improvement;
    const fq = c.fullQualityFromLastInput;
    rows.push([
      n,
      `${fmt(p.off.median)}/${fmt(p.on.median)}`,
      `${fmt(p.improvement * 100)}% [${fmt(p.ci95.lo === null ? null : p.ci95.lo * 100)}, ${fmt(p.ci95.hi === null ? null : p.ci95.hi * 100)}]`,
      `${fmt(c.over50NoIncrease.off.median)}/${fmt(c.over50NoIncrease.on.median)}`,
      `${fmt(c.qualityTransitions.off.median)}/${fmt(c.qualityTransitions.on.median)} (${fmt(c.qualityTransitions.limit)})`,
      `${fmt(fq.off.median, 0)}/${fmt(fq.on.median, 0)}`,
      `${fmt(fq.extraMs, 0)} [${fmt(fq.ci95.lo, 0)}, ${fmt(fq.ci95.hi, 0)}]`,
      String(c.settledRestored.pass),
      String(c.digestsIdentical.pass),
      t.failed.join(',') || '-',
    ]);
  }
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return [
    `dataset ${record.datasetKey}: ${record.dataset.id}${record.heldOut ? ' (held out)' : ''}`,
    ...rows.map((r) => r.map((v, i) => v.padEnd(w[i])).join('  ')),
    '',
    `presentationInvariance: ${record.scientificDigests.presentationInvariance.summary}`,
    `verdict: ${record.verdict}${record.failing.length ? `\n  ${record.failing.join('\n  ')}` : ''}`,
  ].join('\n');
}

if (isCliEntry(import.meta.url)) {
  const cmd = process.argv[2];
  try {
    if (cmd === 'step') {
      if (!step()) console.log('[governor-ab] nothing pending');
    } else if (cmd === 'run') {
      while (step());
    } else if (cmd === 'status') {
      const sha = headSha();
      for (const s of plan()) console.log(`${s.index}\tpair ${s.pair + 1}\t${s.cond}\t${complete(sessionResult(sha, s)) ? 'done' : 'pending'}`);
    } else if (cmd === 'evaluate') {
      const { file, record } = evaluate();
      console.log(formatVerdict(record));
      console.log(`[governor-ab] wrote ${file}`);
      process.exit(record.verdict === 'PASS' ? 0 : 1);
    } else {
      console.error('usage: governor-ab.mjs step | run | status | evaluate');
      process.exit(2);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
