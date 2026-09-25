#!/usr/bin/env node
/**
 * nav-jank-report.mjs: print a heavy-navigation benchmark result.
 *
 *   node scripts/nav-jank-report.mjs <results.json>            one session
 *   node scripts/nav-jank-report.mjs <base.json> <head.json>   compare two
 *   node scripts/nav-jank-report.mjs --ab <off.json> <on.json> governor off vs on
 *
 * One file: per trajectory, the warm-run medians (and the cold run) of the
 * active-window frame p50/p95/p99, frames over 50 and 100 ms, jank events and
 * longest starvation, then input-to-draw p95, upload p95, LOD churn per
 * second, quality transitions, EDL flaps after the last input, time to
 * stationary quality and long tasks; then the whole-run view (frame p95/p99,
 * frames over 100 ms, starvation, idle wakes) and long-task time by owner.
 *
 * Two files: the per-metric difference of the warm medians next to the
 * run-to-run spread (the larger of the two IQRs), marking a difference larger
 * than the spread. It refuses files of another kind or version, a different
 * environment fingerprint (browser, OS, renderer, DPR, dataset, flags), and a
 * trajectory whose digest differs, since none of those differences is a code
 * change. Exit 2 on a refusal.
 *
 * --ab: the same comparison between a governor-off and a governor-on session
 * of one commit. Every environment field must match except the `governor=on`
 * flag, which the off file must lack and the on file must carry.
 */
import { readFileSync } from 'node:fs';
import { isCliEntry } from './lib/isCliEntry.mjs';
import { FINGERPRINT_KEYS, METRICS, RESULTS_KIND, RESULTS_VERSION, SECONDARY_METRICS } from './lib/navJankResults.mjs';

const LABELS = {
  frameP50Ms: 'frame p50 ms',
  frameP95Ms: 'frame p95 ms',
  frameP99Ms: 'frame p99 ms',
  over50: '>50 ms',
  over100: '>100 ms',
  jankEvents: 'jank events',
  longestStarvationMs: 'starvation ms',
  activeDurationMs: 'active window ms',
  inputToDrawP95Ms: 'input→draw p95 ms',
  uploadP95Ms: 'upload p95 ms',
  lodChurnPerSec: 'LOD churn/s',
  qualityTransitions: 'quality trans.',
  postInputEdlFlaps: 'EDL flaps after input',
  timeToStationaryQualityMs: 'to stationary quality ms',
  longTasks: 'long tasks',
  wholeFrameP95Ms: 'whole-run frame p95 ms',
  wholeFrameP99Ms: 'whole-run frame p99 ms',
  wholeOver100: 'whole-run >100 ms',
  wholeStarvationMs: 'whole-run starvation ms',
  idleWakes: 'idle wakes',
};

const PRIMARY = METRICS.map(([k]) => k).filter((k) => !SECONDARY_METRICS.includes(k));

const fmt = (v) => (v === null || v === undefined ? '-' : Number.isInteger(v) ? String(v) : v.toFixed(1));

function pad(rows) {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  return rows.map((r) => r.map((v, c) => (c === 0 ? String(v).padEnd(widths[c]) : String(v).padStart(widths[c]))).join('  ')).join('\n');
}

/** Throw unless `f` is a results file this script reads. */
export function assertResults(f, label = 'file') {
  if (!f || f.kind !== RESULTS_KIND) throw new Error(`${label}: not a nav-jank results file`);
  if (f.version !== RESULTS_VERSION) throw new Error(`${label}: results version ${f.version}, this report reads ${RESULTS_VERSION}`);
}

/** The table of one results file. */
export function formatTable(f) {
  assertResults(f);
  const names = Object.keys(f.trajectories);
  const header = ['metric', ...names.flatMap((n) => [`${n} warm`, 'cold'])];
  const rows = [header];
  const secondary = [['whole run (secondary)', ...names.flatMap((n) => [`${n} warm`, 'cold'])]];
  for (const [k] of METRICS) {
    (SECONDARY_METRICS.includes(k) ? secondary : rows).push([
      LABELS[k] ?? k,
      ...names.flatMap((n) => {
        const t = f.trajectories[n];
        return [fmt(t.warmMedians?.[k]?.median), fmt(t.coldMetrics?.[k])];
      }),
    ]);
  }
  const owners = [...new Set(names.flatMap((n) => Object.keys(f.trajectories[n].longTasksByOwner)))].sort();
  const ownerRows = [['long-task ms by owner', ...names]];
  for (const o of owners) ownerRows.push([o, ...names.map((n) => fmt(f.trajectories[n].longTasksByOwner[o]?.totalMs ?? 0))]);
  const env = FINGERPRINT_KEYS.map((k) => `${k}: ${JSON.stringify(f.fingerprint[k])}`).join('\n');
  const runs = names.map((n) => `${n} ${f.trajectories[n].warmMedians?.frameP50Ms?.n ?? 0} warm`).join(', ');
  return [
    `commit ${f.commit}  machine ${f.machine}  generated ${f.generatedAt}`,
    env,
    `runs: ${runs} (+1 cold each)`,
    '',
    pad(rows),
    '',
    pad(secondary),
    ...(owners.length ? ['', pad(ownerRows)] : []),
  ].join('\n');
}

/** Why `a` and `b` cannot be compared, or [] when they can. */
export function compareRefusals(a, b) {
  const out = [];
  for (const [f, l] of [[a, 'base'], [b, 'head']]) {
    try {
      assertResults(f, l);
    } catch (e) {
      out.push(e.message);
    }
  }
  if (out.length) return out;
  for (const k of FINGERPRINT_KEYS) {
    if (JSON.stringify(a.fingerprint[k]) !== JSON.stringify(b.fingerprint[k])) {
      out.push(`environment differs in ${k}: ${JSON.stringify(a.fingerprint[k])} vs ${JSON.stringify(b.fingerprint[k])}`);
    }
  }
  const shared = Object.keys(a.trajectories).filter((n) => n in b.trajectories);
  if (shared.length === 0) out.push('no trajectory in common');
  for (const n of shared) {
    if (a.trajectories[n].trajectoryDigest !== b.trajectories[n].trajectoryDigest) out.push(`${n}: trajectory digest differs`);
  }
  return out;
}

/** The flag a governor-on session carries in its fingerprint. */
export const GOVERNOR_FLAG = 'governor=on';

/** Why `off` and `on` are not a governor A/B pair, or [] when they are. */
export function abRefusals(off, on) {
  const out = [];
  for (const [f, l] of [[off, 'off'], [on, 'on']]) {
    try {
      assertResults(f, l);
    } catch (e) {
      out.push(e.message);
    }
  }
  if (out.length) return out;
  if (off.fingerprint.flags?.includes(GOVERNOR_FLAG)) out.push(`off file carries the ${GOVERNOR_FLAG} flag`);
  if (!on.fingerprint.flags?.includes(GOVERNOR_FLAG)) out.push(`on file lacks the ${GOVERNOR_FLAG} flag`);
  const strip = (f) => ({ ...f.fingerprint, flags: (f.fingerprint.flags ?? []).filter((x) => x !== GOVERNOR_FLAG) });
  const a = strip(off);
  const b = strip(on);
  for (const k of FINGERPRINT_KEYS) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(`environment differs in ${k}: ${JSON.stringify(a[k])} vs ${JSON.stringify(b[k])}`);
  }
  if (off.commit !== on.commit) out.push(`commit differs: ${off.commit} vs ${on.commit}`);
  const shared = Object.keys(off.trajectories).filter((n) => n in on.trajectories);
  if (shared.length === 0) out.push('no trajectory in common');
  for (const n of shared) {
    if (off.trajectories[n].trajectoryDigest !== on.trajectories[n].trajectoryDigest) out.push(`${n}: trajectory digest differs`);
  }
  return out;
}

/** Per trajectory and metric: base and head medians, difference, spread, and whether |diff| > spread. */
export function compareResults(a, b, refuse = compareRefusals) {
  const refusals = refuse(a, b);
  if (refusals.length) throw new Error(`refusing to compare:\n  ${refusals.join('\n  ')}`);
  const out = {};
  for (const n of Object.keys(a.trajectories).filter((x) => x in b.trajectories)) {
    const ma = a.trajectories[n].warmMedians;
    const mb = b.trajectories[n].warmMedians;
    if (!ma || !mb) continue;
    out[n] = {};
    for (const [k] of METRICS) {
      const diff = mb[k].median - ma[k].median;
      const noise = Math.max(ma[k].iqr, mb[k].iqr);
      out[n][k] = { base: ma[k].median, head: mb[k].median, diff, noise, beyondNoise: Math.abs(diff) > noise };
    }
  }
  return out;
}

/** The comparison as text. */
export function formatComparison(a, b, refuse = compareRefusals) {
  const cmp = compareResults(a, b, refuse);
  const head = refuse === abRefusals ? `governor off vs on, commit ${a.commit}` : `base ${a.commit}  head ${b.commit}`;
  const blocks = [`${head}  (IQR = larger run-to-run interquartile range; * = |diff| > IQR)`];
  for (const [n, metrics] of Object.entries(cmp)) {
    const rows = [[n, 'base', 'head', 'diff', 'IQR', '']];
    for (const k of [...PRIMARY, ...SECONDARY_METRICS]) {
      const m = metrics[k];
      rows.push([LABELS[k] ?? k, fmt(m.base), fmt(m.head), (m.diff > 0 ? '+' : '') + fmt(m.diff), fmt(m.noise), m.beyondNoise ? '*' : '']);
    }
    blocks.push('', pad(rows));
  }
  return blocks.join('\n');
}

if (isCliEntry(import.meta.url)) {
  const args = process.argv.slice(2);
  const ab = args[0] === '--ab';
  const files = ab ? args.slice(1) : args;
  if (files.length < 1 || files.length > 2 || (ab && files.length !== 2)) {
    console.error('usage: nav-jank-report.mjs <results.json> [<head-results.json>] | --ab <off.json> <on.json>');
    process.exit(1);
  }
  const refuse = ab ? abRefusals : compareRefusals;
  const data = files.map((p) => JSON.parse(readFileSync(p, 'utf8')));
  try {
    if (data.length === 1) console.log(formatTable(data[0]));
    else {
      const refusals = refuse(data[0], data[1]);
      if (refusals.length) {
        console.error(`refusing to compare:\n  ${refusals.join('\n  ')}`);
        process.exit(2);
      }
      console.log(formatComparison(data[0], data[1], refuse));
    }
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
