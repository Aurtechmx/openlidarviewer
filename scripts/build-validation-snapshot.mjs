#!/usr/bin/env node
/**
 * build-validation-snapshot.mjs — collect the candidate's validation state into
 * one directory that can be checked on its own.
 *
 *   npm run validation:snapshot
 *   node scripts/build-validation-snapshot.mjs --out <dir>
 *   node scripts/build-validation-snapshot.mjs --preserve-existing
 *
 * The output is `validation/snapshot/`: a copy of every record the snapshot
 * cites, a `snapshot.json` derived from those copies, a `SUMMARY.md` rendered
 * from that, and a `SHA256SUMS` over everything. Because the derivation reads
 * the copies rather than the repository, the directory can be moved anywhere
 * and still be checked — see `scripts/verify-validation-snapshot.mjs`.
 *
 * Every declared producer appears in the output with exactly one status:
 * collected, not-executed, environment-unavailable, not-applicable or failed.
 * A producer that was not run is copied as nothing and carries the command that
 * produces it. It is never a zero, never a pass, and never simply absent from
 * the manifest.
 *
 * Each collected record states both its source path and the path it is stored
 * at. Some records are stored under a changed name so a copy is not mistaken
 * for the thing it copies, and because the pairing is written down, reading a
 * snapshot back never has to invert that rule.
 *
 * Exit 0 when the snapshot is written and its own verdict is PASS, 1 when the
 * verdict is FAIL, 2 on a read or write error.
 */
import {
  readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, statSync, readdirSync,
  copyFileSync, cpSync,
} from 'node:fs';
import { dirname, resolve, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
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

/**
 * A reader over an evidence directory, keyed by source path.
 *
 * `index` is the explicit pairing of source path to stored path: at build time
 * it is the collection plan, at verification time it is read out of the
 * snapshot's own artifact records. Nothing here derives one path from the
 * other. That inference used to live in this function, it stripped only
 * `SHA256SUMS.txt` and `*.md.txt`, and it silently lost the collected
 * `package.json` and `package-lock.json` — which are also stored with a `.txt`
 * suffix — so the identity checks that read them saw nothing at all and
 * reported "not executed" rather than failing.
 *
 * A stored path that is listed but not on disk is left out of the reader
 * rather than throwing, so the caller can report it as a missing record.
 */
export function evidenceReader(dir, index) {
  const stored = new Map();
  for (const { sourcePath, storedPath } of index) {
    const abs = join(dir, storedPath);
    if (existsSync(abs) && statSync(abs).isFile()) stored.set(sourcePath, abs);
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
    storedPathOf: (p) => index.find((e) => e.sourcePath === p)?.storedPath ?? null,
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
  /**
   * Carry a record the working tree no longer holds over from the snapshot
   * being replaced.
   *
   * Off by default, because a release build must state what this tree actually
   * produced. It exists for the case where the derived files have to be
   * regenerated on a host that is not the one that ran the producers: several
   * producers write into `release/` and `benchmark-results/`, neither of which
   * is committed, so a plain rebuild elsewhere would drop records of runs that
   * did happen and report the result as a smaller snapshot rather than as a
   * host difference. Nothing is invented — a record is only carried over if the
   * previous snapshot already stored it at the same path, and it is re-hashed
   * and re-derived from its own bytes like every other record.
   */
  const preserve = process.argv.includes('--preserve-existing');
  const previous = preserve && existsSync(out) ? mkdtempSync(join(tmpdir(), 'olv-snapshot-prev-')) : null;
  if (previous) cpSync(out, previous, { recursive: true });

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  let copied = 0;
  let absent = 0;
  let carried = 0;
  // The pairing is decided once, here, and then written into the snapshot. The
  // storage-side rename is applied exactly at the point the copy is made.
  const index = [];
  for (const job of plan()) {
    const src = join(ROOT, job.path);
    const storedPath = evidencePath(job.id, job.path);
    index.push({ sourcePath: job.path, storedPath });
    const dest = join(out, storedPath);
    if (!existsSync(src) || !statSync(src).isFile()) {
      const kept = previous && join(previous, storedPath);
      if (kept && existsSync(kept) && statSync(kept).isFile()) {
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(kept, dest);
        carried += 1;
        continue;
      }
      absent += 1;
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    copied += 1;
  }
  if (previous) rmSync(previous, { recursive: true, force: true });

  const snapshot = deriveSnapshot(evidenceReader(out, index));
  writeFileSync(join(out, 'snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
  writeFileSync(join(out, 'SUMMARY.md'), renderSummary(snapshot));
  const listed = writeManifest(out);

  const where = relative(ROOT, out) || out;
  console.log(`Validation snapshot — ${where}`);
  console.log(`  candidate version: ${snapshot.candidateVersion}`);
  console.log(`  records collected: ${copied}, carried from the previous snapshot: ${carried}, declared and absent: ${absent}`);
  const c = snapshot.coverage;
  console.log(`  producer accounting completeness: ${c.producerAccounting.numerator}/${c.producerAccounting.denominator}`);
  console.log(`  executed producer coverage: ${c.executedProducers.numerator}/${c.executedProducers.denominator}`);
  console.log(`  successful producer coverage: ${c.successfulProducers.numerator}/${c.successfulProducers.denominator}`);
  for (const p of snapshot.producers) {
    console.log(`  ${p.status === 'collected' ? '✓' : '○'} ${p.producerId} — ${p.status}${p.status === 'collected' ? ` (${p.artifacts.length})` : ` — run: ${p.producedBy}`}`);
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
