#!/usr/bin/env node
/**
 * Build the defect chronology from validation/defects/defect-registry.json,
 * the replay records beside it, the mutation campaign results, and git.
 *
 *   node scripts/build-defect-chronology.mjs          write the three files
 *   node scripts/build-defect-chronology.mjs --check  fail if they are stale
 *
 * Why this file exports its model and its renderers: chronology.json,
 * chronology.csv and chronology.md are three views of ONE array of records.
 * The verifier imports `buildModel` and the `render*` functions from here
 * rather than re-deriving anything, because a verifier that derives the same
 * facts a second time can disagree with the generator and both can be wrong.
 * Deriving once and rendering three times makes drift between the three files
 * impossible rather than merely unlikely.
 *
 * Nothing here invents a date. Every commit and every timestamp comes from
 * `git`; every classification comes from a field already in the registry or
 * the replay records. Where neither establishes a fact the field is the
 * string "unknown", which is a result, not a placeholder to be filled in
 * later.
 *
 * Exit 0 on success, 1 on a stale --check, 2 on a read, parse or git error.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFECT_DIR = resolve(ROOT, 'validation/defects');
const REGISTRY = resolve(DEFECT_DIR, 'defect-registry.json');
const REPLAY_RAW = resolve(DEFECT_DIR, 'replay/raw');
const MUTATIONS = resolve(ROOT, 'validation/mutations/results.json');

export const OUT_JSON = resolve(DEFECT_DIR, 'chronology.json');
export const OUT_CSV = resolve(DEFECT_DIR, 'chronology.csv');
export const OUT_MD = resolve(DEFECT_DIR, 'chronology.md');

export const UNKNOWN = 'unknown';

export const DISCOVERY_SOURCES = [
  'prospective-exposure',
  'retrospective-regression-evidence',
  'discovery-by-review',
  'external-report',
  'unknown',
];

export const DATE_PRECISIONS = ['exact', 'commit-order-only', 'approximate', 'unknown'];

export const CONFIDENCES = ['high', 'medium', 'low'];

/**
 * How a discovery reference was established. This is separate from
 * `discoverySource` because the two can disagree in a way that is a real
 * error: a replay run performed after the fix can never be the evidence for
 * the original discovery, whatever the discovery source says. Keeping the
 * evidence kind explicit lets the verifier reject that combination instead of
 * having to guess at it from a commit id.
 */
export const DISCOVERY_EVIDENCE = [
  'known-limitations-record',
  'detecting-suite-first-commit',
  'replay-baseline',
  'none',
];

/** Basis on which a first-failing-validation commit was established. */
export const FAILING_BASES = ['prospective-run', 'retrospective-replay', 'unknown'];

/** The v0.6.1 audit document that the registry names as the review record. */
const KNOWN_LIMITATIONS = 'KNOWN_LIMITATIONS_v0.6.1.md';

function git(args) {
  // git's own stderr is discarded: a rev that does not resolve is a result
  // this script reports itself, not a message to leak into the caller's log.
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/** Resolve a rev to {sha, shortSha, committedAt}, or null if it does not exist. */
export function resolveCommit(rev) {
  if (!rev || rev === UNKNOWN) return null;
  try {
    const line = git(['log', '-1', '--format=%H%x00%h%x00%cI', `${rev}^{commit}`]);
    const [sha, shortSha, committedAt] = line.split('\0');
    return { sha, shortSha, committedAt };
  } catch {
    return null;
  }
}

/** First commit that ADDED a path, or null. `--follow` is deliberately not
 * used: a rename would report a date earlier than the path itself existed. */
function firstAddCommit(path) {
  let out;
  try {
    out = git(['log', '--diff-filter=A', '--format=%H', '--', path]);
  } catch {
    return null;
  }
  if (!out) return null;
  const lines = out.split('\n').filter(Boolean);
  return resolveCommit(lines[lines.length - 1]);
}

/** True when `ancestor` is reachable from `descendant`. */
export function isAncestor(ancestor, descendant) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Collect, per defect, the baseline replay run that actually failed. A replay
 * baseline that exits 0 established nothing about that defect at that commit,
 * so only a non-zero exit counts as a failing validation.
 */
function readReplayEvidence() {
  const perDefect = new Map();
  let files;
  try {
    files = readdirSync(REPLAY_RAW).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return perDefect;
  }
  for (const file of files) {
    const record = JSON.parse(readFileSync(resolve(REPLAY_RAW, file), 'utf8'));
    const id = record.defect;
    const entry = perDefect.get(id) ?? { failingBaseline: null, probes: 0, addedIn: null };
    if (record.environment?.label === 'baseline') entry.probes += 1;
    if (record.environment?.label === 'baseline' && record.exitCode !== 0 && !entry.failingBaseline) {
      entry.failingBaseline = {
        rev: record.environment.commit,
        ref: record.environment.ref ?? UNKNOWN,
        probeCase: record.probeCase ?? UNKNOWN,
      };
    }
    if (!entry.addedIn) entry.addedIn = firstAddCommit(`validation/defects/replay/raw/${file}`);
    perDefect.set(id, entry);
  }
  return perDefect;
}

/**
 * Mutations are indexed by the source file they mutate, not by defect id.
 * The association below is therefore file-level only, and the note on each
 * record says so — a mutation that touches a file in a defect's code path is
 * not a claim that the mutation reproduces that defect.
 */
function readMutationIndex() {
  let results;
  try {
    results = JSON.parse(readFileSync(MUTATIONS, 'utf8'));
  } catch {
    return { byFile: new Map(), addedIn: null };
  }
  const byFile = new Map();
  for (const [id, m] of Object.entries(results.mutations ?? {})) {
    if (!byFile.has(m.file)) byFile.set(m.file, []);
    byFile.get(m.file).push(id);
  }
  return { byFile, addedIn: firstAddCommit('validation/mutations/results.json') };
}

/** Map the registry's own discoveryMethod vocabulary onto the chronology's. */
function discoverySourceOf(defect) {
  switch (defect.discoveryMethod) {
    case 'validation suite':
      // A suite written to probe the module, run before any external report:
      // it exposed the defect rather than confirming a known one.
      return 'prospective-exposure';
    case 'code review':
      return 'discovery-by-review';
    default:
      return UNKNOWN;
  }
}

export function buildModel() {
  const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  const replay = readReplayEvidence();
  const mutations = readMutationIndex();
  const knownLimitations = firstAddCommit(KNOWN_LIMITATIONS);

  const records = registry.defects.map((defect) => {
    const notes = [];
    const discoverySource = discoverySourceOf(defect);

    // --- discovery reference -------------------------------------------------
    let discoveryEvidence = 'none';
    let discoveryCommit = null;
    if (discoverySource === 'discovery-by-review') {
      if ((defect.discoveryContext ?? '').includes(KNOWN_LIMITATIONS) && knownLimitations) {
        discoveryEvidence = 'known-limitations-record';
        discoveryCommit = knownLimitations;
        notes.push(
          `Discovery is bounded by the commit that added ${KNOWN_LIMITATIONS}, which records the gap. The review itself is undated in git.`,
        );
      } else {
        notes.push(
          'The registry attributes discovery to review during the fix work; no dated record of it exists in git.',
        );
      }
    } else if (discoverySource === 'prospective-exposure') {
      const suiteFile = defect.regressionTest?.file;
      const added = suiteFile ? firstAddCommit(suiteFile) : null;
      if (added) {
        discoveryEvidence = 'detecting-suite-first-commit';
        discoveryCommit = added;
        notes.push(
          `Discovery is bounded by the commit that first added ${suiteFile}, the suite the registry credits with the finding. Git establishes the ordering, not the day of the finding.`,
        );
      }
    }

    // Only commit ordering was ever available, so `exact` is never reachable
    // here. Saying so is the point of the field.
    const datePrecision = discoveryCommit ? 'commit-order-only' : UNKNOWN;

    // --- first failing validation -------------------------------------------
    const evidence = replay.get(defect.id);
    let firstFailing = { commit: UNKNOWN, basis: UNKNOWN, note: '' };
    if (evidence?.failingBaseline) {
      const commit = resolveCommit(evidence.failingBaseline.rev);
      firstFailing = {
        commit: commit ? commit.sha : evidence.failingBaseline.rev,
        basis: 'retrospective-replay',
        note: `Probe "${evidence.failingBaseline.probeCase}" exits non-zero against ${evidence.failingBaseline.ref} with the regression case injected. The run post-dates the fix; it establishes that the defect was reachable at that commit, not when it was found.`,
      };
    } else if (evidence) {
      firstFailing = {
        commit: UNKNOWN,
        basis: UNKNOWN,
        note: 'No replay baseline for this defect exits non-zero, so no commit in this repository is established as failing validation.',
      };
    }

    // --- fix, regression test, replay, mutation ------------------------------
    const fix = resolveCommit(defect.fixCommit);
    if (defect.fixCommit && !fix) {
      notes.push(`The registry names fix commit ${defect.fixCommit}; it does not resolve here.`);
    }
    const regressionCommit = defect.regressionTest?.file
      ? firstAddCommit(defect.regressionTest.file)
      : null;

    const mutationIds = (defect.codePath ?? [])
      .flatMap((p) => mutations.byFile.get(p) ?? [])
      .sort();
    const mutationCommit = mutationIds.length > 0 ? mutations.addedIn : null;
    if (mutationIds.length > 0) {
      notes.push(
        `Mutation${mutationIds.length > 1 ? 's' : ''} ${mutationIds.join(', ')} ${mutationIds.length > 1 ? 'target' : 'targets'} a file in this defect's code path. The link is file-level; the campaign does not claim to reproduce this defect.`,
      );
    }

    // --- released impact -----------------------------------------------------
    const affected = defect.affectedVersion ?? '';
    let releasedImpact;
    if (affected.startsWith('0.6.1 and earlier')) {
      releasedImpact = 'released-through-v0.6.1';
    } else if (affected) {
      releasedImpact = 'partially-released';
      notes.push(`Registry affectedVersion: ${affected}`);
    } else {
      releasedImpact = UNKNOWN;
    }

    // --- confidence ----------------------------------------------------------
    const established = [
      discoveryCommit,
      fix,
      regressionCommit,
      firstFailing.commit !== UNKNOWN ? firstFailing : null,
    ].filter(Boolean).length;
    let classificationConfidence;
    if (discoverySource === UNKNOWN) classificationConfidence = 'low';
    else if (established === 4) classificationConfidence = 'high';
    else if (fix && regressionCommit) classificationConfidence = 'medium';
    else classificationConfidence = 'low';

    return {
      defectId: defect.id,
      name: defect.name,
      discoverySource,
      discovery: {
        commit: discoveryCommit ? discoveryCommit.sha : UNKNOWN,
        committedAt: discoveryCommit ? discoveryCommit.committedAt : UNKNOWN,
        evidence: discoveryEvidence,
      },
      datePrecision,
      firstFailingValidation: firstFailing,
      fixCommit: fix ? fix.sha : UNKNOWN,
      fixCommittedAt: fix ? fix.committedAt : UNKNOWN,
      regressionTestCommit: regressionCommit ? regressionCommit.sha : UNKNOWN,
      replayCreationCommit: evidence?.addedIn ? evidence.addedIn.sha : UNKNOWN,
      mutationCreationCommit: mutationCommit ? mutationCommit.sha : UNKNOWN,
      releasedImpact,
      classificationConfidence,
      notes: notes.join(' '),
    };
  });

  return {
    schemaVersion: 1,
    registryVersion: registry.registryVersion,
    defectCount: records.length,
    derivedFrom: [
      'validation/defects/defect-registry.json',
      'validation/defects/replay/raw/',
      'validation/mutations/results.json',
      'git log in this repository',
    ],
    unknownPolicy:
      'A field is "unknown" when neither the registry nor git establishes it. No value here is estimated, and datePrecision is never "exact" because no dated discovery record exists.',
    vocabularies: {
      discoverySource: DISCOVERY_SOURCES,
      datePrecision: DATE_PRECISIONS,
      discoveryEvidence: DISCOVERY_EVIDENCE,
      firstFailingValidationBasis: FAILING_BASES,
      classificationConfidence: CONFIDENCES,
    },
    records,
  };
}

// ---------------------------------------------------------------------------
// Renderers. All three take the same model object; none of them reads git.
// ---------------------------------------------------------------------------

export function renderJson(model) {
  return `${JSON.stringify(model, null, 2)}\n`;
}

const CSV_COLUMNS = [
  ['defect_id', (r) => r.defectId],
  ['discovery_source', (r) => r.discoverySource],
  ['discovery_commit', (r) => r.discovery.commit],
  ['discovery_committed_at', (r) => r.discovery.committedAt],
  ['discovery_evidence', (r) => r.discovery.evidence],
  ['date_precision', (r) => r.datePrecision],
  ['first_failing_validation_commit', (r) => r.firstFailingValidation.commit],
  ['first_failing_validation_basis', (r) => r.firstFailingValidation.basis],
  ['fix_commit', (r) => r.fixCommit],
  ['fix_committed_at', (r) => r.fixCommittedAt],
  ['regression_test_commit', (r) => r.regressionTestCommit],
  ['replay_creation_commit', (r) => r.replayCreationCommit],
  ['mutation_creation_commit', (r) => r.mutationCreationCommit],
  ['released_impact', (r) => r.releasedImpact],
  ['classification_confidence', (r) => r.classificationConfidence],
  ['notes', (r) => r.notes],
];

const csvCell = (value) => {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

export function renderCsv(model) {
  const rows = [CSV_COLUMNS.map(([h]) => h).join(',')];
  for (const record of model.records) {
    rows.push(CSV_COLUMNS.map(([, get]) => csvCell(get(record))).join(','));
  }
  return `${rows.join('\n')}\n`;
}

const mdCell = (value) => String(value ?? '').replaceAll('|', '\\|');
const shortOf = (sha) => (sha === UNKNOWN ? UNKNOWN : sha.slice(0, 7));

export function renderMarkdown(model) {
  const out = [];
  out.push('# Defect chronology');
  out.push('');
  out.push(
    'Generated by `scripts/build-defect-chronology.mjs`. Do not edit by hand. This file,',
  );
  out.push(
    '`chronology.json` and `chronology.csv` are rendered from one model in one pass, so they',
  );
  out.push('cannot disagree with each other.');
  out.push('');
  out.push(`Registry version ${model.registryVersion}; ${model.defectCount} defects.`);
  out.push('');
  out.push(model.unknownPolicy);
  out.push('');
  out.push('## Per-defect chronology');
  out.push('');
  out.push(
    '| defect | discovery source | discovery commit | date precision | first failing validation | basis | fix | regression test | replay | mutation | released impact | confidence |',
  );
  out.push(
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const r of model.records) {
    out.push(
      `| ${mdCell(r.defectId)} | ${r.discoverySource} | ${shortOf(r.discovery.commit)} | ${r.datePrecision} | ${shortOf(r.firstFailingValidation.commit)} | ${r.firstFailingValidation.basis} | ${shortOf(r.fixCommit)} | ${shortOf(r.regressionTestCommit)} | ${shortOf(r.replayCreationCommit)} | ${shortOf(r.mutationCreationCommit)} | ${r.releasedImpact} | ${r.classificationConfidence} |`,
    );
  }
  out.push('');
  out.push('## Notes');
  out.push('');
  for (const r of model.records) {
    out.push(`### ${r.defectId} — ${mdCell(r.name)}`);
    out.push('');
    out.push(r.notes ? mdCell(r.notes) : 'No qualifications recorded.');
    if (r.firstFailingValidation.note) {
      out.push('');
      out.push(`First failing validation: ${mdCell(r.firstFailingValidation.note)}`);
    }
    out.push('');
  }
  return `${out.join('\n')}`;
}

export function renderAll(model) {
  return {
    [OUT_JSON]: renderJson(model),
    [OUT_CSV]: renderCsv(model),
    [OUT_MD]: renderMarkdown(model),
  };
}

function main() {
  const check = process.argv.includes('--check');
  let rendered;
  try {
    rendered = renderAll(buildModel());
  } catch (err) {
    console.error(`cannot build the chronology: ${err.message}`);
    process.exit(2);
  }
  let stale = 0;
  for (const [path, content] of Object.entries(rendered)) {
    if (check) {
      let current = null;
      try {
        current = readFileSync(path, 'utf8');
      } catch {
        current = null;
      }
      if (current !== content) {
        console.error(`stale: ${path}`);
        stale += 1;
      }
    } else {
      writeFileSync(path, content);
      console.log(`wrote ${path}`);
    }
  }
  process.exit(check && stale > 0 ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
