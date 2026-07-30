#!/usr/bin/env node
/**
 * verify-reproduction-record.mjs — refuse a reproduction that is not one.
 *
 *   node scripts/verify-reproduction-record.mjs
 *   node scripts/verify-reproduction-record.mjs --records <dir>
 *
 * WHY THIS EXISTS. E6_INDEPENDENTLY_REPRODUCED is the only level in
 * src/validation/evidenceLevel.ts that this project structurally cannot award
 * itself. Someone unaffiliated has to take a released artifact, run it on their
 * own hardware, and publish what they got. No amount of care inside this
 * repository produces that, which is why running the suite again here, on
 * another machine, under another operating system, is still not a reproduction.
 *
 * THE ONE RULE THE WHOLE FILE IS FOR. P4 refuses a record whose reproducer turns
 * out to be us: affiliated, funded, a contributor, or an organisation whose name
 * is this project's. That refusal is the container's reason to exist. Everything
 * else here keeps a record checkable — a persistent identifier that resolves, a
 * pinned artifact, raw output at a location the reproducer controls.
 *
 * THE DIRECTORY IS EMPTY ON PURPOSE. validation/reproduction/records/ holds one
 * EXAMPLE record and nobody outside this project has reproduced anything.
 * Inventing one would be worse than having none: the entire value of this
 * repository's evidence ladder is that the top rung is visibly unoccupied.
 *
 * WHAT IT DOES NOT DO. It cannot tell a real person from a well-formed one. An
 * ORCID that passes its checksum is a syntactically valid identifier, not a
 * verified human, and the verifier says so rather than implying otherwise. What
 * it guarantees is that a record makes checkable assertions: someone reading it
 * can resolve the identifier, fetch the artifact, and read the raw output.
 *
 * Exit 0 when every record verifies, 1 when any is rejected, 2 on a usage, read
 * or parse error.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import { validateAgainstSchema, isIsoDate, compareCodeUnits } from './lib/recordSchema.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const RECORDS_DIR = 'validation/reproduction/records';
export const SCHEMA_PATH = 'validation/reproduction/reproduction-record.schema.json';
export const CLAIM_REGISTER_PATH = 'docs/validation/claim-register.yaml';

/**
 * Every permitted status.
 *
 *   pending              someone has agreed to try; nothing has been run
 *   not-executed         deliberately left unrun
 *   blocked-external     cannot be closed from inside this repository at all
 *   reproduced           ran independently and got what the claim says
 *   partially-reproduced part of the registered scope only
 *   not-reproduced       ran independently and did not get it
 *   invalid              the reproduction itself was mis-run
 *   inconclusive         ran and valid, but cannot discriminate
 */
export const REPRODUCTION_STATUSES = [
  'pending',
  'not-executed',
  'blocked-external',
  'reproduced',
  'partially-reproduced',
  'not-reproduced',
  'invalid',
  'inconclusive',
];

/** Statuses that assert an independent run happened, so evidence must exist. */
export const RESULT_STATUSES = new Set(['reproduced', 'partially-reproduced', 'not-reproduced']);

/** Statuses that may never reach a count. */
export const UNCOUNTED_STATUSES = new Set(['pending', 'not-executed']);

/** Statuses under which a claim may be declared reproduced. */
export const SCOPE_CLAIMABLE_STATUSES = new Set(['reproduced', 'partially-reproduced']);

/** The evidence level this container is for, and the only one it accepts. */
export const EVIDENCE_LEVEL = 'E6_INDEPENDENTLY_REPRODUCED';

/** Names that mean this project. A reproducer carrying one is not independent. */
export const SELF_NAMES = /openlidar|openlidarviewer|(^|[^a-z])olv([^a-z]|$)|aurtech/i;

/**
 * Hosts nobody else can reach, so a location on one is not published.
 *
 * Two rules rather than one pattern, for the reason given in
 * verify-impact-record.mjs: the `^` applied to the leading alternative only,
 * and a reader cannot tell a deliberate mixed anchor from a typo.
 */
const PRIVATE_LOCATION_PREFIX = /^(?:file:|\/)/i;
const PRIVATE_LOCATION_ANYWHERE =
  /localhost|127\.0\.0\.1|0\.0\.0\.0|\.local(?:\/|$)|192\.168\.|10\.\d+\.|intranet|(?:^|\W)internal(?:\W|$)/i;
const isPrivateLocation = (value) =>
  PRIVATE_LOCATION_PREFIX.test(value) || PRIVATE_LOCATION_ANYWHERE.test(value);

/** A DOI, in the only form that resolves. */
const DOI = /^10\.\d{4,9}\/\S+$/;

/**
 * ORCID identifiers carry an ISO 7064 MOD 11-2 check digit. Checking it is not
 * proof a person exists — it rejects a typo and a casually invented number, and
 * a record that cannot even be resolved is not worth reading further.
 */
export function isValidOrcid(value) {
  const m = /^https:\/\/orcid\.org\/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])$/.exec(value);
  if (!m) return false;
  const digits = m[1].replace(/-/g, '');
  let total = 0;
  for (let i = 0; i < 15; i++) total = (total + Number(digits[i])) * 2;
  const expected = (12 - (total % 11)) % 11;
  const actual = digits[15] === 'X' ? 10 : Number(digits[15]);
  return expected === actual;
}

/** ROR identifiers are a fixed shape; ISNI and ARK are checked for shape only. */
const IDENTIFIER_SHAPE = {
  ORCID: { test: isValidOrcid, expected: 'https://orcid.org/0000-0000-0000-0000 with a valid MOD 11-2 check digit' },
  ROR: { test: (v) => /^https:\/\/ror\.org\/0[0-9a-hjkmnp-tv-z]{6}\d{2}$/.test(v), expected: 'https://ror.org/ followed by a 9-character ROR id' },
  ISNI: { test: (v) => /^https:\/\/isni\.org\/isni\/\d{15}[\dX]$/.test(v), expected: 'https://isni.org/isni/ followed by 16 characters' },
  ARK: { test: (v) => /^ark:\/\d{5,9}\/\S+$/.test(v), expected: 'ark:/NAAN/name' },
};

/** Claim ids from the register. Line-based, READ ONLY. */
export function parseClaimIds(yamlText) {
  const ids = new Set();
  for (const raw of yamlText.split('\n')) {
    const m = raw.trim().match(/^-?\s*claimId:\s*(\S+)/);
    if (m) ids.add(m[1]);
  }
  return ids;
}

/**
 * Verify one record. `ctx` supplies `record`, `file`, `schema` and `claimIds`.
 * Returns `[{ rule, message }]`; empty means the record verifies.
 */
export function collectReproductionProblems(ctx) {
  const { record: r, file, schema, claimIds } = ctx;
  const problems = [];
  const add = (rule, message) => problems.push({ rule, message: `${file}: ${message}` });

  // ── P1. Shape first ───────────────────────────────────────────────────────
  const schemaErrors = [];
  validateAgainstSchema(r, schema, schema, '$', schemaErrors);
  for (const e of schemaErrors) add('P1-SCHEMA', e);
  if (schemaErrors.length > 0) return problems;

  // ── P2. An example is marked as one on both sides ─────────────────────────
  const prefixed = r.recordId.startsWith('EXAMPLE-');
  if (prefixed !== r.example) {
    add('P2-EXAMPLE', `recordId ${prefixed ? 'is' : 'is not'} prefixed EXAMPLE- but example is ${r.example}; a template must be unmistakable from either field alone.`);
  }
  if (r.example && !UNCOUNTED_STATUSES.has(r.status)) {
    add('P2-EXAMPLE', `an example record may only sit at ${[...UNCOUNTED_STATUSES].sort(compareCodeUnits).join(' or ')}, not "${r.status}"; a template that reports an outcome is a fabricated reproduction.`);
  }

  // ── P3. The claims must exist in the register ─────────────────────────────
  for (const id of r.claimIds) {
    if (!claimIds.has(id)) {
      add('P3-CLAIM-UNKNOWN', `claimId "${id}" is not in ${CLAIM_REGISTER_PATH}.`);
    }
  }
  if (r.evidenceLevelClaimed !== EVIDENCE_LEVEL) {
    add('P3-CLAIM-UNKNOWN', `evidenceLevelClaimed is "${r.evidenceLevelClaimed}"; this container holds ${EVIDENCE_LEVEL} and nothing else.`);
  }

  // ── P4. A reproduction performed by this project is not a reproduction ────
  const ind = r.independence;
  const disqualifying = [];
  if (ind.affiliatedWithProject) disqualifying.push('independence.affiliatedWithProject is true');
  if (ind.fundedByProject) disqualifying.push('independence.fundedByProject is true');
  if (ind.contributedCode) disqualifying.push('independence.contributedCode is true');
  for (const [label, value] of [
    ['reproducer.name', r.reproducer.name],
    ['reproducer.affiliation.organisation', r.reproducer.affiliation.organisation],
    ['independence.statement', ind.statement],
  ]) {
    if (SELF_NAMES.test(value)) disqualifying.push(`${label} names this project`);
  }
  if (r.rawOutput.publishedBy === 'this-project') {
    disqualifying.push('rawOutput.publishedBy is "this-project", so the only copy of their evidence is ours');
  }
  if (disqualifying.length > 0) {
    add('P4-NOT-INDEPENDENT', `${disqualifying.join('; ')}. A reproduction performed, funded or published by this project is not an independent reproduction, whatever care went into it. E6 is the one level that cannot be awarded from inside this repository; file the work as an internal re-run instead.`);
  }

  // ── P5. Identity has to be resolvable by a third party ────────────────────
  const idf = r.reproducer.identifier;
  const shape = IDENTIFIER_SHAPE[idf.scheme];
  if (shape && !shape.test(idf.value)) {
    add('P5-IDENTIFIER', `reproducer.identifier ${JSON.stringify(idf.value)} is not a well-formed ${idf.scheme} (expected ${shape.expected}); a name with no resolvable identifier cannot be checked by a reader, and a well-formed identifier is still only a syntactic check, never proof the person exists.`);
  }

  // ── P6. What they ran has to be pinned ────────────────────────────────────
  const art = r.artifactUnderTest;
  if (!/^https:\/\//.test(art.downloadUrl) || isPrivateLocation(art.downloadUrl)) {
    add('P6-ARTIFACT-UNPINNED', `artifactUnderTest.downloadUrl ${JSON.stringify(art.downloadUrl)} is not a public https location; a reader cannot fetch what the reproducer ran.`);
  }
  if (/^0{40}$/.test(art.revision) && r.example !== true) {
    add('P6-ARTIFACT-UNPINNED', 'artifactUnderTest.revision is all zeros, which is a placeholder and not a revision.');
  }

  // ── P7. Dates have to be real, and in order ───────────────────────────────
  for (const [label, value] of [
    ['executed.startedAt', r.executed.startedAt],
    ['executed.completedAt', r.executed.completedAt],
  ]) {
    if (!isIsoDate(value)) add('P7-DATES', `${label} "${value}" is not a real calendar date.`);
  }
  if (r.executed.completedAt < r.executed.startedAt) {
    add('P7-DATES', `executed.completedAt ${r.executed.completedAt} precedes executed.startedAt ${r.executed.startedAt}.`);
  }
  if (r.rawOutput.retrievedAt && !isIsoDate(r.rawOutput.retrievedAt)) {
    add('P7-DATES', `rawOutput.retrievedAt "${r.rawOutput.retrievedAt}" is not a real calendar date.`);
  }

  // ── P8. A reported outcome needs raw output somewhere public ──────────────
  const raw = r.rawOutput;
  if (RESULT_STATUSES.has(r.status)) {
    if (!r.outcome) {
      add('P8-RAW-OUTPUT-MISSING', `status "${r.status}" asserts an independent run, so an outcome block is required.`);
    }
    if (raw.locationKind === 'none') {
      add('P8-RAW-OUTPUT-MISSING', `status "${r.status}" asserts an independent run whose raw output is nowhere; a reproduction nobody can read is a rumour about a result.`);
    }
    if (!raw.sha256) {
      add('P8-RAW-OUTPUT-MISSING', `status "${r.status}" asserts an independent run, so rawOutput.sha256 is required; without it the location can be replaced under the record.`);
    }
  }
  if (raw.locationKind === 'doi' && !DOI.test(raw.location)) {
    add('P8-RAW-OUTPUT-MISSING', `rawOutput.location ${JSON.stringify(raw.location)} is declared a DOI but is not one (expected 10.NNNN/suffix).`);
  }
  if (raw.locationKind !== 'doi' && raw.locationKind !== 'none') {
    if (!/^https:\/\//.test(raw.location) || isPrivateLocation(raw.location)) {
      add('P8-RAW-OUTPUT-MISSING', `rawOutput.location ${JSON.stringify(raw.location)} is not a public https location; "on file with the author" is not published output.`);
    }
  }

  // ── P9. Nothing unrun may carry a number ──────────────────────────────────
  if (UNCOUNTED_STATUSES.has(r.status)) {
    if (r.outcome) {
      add('P9-UNCOUNTED-CARRIES-OUTCOME', `status "${r.status}" means nothing was run, so an outcome block may not be present.`);
    }
    if (r.scope.reproduced.length > 0) {
      add('P9-UNCOUNTED-CARRIES-OUTCOME', `status "${r.status}" reproduces nothing, so scope.reproduced must be empty.`);
    }
  }

  // ── P10. Reproduced scope may not exceed the registered claims ────────────
  const registered = new Set(r.claimIds);
  for (const s of r.scope.reproduced) {
    if (!registered.has(s.claimId)) {
      add('P10-SCOPE-BROADER', `scope.reproduced names claimId "${s.claimId}", which this record does not list in claimIds.`);
    }
  }
  if (r.scope.reproduced.length > 0 && !SCOPE_CLAIMABLE_STATUSES.has(r.status)) {
    add('P10-SCOPE-BROADER', `status "${r.status}" reproduces nothing, so scope.reproduced must be empty.`);
  }
  if (r.status === 'reproduced' && r.outcome && r.outcome.deviations.length > 0) {
    add('P10-SCOPE-BROADER', `status "reproduced" while outcome.deviations lists ${r.outcome.deviations.length} difference(s); use partially-reproduced, or explain the deviations away in the record rather than in the status.`);
  }

  return problems;
}

/** Read every *.json record in `dir`, sorted by filename for determinism. */
export function loadRecords(dir) {
  const names = readdirSync(dir).filter((f) => f.endsWith('.json')).sort(compareCodeUnits);
  return names.map((name) => ({ name, record: JSON.parse(readFileSync(join(dir, name), 'utf8')) }));
}

/** Verify a whole directory. Returns `{ records, problems }`. */
export function verifyReproductionRecords(opts = {}) {
  const root = resolve(opts.root ?? ROOT);
  const recordsDir = resolve(opts.recordsDir ?? join(root, RECORDS_DIR));
  const registerPath = resolve(opts.registerPath ?? join(ROOT, CLAIM_REGISTER_PATH));

  const schema = JSON.parse(readFileSync(resolve(ROOT, SCHEMA_PATH), 'utf8'));
  const claimIds = parseClaimIds(readFileSync(registerPath, 'utf8'));

  const seenIds = new Map();
  const records = loadRecords(recordsDir).map(({ name, record }) => {
    const problems = collectReproductionProblems({ record, file: name, schema, claimIds });
    const id = record?.recordId;
    if (typeof id === 'string') {
      if (seenIds.has(id)) {
        problems.push({ rule: 'P11-DUPLICATE-RECORD', message: `${name}: recordId "${id}" is already used by ${seenIds.get(id)}.` });
      } else seenIds.set(id, name);
    }
    return { name, record, problems };
  });

  return { recordsDir, records, problems: records.flatMap((x) => x.problems) };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  let out;
  try {
    out = verifyReproductionRecords({ recordsDir: opt('--records'), registerPath: opt('--register') });
  } catch (err) {
    console.error(`verify:reproduction-record cannot read its inputs: ${err.message}`);
    process.exit(2);
  }

  if (out.problems.length > 0) {
    console.error('verify:reproduction-record FAILED\n');
    for (const p of out.problems) console.error(`  • [${p.rule}] ${p.message}`);
    console.error('\nE6 is the one evidence level this project cannot award itself.');
    console.error('Fix the record, or accept that the work was not an independent reproduction.');
    process.exit(1);
  }

  const real = out.records.filter((x) => x.record.example !== true);
  console.log(
    `verify:reproduction-record OK — ${out.records.length} record(s) in ${out.recordsDir}, ` +
      `${out.records.length - real.length} of them examples that count for nothing. ` +
      `Independent reproductions on file: ${real.length}. No claim is promoted by this check.`,
  );
  process.exit(0);
}
