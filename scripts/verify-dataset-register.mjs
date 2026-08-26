#!/usr/bin/env node
/**
 * verify-dataset-register.mjs — the validation dataset register has to be
 * citable, not merely present.
 *
 * A study that says "we used the Swiss tile" cannot be checked by anyone. The
 * register gives every dataset an id so a later cross-implementation run or
 * field study cites the id, and this script checks the properties that make the
 * citation worth anything. The nine rejections below are the ones that turn a
 * measurement into a number nobody can defend:
 *
 *   R1 licence-missing               unlicensed data cannot be cited as evidence
 *   R2 mutable-source-needs-checksum a host can change the bytes under you
 *   R3 crs-missing                   a metric claim without a frame is not checkable
 *   R4 unit-axis-mismatch            metres declared against a foot datum
 *   R5 checkpoint-reused-as-control  processing marked its own homework
 *   R6 checksum-drift                the committed file is not the recorded one
 *   R7 restricted-but-redistributable a record that claims both at once
 *   R8 candidate-derived-reference   the software under test supplied its own truth
 *   R9 committed-file-absent         a hash recorded for a file that is not here
 *
 * WHY THE RULE CODES ARE IN THE MESSAGES. Each rejection has a test that proves
 * it fails for its own reason and not incidentally, which needs the reason to be
 * machine-readable. The codes are that handle; do not renumber them.
 *
 * The YAML reader is a deliberate subset (see parseRegister): flat records,
 * scalars and inline sequences. No dependency is added for this, matching the
 * other register linters in this directory, and the subset is exactly what the
 * schema allows a record to be.
 *
 * Usage: node scripts/verify-dataset-register.mjs
 *        node scripts/verify-dataset-register.mjs --register <path> --root <dir>
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from './lib/isCliEntry.mjs';

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REGISTER = 'validation/datasets/dataset-register.yaml';
const SCHEMA_PATH = 'validation/datasets/dataset-register.schema.json';

// ── YAML subset reader ──────────────────────────────────────────────────────

/**
 * Read the register's YAML subset: top-level scalars, one `datasets:` sequence,
 * and records whose values are scalars or inline sequences. Anything outside
 * the subset throws rather than being silently half-read. A register that
 * parses to the wrong thing is worse than one that fails to parse.
 */
export function parseRegister(text) {
  const doc = {};
  let datasets = null;
  let record = null;
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;

    const item = raw.match(/^ {2}- ([A-Za-z][A-Za-z0-9_]*):(?:[ \t]+(.*))?$/);
    if (item) {
      if (datasets === null) throw new Error(`line ${i + 1}: a record appears before "datasets:"`);
      record = {};
      datasets.push(record);
      record[item[1]] = parseScalar(item[2] ?? '', i + 1);
      continue;
    }

    const nested = raw.match(/^ {4}([A-Za-z][A-Za-z0-9_]*):(?:[ \t]+(.*))?$/);
    if (nested) {
      if (record === null) throw new Error(`line ${i + 1}: a record field appears outside a record`);
      if (nested[1] in record) throw new Error(`line ${i + 1}: duplicate field "${nested[1]}" in one record`);
      record[nested[1]] = parseScalar(nested[2] ?? '', i + 1);
      continue;
    }

    const top = raw.match(/^([A-Za-z][A-Za-z0-9_]*):(?:[ \t]+(.*))?$/);
    if (top) {
      if (top[1] === 'datasets') {
        if ((top[2] ?? '').trim() !== '') throw new Error(`line ${i + 1}: "datasets:" must start a block sequence`);
        datasets = [];
        doc.datasets = datasets;
        record = null;
      } else {
        doc[top[1]] = parseScalar(top[2] ?? '', i + 1);
        record = null;
      }
      continue;
    }

    throw new Error(`line ${i + 1}: outside the supported YAML subset: ${raw}`);
  }

  return doc;
}

/** Scalar, inline sequence, boolean or number. Quoted strings stay strings. */
function parseScalar(text, lineNo) {
  const v = text.trim();
  if (v === '') throw new Error(`line ${lineNo}: empty value; write an explicit sentinel instead`);

  if (v.startsWith('[')) {
    if (!v.endsWith(']')) throw new Error(`line ${lineNo}: unterminated inline sequence`);
    const inner = v.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((part) => parseScalar(part, lineNo));
  }
  if (v.startsWith('"') && v.endsWith('"') && v.length > 1) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length > 1) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return Number.parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return Number.parseFloat(v);
  return v;
}

// ── Schema validation (the subset of JSON Schema this register uses) ─────────

/**
 * A required field that is absent or blank is reported under the rule code for
 * the thing it breaks, not as a generic schema complaint. "Missing licence" is
 * rejection R1 whether the key was deleted or left empty, and a test asserting
 * R1 should not have to know which.
 */
function codeForField(field) {
  if (field === 'licence') return 'R1 licence-missing';
  if (field === 'horizontalCrs' || field === 'verticalCrs') return 'R3 crs-missing';
  if (field === 'sourceSha256') return 'R2 mutable-source-needs-checksum';
  return 'RX schema';
}

function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeMatches(value, allowed) {
  const list = Array.isArray(allowed) ? allowed : [allowed];
  const actual = typeOf(value);
  // JSON Schema treats every integer as a number; the reverse is not true.
  return list.includes(actual) || (actual === 'integer' && list.includes('number'));
}

/** Resolve the one `$ref` shape this schema uses: local `#/$defs/<name>`. */
function deref(schema, node) {
  let seen = 0;
  while (node && node.$ref) {
    if (seen++ > 8) throw new Error('schema $ref cycle');
    const name = node.$ref.replace('#/$defs/', '');
    node = { ...schema.$defs[name], ...Object.fromEntries(Object.entries(node).filter(([k]) => k !== '$ref')) };
  }
  return node;
}

function checkValue(schema, node, value, where, problems, field) {
  const spec = deref(schema, node);
  if (spec.type && !typeMatches(value, spec.type)) {
    problems.push(`${where} [${codeForField(field)}]: ${field} must be ${[].concat(spec.type).join(' or ')}, got ${typeOf(value)}.`);
    return;
  }
  if (spec.const !== undefined && value !== spec.const) {
    problems.push(`${where} [RX schema]: ${field} must be ${JSON.stringify(spec.const)}.`);
  }
  if (spec.enum && !spec.enum.includes(value)) {
    problems.push(`${where} [${codeForField(field)}]: ${field} is "${value}", which is not one of ${spec.enum.join(', ')}.`);
  }
  if (spec.pattern && typeof value === 'string' && !new RegExp(spec.pattern).test(value)) {
    problems.push(`${where} [${codeForField(field)}]: ${field} "${value}" does not match ${spec.pattern}.`);
  }
  if (spec.minLength !== undefined && typeof value === 'string' && value.trim().length < spec.minLength) {
    problems.push(`${where} [${codeForField(field)}]: ${field} is blank.`);
  }
  if (spec.items && Array.isArray(value)) {
    value.forEach((entry, i) => checkValue(schema, spec.items, entry, where, problems, `${field}[${i}]`));
  }
}

/** Structural problems only. Semantics are the nine rules further down. */
export function collectSchemaProblems(doc, schema) {
  const problems = [];
  for (const field of schema.required ?? []) {
    if (!(field in doc)) problems.push(`register [RX schema]: top-level "${field}" is missing.`);
  }
  if (schema.additionalProperties === false) {
    for (const field of Object.keys(doc)) {
      if (!(field in schema.properties)) problems.push(`register [RX schema]: unknown top-level field "${field}".`);
    }
  }
  if ('schemaVersion' in doc) {
    checkValue(schema, schema.properties.schemaVersion, doc.schemaVersion, 'register', problems, 'schemaVersion');
  }
  if (!Array.isArray(doc.datasets)) {
    problems.push('register [RX schema]: "datasets" must be a sequence.');
    return problems;
  }

  const recordSpec = deref(schema, schema.properties.datasets.items);
  doc.datasets.forEach((record, index) => {
    const where = typeof record.datasetId === 'string' ? record.datasetId : `datasets[${index}]`;
    for (const field of recordSpec.required) {
      if (!(field in record)) {
        problems.push(`${where} [${codeForField(field)}]: ${field} is missing.`);
      }
    }
    for (const [field, value] of Object.entries(record)) {
      const spec = recordSpec.properties[field];
      if (!spec) {
        problems.push(`${where} [RX schema]: unknown field "${field}"; add it to the schema first if it is really needed.`);
        continue;
      }
      checkValue(schema, spec, value, where, problems, field);
    }
  });
  return problems;
}

// ── Unit / axis vocabulary ──────────────────────────────────────────────────

/**
 * Foot and metre are read off the CRS label, plus a short list of codes whose
 * names are commonly written without a unit. The list is not exhaustive on
 * purpose: an unrecognised code raises nothing, so this check never invents a
 * contradiction it cannot see.
 */
const FOOT_LABEL = /(?:^|[^a-z])(ft|ftus|feet|foot)(?:[^a-z]|$)|us[- ]?survey[- ]?f(?:oo)?t|international[- ]?f(?:oo)?t/i;
const METRE_LABEL = /\bmetre|\bmeter|\bmetric\b/i;
const FOOT_EPSG = new Set([2231, 2232, 2233, 3433, 5702, 6359, 6360, 6430, 6431, 8228]);
const METRE_EPSG = new Set([2056, 3855, 4979, 5703, 5714, 5773, 5783, 5728, 25832, 32633]);

function epsgCodesIn(label) {
  return [...String(label).matchAll(/EPSG[:\s]*(\d{4,5})/gi)].map((m) => Number.parseInt(m[1], 10));
}
function indicatesFoot(label) {
  return FOOT_LABEL.test(label) || epsgCodesIn(label).some((c) => FOOT_EPSG.has(c));
}
function indicatesMetre(label) {
  return METRE_LABEL.test(label) || epsgCodesIn(label).some((c) => METRE_EPSG.has(c));
}
const isFootUnit = (u) => u === 'us-survey-foot' || u === 'international-foot';

// ── Provenance vocabulary ───────────────────────────────────────────────────

/**
 * A source URL that is immutable enough that a missing checksum is not a hole:
 * a DOI or an archival record resolves to fixed bytes, or the URL pins the
 * digest itself. Everything else served over http can change without notice.
 */
const IMMUTABLE_SOURCE = [
  /^https?:\/\/(dx\.)?doi\.org\//i,
  /^https?:\/\/zenodo\.org\/records?\//i,
  /^https?:\/\/archive\.softwareheritage\.org\//i,
  /[?&#]sha256=/i,
];

/**
 * Directories holding this software's OWN output. Validation truth must not
 * come from here. `scripts/` is deliberately NOT on the list: a generator that
 * writes an analytic surface from a closed-form equation is an input, and the
 * reference it gets compared against still has to come from elsewhere.
 */
const CANDIDATE_OUTPUT = /^(?:benchmarks\/out|validation\/snapshot|validation\/defects|dist)\//;
const CANDIDATE_NAME = /openlidarviewer|open ?lidar ?viewer|(?:^|[^a-z])olv(?:[^a-z]|$)/i;

/** Latitude/longitude-looking pair, at the precision that identifies a site. */
const PRECISE_COORD_PAIR = /-?\d{1,3}\.\d{4,}[ ,;/]+-?\d{1,3}\.\d{4,}/;

// ── The nine rejections ─────────────────────────────────────────────────────

/**
 * `fileAt(relPath)` returns `{ sha256, bytes }` for a file under the tree, or
 * null when it does not exist. Passed in so the rules stay a pure function of
 * the register plus the tree, and a test can drive either.
 */
export function collectDatasetRegisterProblems(doc, schema, fileAt) {
  const problems = collectSchemaProblems(doc, schema);
  if (!Array.isArray(doc.datasets)) return problems;

  const seenIds = new Map();

  for (const [index, r] of doc.datasets.entries()) {
    const id = typeof r.datasetId === 'string' ? r.datasetId : `datasets[${index}]`;

    if (typeof r.datasetId === 'string') {
      if (seenIds.has(r.datasetId)) {
        problems.push(`${id} [RX duplicate-id]: datasetId is used by datasets[${seenIds.get(r.datasetId)}] as well; an id is a citation handle and must resolve to one record.`);
      } else {
        seenIds.set(r.datasetId, index);
      }
    }

    // ── R1: an unlicensed dataset cannot be cited as evidence ──────────────
    if (typeof r.licence === 'string' && /^(unknown|tbd|todo|n\/a|none|\?+)$/i.test(r.licence.trim())) {
      problems.push(`${id} [R1 licence-missing]: licence is "${r.licence}". Find the licence or drop the dataset; a reader cannot reuse evidence they may not use.`);
    }

    // ── R2: a mutable source with no checksum ──────────────────────────────
    if (r.sourceSha256 === 'not-fetched' && r.storage !== 'restricted') {
      const url = String(r.sourceUrl ?? '');
      const mutable = /^https?:\/\//i.test(url) && !IMMUTABLE_SOURCE.some((re) => re.test(url));
      const why = mutable
        ? 'the host can replace the bytes at that URL without notice'
        : 'nothing pins the bytes that were actually used';
      problems.push(`${id} [R2 mutable-source-needs-checksum]: sourceSha256 is "not-fetched" while storage is "${r.storage}", and ${why}. Record the digest, or set storage to "restricted" if the bytes were deliberately never retrieved.`);
    }

    // ── R3: a metric claim needs a frame (blank/absent CRS) ────────────────
    for (const axis of ['horizontalCrs', 'verticalCrs']) {
      if (typeof r[axis] === 'string' && r[axis].trim() === '') {
        problems.push(`${id} [R3 crs-missing]: ${axis} is blank.`);
      }
    }

    // ── R4: units must agree with the axis they measure ────────────────────
    for (const axis of ['horizontal', 'vertical']) {
      const crs = r[`${axis}Crs`];
      const units = r[`${axis}Units`];
      if (typeof crs !== 'string' || typeof units !== 'string') continue;

      const crsAbsent = crs.trim().toLowerCase().startsWith('not-applicable');
      const unitsAbsent = units === 'not-applicable';
      if (crsAbsent !== unitsAbsent) {
        problems.push(`${id} [R4 unit-axis-mismatch]: ${axis}Crs is "${crs}" and ${axis}Units is "${units}"; an axis either exists with a unit or is not-applicable on both, never one of each.`);
        continue;
      }
      if (crsAbsent) continue;

      if (indicatesFoot(crs) && !isFootUnit(units)) {
        problems.push(`${id} [R4 unit-axis-mismatch]: ${axis}Crs "${crs}" is a foot system but ${axis}Units is "${units}". A metre reading of foot data is off by 3.28x and every derived figure inherits it.`);
      }
      if (indicatesMetre(crs) && isFootUnit(units)) {
        problems.push(`${id} [R4 unit-axis-mismatch]: ${axis}Crs "${crs}" is a metre system but ${axis}Units is "${units}".`);
      }
      if (units === 'degree' && (indicatesFoot(crs) || indicatesMetre(crs))) {
        problems.push(`${id} [R4 unit-axis-mismatch]: ${axis}Units is "degree" but ${axis}Crs "${crs}" is a linear system.`);
      }
    }

    // ── R5: a control point cannot check the processing that consumed it ───
    const control = Array.isArray(r.controlPointIds) ? r.controlPointIds : [];
    const checks = Array.isArray(r.checkpointIds) ? r.checkpointIds : [];
    const shared = control.filter((pid) => checks.includes(pid));
    if (shared.length > 0) {
      problems.push(`${id} [R5 checkpoint-reused-as-control]: ${shared.length} point id(s) are declared as both processing control and validation checkpoints (${shared.slice(0, 5).join(', ')}${shared.length > 5 ? ', ...' : ''}). Error measured at a point the adjustment already fitted is not error.`);
    }
    // ── R7: restricted and redistributable at the same time ────────────────
    if (r.redistribution === 'permitted') {
      if (r.storage === 'restricted') {
        problems.push(`${id} [R7 restricted-but-redistributable]: storage is "restricted" but redistribution is "permitted". If it may be passed on it is not restricted; pick the one that is true.`);
      }
      if (typeof r.licence === 'string' && /proprietary|confidential|internal[- ]only|non[- ]disclosure|\bnda\b|access agreement|no public licence/i.test(r.licence)) {
        problems.push(`${id} [R7 restricted-but-redistributable]: licence "${r.licence}" describes restricted access while redistribution is "permitted".`);
      }
      if (['internal-only', 'no-redistribution', 'embargoed'].includes(r.checkpointUseRestriction)) {
        problems.push(`${id} [R7 restricted-but-redistributable]: checkpointUseRestriction is "${r.checkpointUseRestriction}" while redistribution is "permitted".`);
      }
    }

    // ── R8: the software under test must not supply its own truth ──────────
    if (typeof r.checkpointSource === 'string' && CANDIDATE_NAME.test(r.checkpointSource)) {
      problems.push(`${id} [R8 candidate-derived-reference]: checkpointSource "${r.checkpointSource}" names the software under test. Comparing an implementation against its own output measures repeatability, not accuracy.`);
    }
    for (const field of ['sourceUrl', 'localPath']) {
      const value = r[field];
      if (typeof value === 'string' && CANDIDATE_OUTPUT.test(value)) {
        problems.push(`${id} [R8 candidate-derived-reference]: ${field} "${value}" points into this project's own output tree. Reference data has to come from outside the candidate.`);
      }
    }

    // ── R6 / R9: the committed bytes are the recorded bytes ────────────────
    if (r.storage === 'committed') {
      const path = typeof r.localPath === 'string' ? r.localPath : null;
      if (!path) {
        problems.push(`${id} [R9 committed-file-absent]: storage is "committed" but no localPath is given, so nothing can be checked.`);
      } else {
        const file = fileAt(path);
        if (!file) {
          problems.push(`${id} [R9 committed-file-absent]: storage is "committed" but ${path} is not in the tree. Commit the file, or say storage "acquired"/"restricted" so absence is not read as breakage.`);
        } else {
          if (r.sourceSha256 !== 'not-fetched' && typeof r.sourceSha256 === 'string' && file.sha256 !== r.sourceSha256) {
            problems.push(`${id} [R6 checksum-drift]: ${path} hashes to ${file.sha256} but the register records ${r.sourceSha256}. One of the two is stale, and every result citing this id is unsafe until it is settled.`);
          }
          if (typeof r.sourceBytes === 'number' && file.bytes !== r.sourceBytes) {
            problems.push(`${id} [RX size-drift]: ${path} is ${file.bytes} bytes, the register records ${r.sourceBytes}.`);
          }
        }
      }
    }

    // ── Honesty guards ────────────────────────────────────────────────────
    if (typeof r.datasetId === 'string' && r.datasetId.startsWith('EXAMPLE-')) {
      if (!/^EXAMPLE RECORD\b/.test(String(r.knownLimitations ?? ''))) {
        problems.push(`${id} [RX example-unlabelled]: an EXAMPLE- record must open knownLimitations with "EXAMPLE RECORD" so its placeholder values are never read as a dataset in use.`);
      }
    }
    if (r.storage === 'restricted') {
      for (const [field, value] of Object.entries(r)) {
        if (typeof value === 'string' && PRECISE_COORD_PAIR.test(value)) {
          problems.push(`${id} [RX restricted-coordinates]: ${field} carries a precise coordinate pair. A restricted record states provenance, never location.`);
        }
      }
    }
  }

  return problems;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function isMain() {
  return isCliEntry(import.meta.url);
}

if (isMain()) {
  const registerPath = resolve(SCRIPT_ROOT, arg('--register', DEFAULT_REGISTER));
  const treeRoot = resolve(SCRIPT_ROOT, arg('--root', '.'));
  const schema = JSON.parse(readFileSync(resolve(SCRIPT_ROOT, SCHEMA_PATH), 'utf8'));

  // One read, no pre-check. Asking existsSync/statSync first and then reading
  // is a check-then-use window, and it also answers a different question than
  // the one that matters: whether the bytes can be read now. A directory or a
  // vanished file both surface here as a read failure, which is the same null
  // the caller already handles.
  const fileAt = (relPath) => {
    const full = resolve(treeRoot, relPath);
    let buf;
    try {
      buf = readFileSync(full);
    } catch {
      return null;
    }
    return { sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
  };

  let doc;
  try {
    doc = parseRegister(readFileSync(registerPath, 'utf8'));
  } catch (err) {
    console.error('verify:dataset-register FAILED\n');
    console.error(`  • ${registerPath} could not be read: ${err.message}`);
    console.error('');
    process.exit(1);
  }

  const problems = collectDatasetRegisterProblems(doc, schema, fileAt);

  if (problems.length === 0) {
    // An EXAMPLE- record is a worked template carrying placeholder values, not
    // data this project has used. The rules above check it like any other
    // record; the counts below hold it apart, so the total is the number of
    // datasets a study can cite rather than the number of records in the file.
    const isTemplate = (r) => typeof r.datasetId === 'string' && r.datasetId.startsWith('EXAMPLE-');
    const records = doc.datasets.filter((r) => !isTemplate(r));
    const templates = doc.datasets.filter(isTemplate);
    const byStorage = { committed: 0, acquired: 0, restricted: 0 };
    for (const r of records) byStorage[r.storage]++;
    const withCheckpoints = records.filter((r) => r.containsIndependentCheckpoints === true).length;
    const licences = new Set(records.map((r) => r.licence));
    // Every committed file is checksummed, template or not, so this count reads
    // the whole register.
    const committedFiles = doc.datasets.filter((r) => r.storage === 'committed').length;
    console.log(
      `verify:dataset-register OK — ${records.length} dataset(s) ` +
        `(${byStorage.committed} committed, ${byStorage.acquired} acquired, ${byStorage.restricted} restricted) ` +
        `plus ${templates.length} EXAMPLE template record(s), counted separately; ` +
        `${licences.size} distinct licence(s), all named; every CRS and unit pair agrees; ` +
        `${withCheckpoints} dataset(s) declare independent checkpoints with no id shared with processing control; ` +
        `all ${committedFiles} committed file(s) match their recorded sha256.`,
    );
    process.exit(0);
  }

  console.error('verify:dataset-register FAILED\n');
  console.error(`The register cannot be cited as it stands (${registerPath}):`);
  for (const p of problems) console.error(`  • ${p}`);
  console.error('');
  console.error('Rule codes: R1 licence, R2 checksum, R3 CRS, R4 units, R5 checkpoint reuse,');
  console.error('R6 checksum drift, R7 restricted vs redistributable, R8 candidate-derived, R9 missing file.');
  process.exit(1);
}
