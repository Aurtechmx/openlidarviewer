#!/usr/bin/env node
/**
 * calibration-ab.mjs: render budget calibration, fixed vs calibrated start,
 * judged by the criteria pre-registered in
 * validation/protocols/render-budget-calibration-v1.md.
 *
 *   node scripts/calibration-ab.mjs step | run | status | evaluate
 *
 * Same plan and harness as scripts/governor-ab.mjs (V3_PAIRS alternating
 * pairs, one headed @bench session of tests/e2e/navJank.spec.ts each, 1 cold
 * + 1 warm run per trajectory, the warm run is the sample). Both arms run the
 * governor: 'fixed' is OLV_NAV_GOVERNOR=on, 'calibrated' is
 * OLV_NAV_GOVERNOR=calibrate. OLV_GOV_AB_DATASET picks A (OLV-DS-090) or B
 * (OLV-DS-093, held out); OLV_GOV_AB_PATH_<key> is the local copy.
 *
 * `evaluate` writes
 * validation/performance/render-budget-calibration/<date>-<sha>-<machine>-v1-<key>.json
 * (never overwritten), PASS or FAIL. Exit 0 on PASS, 1 on FAIL.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from './lib/isCliEntry.mjs';
import { runMetrics, spread } from './lib/navJankResults.mjs';
import { abRefusals } from './nav-jank-report.mjs';
import { pairedBootstrapCI, plan, V3_DATASETS, V3_PAIRS } from './governor-ab.mjs';

/** Pre-registered (render-budget-calibration-v1.md). Not to be changed after measuring. */
export const CRITERIA_CAL_V1 = Object.freeze({
  p95MaxRatio: 1.05,
  over50MayIncrease: false,
  firstRenderMaxExtraMs: 100,
  qualityTransitionsMaxExtraOverFixed: 2,
  fullQualityMaxExtraMs: 500,
  settledRestored: true,
  digestsIdentical: true,
  bootstrapResamples: 2000,
  bootstrapSeed: 20260925,
  ciLevel: 0.95,
});

const ARM = { off: 'fixed', on: 'calibrated' };
const KEY = process.env.OLV_GOV_AB_DATASET ?? 'A';
const MACHINE = process.env.OLV_NAV_MACHINE ?? 'mbp-local';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TRAJECTORY_COUNT = 5;

const headSha = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const stateDir = (sha) => join(ROOT, 'playwright', '.cache', 'calibration-ab', `${sha.slice(0, 12)}-${MACHINE}-v1-${KEY}`);
const sessionDir = (sha, s) => join(stateDir(sha), `${String(s.index).padStart(2, '0')}-${ARM[s.cond]}`);

function sessionResult(sha, s) {
  const dir = sessionDir(sha, s);
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).find((x) => x.endsWith('.json'));
  return f ? JSON.parse(readFileSync(join(dir, f), 'utf8')) : null;
}
const complete = (r) => r !== null && Object.values(r.trajectories).filter((t) => t.warm).length >= TRAJECTORY_COUNT;

export function step(sha = headSha()) {
  const next = plan().find((s) => !complete(sessionResult(sha, s)));
  if (!next) return false;
  const path = process.env[`OLV_GOV_AB_PATH_${KEY}`];
  if (!path) throw new Error(`Set OLV_GOV_AB_PATH_${KEY} to the local copy of ${V3_DATASETS[KEY].id}.`);
  const dir = sessionDir(sha, next);
  mkdirSync(dir, { recursive: true });
  console.log(`[calibration-ab] ${KEY} session ${next.index + 1}/${V3_PAIRS * 2}: pair ${next.pair + 1}, ${ARM[next.cond]}`);
  const res = spawnSync('npx', ['playwright', 'test', 'tests/e2e/navJank.spec.ts', '--project=bench', '--headed', '--reporter=line'], {
    cwd: ROOT, stdio: 'inherit',
    env: {
      ...process.env, OLV_NAV_DATASET: path, OLV_NAV_DATASET_ID: V3_DATASETS[KEY].id, OLV_NAV_RUNS: '1',
      OLV_NAV_GOVERNOR: next.cond === 'on' ? 'calibrate' : 'on', OLV_NAV_OUT_DIR: dir, OLV_NAV_MACHINE: MACHINE, OLV_NO_SERVER_REUSE: '1',
    },
  });
  if (res.status !== 0) throw new Error(`session ${next.index} (${ARM[next.cond]}) failed with exit ${res.status}`);
  return true;
}

/** Why a fixed/calibrated pair is not comparable: the governor A/B rule with the calibration flag as the only difference. */
export function pairRefusals(fixed, cal) {
  const out = [];
  const flags = (r) => r?.fingerprint?.flags ?? [];
  if (!flags(fixed).includes('governor=on') || flags(fixed).includes('calibrate=on')) out.push('fixed arm flags wrong');
  if (!flags(cal).includes('governor=on') || !flags(cal).includes('calibrate=on')) out.push('calibrated arm flags wrong');
  const as = (r, drop) => ({ ...r, fingerprint: { ...r.fingerprint, flags: flags(r).filter((f) => f !== drop) } });
  return [...out, ...abRefusals(as(fixed, 'governor=on'), as(cal, 'calibrate=on'))];
}

function samples(sessions) {
  const out = {};
  for (const { s, r } of sessions) {
    for (const [name, t] of Object.entries(r.trajectories)) {
      if (!t.warm) continue;
      const meta = (t.runMeta ?? []).filter((m) => m.cache === 'warm').at(-1);
      const load = (t.loads ?? []).filter((l) => l.cache === 'warm').at(-1);
      ((out[name] ??= { off: [], on: [] })[s.cond]).push({
        pair: s.pair, session: s.index, ...runMetrics(t.warm.runs[0].summary),
        presentation: meta?.presentation ?? null, fullQualityMs: meta?.fullQuality?.ms ?? null,
        firstRenderMs: load?.timeToFirstRenderMs ?? null,
      });
    }
  }
  return out;
}

const val = (v) => (v === null || v === undefined ? Infinity : v);
const med = (xs) => {
  const s = xs.map(val).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const p = (s.length - 1) / 2;
  const lo = s[Math.floor(p)];
  const hi = s[Math.ceil(p)];
  return lo === hi ? lo : (lo + hi) / 2;
};
const fin = (x) => (Number.isFinite(x) ? x : null);
const stat = (xs) => ({ ...spread(xs), max: Math.max(...xs), values: xs });

export function judgeTrajectory(off, on, digestsIdentical) {
  const c = CRITERIA_CAL_V1;
  const ratio = (a, b) => (a > 0 ? b / a : Infinity);
  const extra = (a, b) => b - a;
  const ci = (key, d) => pairedBootstrapCI(off, on, key, d, { resamples: c.bootstrapResamples, seed: c.bootstrapSeed, level: c.ciLevel });
  const p95 = { off: stat(off.map((r) => r.frameP95Ms)), on: stat(on.map((r) => r.frameP95Ms)) };
  const p95Ratio = ratio(p95.off.median, p95.on.median);
  const o50 = { off: stat(off.map((r) => r.over50)), on: stat(on.map((r) => r.over50)) };
  const q = { off: stat(off.map((r) => r.qualityTransitions)), on: stat(on.map((r) => r.qualityTransitions)) };
  const frOff = med(off.map((r) => r.firstRenderMs));
  const frOn = med(on.map((r) => r.firstRenderMs));
  const fqOff = med(off.map((r) => r.fullQualityMs));
  const fqOn = med(on.map((r) => r.fullQualityMs));
  const offRatios = new Set(off.map((r) => r.presentation?.backingRatio ?? null));
  const settled = on.map((r) => {
    const g = r.presentation?.governor ?? null;
    const ok = g !== null && g.renderScale === 1 && g.pointBudgetFraction === 1 && g.reducedMeshes === 0
      && offRatios.size === 1 && r.presentation.backingRatio !== null && offRatios.has(r.presentation.backingRatio);
    return { pair: r.pair, governor: g, backingRatio: r.presentation?.backingRatio ?? null, ok };
  });
  const criteria = {
    p95NotWorse: { ...p95, ratio: p95Ratio, threshold: c.p95MaxRatio, pass: p95Ratio <= c.p95MaxRatio, ci95: ci('frameP95Ms', ratio) },
    over50NoIncrease: { ...o50, pass: c.over50MayIncrease || o50.on.median <= o50.off.median },
    firstRender: {
      off: { median: fin(frOff), values: off.map((r) => r.firstRenderMs) }, on: { median: fin(frOn), values: on.map((r) => r.firstRenderMs) },
      extraMs: fin(frOn - frOff), threshold: c.firstRenderMaxExtraMs, pass: Number.isFinite(frOn) && frOn - frOff <= c.firstRenderMaxExtraMs,
      ci95: ci('firstRenderMs', extra),
    },
    qualityTransitions: { ...q, limit: q.off.median + c.qualityTransitionsMaxExtraOverFixed, pass: q.on.median <= q.off.median + c.qualityTransitionsMaxExtraOverFixed },
    fullQualityFromLastInput: {
      off: { median: fin(fqOff), values: off.map((r) => r.fullQualityMs) }, on: { median: fin(fqOn), values: on.map((r) => r.fullQualityMs) },
      extraMs: fin(fqOn - fqOff), threshold: c.fullQualityMaxExtraMs, pass: Number.isFinite(fqOn) && fqOn - fqOff <= c.fullQualityMaxExtraMs,
      ci95: ci('fullQualityMs', extra),
    },
    settledRestored: { offBackingRatios: [...offRatios], on: settled, pass: settled.length > 0 && settled.every((x) => x.ok) },
    digestsIdentical: { pass: digestsIdentical },
  };
  return { criteria, calibratedLevels: on.map((r) => r.presentation?.governor?.calibratedLevel ?? null), failed: Object.entries(criteria).filter(([, x]) => !x.pass).map(([k]) => k) };
}

function presentationInvariance() {
  const res = spawnSync('npx', ['vitest', 'run', 'tests/presentationInvariance.test.ts'], { cwd: ROOT, encoding: 'utf8' });
  const m = /Tests\s+(\d+) passed \((\d+)\)/.exec(`${res.stdout}\n${res.stderr}`);
  return { pass: res.status === 0, summary: m ? `${m[1]}/${m[2]} passed` : 'no summary' };
}

export function evaluate(sha = headSha()) {
  const sessions = plan().map((s) => ({ s, r: sessionResult(sha, s) }));
  const missing = sessions.filter(({ r }) => !complete(r)).map(({ s }) => `${s.index}-${ARM[s.cond]}`);
  if (missing.length) throw new Error(`plan incomplete: ${missing.join(', ')}`);
  const refusals = [];
  for (let p = 0; p < V3_PAIRS; p++) {
    const get = (cond) => sessions.find(({ s }) => s.pair === p && s.cond === cond).r;
    for (const why of pairRefusals(get('off'), get('on'))) refusals.push(`pair ${p + 1}: ${why}`);
  }
  const invariance = presentationInvariance();
  const digestsIdentical = invariance.pass && refusals.length === 0;
  const trajectories = {};
  for (const [name, { off, on }] of Object.entries(samples(sessions))) {
    trajectories[name] = { ...judgeTrajectory(off, on, digestsIdentical), samples: { fixed: off, calibrated: on } };
  }
  const failing = [...Object.entries(trajectories).flatMap(([n, t]) => t.failed.map((c) => `${n}: ${c}`)), ...refusals];
  const record = {
    kind: 'olv-render-budget-calibration-ab', version: 1, protocol: 'validation/protocols/render-budget-calibration-v1.md',
    datasetKey: KEY, heldOut: KEY === 'B', generatedAt: new Date().toISOString(), commit: sha, machine: MACHINE,
    dataset: sessions[0].r.dataset, fingerprintFixed: sessions[0].r.fingerprint, fingerprintCalibrated: sessions[1].r.fingerprint,
    plan: { pairs: V3_PAIRS, order: plan().map((s) => ARM[s.cond]), runsPerSession: '1 cold + 1 warm per trajectory; the warm run is the sample' },
    criteria: CRITERIA_CAL_V1,
    scientificDigests: { presentationInvariance: invariance, pairRefusals: refusals },
    trajectories, verdict: failing.length === 0 ? 'PASS' : 'FAIL', failing,
    sessions: sessions.map(({ s, r }) => ({ ...s, arm: ARM[s.cond], commit: r.commit, generatedAt: r.generatedAt, fingerprint: r.fingerprint, notes: r.notes, trajectories: r.trajectories })),
  };
  const outDir = join(ROOT, 'validation', 'performance', 'render-budget-calibration');
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${record.generatedAt.slice(0, 10)}-${sha.slice(0, 8)}-${MACHINE}-v1-${KEY}.json`);
  try {
    writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  } catch (err) {
    if (err?.code === 'EEXIST') throw new Error(`refusing to overwrite ${file}`);
    throw err;
  }
  return { file, record };
}

const fmt = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? 'n/a' : v.toFixed(d));

export function formatVerdict(record) {
  const lines = [`dataset ${record.datasetKey}: ${record.dataset.id}${record.heldOut ? ' (held out)' : ''}`];
  for (const [n, t] of Object.entries(record.trajectories)) {
    const c = t.criteria;
    lines.push(`${n}: p95 ${fmt(c.p95NotWorse.off.median)}/${fmt(c.p95NotWorse.on.median)} ratio ${fmt(c.p95NotWorse.ratio, 3)} [${fmt(c.p95NotWorse.ci95.lo, 3)}, ${fmt(c.p95NotWorse.ci95.hi, 3)}]`
      + `  >50 ${fmt(c.over50NoIncrease.off.median)}/${fmt(c.over50NoIncrease.on.median)}`
      + `  firstRender +${fmt(c.firstRender.extraMs, 0)} ms  q ${fmt(c.qualityTransitions.off.median)}/${fmt(c.qualityTransitions.on.median)}`
      + `  fullQ +${fmt(c.fullQualityFromLastInput.extraMs, 0)} ms  restored ${c.settledRestored.pass}  levels ${t.calibratedLevels.join(',')}  failed ${t.failed.join(',') || '-'}`);
  }
  lines.push(`presentationInvariance: ${record.scientificDigests.presentationInvariance.summary}`, `verdict: ${record.verdict}${record.failing.length ? `\n  ${record.failing.join('\n  ')}` : ''}`);
  return lines.join('\n');
}

if (isCliEntry(import.meta.url)) {
  const cmd = process.argv[2];
  try {
    if (cmd === 'step') { if (!step()) console.log('[calibration-ab] nothing pending'); }
    else if (cmd === 'run') { while (step()); }
    else if (cmd === 'status') { const sha = headSha(); for (const s of plan()) console.log(`${s.index}\tpair ${s.pair + 1}\t${ARM[s.cond]}\t${complete(sessionResult(sha, s)) ? 'done' : 'pending'}`); }
    else if (cmd === 'evaluate') { const { file, record } = evaluate(); console.log(formatVerdict(record)); console.log(`[calibration-ab] wrote ${file}`); process.exit(record.verdict === 'PASS' ? 0 : 1); }
    else { console.error('usage: calibration-ab.mjs step | run | status | evaluate'); process.exit(2); }
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
