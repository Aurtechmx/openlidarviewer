#!/usr/bin/env node
/**
 * verify-impact-record.mjs — refuse an impact claim nobody can check.
 *
 *   node scripts/verify-impact-record.mjs
 *   node scripts/verify-impact-record.mjs --records <dir>
 *
 * WHY THIS EXISTS. Institutional use, research outputs and citations are the
 * one part of a project's record that nothing inside the repository can produce
 * and everything inside the repository is tempted to assert. The failure mode is
 * specific: a line that reads "in use at several universities" with no way to
 * check it. That line costs more than it earns here, because the whole argument
 * of this repository is that its claims come with a way to check them. An
 * unverifiable claim of impact is worse than no claim of impact.
 *
 * SO THE RULE IS: every record names a source a stranger can resolve, and I3
 * refuses to let a record without one carry status "verified". "Personal
 * communication" and "unpublished" stay in the vocabulary on purpose, so a
 * record can say honestly what it is; they simply never reach a count, and
 * scripts/build-impact-summary.mjs excludes them by the same rule.
 *
 * THE DIRECTORY IS EMPTY ON PURPOSE. validation/impact/records/ holds one
 * EXAMPLE record. No use, output or citation has been recorded, and the summary
 * says zero.
 *
 * WHAT IT DOES NOT DO. It does not fetch anything. A DOI that passes the shape
 * check here has not been resolved by this script, and the record says who
 * resolved it and when instead. Network access would make this check
 * non-deterministic and would fail in an offline clone, which is the environment
 * the rest of this repository's verification is built for.
 *
 * Exit 0 when every record verifies, 1 when any is rejected, 2 on a usage, read
 * or parse error.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import { validateAgainstSchema, isIsoDate, compareCodeUnits } from './lib/recordSchema.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const RECORDS_DIR = 'validation/impact/records';
export const SCHEMA_PATH = 'validation/impact/impact-record.schema.json';
export const CLAIM_REGISTER_PATH = 'docs/validation/claim-register.yaml';

/**
 * Every permitted status.
 *
 *   pending      recorded, source not yet checked
 *   verified     the source was resolved, by the method the record names
 *   unverifiable checked, and the source turned out not to be checkable
 *   retracted    the output was retracted at source
 *   withdrawn    the subject asked to be removed, or the use ended
 */
export const IMPACT_STATUSES = ['pending', 'verified', 'unverifiable', 'retracted', 'withdrawn'];

/**
 * Only a verified record counts. The other four are visible in the register and
 * absent from every total, which is the difference between a queue and a claim.
 */
export const UNCOUNTED_STATUSES = new Set(['pending', 'unverifiable', 'retracted', 'withdrawn']);

/** Source kinds that a stranger can resolve. Nothing else may be counted. */
export const PUBLIC_SOURCE_KINDS = new Set([
  'doi',
  'arxiv',
  'pubmed',
  'isbn',
  'handle',
  'software-heritage',
  'public-url',
]);

/** Shape checks for the identifier kinds that have a fixed form. */
const SOURCE_SHAPE = {
  doi: { test: (v) => /^10\.\d{4,9}\/\S+$/.test(v), expected: '10.NNNN/suffix' },
  arxiv: { test: (v) => /^arXiv:\d{4}\.\d{4,5}(v\d+)?$/.test(v), expected: 'arXiv:YYMM.NNNNN' },
  pubmed: { test: (v) => /^PMID:\d{1,9}$/.test(v), expected: 'PMID:NNNNNNN' },
  isbn: { test: (v) => /^(97[89])?\d{9}[\dX]$/.test(v.replace(/[- ]/g, '')), expected: 'a 10 or 13 digit ISBN' },
  handle: { test: (v) => /^\d{2,5}(\.\d+)*\/\S+$/.test(v), expected: 'PREFIX/SUFFIX' },
  'software-heritage': { test: (v) => /^swh:1:[a-z]{3}:[0-9a-f]{40}/.test(v), expected: 'swh:1:TYPE:HASH' },
  'public-url': { test: (v) => /^https:\/\//.test(v), expected: 'an https URL' },
};

/**
 * Locations nobody else can reach, so a URL on one is not a public source.
 *
 * Two rules rather than one pattern. The first matches only at the start,
 * because a local scheme or an absolute path is a prefix. The second matches
 * anywhere, because a private host can sit at any position. Written as one
 * regex the `^` bound to the leading alternative alone, which reads as a
 * mistake whether or not it is one.
 */
const PRIVATE_LOCATION_PREFIX = /^(?:file:|\/)/i;
const PRIVATE_LOCATION_ANYWHERE =
  /localhost|127\.0\.0\.1|\.local(?:\/|$)|192\.168\.|10\.\d+\.|intranet|(?:^|\W)internal(?:\W|$)/i;
const isPrivateLocation = (value) =>
  PRIVATE_LOCATION_PREFIX.test(value) || PRIVATE_LOCATION_ANYWHERE.test(value);

/** Independent web archives. A snapshot elsewhere is not an independent one. */
const ARCHIVE_HOST = /^https:\/\/(web\.archive\.org\/|archive\.(ph|today)\/|perma\.cc\/|www\.webcitation\.org\/)/;

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
export function collectImpactProblems(ctx) {
  const { record: r, file, schema, claimIds } = ctx;
  const problems = [];
  const add = (rule, message) => problems.push({ rule, message: `${file}: ${message}` });

  // ── I1. Shape first ───────────────────────────────────────────────────────
  const schemaErrors = [];
  validateAgainstSchema(r, schema, schema, '$', schemaErrors);
  for (const e of schemaErrors) add('I1-SCHEMA', e);
  if (schemaErrors.length > 0) return problems;

  // ── I2. An example is marked as one on both sides ─────────────────────────
  const prefixed = r.recordId.startsWith('EXAMPLE-');
  if (prefixed !== r.example) {
    add('I2-EXAMPLE', `recordId ${prefixed ? 'is' : 'is not'} prefixed EXAMPLE- but example is ${r.example}; a template must be unmistakable from either field alone.`);
  }
  if (r.example && r.status === 'verified') {
    add('I2-EXAMPLE', 'an example record may not sit at status "verified"; a template that reports impact is a fabricated impact claim.');
  }

  // ── I3. A counted record names a source a stranger can resolve ────────────
  const src = r.source;
  const isPublic = PUBLIC_SOURCE_KINDS.has(src.kind);
  if (r.status === 'verified' && !isPublic) {
    add('I3-SOURCE-UNVERIFIABLE', `source.kind "${src.kind}" is not something a reader can resolve, so this record may not be status "verified". An unverifiable claim of impact is worse than none: it spends the credibility that the rest of this repository's evidence discipline exists to earn. Keep the record at "unverifiable" and say what it is, or find a public source.`);
  }
  const shape = SOURCE_SHAPE[src.kind];
  if (shape && !shape.test(src.value)) {
    add('I3-SOURCE-UNVERIFIABLE', `source.value ${JSON.stringify(src.value)} is declared ${src.kind} but is not one (expected ${shape.expected}).`);
  }
  if (src.kind === 'public-url' && isPrivateLocation(src.value)) {
    add('I3-SOURCE-UNVERIFIABLE', `source.value ${JSON.stringify(src.value)} points somewhere only this project can reach; that is not a public source.`);
  }
  if (r.status === 'verified' && r.verification.method === 'not-verified') {
    add('I3-SOURCE-UNVERIFIABLE', 'status is "verified" while verification.method is "not-verified"; one of the two is a lie about the same act.');
  }
  if (r.status === 'verified' && r.relationToProject.selfReported && !isPublic) {
    add('I3-SOURCE-UNVERIFIABLE', 'the only source is this project\'s own statement that the use happened; self-report is not verification.');
  }

  // ── I4. A verified URL needs an independent snapshot ──────────────────────
  if (r.status === 'verified' && src.kind === 'public-url') {
    if (!src.archivedUrl) {
      add('I4-ARCHIVE-REQUIRED', 'a verified public-url record needs source.archivedUrl; a bare URL rots, and a dead link cannot be told apart from an invention.');
    } else if (!ARCHIVE_HOST.test(src.archivedUrl)) {
      add('I4-ARCHIVE-REQUIRED', `source.archivedUrl ${JSON.stringify(src.archivedUrl)} is not a snapshot at an independent web archive; a copy under our own control proves nothing about the original.`);
    }
  }

  // ── I5. Dates have to be real, and in order ───────────────────────────────
  for (const [label, value] of [
    ['source.retrievedAt', src.retrievedAt],
    ['verification.verifiedAt', r.verification.verifiedAt],
  ]) {
    if (!isIsoDate(value)) add('I5-DATES', `${label} "${value}" is not a real calendar date.`);
  }
  if (r.subject.publishedAt && !isIsoDate(r.subject.publishedAt)) {
    add('I5-DATES', `subject.publishedAt "${r.subject.publishedAt}" is not a real calendar date.`);
  }
  if (r.verification.verifiedAt < src.retrievedAt) {
    add('I5-DATES', `verification.verifiedAt ${r.verification.verifiedAt} precedes source.retrievedAt ${src.retrievedAt}; the source cannot have been checked before it was fetched.`);
  }
  if (r.subject.publishedAt && r.subject.publishedAt > src.retrievedAt) {
    add('I5-DATES', `subject.publishedAt ${r.subject.publishedAt} is after source.retrievedAt ${src.retrievedAt}.`);
  }

  // ── I6. Our own paper is not somebody else's adoption ─────────────────────
  if (r.relationToProject.byProjectMembers && r.kind === 'institutional-use') {
    add('I6-SELF-REPORTED-AS-ADOPTION', 'a record authored by this project\'s own members is filed as institutional-use; use by the people who wrote the software is not adoption. File it as research-output and let the summary count the two separately.');
  }
  if (r.relationToProject.byProjectMembers && !r.relationToProject.note) {
    add('I6-SELF-REPORTED-AS-ADOPTION', 'relationToProject.byProjectMembers is true, so relationToProject.note must say which members and in what role; the summary reports this separately and a reader needs to see why.');
  }

  // ── I7. Referenced claims must exist ──────────────────────────────────────
  for (const id of r.claimIds ?? []) {
    if (!claimIds.has(id)) {
      add('I7-CLAIM-UNKNOWN', `claimIds names "${id}", which is not in ${CLAIM_REGISTER_PATH}.`);
    }
  }

  return problems;
}

/** Read every *.json record in `dir`, sorted by filename for determinism. */
export function loadRecords(dir) {
  const names = readdirSync(dir).filter((f) => f.endsWith('.json')).sort(compareCodeUnits);
  return names.map((name) => ({ name, record: JSON.parse(readFileSync(join(dir, name), 'utf8')) }));
}

/** Verify a whole directory. Returns `{ records, problems }`. */
export function verifyImpactRecords(opts = {}) {
  const root = resolve(opts.root ?? ROOT);
  const recordsDir = resolve(opts.recordsDir ?? join(root, RECORDS_DIR));
  const registerPath = resolve(opts.registerPath ?? join(ROOT, CLAIM_REGISTER_PATH));

  const schema = JSON.parse(readFileSync(resolve(ROOT, SCHEMA_PATH), 'utf8'));
  const claimIds = parseClaimIds(readFileSync(registerPath, 'utf8'));

  const seenIds = new Map();
  const seenSources = new Map();
  const records = loadRecords(recordsDir).map(({ name, record }) => {
    const problems = collectImpactProblems({ record, file: name, schema, claimIds });
    const id = record?.recordId;
    if (typeof id === 'string') {
      if (seenIds.has(id)) {
        problems.push({ rule: 'I8-DUPLICATE-RECORD', message: `${name}: recordId "${id}" is already used by ${seenIds.get(id)}.` });
      } else seenIds.set(id, name);
    }
    // The same source filed twice counts one thing as two, which is the
    // arithmetic version of the claim this container exists to prevent.
    const key = `${record?.source?.kind}:${record?.source?.value}`;
    if (record?.source?.value && record.source.kind !== 'personal-communication') {
      if (seenSources.has(key)) {
        problems.push({ rule: 'I8-DUPLICATE-RECORD', message: `${name}: source ${key} is already recorded by ${seenSources.get(key)}; one source counted twice is two impacts that did not happen.` });
      } else seenSources.set(key, name);
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
    out = verifyImpactRecords({ recordsDir: opt('--records'), registerPath: opt('--register') });
  } catch (err) {
    console.error(`verify:impact-record cannot read its inputs: ${err.message}`);
    process.exit(2);
  }

  if (out.problems.length > 0) {
    console.error('verify:impact-record FAILED\n');
    for (const p of out.problems) console.error(`  • [${p.rule}] ${p.message}`);
    console.error('\nAn impact record that a reader cannot check is worth less than silence.');
    process.exit(1);
  }

  const counted = out.records.filter((x) => x.record.example !== true && x.record.status === 'verified');
  console.log(
    `verify:impact-record OK — ${out.records.length} record(s) in ${out.recordsDir}, ` +
      `${counted.length} of them verified and countable. Nothing here is evidence for any claim.`,
  );
  process.exit(0);
}
