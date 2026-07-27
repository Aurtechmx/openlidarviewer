#!/usr/bin/env node
/**
 * verify-validation-snapshot.mjs — recheck a validation snapshot from its own
 * bytes.
 *
 *   npm run validation:snapshot:verify
 *   node scripts/verify-validation-snapshot.mjs --dir <extracted-snapshot>
 *   node scripts/verify-validation-snapshot.mjs --controls
 *
 * Three things happen on every run, in this order:
 *
 *   1. the checksum manifest is read in both directions — nothing it lists is
 *      missing or altered, and nothing present is unlisted;
 *   2. every derived value in `snapshot.json` is recomputed from the collected
 *      records and compared;
 *   3. `SUMMARY.md` is regenerated from the recomputed values and compared byte
 *      for byte.
 *
 * Step 2 is what makes step 1 hard to defeat. Editing a record and refreshing
 * its digest satisfies the manifest and then fails re-derivation, because the
 * figures the snapshot states are not stored data, they are a function of the
 * records.
 *
 * The default run checks the snapshot where it sits and then copies it to a
 * directory outside the repository and checks it again there. `--dir` checks a
 * relocated copy only, and refuses a target that is inside the repository or
 * that carries a `.git`, the same structural guard
 * `scripts/verify-archive-portability.mjs` applies to an extracted archive: a
 * check that accidentally reads the working tree cannot pass by looking at the
 * wrong files, because there are no other files to look at.
 *
 * Exit 0 when every check passes, 1 when one fails, 2 on a usage or read error.
 */
import {
  readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync, mkdtempSync, rmSync,
  cpSync, unlinkSync,
} from 'node:fs';
import { dirname, resolve, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { sha256, deriveSnapshot, renderSummary } from './validation-snapshot-lib.mjs';
import { evidenceReader, writeManifest } from './build-validation-snapshot.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DIR = join(ROOT, 'validation/snapshot');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

function walk(dirAbs, base = dirAbs) {
  const out = [];
  for (const e of readdirSync(dirAbs, { withFileTypes: true })) {
    const p = join(dirAbs, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else if (e.isFile()) out.push(relative(base, p).split(/[\\/]/).join('/'));
  }
  return out;
}

/** Refuse a target that could let a check read the repository instead. */
export function guard(dir) {
  const problems = [];
  const rel = relative(ROOT, dir);
  if (rel === '' || !rel.startsWith('..')) {
    problems.push(`${dir} is inside the repository. A relocated check needs a target outside it.`);
  }
  if (existsSync(join(dir, '.git'))) {
    problems.push(`${dir} carries a .git. A relocated snapshot has no repository around it.`);
  }
  return problems;
}

/** The first path at which two JSON values differ, or null. */
export function firstDifference(a, b, path = '') {
  if (a === b) return null;
  const ta = Array.isArray(a) ? 'array' : a === null ? 'null' : typeof a;
  const tb = Array.isArray(b) ? 'array' : b === null ? 'null' : typeof b;
  if (ta !== tb) return { path: path || '(root)', stored: a, derived: b };
  if (ta === 'array') {
    if (a.length !== b.length) return { path: `${path}.length`, stored: a.length, derived: b.length };
    for (let i = 0; i < a.length; i += 1) {
      const d = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (ta === 'object') {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) {
      const d = firstDifference(a[k], b[k], path ? `${path}.${k}` : k);
      if (d) return d;
    }
    return null;
  }
  return { path: path || '(root)', stored: a, derived: b };
}

/** The manifest read in both directions. */
export function checkManifest(dir) {
  const problems = [];
  const manifestPath = join(dir, 'SHA256SUMS');
  if (!existsSync(manifestPath)) return ['the snapshot carries no SHA256SUMS.'];
  const listed = new Map();
  for (const line of readFileSync(manifestPath, 'utf8').split('\n')) {
    const m = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/);
    if (m) listed.set(m[2].trim(), m[1]);
  }
  const present = new Set(walk(dir).filter((p) => p !== 'SHA256SUMS'));
  for (const [p, want] of listed) {
    if (!present.has(p)) {
      problems.push(`SHA256SUMS lists ${p}, which is not in the snapshot.`);
      continue;
    }
    const got = sha256(readFileSync(join(dir, p)));
    if (got !== want) problems.push(`${p} hashes ${got}, the manifest says ${want}.`);
  }
  for (const p of [...present].sort()) {
    if (!listed.has(p)) problems.push(`${p} is in the snapshot and the manifest does not account for it.`);
  }
  return problems;
}

/** Every check, over one snapshot directory. */
export function verifyDir(dir, { relocated }) {
  const steps = [];
  const record = (id, title, problems) => {
    steps.push({ id, title, status: problems.length === 0 ? 'pass' : 'fail', problems });
    return problems.length === 0;
  };

  if (relocated && !record('structural-guard', 'the target is outside the repository and carries no .git', guard(dir))) {
    return steps;
  }
  if (!existsSync(join(dir, 'snapshot.json'))) {
    record('snapshot-present', 'the directory carries a snapshot', [`${dir} has no snapshot.json.`]);
    return steps;
  }
  if (!record('manifest', 'the manifest accounts for the snapshot in both directions', checkManifest(dir))) {
    return steps;
  }

  const stored = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8'));
  const missingCopies = (stored.inputs ?? [])
    .flatMap((i) => i.files.map((f) => f.storedAt))
    .filter((p) => !existsSync(join(dir, p)))
    .map((p) => `snapshot.json cites ${p}, which the snapshot does not carry.`);
  if (!record('records-available', 'every record the snapshot cites is available in it', missingCopies)) {
    return steps;
  }

  const derived = deriveSnapshot(evidenceReader(dir));
  const diff = firstDifference(stored, derived);
  record(
    're-derivation',
    'every derived value recomputes from the records to the value the snapshot states',
    diff ? [`${diff.path}: the snapshot states ${JSON.stringify(diff.stored)}, the records give ${JSON.stringify(diff.derived)}.`] : [],
  );

  const rendered = renderSummary(derived);
  const onDisk = existsSync(join(dir, 'SUMMARY.md')) ? readFileSync(join(dir, 'SUMMARY.md'), 'utf8') : null;
  record(
    'summary',
    'the human-readable summary regenerates byte for byte',
    onDisk === rendered ? [] : [onDisk === null ? 'SUMMARY.md is absent.' : 'SUMMARY.md does not match the summary regenerated from the records.'],
  );

  record(
    'verdict',
    'the snapshot verdict holds',
    derived.verdict === 'PASS' ? [] : derived.failures.map((f) => f),
  );
  return steps;
}

function report(label, steps) {
  console.log(`\n${label}`);
  for (const s of steps) {
    console.log(`  ${s.status === 'pass' ? '✓' : '✗'} ${s.id} — ${s.title}`);
    for (const p of s.problems) console.log(`      ${p}`);
  }
  return steps.every((s) => s.status === 'pass');
}

// ── negative controls ────────────────────────────────────────────────────────

/**
 * Each control tampers with a copy of a good snapshot and asserts the
 * verification refuses it. The refreshed-hash control is the one that matters:
 * it edits a record and then rebuilds the manifest over the edit, so the
 * digests are all correct and only re-derivation is left to catch it.
 */
/** Where a snapshot stores its copy of a collected record. */
function stored(dir, repoPath) {
  const s = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8'));
  for (const input of s.inputs) {
    for (const f of input.files) if (f.path === repoPath) return join(dir, f.storedAt);
  }
  throw new Error(`the snapshot carries no copy of ${repoPath}; a control cannot tamper with it`);
}

/** The record a control removes: the last one the snapshot cites. */
function lastStored(dir) {
  const s = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8'));
  const all = s.inputs.flatMap((i) => i.files.map((f) => f.storedAt));
  return join(dir, all[all.length - 1]);
}

const REGISTRY = 'validation/defects/defect-registry.json';

/** Move one record from code review to a validation suite. */
function editRegistry(path) {
  const j = JSON.parse(readFileSync(path, 'utf8'));
  const target = j.defects.find((d) => d.discoveryMethod === 'code review') ?? j.defects[0];
  target.discoveryMethod = 'validation suite';
  writeFileSync(path, `${JSON.stringify(j, null, 2)}\n`);
}

const CONTROLS = [
  {
    id: 'missing-evidence',
    what: 'a collected record is deleted, the manifest still lists it',
    tamper: (dir) => unlinkSync(stored(dir, REGISTRY)),
  },
  {
    id: 'extra-evidence',
    what: 'a record the manifest does not account for is added',
    tamper: (dir) => writeFileSync(join(dir, 'evidence/extra-record.json'), '{"added":"by hand"}\n'),
  },
  {
    id: 'altered-evidence',
    what: 'a collected record is edited, the manifest is left alone',
    tamper: (dir) => editRegistry(stored(dir, REGISTRY)),
  },
  {
    id: 'altered-evidence-hashes-refreshed',
    what: 'a collected record is edited and every digest is recomputed over the edit',
    tamper: (dir) => {
      editRegistry(stored(dir, REGISTRY));
      writeManifest(dir);
    },
  },
  {
    id: 'unavailable-evidence',
    what: 'a collected record is removed and the manifest is rebuilt without it',
    tamper: (dir) => {
      unlinkSync(lastStored(dir));
      writeManifest(dir);
    },
  },
  {
    id: 'version-mismatched-evidence',
    what: 'one identity source states a different version, with every digest recomputed',
    tamper: (dir) => {
      const p = stored(dir, 'CITATION.cff');
      writeFileSync(p, readFileSync(p, 'utf8').replace(/^version:.*$/m, 'version: "9.9.9"'));
      writeManifest(dir);
    },
  },
];

function runControls(sourceDir) {
  const base = mkdtempSync(join(tmpdir(), 'olv-snapshot-controls-'));
  const rows = [];
  for (const control of CONTROLS) {
    const dir = join(base, control.id);
    mkdirSync(dir, { recursive: true });
    cpSync(sourceDir, dir, { recursive: true });
    try {
      control.tamper(dir);
    } catch (err) {
      rows.push({ id: control.id, what: control.what, caught: false, caughtBy: [], reason: `the control could not be set up: ${err.message}` });
      continue;
    }
    const steps = verifyDir(dir, { relocated: true });
    const failed = steps.filter((s) => s.status === 'fail');
    rows.push({
      id: control.id,
      what: control.what,
      caught: failed.length > 0,
      caughtBy: failed.map((s) => s.id),
      reason: failed[0]?.problems[0] ?? null,
    });
  }
  rmSync(base, { recursive: true, force: true });
  console.log('\nNegative controls');
  for (const r of rows) {
    console.log(`  ${r.caught ? '✓' : '✗'} ${r.id} — ${r.what}`);
    console.log(`      ${r.caught ? `refused by ${r.caughtBy.join(', ')}: ${r.reason}` : 'ACCEPTED, which is a hole in the verification'}`);
  }
  const held = rows.every((r) => r.caught);
  console.log(`\n${held ? '✓' : '✗'} ${rows.filter((r) => r.caught).length} of ${rows.length} controls refused`);
  return held;
}

// ── run ──────────────────────────────────────────────────────────────────────

function main() {
  const explicit = arg('--dir', null);
  if (explicit) {
    const dir = resolve(explicit);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      console.error(`✗ no such directory: ${dir}`);
      return 2;
    }
    console.log(`Validation snapshot — relocated check of ${dir}`);
    return report('relocated', verifyDir(dir, { relocated: true })) ? 0 : 1;
  }

  if (!existsSync(DEFAULT_DIR)) {
    console.error('✗ validation/snapshot is absent. Run `npm run validation:snapshot` first.');
    return 2;
  }
  console.log(`Validation snapshot — checking ${relative(ROOT, DEFAULT_DIR)}`);
  let ok = report('in place', verifyDir(DEFAULT_DIR, { relocated: false }));

  const tmp = mkdtempSync(join(tmpdir(), 'olv-snapshot-'));
  const moved = join(tmp, 'snapshot');
  cpSync(DEFAULT_DIR, moved, { recursive: true });
  ok = report(`relocated to ${moved}`, verifyDir(moved, { relocated: true })) && ok;

  if (process.argv.includes('--controls')) ok = runControls(moved) && ok;
  rmSync(tmp, { recursive: true, force: true });

  console.log(`\n${ok ? '✓ PASS' : '✗ FAIL'}`);
  return ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(2);
  }
}
