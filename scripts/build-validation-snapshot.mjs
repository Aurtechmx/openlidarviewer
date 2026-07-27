#!/usr/bin/env node
/**
 * build-validation-snapshot.mjs — collect the candidate's validation state into
 * one directory that can be checked on its own.
 *
 *   npm run validation:snapshot
 *   node scripts/build-validation-snapshot.mjs --out <dir>
 *
 * The output is `validation/snapshot/`: a copy of every record the snapshot
 * cites, a `snapshot.json` derived from those copies, a `SUMMARY.md` rendered
 * from that, and a `SHA256SUMS` over everything. Because the derivation reads
 * the copies rather than the repository, the directory can be moved anywhere
 * and still be checked — see `scripts/verify-validation-snapshot.mjs`.
 *
 * An input that has not been produced is copied as nothing and recorded as
 * `not-executed` with the command that produces it. It is never a zero and
 * never a pass.
 *
 * Exit 0 when the snapshot is written and its own verdict is PASS, 1 when the
 * verdict is FAIL, 2 on a read or write error.
 */
import {
  readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync, readdirSync, copyFileSync,
} from 'node:fs';
import { dirname, resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INPUTS, evidencePath, sha256, deriveSnapshot, renderSummary } from './validation-snapshot-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

/** Every file under a repository directory, as repo-relative paths. */
function walk(dirAbs, base) {
  if (!existsSync(dirAbs) || !statSync(dirAbs).isDirectory()) return [];
  const out = [];
  for (const e of readdirSync(dirAbs, { withFileTypes: true })) {
    const p = join(dirAbs, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else if (e.isFile()) out.push(relative(base, p).split(/[\\/]/).join('/'));
  }
  return out;
}

/** Repo-relative paths to collect, by owning input. */
function plan() {
  const jobs = [];
  for (const spec of INPUTS) {
    const paths = new Set(spec.files);
    if (spec.dir) {
      for (const p of walk(join(ROOT, spec.dir.path), ROOT)) if (spec.dir.match.test(p)) paths.add(p);
    }
    for (const p of [...paths].sort()) jobs.push({ id: spec.id, path: p });
  }
  return jobs;
}

/** A reader over an evidence directory, keyed by repo-relative path. */
export function evidenceReader(dir) {
  const stored = new Map();
  for (const rel of walk(join(dir, 'evidence'), dir)) {
    const parts = rel.split('/');
    const repoPath = [
      ...parts.slice(2, -1),
      parts[parts.length - 1].replace(/(SHA256SUMS|\.md)\.txt$/, '$1'),
    ].join('/');
    stored.set(repoPath, join(dir, rel));
  }
  return {
    stored,
    has: (p) => stored.has(p),
    read: (p) => (stored.has(p) ? readFileSync(stored.get(p), 'utf8') : null),
    digest: (p) => {
      const buf = readFileSync(stored.get(p));
      return { sha256: sha256(buf), bytes: buf.length };
    },
    listed: (prefix) => [...stored.keys()].filter((p) => p.startsWith(`${prefix}/`)).sort(),
  };
}

/** Write SHA256SUMS over every file in the directory except the manifest. */
export function writeManifest(dir) {
  const files = walk(dir, dir).filter((p) => p !== 'SHA256SUMS').sort();
  const lines = files.map((p) => `${sha256(readFileSync(join(dir, p)))}  ${p}`);
  writeFileSync(join(dir, 'SHA256SUMS'), `${lines.join('\n')}\n`);
  return files.length;
}

function main() {
  const out = resolve(arg('--out', join(ROOT, 'validation/snapshot')));
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  let copied = 0;
  let absent = 0;
  for (const job of plan()) {
    const src = join(ROOT, job.path);
    if (!existsSync(src) || !statSync(src).isFile()) {
      absent += 1;
      continue;
    }
    const dest = join(out, evidencePath(job.id, job.path));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    copied += 1;
  }

  const snapshot = deriveSnapshot(evidenceReader(out));
  writeFileSync(join(out, 'snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
  writeFileSync(join(out, 'SUMMARY.md'), renderSummary(snapshot));
  const listed = writeManifest(out);

  const where = relative(ROOT, out) || out;
  console.log(`Validation snapshot — ${where}`);
  console.log(`  candidate version: ${snapshot.candidateVersion}`);
  console.log(`  records collected: ${copied}, declared and absent: ${absent}`);
  console.log(`  inputs: ${snapshot.totals.recorded} recorded, ${snapshot.totals.notExecuted} not executed, ${snapshot.totals.inputs} total`);
  for (const i of snapshot.inputs) {
    console.log(`  ${i.status === 'recorded' ? '✓' : '○'} ${i.id} — ${i.status}${i.status === 'recorded' ? ` (${i.files.length})` : ` — run: ${i.producedBy}`}`);
  }
  if (snapshot.defects.status === 'recorded') {
    const d = snapshot.defects.derived;
    console.log(`  defects: ${d.total} total, ${d.exposedBySpecializedValidation} exposed by specialized validation, ${d.byCodeReview} by code review, ${d.carriedFromTheEarlierAudit} carried, ${d.affectingReleasedStatementsOrOutputs} reaching released statements or outputs`);
    console.log(`  reconciles with the stated composition: ${snapshot.defects.reconciles ? 'yes' : 'no'}`);
  }
  console.log(`  identity: ${snapshot.identity.agreement}${snapshot.identity.disagreements.length ? ` (${snapshot.identity.disagreements.join(', ')})` : ''}`);
  console.log(`  manifest covers ${listed} files`);
  console.log(`\n${snapshot.verdict === 'PASS' ? '✓' : '✗'} ${snapshot.verdict}`);
  for (const f of snapshot.failures) console.log(`  - ${f}`);
  return snapshot.verdict === 'PASS' ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(2);
  }
}
