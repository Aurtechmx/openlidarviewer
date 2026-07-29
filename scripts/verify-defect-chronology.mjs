#!/usr/bin/env node
/**
 * Verify validation/defects/chronology.{json,csv,md} against the defect
 * registry and against git.
 *
 *   node scripts/verify-defect-chronology.mjs
 *   node scripts/verify-defect-chronology.mjs --chronology <path-to-json>
 *
 * The `--chronology` form exists so the tests can feed deliberately corrupt
 * records through the real checks. Without it the checks run against the
 * generated files and the CSV/Markdown views are compared too.
 *
 * This verifier does NOT re-derive the chronology. It imports the model
 * builder and renderers from the generator and reuses them, because two
 * independent derivations of the same fact can disagree and then neither the
 * generator nor the verifier is trustworthy. What it checks is that the
 * recorded chronology is internally coherent, resolves in this repository, and
 * does not overstate what the evidence supports.
 *
 * Exit 0 when every check passes, 1 when any fails, 2 on a read or parse error.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  OUT_JSON,
  OUT_CSV,
  OUT_MD,
  UNKNOWN,
  ROOT,
  DISCOVERY_SOURCES,
  DATE_PRECISIONS,
  DISCOVERY_EVIDENCE,
  FAILING_BASES,
  CONFIDENCES,
  resolveCommit,
  isAncestor,
  renderCsv,
  renderMarkdown,
} from './build-defect-chronology.mjs';

const REGISTRY = resolve(ROOT, 'validation/defects/defect-registry.json');

const args = process.argv.slice(2);
const flagIndex = args.indexOf('--chronology');
const jsonPath = flagIndex === -1 ? OUT_JSON : resolve(args[flagIndex + 1] ?? '');
const checkViews = flagIndex === -1;

let model;
let registry;
try {
  model = JSON.parse(readFileSync(jsonPath, 'utf8'));
  registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
} catch (err) {
  console.error(`cannot read input: ${err.message}`);
  process.exit(2);
}

const failures = [];
const fail = (code, message) => failures.push(`${code}: ${message}`);

const records = Array.isArray(model.records) ? model.records : [];
const byId = new Map(records.map((r) => [r.defectId, r]));

// --- 1. coverage -----------------------------------------------------------
// Every registered defect needs a record, and the chronology may not invent
// defects the registry does not carry.
for (const defect of registry.defects) {
  if (!byId.has(defect.id)) fail('E_MISSING_DEFECT', `${defect.id} has no chronology record`);
}
const registered = new Set(registry.defects.map((d) => d.id));
for (const r of records) {
  if (!registered.has(r.defectId)) {
    fail('E_UNREGISTERED_DEFECT', `${r.defectId} is not in the registry`);
  }
}
if (records.length !== new Set(records.map((r) => r.defectId)).size) {
  fail('E_DUPLICATE_DEFECT', 'the chronology carries the same defect id more than once');
}

// --- 2. commit resolution --------------------------------------------------
// A commit id that does not resolve here is a dangling reference, whether it
// was mistyped, rebased away, or copied from another repository.
const COMMIT_FIELDS = [
  ['discovery.commit', (r) => r.discovery?.commit],
  ['firstFailingValidation.commit', (r) => r.firstFailingValidation?.commit],
  ['fixCommit', (r) => r.fixCommit],
  ['regressionTestCommit', (r) => r.regressionTestCommit],
  ['replayCreationCommit', (r) => r.replayCreationCommit],
  ['mutationCreationCommit', (r) => r.mutationCreationCommit],
];
/**
 * Whether this checkout has the history the commit checks need.
 *
 * CI clones at depth 1 by default, so every referenced commit is genuinely
 * absent and the resolution check reports E_UNRESOLVED_COMMIT for all of them.
 * That message is wrong in a way that matters: it says the chronology names a
 * commit that does not exist, when what happened is that this checkout cannot
 * see it. One is a corrupt record, the other is a missing environment, and
 * conflating them would either mask a real defect or fail a good record.
 */
function historyIsShallow() {
  try {
    return (
      execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() === 'true'
    );
  } catch {
    return false;
  }
}

const shallow = historyIsShallow();
if (shallow) {
  console.error(
    'history is shallow: commit resolution is reported as environment-unavailable, not verified.',
  );
  console.error('Run with a full clone (actions/checkout fetch-depth: 0) to check commits.');
}

const resolved = new Map();
for (const r of records) {
  for (const [label, get] of COMMIT_FIELDS) {
    const value = get(r);
    if (value === undefined || value === UNKNOWN) continue;
    const commit = resolveCommit(value);
    if (!commit) {
      // A shallow clone cannot see the commit; that is an unavailable
      // environment, not a bad record, and must not be reported as one.
      if (!shallow) {
        fail('E_UNRESOLVED_COMMIT', `${r.defectId} ${label} ${value} does not resolve`);
      }
    } else {
      resolved.set(`${r.defectId}:${label}`, commit);
    }
  }
}

// --- 3. fix cannot precede the validation that failed on it ----------------
// A fix that lands before the run it is supposed to answer means the two
// commits were transcribed the wrong way round, or the failing run belongs to
// a different defect.
for (const r of records) {
  const fix = resolved.get(`${r.defectId}:fixCommit`);
  const failing = resolved.get(`${r.defectId}:firstFailingValidation.commit`);
  if (!fix || !failing) continue;
  if (fix.sha === failing.sha) continue;
  if (!isAncestor(failing.sha, fix.sha)) {
    fail(
      'E_FIX_BEFORE_FAILING',
      `${r.defectId} fix ${fix.shortSha} does not descend from first failing validation ${failing.shortSha}`,
    );
  } else if (Date.parse(fix.committedAt) < Date.parse(failing.committedAt)) {
    fail(
      'E_FIX_BEFORE_FAILING',
      `${r.defectId} fix ${fix.shortSha} is dated before first failing validation ${failing.shortSha}`,
    );
  }
}

// --- 4. a retrospective check is not a discovery ---------------------------
// The replay runs were performed after the fixes, with the regression cases
// injected into an already-released tree. Treating one as the moment the
// defect was found would turn evidence of reachability into a discovery
// claim, which is the single most consequential error this ledger can make.
for (const r of records) {
  if (r.discovery?.evidence === 'replay-baseline') {
    fail(
      'E_RETROSPECTIVE_AS_DISCOVERY',
      `${r.defectId} cites a replay baseline as its discovery evidence`,
    );
  }
  if (
    r.firstFailingValidation?.basis === 'retrospective-replay' &&
    r.discoverySource === 'retrospective-regression-evidence' &&
    r.discovery?.commit === r.firstFailingValidation.commit &&
    r.discovery?.evidence !== 'known-limitations-record'
  ) {
    fail(
      'E_RETROSPECTIVE_AS_DISCOVERY',
      `${r.defectId} names the retrospective replay commit as the original discovery`,
    );
  }
}

// --- 5. labels that cannot hold at the same time ---------------------------
for (const r of records) {
  if (!DISCOVERY_SOURCES.includes(r.discoverySource)) {
    fail('E_INCOMPATIBLE_LABELS', `${r.defectId} discoverySource "${r.discoverySource}" is not a known value`);
  }
  if (!DATE_PRECISIONS.includes(r.datePrecision)) {
    fail('E_INCOMPATIBLE_LABELS', `${r.defectId} datePrecision "${r.datePrecision}" is not a known value`);
  }
  if (!DISCOVERY_EVIDENCE.includes(r.discovery?.evidence)) {
    fail('E_INCOMPATIBLE_LABELS', `${r.defectId} discovery evidence "${r.discovery?.evidence}" is not a known value`);
  }
  if (!FAILING_BASES.includes(r.firstFailingValidation?.basis)) {
    fail('E_INCOMPATIBLE_LABELS', `${r.defectId} firstFailingValidation basis "${r.firstFailingValidation?.basis}" is not a known value`);
  }
  if (!CONFIDENCES.includes(r.classificationConfidence)) {
    fail('E_INCOMPATIBLE_LABELS', `${r.defectId} classificationConfidence "${r.classificationConfidence}" is not a known value`);
  }

  const hasRef = r.discovery?.commit !== UNKNOWN || r.discovery?.committedAt !== UNKNOWN;

  // `exact` asserts a known calendar day. A commit timestamp bounds the
  // discovery, it does not date it, so nothing in this ledger may claim it.
  if (r.datePrecision === 'exact' && r.discovery?.evidence !== 'none' && !r.discovery?.exactDateSource) {
    fail('E_INCOMPATIBLE_LABELS', `${r.defectId} claims an exact discovery date with no dated source`);
  }
  if (r.datePrecision === UNKNOWN && hasRef) {
    fail('E_INCOMPATIBLE_LABELS', `${r.defectId} carries a discovery reference but calls its precision unknown`);
  }
  if (r.datePrecision !== UNKNOWN && !hasRef) {
    fail('E_INCOMPATIBLE_LABELS', `${r.defectId} claims precision "${r.datePrecision}" with no discovery reference`);
  }
  if (r.discovery?.evidence === 'none' && hasRef) {
    fail('E_INCOMPATIBLE_LABELS', `${r.defectId} names a discovery reference while recording no evidence for it`);
  }
  if (r.discoverySource === UNKNOWN && r.classificationConfidence !== 'low') {
    fail('E_INCOMPATIBLE_LABELS', `${r.defectId} rates confidence "${r.classificationConfidence}" with an unknown discovery source`);
  }
  // A basis describes a commit; one without the other is an unfinished record.
  const failingKnown = r.firstFailingValidation?.commit !== UNKNOWN;
  const basisKnown = r.firstFailingValidation?.basis !== UNKNOWN;
  if (failingKnown !== basisKnown) {
    fail('E_INCOMPATIBLE_LABELS', `${r.defectId} first-failing-validation commit and basis disagree about being known`);
  }
}

// --- 6. the three views must be one model ----------------------------------
if (checkViews) {
  const views = [
    [OUT_CSV, renderCsv(model)],
    [OUT_MD, renderMarkdown(model)],
  ];
  for (const [path, expected] of views) {
    let actual = null;
    try {
      actual = readFileSync(path, 'utf8');
    } catch {
      actual = null;
    }
    if (actual !== expected) {
      fail('E_VIEW_DRIFT', `${path} does not match what chronology.json renders to`);
    }
  }
}

if (failures.length > 0) {
  for (const line of failures) console.error(line);
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
console.log(`defect chronology verified: ${records.length} records`);
process.exit(0);
