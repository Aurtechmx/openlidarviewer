#!/usr/bin/env node
/**
 * nav-jank-report.mjs: print a heavy-navigation benchmark result.
 *
 *   node scripts/nav-jank-report.mjs <results.json>            one session
 *   node scripts/nav-jank-report.mjs <base.json> <head.json>   compare two
 *
 * One file: per trajectory, the warm-run medians (and the cold run) of frame
 * p50/p95/p99, frames over 50 and 100 ms, jank events, input-to-draw p95,
 * longest starvation, upload p95, LOD churn per second, quality transitions
 * and long tasks, then long-task time by owner.
 *
 * Two files: the per-metric difference of the warm medians next to the
 * run-to-run spread (the larger of the two IQRs), marking a difference larger
 * than the spread. It refuses files of another kind or version, a different
 * environment fingerprint (browser, OS, renderer, DPR, dataset, flags), and a
 * trajectory whose digest differs, since none of those differences is a code
 * change. Exit 2 on a refusal.
 */
import { readFileSync } from 'node:fs';
import { isCliEntry } from './lib/isCliEntry.mjs';
import { FINGERPRINT_KEYS, METRICS, RESULTS_KIND, RESULTS_VERSION } from './lib/navJankResults.mjs';

const LABELS = {
  frameP50Ms: 'frame p50 ms',
  frameP95Ms: 'frame p95 ms',
  frameP99Ms: 'frame p99 ms',
  over50: '>50 ms',
  over100: '>100 ms',
  jankEvents: 'jank events',
  inputToDrawP95Ms: 'input→draw p95 ms',
  longestStarvationMs: 'starvation ms',
  uploadP95Ms: 'upload p95 ms',
  lodChurnPerSec: 'LOD churn/s',
  qualityTransitions: 'quality trans.',
  longTasks: 'long tasks',
};

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
  for (const [k] of METRICS) {
    rows.push([
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

/** Per trajectory and metric: base and head medians, difference, spread, and whether |diff| > spread. */
export function compareResults(a, b) {
  const refusals = compareRefusals(a, b);
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
export function formatComparison(a, b) {
  const cmp = compareResults(a, b);
  const blocks = [`base ${a.commit}  head ${b.commit}  (IQR = larger run-to-run interquartile range; * = |diff| > IQR)`];
  for (const [n, metrics] of Object.entries(cmp)) {
    const rows = [[n, 'base', 'head', 'diff', 'IQR', '']];
    for (const [k, m] of Object.entries(metrics)) {
      rows.push([LABELS[k] ?? k, fmt(m.base), fmt(m.head), (m.diff > 0 ? '+' : '') + fmt(m.diff), fmt(m.noise), m.beyondNoise ? '*' : '']);
    }
    blocks.push('', pad(rows));
  }
  return blocks.join('\n');
}

if (isCliEntry(import.meta.url)) {
  const files = process.argv.slice(2);
  if (files.length < 1 || files.length > 2) {
    console.error('usage: nav-jank-report.mjs <results.json> [<head-results.json>]');
    process.exit(1);
  }
  const data = files.map((p) => JSON.parse(readFileSync(p, 'utf8')));
  try {
    if (data.length === 1) console.log(formatTable(data[0]));
    else {
      const refusals = compareRefusals(data[0], data[1]);
      if (refusals.length) {
        console.error(`refusing to compare:\n  ${refusals.join('\n  ')}`);
        process.exit(2);
      }
      console.log(formatComparison(data[0], data[1]));
    }
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
