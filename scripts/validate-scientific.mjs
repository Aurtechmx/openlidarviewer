#!/usr/bin/env node
/**
 * validate-scientific.mjs — one command that replays the scientific evidence.
 *
 * This is an ORCHESTRATOR, not a verifier. Every check it runs already exists as
 * its own npm script and its own file under scripts/, and the science lives
 * there and stays there. What was missing was a single entry point that runs
 * those checks in a fixed order, records what each one said, and writes the
 * result down in three shapes a reviewer can read or a machine can diff. That is
 * all this file does. It computes no metric, promotes no claim, and never edits a
 * record; a green run here means "the evidence that was already committed still
 * verifies and still lines up", nothing more.
 *
 * WHAT IT RUNS, IN ORDER. The steps follow the shape a reader checks the project
 * in: the data first, then the studies built on it, then the provenance that
 * pins the run, then the register the claims are stated in, then the temporal
 * freeze that says the tolerances were set before the results.
 *
 *   1. dataset register        validation:datasets:verify
 *   2. the frozen studies       validation:study:verify (cross-implementation E4)
 *      and evidence records      validation:field:verify
 *                                validation:reproduction:verify
 *                                validation:generalization:verify
 *                                validation:impact:verify
 *                                validation:impact:summary:check
 *                                validation:snapshot:verify
 *   3. provenance              recorded here, not delegated: commit sha, the
 *                              reproducible timestamp, app and node versions, the
 *                              tool pins the sbom carries, and the reference tools
 *                              the cross-implementation manifests name
 *   4. claim register          lint:claim-register (register <-> runtime links)
 *   5. temporal freeze         validation:freeze:verify
 *
 * HOW IT CALLS THEM. Through `npm run --silent <id>`, so the exact flags a check
 * needs (`--controls`, `--check`) stay defined once, in package.json, and are
 * never copied here. Duplicating a verifier's flag list would be one more place
 * to drift. `execFileSync` gives the child's stdout and its real exit code; the
 * runner reads the first "OK" line for the count each check reports and treats a
 * non-zero exit as a failure of that step.
 *
 * THE FREEZE STEP IS ALLOWED TO SAY "UNSUPPORTED". verify-freeze-claims.mjs needs
 * git history to witness a preregistration, and an extracted source archive has
 * no `.git`. There it prints `{"status":"unsupported"}` and exits 0 on purpose,
 * rather than false-failing every claim. This runner honours that: an unsupported
 * freeze is recorded as unsupported and does not fail the run, it only turns a
 * PASS into a PARTIAL so the degraded context is never silently read as full
 * verification. The provenance step degrades the same way when there is no git.
 *
 * REPRODUCIBLE TIMESTAMP. The reports carry a run timestamp, and a real wall
 * clock would make two runs of the same commit differ byte for byte. So the stamp
 * is resolved the way scripts/package.sh resolves SOURCE_DATE_EPOCH: the
 * SOURCE_DATE_EPOCH environment variable if set, else the HEAD commit's committer
 * time, else the wall clock as a last resort (and the report says which of the
 * three it used). On a fixed checkout with no override every run writes the same
 * bytes.
 *
 * OUTPUT. Three artifacts under reports/scientific/ (a gitignored tree, so a run
 * never dirties the working tree): a machine JSON with every step, a CSV with one
 * row per check, and a human Markdown report. Change the directory with --out.
 *
 * EXIT. Non-zero when any mandatory check fails or errors. `unsupported` (archive
 * freeze) and a git-less provenance are non-fatal and yield PARTIAL. Everything
 * green with full context yields PASS.
 *
 * Usage:
 *   node scripts/validate-scientific.mjs
 *   node scripts/validate-scientific.mjs --out <dir>
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The checks, in the order a reader walks the project. Every `script` is an
// existing package.json entry; nothing here reimplements what it runs. `group`
// is only for grouping in the reports. All are mandatory: each one already sits
// in test:release:execute, so a clean checkout passes every one of them.
const CHECKS = [
  { name: 'dataset-register', group: 'datasets', script: 'validation:datasets:verify' },
  { name: 'cross-implementation-study', group: 'studies', script: 'validation:study:verify' },
  { name: 'field-study', group: 'studies', script: 'validation:field:verify' },
  { name: 'reproduction-record', group: 'studies', script: 'validation:reproduction:verify' },
  { name: 'generalization-record', group: 'studies', script: 'validation:generalization:verify' },
  { name: 'impact-record', group: 'studies', script: 'validation:impact:verify' },
  { name: 'impact-summary', group: 'studies', script: 'validation:impact:summary:check' },
  { name: 'validation-snapshot', group: 'studies', script: 'validation:snapshot:verify' },
  { name: 'claim-register', group: 'claim-register', script: 'lint:claim-register' },
  // freeze is run last and handled specially: it may report "unsupported".
  { name: 'freeze-claims', group: 'freeze', script: 'validation:freeze:verify', freeze: true },
];

// The sbom components worth pinning in a provenance record: the libraries that
// actually shape a numeric result the viewer produces. Read from sbom.json, which
// carries resolved versions rather than the ranges package.json states, and is
// corroborated by THIRD_PARTY_NOTICES.md.
const PINNED_TOOLS = ['proj4', 'three', 'laz-perf', '@loaders.gl/core', 'pdf-lib'];

const STUDIES_DIR = 'validation/cross-implementation/studies';

// ── running a check ──────────────────────────────────────────────────────────

/** Run one npm script. Returns its real exit code plus captured streams. */
function runNpm(scriptId) {
  try {
    const stdout = execFileSync('npm', ['run', '--silent', scriptId], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err) {
    // A non-zero child makes execFileSync throw; the fields carry what it wrote.
    return {
      exitCode: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout ? String(err.stdout) : '',
      stderr: err.stderr ? String(err.stderr) : String(err.message ?? ''),
    };
  }
}

/**
 * The one line worth quoting from a check's output: its own "OK ..." summary if
 * it printed one, a top-level "✓ N ..." count line (the snapshot check reports
 * "✓ 8 of 8 controls refused" instead of an OK line), its "FAILED" headline if
 * it failed, its bare "✓ PASS", or the last thing it said.
 */
function summaryLine(stdout, stderr) {
  const lines = `${stdout}\n${stderr}`.split('\n').map((l) => l.trim()).filter(Boolean);
  return (
    // A successful check prints its own "OK ..." line, so that wins first. Only
    // when there is none do we reach for a failure headline (so a failed step is
    // never summarised by a passing-looking control line), then the snapshot's
    // "✓ N ..." count line, then a bare PASS, then whatever it said last.
    lines.find((l) => /\bOK\b/.test(l)) ??
    lines.find((l) => /FAILED/i.test(l) || /^✗/.test(l)) ??
    lines.find((l) => /^✓ \d/.test(l)) ??
    lines.find((l) => /\bPASS\b/.test(l)) ??
    lines[lines.length - 1] ??
    ''
  );
}

/** The counts a summary line reports: the first number after "OK", and all of them. */
function numbersOf(line) {
  const all = [...line.matchAll(/\d[\d,]*/g)].map((m) => Number.parseInt(m[0].replace(/,/g, ''), 10));
  const afterOk = line.match(/OK\b[^0-9]*([0-9][0-9,]*)/);
  const primary = afterOk ? Number.parseInt(afterOk[1].replace(/,/g, ''), 10) : (all[0] ?? null);
  return { primary, all };
}

/** The `{"status":"unsupported"}` object the freeze check prints in archive mode, or null. */
function unsupportedStatus(stdout) {
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object' && typeof obj.status === 'string') return obj;
    } catch {
      // Not the JSON line; keep scanning.
    }
  }
  return null;
}

// ── provenance ───────────────────────────────────────────────────────────────

/** git output, trimmed, or null when there is no repository to answer. */
function git(...argv) {
  try {
    return execFileSync('git', argv, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * The reproducible run stamp, resolved exactly as scripts/package.sh resolves
 * SOURCE_DATE_EPOCH: the environment override first, then HEAD's committer time,
 * then the wall clock. The source is recorded so a reader knows which one held.
 */
function resolveEpoch() {
  const env = process.env.SOURCE_DATE_EPOCH;
  if (env && /^\d+$/.test(env.trim())) {
    return { epoch: Number.parseInt(env.trim(), 10), source: 'env:SOURCE_DATE_EPOCH' };
  }
  const committed = git('show', '-s', '--format=%ct', 'HEAD');
  if (committed && /^\d+$/.test(committed)) {
    return { epoch: Number.parseInt(committed, 10), source: 'git:HEAD-committer-time' };
  }
  return { epoch: Math.floor(Date.now() / 1000), source: 'wall-clock-fallback' };
}

/** Resolved versions for the pinned tools, read from the committed sbom. */
function sbomProvenance() {
  const out = { pins: {}, sbom: null };
  let sbom;
  try {
    sbom = JSON.parse(readFileSync(join(ROOT, 'sbom.json'), 'utf8'));
  } catch {
    return out;
  }
  // The sbom stores a scoped package as {group: "@loaders.gl", name: "core"};
  // rebuild the full "@scope/name" so a pin like @loaders.gl/core resolves.
  const byName = new Map();
  for (const c of sbom.components ?? []) {
    if (!c || typeof c.name !== 'string') continue;
    const full = c.group ? `${c.group}/${c.name}` : c.name;
    if (!byName.has(full)) byName.set(full, c.version ?? null);
  }
  for (const name of PINNED_TOOLS) {
    if (byName.has(name)) out.pins[name] = byName.get(name);
  }
  const generators = (sbom.metadata?.tools?.components ?? [])
    .map((t) => (t?.version ? `${t.name}@${t.version}` : t?.name))
    .filter(Boolean);
  out.sbom = {
    bomFormat: sbom.bomFormat ?? null,
    specVersion: sbom.specVersion ?? null,
    components: Array.isArray(sbom.components) ? sbom.components.length : null,
    generators,
  };
  return out;
}

/** The reference tools the non-example cross-implementation manifests name (GDAL, PDAL, ...). */
function referenceTools() {
  const dir = join(ROOT, STUDIES_DIR);
  if (!existsSync(dir)) return [];
  const seen = new Map();
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json') || name.startsWith('EXAMPLE-')) continue;
    let m;
    try {
      m = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    const rt = m.reference ?? null;
    if (rt && typeof rt.tool === 'string') {
      const key = `${rt.tool}@${rt.version ?? '?'}`;
      if (!seen.has(key)) seen.set(key, { tool: rt.tool, version: rt.version ?? null });
    }
  }
  return [...seen.values()];
}

/**
 * The provenance step. It records rather than verifies, so it never fails; when
 * there is no git it degrades (sha "unavailable — archive") and marks itself so,
 * which turns the whole run into a PARTIAL the same way an unsupported freeze
 * does.
 */
function provenanceStep(stamp) {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const sha = git('rev-parse', 'HEAD');
  const inRepo = sha !== null;
  const { pins, sbom } = sbomProvenance();

  const data = {
    commit: inRepo ? sha : 'unavailable — archive',
    commitShort: inRepo ? sha.slice(0, 12) : 'unavailable — archive',
    commitDate: inRepo ? git('show', '-s', '--format=%cI', 'HEAD') : null,
    mode: inRepo ? 'git' : 'archive',
    reproducibleTimestamp: { epoch: stamp.epoch, iso: stamp.iso, source: stamp.source },
    app: { name: pkg.name, version: pkg.version },
    node: process.version,
    enginesNode: pkg.engines?.node ?? null,
    packageManager: pkg.packageManager ?? null,
    toolPins: pins,
    referenceTools: referenceTools(),
    sbom,
  };

  const pinText = Object.entries(pins).map(([k, v]) => `${k}@${v}`).join(', ') || 'none';
  const summary =
    `commit ${data.commitShort} (${data.mode}), ${pkg.name} ${pkg.version}, node ${process.version}; ` +
    `sbom pins ${pinText}; stamp source ${stamp.source}`;

  return {
    name: 'provenance',
    group: 'provenance',
    script: null,
    mandatory: false,
    status: 'recorded',
    degraded: !inRepo,
    exitCode: 0,
    summary,
    numbers: { primary: null, all: [] },
    data,
    timestamp: stamp.iso,
  };
}

// ── report writers ───────────────────────────────────────────────────────────

function csvCell(value) {
  const s = String(value ?? '').replace(/[\r\n]+/g, ' ');
  return `"${s.replace(/"/g, '""')}"`;
}

function writeReports(outDir, run) {
  mkdirSync(outDir, { recursive: true });

  const jsonPath = join(outDir, 'scientific-validation.json');
  writeFileSync(jsonPath, `${JSON.stringify(run, null, 2)}\n`);

  const csvPath = join(outDir, 'scientific-validation.csv');
  const header = 'check,group,script,status,mandatory,exit_code,primary_count,summary';
  const rows = run.steps.map((s) =>
    [
      csvCell(s.name),
      csvCell(s.group),
      csvCell(s.script ?? ''),
      csvCell(s.status),
      csvCell(s.mandatory),
      csvCell(s.exitCode),
      csvCell(s.numbers?.primary ?? ''),
      csvCell(s.summary),
    ].join(','),
  );
  writeFileSync(csvPath, `${[header, ...rows].join('\n')}\n`);

  const mdPath = join(outDir, 'scientific-validation.md');
  writeFileSync(mdPath, markdown(run));

  return { jsonPath, csvPath, mdPath };
}

const STATUS_MARK = { pass: 'pass', fail: 'FAIL', unsupported: 'unsupported', recorded: 'recorded', error: 'ERROR' };

function markdown(run) {
  const p = run.provenance;
  const lines = [];
  lines.push('# Scientific validation report');
  lines.push('');
  lines.push(
    'Generated by `scripts/validate-scientific.mjs`, which orchestrates the existing ' +
      'validation scripts. It records what each committed check reports; it does not ' +
      'recompute any metric or move any claim.',
  );
  lines.push('');
  lines.push(`- Result: **${run.overall}**`);
  lines.push(`- Generated at: ${run.generatedAt} (source: ${run.timestampSource})`);
  lines.push(`- Commit: ${p.commit} (${p.mode})`);
  lines.push(`- App: ${p.app.name} ${p.app.version}, node ${p.node}`);
  lines.push(
    `- Checks: ${run.summary.checks} total, ${run.summary.passed} passed, ` +
      `${run.summary.unsupported} unsupported, ${run.summary.failed} failed, ${run.summary.recorded} recorded`,
  );
  lines.push('');
  lines.push('## Checks');
  lines.push('');
  lines.push('| Check | Group | Status | Count | Summary |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const s of run.steps) {
    const count = s.numbers?.primary ?? '';
    const summary = String(s.summary ?? '').replace(/\|/g, '\\|');
    lines.push(`| ${s.name} | ${s.group} | ${STATUS_MARK[s.status] ?? s.status} | ${count} | ${summary} |`);
  }
  lines.push('');
  lines.push('## Provenance');
  lines.push('');
  lines.push(`- Reproducible stamp: ${p.reproducibleTimestamp.iso} (source: ${p.reproducibleTimestamp.source})`);
  lines.push(`- engines.node: ${p.enginesNode ?? 'n/a'}; packageManager: ${p.packageManager ?? 'n/a'}`);
  const pins = Object.entries(p.toolPins);
  lines.push(`- sbom tool pins: ${pins.length ? pins.map(([k, v]) => `${k}@${v}`).join(', ') : 'none'}`);
  const refs = p.referenceTools;
  lines.push(
    `- reference tools (cross-implementation): ${
      refs.length ? refs.map((r) => `${r.tool}@${r.version ?? '?'}`).join(', ') : 'none'
    }`,
  );
  if (p.sbom) {
    lines.push(
      `- sbom: ${p.sbom.bomFormat ?? '?'} ${p.sbom.specVersion ?? ''}, ${p.sbom.components ?? '?'} components`,
    );
  }
  lines.push('');
  lines.push('## What a green run means');
  lines.push('');
  lines.push(
    'Every committed evidence record still verifies, the register and the runtime ' +
      'registry still agree, and the temporal freeze still holds (or is unsupported in ' +
      'an archive, which is recorded, not a failure). No claim was promoted by this run.',
  );
  lines.push('');
  return lines.join('\n');
}

// ── main ─────────────────────────────────────────────────────────────────────

function parseOut(argv) {
  const i = argv.indexOf('--out');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : 'reports/scientific';
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      'Usage: node scripts/validate-scientific.mjs [--out <dir>]\n' +
        'Orchestrates the existing validation checks and writes JSON, CSV and Markdown reports.\n',
    );
    return 0;
  }

  const stampRaw = resolveEpoch();
  const stamp = { ...stampRaw, iso: new Date(stampRaw.epoch * 1000).toISOString() };
  const outDir = resolve(ROOT, parseOut(argv));

  process.stdout.write('scientific evidence runner (orchestrates existing validation checks)\n');

  const steps = [];

  // The verifier checks, in the fixed order, with provenance recorded between the
  // studies and the claim register.
  for (const check of CHECKS) {
    if (check.group === 'claim-register' && !steps.some((s) => s.name === 'provenance')) {
      const prov = provenanceStep(stamp);
      steps.push(prov);
      process.stdout.write(`  [${prov.status}] ${prov.name.padEnd(26)} ${prov.summary}\n`);
    }

    const run = runNpm(check.script);
    const line = summaryLine(run.stdout, run.stderr);
    let status;
    let summary = line;

    if (check.freeze && run.exitCode === 0) {
      const unsupported = unsupportedStatus(run.stdout);
      if (unsupported) {
        status = 'unsupported';
        summary = `unsupported: ${unsupported.reason ?? 'freeze check cannot run in this context'}`;
      } else {
        status = 'pass';
      }
    } else {
      status = run.exitCode === 0 ? 'pass' : 'fail';
    }

    steps.push({
      name: check.name,
      group: check.group,
      script: check.script,
      mandatory: true,
      status,
      exitCode: run.exitCode,
      summary,
      numbers: numbersOf(line),
      timestamp: stamp.iso,
    });
    process.stdout.write(`  [${STATUS_MARK[status] ?? status}] ${check.name.padEnd(26)} ${summary}\n`);
  }

  const provenance = steps.find((s) => s.name === 'provenance');

  const summaryCounts = {
    checks: steps.length,
    passed: steps.filter((s) => s.status === 'pass').length,
    unsupported: steps.filter((s) => s.status === 'unsupported').length,
    failed: steps.filter((s) => s.status === 'fail' || s.status === 'error').length,
    recorded: steps.filter((s) => s.status === 'recorded').length,
  };

  const mandatoryFailed = steps.some((s) => s.mandatory && (s.status === 'fail' || s.status === 'error'));
  const anyUnsupported = steps.some((s) => s.status === 'unsupported');
  const anyDegraded = steps.some((s) => s.degraded === true);
  const overall = mandatoryFailed ? 'FAIL' : anyUnsupported || anyDegraded ? 'PARTIAL' : 'PASS';

  const run = {
    tool: 'validate-scientific',
    schemaVersion: 1,
    generatedAt: stamp.iso,
    timestampSource: stamp.source,
    overall,
    summary: summaryCounts,
    provenance: provenance.data,
    steps,
  };

  const written = writeReports(outDir, run);

  process.stdout.write('\n');
  process.stdout.write(
    `${overall}: ${summaryCounts.checks} checks, ${summaryCounts.passed} passed, ` +
      `${summaryCounts.unsupported} unsupported, ${summaryCounts.failed} failed, ` +
      `${summaryCounts.recorded} recorded.\n`,
  );
  for (const f of [written.jsonPath, written.csvPath, written.mdPath]) {
    process.stdout.write(`  report: ${relative(ROOT, f)}\n`);
  }

  return overall === 'FAIL' ? 1 : 0;
}

process.exit(main());
