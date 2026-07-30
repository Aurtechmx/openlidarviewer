#!/usr/bin/env node
/**
 * verify-freeze-claims.mjs — a record that says a gate was set before a result
 * has to be able to prove it.
 *
 * WHY THIS EXISTS. Twice in one day a check caught something real, and neither
 * time was it a wrong number. Both were claims about WHEN a decision was made:
 * a tolerance presented as frozen before the run that produced the result it
 * judges. The numbers were right. The chronology was not.
 *
 * That failure has a name outside this repository. Deciding the hypothesis, or
 * the threshold, after seeing the data and then presenting it as if it came
 * first is HARKing, and preregistration is the standard defence. This project
 * already preregisters: study manifests carry a `protocolDigest` over the
 * metrics block precisely so that loosening a tolerance after a disappointing
 * result shows up in a diff.
 *
 * What was missing is the audit. A digest proves the tolerance has not changed
 * SINCE the record was written. It says nothing about whether the record was
 * written before or after the result existed, and a record authored in one
 * sitting looks identical either way. Nothing read the repository's own history
 * to check.
 *
 * THE INVARIANT. For any record asserting a measured outcome, the gate it was
 * judged against must be visible in an earlier commit, at a status that had not
 * yet measured anything, with the same digest. Preregistration that left no
 * trace in the history is indistinguishable from a tolerance chosen to fit.
 *
 * WHAT THIS CANNOT DO. It cannot detect a gate chosen to fit and then committed
 * as `pending` in one commit and `agree` in the next, minutes later, by someone
 * who already knew the answer. Nothing in a repository can. It raises the cost
 * of that from "edit one field" to "construct a false history", and it makes
 * the honest path, commit the protocol first, the cheap one.
 *
 * SQUASH MERGES. This branch is squash-merged, which collapses a two-commit
 * preregistration into one commit and erases exactly the sequence above. The
 * first study to land after this check was written was genuinely preregistered
 * on its branch and still failed here, because on the default branch the gate
 * and the result really did arrive together.
 *
 * So a record may instead name the commit that froze it. That commit is
 * verified: it must exist, and it must carry the same digest at a status that
 * had measured nothing. It is weaker evidence than reachable history, because
 * an object no ancestor points at can be collected and will be missing from a
 * fresh clone, and the check says so when it accepts one.
 *
 * The durable fix is neither: preregister in its own pull request, so the
 * pending state lands on the default branch before the result exists.
 *
 * Exit 0 when every freeze claim is witnessed, 1 when any is not, 2 on a usage
 * or read error.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, accessSync, constants } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Statuses that assert something was measured. Kept in step with the study verifier. */
const MEASURED = new Set(['agree', 'partial', 'disagree']);

/** Directories scanned for records that carry a status and a protocol digest. */
const RECORD_DIRS = [
  'validation/cross-implementation/studies',
  'validation/field/studies',
];

/**
 * git, found by reading PATH rather than by asking a shell.
 *
 * Nothing here needs a shell, and not spawning one keeps the argv exact.
 */
function gitPath() {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir === '') continue;
    const candidate = resolve(dir, 'git');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here. Keep looking.
    }
  }
  return null;
}

const GIT = gitPath();

function git(...argv) {
  return execFileSync(GIT, argv, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

/** Every commit that touched `file`, oldest first. */
function commitsTouching(file) {
  const out = git('log', '--format=%H %ad', '--date=short', '--reverse', '--', file).trim();
  if (out === '') return [];
  return out.split('\n').map((line) => {
    const sp = line.indexOf(' ');
    return { sha: line.slice(0, sp), date: line.slice(sp + 1) };
  });
}

/** The record as it stood at `sha`, or null if it did not exist there. */
function recordAt(sha, file) {
  try {
    // stderr is discarded: a path absent from a commit is the ordinary answer
    // here, and git's "exists on disk, but not in HEAD" printed straight to the
    // terminal reads as a crash rather than as the null this returns.
    return JSON.parse(
      execFileSync(GIT, ['show', `${sha}:${file}`], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    return null;
  }
}

function shallowClone() {
  try {
    return git('rev-parse', '--is-shallow-repository').trim() === 'true';
  } catch {
    return false;
  }
}

function recordFiles() {
  const files = [];
  for (const dir of RECORD_DIRS) {
    const full = resolve(ROOT, dir);
    if (!existsSync(full)) continue;
    for (const name of readdirSync(full)) {
      if (name.endsWith('.json')) files.push(join(dir, name));
    }
  }
  return files;
}

/**
 * The freeze the study's protocol states for this study's claim, or null.
 *
 * Only the presence of the statement is read here. Whether it is true is the
 * study verifier's job, which compares it against the commits it names.
 */
function protocolFreeze(record) {
  const ref = record.protocolRef ?? null;
  if (ref === null || typeof ref.protocolId !== 'string') return null;
  const dir = resolve(ROOT, 'validation/protocols');
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.protocol.json')) continue;
    let doc;
    try {
      doc = JSON.parse(readFileSync(resolve(dir, name), 'utf8'));
    } catch {
      continue;
    }
    if (doc.protocolId !== ref.protocolId) continue;
    for (const claim of doc.claims ?? []) {
      if (claim.claimId !== record.claimId) continue;
      const status = claim.freeze?.status ?? null;
      if (status === null) return null;
      return { protocolId: doc.protocolId, claimId: claim.claimId, status };
    }
  }
  return null;
}

const problems = [];
const witnessed = [];
const skipped = [];

if (GIT === null) {
  console.error('verify:freeze-claims could not find git on PATH; the history is the evidence here.');
  process.exit(2);
}

if (shallowClone()) {
  // A shallow clone genuinely cannot answer the question. Say so and refuse,
  // rather than passing because the evidence is out of reach.
  console.error('verify:freeze-claims FAILED\n');
  console.error('  • This is a shallow clone, so the history that would witness a freeze is absent.');
  console.error('    Fetch the full history before running this check.');
  process.exit(1);
}

for (const file of recordFiles()) {
  const current = recordAt('HEAD', file) ?? JSON.parse(readFileSync(resolve(ROOT, file), 'utf8'));
  const id = current.studyId ?? current.recordId ?? file;

  // An example record measures nothing and is not asked to witness anything.
  if (current.example === true || String(id).startsWith('EXAMPLE')) {
    skipped.push(`${id} (example)`);
    continue;
  }
  if (!MEASURED.has(current.status)) {
    skipped.push(`${id} (status ${current.status}, nothing measured yet)`);
    continue;
  }

  const digest = current.protocolDigest ?? null;
  if (digest === null) {
    problems.push(
      `${file}: status "${current.status}" asserts a measured outcome but the record carries no ` +
        'protocolDigest, so there is nothing a freeze could be checked against.',
    );
    continue;
  }

  const history = commitsTouching(file);
  if (history.length === 0) {
    problems.push(
      `${file}: status "${current.status}" asserts a measured outcome, but the file has no commit ` +
        'history here. An uncommitted result cannot have been preregistered.',
    );
    continue;
  }

  // Walk forward to the first commit where this record claimed a measured
  // outcome, and look for an earlier commit of the same record that carried
  // the same digest while it had measured nothing.
  let firstMeasured = null;
  let priorFreeze = null;
  for (const commit of history) {
    const at = recordAt(commit.sha, file);
    if (at === null) continue;
    if (MEASURED.has(at.status)) {
      firstMeasured = { ...commit, status: at.status, digest: at.protocolDigest ?? null };
      break;
    }
    if ((at.protocolDigest ?? null) === digest) {
      priorFreeze = { ...commit, status: at.status };
    }
  }

  if (firstMeasured === null) {
    // The working tree says measured, the history does not yet. Uncommitted.
    problems.push(
      `${file}: the working tree reports status "${current.status}", but no commit records that ` +
        'result. Commit the preregistration before the result, not both together.',
    );
    continue;
  }

  if (priorFreeze === null) {
    // No reachable history. A named witness is the fallback a squash merge
    // leaves available; it is checked, not taken on trust.
    // A study manifest may transcribe a comparison whose protocol was frozen
    // elsewhere. That is the case the raster studies are in: the comparisons ran
    // in July, the manifests were written afterwards to record them, and the
    // freeze lives in the protocol they cite. Demanding the manifest have its
    // own pending commit would ask it to carry provenance it never held.
    //
    // Deferring is not waiving. The protocol has to exist, name this claim, and
    // state that claim's freeze, and verify-cross-implementation-study.mjs
    // checks that statement against the commits it offers (P9, P10) and refuses
    // a measured study with no protocol at all (R12).
    const viaProtocol = protocolFreeze(current);
    if (viaProtocol !== null) {
      witnessed.push(
        `${id}: freeze recorded in protocol ${viaProtocol.protocolId} for claim ` +
          `${viaProtocol.claimId} (${viaProtocol.status}), measured in ` +
          `${firstMeasured.sha.slice(0, 8)} (${firstMeasured.date})`,
      );
      continue;
    }
    const witness = current.freeze?.witnessCommit ?? current.preregisteredIn ?? null;
    if (witness !== null) {
      const at = recordAt(witness, file);
      if (at === null) {
        problems.push(
          `${file}: names ${String(witness).slice(0, 8)} as the commit that froze it, but this ` +
            'record does not exist there. A witness that cannot be read is not a witness.',
        );
        continue;
      }
      if ((at.protocolDigest ?? null) !== digest) {
        problems.push(
          `${file}: witness ${String(witness).slice(0, 8)} carries protocolDigest ` +
            `${String(at.protocolDigest ?? 'none').slice(0, 22)}, not ${digest.slice(0, 22)}. ` +
            'The gate changed between the commit named as the freeze and the result.',
        );
        continue;
      }
      if (MEASURED.has(at.status)) {
        problems.push(
          `${file}: witness ${String(witness).slice(0, 8)} already reports status "${at.status}". ` +
            'A commit that had measured the outcome cannot be the one that froze the gate.',
        );
        continue;
      }
      let reachable = false;
      try {
        git('merge-base', '--is-ancestor', witness, 'HEAD');
        reachable = true;
      } catch {
        reachable = false;
      }
      witnessed.push(
        `${id}: frozen in ${String(witness).slice(0, 8)} (status ${at.status}), measured in ` +
          `${firstMeasured.sha.slice(0, 8)} (${firstMeasured.date})` +
          (reachable ? '' : ' — witness not reachable from HEAD, squash-merged'),
      );
      continue;
    }
    problems.push(
      `${file}: status "${firstMeasured.status}" first appears in ${firstMeasured.sha.slice(0, 8)} ` +
        `(${firstMeasured.date}), and no earlier commit of this record carries protocolDigest ` +
        `${digest.slice(0, 22)} at an unmeasured status. The gate and the result it judges arrived ` +
        'together, so nothing here shows the tolerance was set before the answer was known. ' +
        'If it was frozen on a branch that was squashed, name that commit in freeze.witnessCommit.',
    );
    continue;
  }

  if (firstMeasured.digest !== null && firstMeasured.digest !== digest) {
    problems.push(
      `${file}: protocolDigest changed between the preregistration ${priorFreeze.sha.slice(0, 8)} ` +
        `and the result ${firstMeasured.sha.slice(0, 8)}. The gate moved while the study was being run.`,
    );
    continue;
  }

  witnessed.push(
    `${id}: frozen in ${priorFreeze.sha.slice(0, 8)} (${priorFreeze.date}, status ` +
      `${priorFreeze.status}), measured in ${firstMeasured.sha.slice(0, 8)} (${firstMeasured.date})`,
  );
}

if (problems.length > 0) {
  console.error('verify:freeze-claims FAILED\n');
  for (const p of problems) console.error(`  • ${p}`);
  console.error('\nA tolerance is only a gate if it was set before the result. Where the history');
  console.error('cannot show that, say so in the record rather than letting it read as preregistered.');
  process.exit(1);
}

console.log(
  `verify:freeze-claims OK — ${witnessed.length} measured record(s) have a freeze the history ` +
    `witnesses, ${skipped.length} not applicable.`,
);
for (const w of witnessed) console.log(`  ${w}`);
for (const s of skipped) console.log(`  skipped: ${s}`);
