/**
 * navJankResults.mjs: the result file of one heavy-navigation benchmark session.
 *
 * A session holds, per trajectory, one cold record (a fresh browser context)
 * and one warm record (N runs in a reused context). Each record is a
 * nav-jank.schema.json record; this file wraps them with the environment
 * fingerprint they share, the dataset, the load times, and the per-trajectory
 * medians and interquartile ranges the report compares.
 *
 * Pure: no IO. The runner writes the object, the report reads it back.
 */

export const RESULTS_KIND = 'olv-nav-jank-results';
export const RESULTS_VERSION = 1;

/** The metrics the report prints, in order, with how to read each from a probe summary. */
export const METRICS = [
  ['frameP50Ms', (s) => s.frameMs.p50],
  ['frameP95Ms', (s) => s.frameMs.p95],
  ['frameP99Ms', (s) => s.frameMs.p99],
  ['over50', (s) => s.over['50']],
  ['over100', (s) => s.over['100']],
  ['jankEvents', (s) => s.jank.events],
  ['inputToDrawP95Ms', (s) => s.inputToDrawMs.p95],
  ['longestStarvationMs', (s) => s.longestStarvationMs],
  ['uploadP95Ms', (s) => s.upload.p95Ms],
  ['lodChurnPerSec', (s) => s.lod.churnPerSec],
  ['qualityTransitions', (s) => s.quality.transitions],
  ['longTasks', (s) => s.longTasks.count],
];

/** The env fields two sessions must share to be compared (commit and cache are what differ). */
export const FINGERPRINT_KEYS = ['browser', 'os', 'renderer', 'dpr', 'datasetSha256', 'flags'];

/** Linear-interpolated quantile of an ascending array. */
export function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Median and interquartile range of `values`. */
export function spread(values) {
  const s = [...values].sort((a, b) => a - b);
  return { median: quantile(s, 0.5), iqr: quantile(s, 0.75) - quantile(s, 0.25), n: s.length };
}

/** One flat metric row for a probe summary. */
export function runMetrics(summary) {
  const row = {};
  for (const [k, read] of METRICS) row[k] = read(summary);
  return row;
}

/** Long-task milliseconds by owner, summed over the runs. */
export function longTasksByOwner(summaries) {
  const out = {};
  for (const s of summaries) {
    for (const [owner, v] of Object.entries(s.longTasks.byOwner)) {
      const o = (out[owner] ??= { count: 0, totalMs: 0 });
      o.count += v.count;
      o.totalMs += v.totalMs;
    }
  }
  return out;
}

/** Median and IQR per metric across the runs of `summaries`. */
export function summarizeRuns(summaries) {
  const rows = summaries.map(runMetrics);
  const out = {};
  for (const [k] of METRICS) out[k] = spread(rows.map((r) => r[k]));
  return out;
}

function fingerprintOf(env) {
  const f = {};
  for (const k of FINGERPRINT_KEYS) f[k] = env[k];
  return f;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Assemble a results file.
 *
 * `trajectories` maps a trajectory name to `{ cold, warm, loads }`: `cold` and
 * `warm` are nav-jank records, `loads` the per-run load timings. Every record
 * must share one fingerprint, and a trajectory's cold and warm records one
 * trajectory digest; a mismatch throws, since the file would compare unlike runs.
 */
export function buildNavJankResults({ generatedAt, machine, dataset, trajectories, notes = [] }) {
  const names = Object.keys(trajectories);
  if (names.length === 0) throw new Error('a results file needs at least one trajectory');
  const first = trajectories[names[0]].cold ?? trajectories[names[0]].warm;
  const fingerprint = fingerprintOf(first.env);
  const out = {};
  for (const name of names) {
    const { cold, warm, loads = [] } = trajectories[name];
    const records = [cold, warm].filter(Boolean);
    for (const r of records) {
      if (!same(fingerprintOf(r.env), fingerprint)) throw new Error(`${name}: environment differs from the session's`);
    }
    const digest = records[0].env.trajectoryDigest;
    if (records.some((r) => r.env.trajectoryDigest !== digest)) throw new Error(`${name}: trajectory digests differ`);
    const warmSummaries = warm ? warm.runs.map((r) => r.summary) : [];
    out[name] = {
      trajectoryDigest: digest,
      cold: cold ?? null,
      warm: warm ?? null,
      loads,
      coldMetrics: cold ? runMetrics(cold.runs[0].summary) : null,
      warmMedians: warm ? summarizeRuns(warmSummaries) : null,
      longTasksByOwner: longTasksByOwner([...(cold ? [cold.runs[0].summary] : []), ...warmSummaries]),
    };
  }
  return {
    kind: RESULTS_KIND,
    version: RESULTS_VERSION,
    recordSchema: 'validation/performance/nav-jank.schema.json',
    generatedAt,
    machine,
    commit: first.env.commit,
    dataset,
    fingerprint,
    trajectories: out,
    notes,
  };
}

/** Merge results files of the same session (e.g. one per trajectory) into one. */
export function mergeNavJankResults(files) {
  if (files.length === 0) throw new Error('nothing to merge');
  const [a] = files;
  for (const f of files) {
    if (f.kind !== RESULTS_KIND || f.version !== RESULTS_VERSION) throw new Error('not a nav-jank results file of this version');
    if (!same(f.fingerprint, a.fingerprint) || f.commit !== a.commit || f.machine !== a.machine) {
      throw new Error('cannot merge results from different environments or commits');
    }
  }
  const trajectories = {};
  for (const f of files) Object.assign(trajectories, f.trajectories);
  return { ...a, trajectories, notes: [...new Set(files.flatMap((f) => f.notes))] };
}

/** `<YYYY-MM-DD>-<shortsha>-<machine>.json`. */
export function resultFileName(date, commit, machine) {
  const day = date.toISOString().slice(0, 10);
  const tag = String(machine).replace(/[^A-Za-z0-9._-]+/g, '-');
  return `${day}-${commit.slice(0, 8)}-${tag}.json`;
}
