#!/usr/bin/env node
/**
 * verify-generalization-record.mjs — refuse an extrapolation dressed as a result.
 *
 *   node scripts/verify-generalization-record.mjs
 *   node scripts/verify-generalization-record.mjs --records <dir>
 *
 * WHY THIS EXISTS. Every study in this repository ran on specific data under
 * specific parameters, and every one of them invites the same next sentence:
 * "so it works on other terrain / other sensors / at other densities". That
 * sentence is an inference, not a measurement, and until now it was made in
 * prose or not at all — which means nothing in the tree marked where the
 * measurement stopped and the extrapolation started. A register of inferences
 * puts the step in the open, one record per reach, so it can be refused as
 * deliberately as it can be asserted.
 *
 * THE RULE THAT MATTERS MOST. G5 keeps the three bases apart. "Measured on a
 * second dataset" is evidence; "argued from the mechanism" is an argument; and
 * "assumed" is neither. All three are representable, because an inference
 * resting on nothing still needs somewhere to be written down — but an
 * unsupported basis may not sit at a status that asserts the generalisation
 * holds, and it never reaches a count. That is the whole point of the file: the
 * unsupported cases are the ones prose hides, so they are the ones the
 * vocabulary has to name.
 *
 * G3 is the other half. A generalisation is always a generalisation OF
 * something, and a source id that resolves nowhere leaves a sentence with no
 * subject — a reach from a study that does not exist reads exactly like a reach
 * from one that does. The id is looked up in the register its kind names, and a
 * miss is a refusal rather than a warning.
 *
 * THIS CHECK IS NOT ALLOWED TO BE VACUOUS. G11 fails an empty records
 * directory and G12 fails an unreadable one. A verifier that passes over zero
 * records is a green light for a container nobody filled, and this repository
 * has shipped that shape before; a register whose records were deleted, or
 * whose one record stopped parsing, must go red rather than quietly report
 * success over nothing.
 *
 * WHAT IT DOES NOT DO. It cannot tell a sound inference from an unsound one. No
 * check here reads the argument in `basis.statement`, and a well-formed record
 * whose mechanism is nonsense passes. What it guarantees is that the reach is
 * visible: which study it starts from, which single axis it travels along, how
 * far, on what basis, and where it stops. Nothing here promotes a claim;
 * evidence levels live in docs/validation/claim-register.yaml and move only by
 * a human change there.
 *
 * Exit 0 when every record verifies, 1 when any is rejected — including a
 * register that is empty or will not parse — and 2 on a usage or read error.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import { validateAgainstSchema, isIsoDate, compareCodeUnits } from './lib/recordSchema.mjs';
import { isCliEntry } from './lib/isCliEntry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const RECORDS_DIR = 'validation/generalization/records';
export const SCHEMA_PATH = 'validation/generalization/generalization-record.schema.json';
export const CLAIM_REGISTER_PATH = 'docs/validation/claim-register.yaml';
export const DATASET_REGISTER_PATH = 'validation/datasets/dataset-register.yaml';

/**
 * Every permitted status.
 *
 *   proposed   the inference is written down; nobody has assessed it
 *   untested   open and unmeasured, and named so it stops being invisible
 *   argued     argued from mechanism or analogy — an argument, never evidence
 *   supported  measured beyond the source along this axis
 *   refused    the reach was considered and does not hold; do not make it
 *   withdrawn  it was asserted once and has been retracted
 */
export const GENERALIZATION_STATUSES = [
  'proposed',
  'untested',
  'argued',
  'supported',
  'refused',
  'withdrawn',
];

/** Statuses that assert the generalisation holds, in one strength or another. */
export const ASSERTING_STATUSES = new Set(['supported', 'argued']);

/** Statuses that assert nothing, and the only ones an example may sit at. */
export const UNCOUNTED_STATUSES = new Set(['proposed', 'untested']);

/** Every permitted basis, in the schema's order. */
export const BASIS_KINDS = [
  'measured-second-dataset',
  'measured-parameter-sweep',
  'mechanism',
  'analogy',
  'assumed',
];

/** Bases that rest on a second measurement. Only these can reach "supported". */
export const MEASURED_BASES = new Set(['measured-second-dataset', 'measured-parameter-sweep']);

/**
 * Bases that rest on no measurement at all. Representable on purpose: an
 * inference nothing supports still has to be writable, or it goes back to being
 * made silently in prose. It simply may never be counted as evidence.
 */
export const UNSUPPORTED_BASES = new Set(['mechanism', 'analogy', 'assumed']);

/** Every permitted axis of extrapolation, in the schema's order. */
export const EXTRAPOLATION_AXES = [
  'terrain-type',
  'sensor',
  'point-density',
  'scan-geometry',
  'crs',
  'vertical-datum',
  'unit',
  'scale',
  'file-format',
  'parameter-set',
  'platform',
  'software-version',
  'operator',
  'season',
];

/**
 * Where each source kind's ids live. `yaml` registers are read line-based for
 * the reason the sibling verifiers give: no YAML parser is a declared
 * dependency. Every path here is READ ONLY.
 */
export const SOURCE_REGISTRIES = {
  claim: { kind: 'yaml', path: CLAIM_REGISTER_PATH, key: 'claimId' },
  'cross-implementation-study': { kind: 'dir', path: 'validation/cross-implementation/studies', key: 'studyId' },
  'field-study': { kind: 'dir', path: 'validation/field/studies', key: 'studyId' },
  'reproduction-record': { kind: 'dir', path: 'validation/reproduction/records', key: 'recordId' },
};

/**
 * Words that turn a measured range into a universal one. A supported record
 * that reaches to "any sensor" has stopped describing a measurement, whatever
 * the measurement was: the reach has to name what was covered, because the
 * unbounded version is precisely the claim this register exists to prevent.
 */
const UNBOUNDED_REACH = /\b(any|all|every|arbitrary|universal|unlimited|unrestricted)\b/i;

/** Ids under `key` in a line-based register. READ ONLY. */
export function parseRegisterIds(yamlText, key) {
  const ids = new Set();
  const pattern = new RegExp(`^-?\\s*${key}:\\s*(\\S+)`);
  for (const raw of yamlText.split('\n')) {
    const m = raw.trim().match(pattern);
    if (m) ids.add(m[1]);
  }
  return ids;
}

/** Claim ids from the register, the same way every sibling verifier reads them. */
export function parseClaimIds(yamlText) {
  return parseRegisterIds(yamlText, 'claimId');
}

/** Ids under `key` across every *.json in a records directory. READ ONLY. */
export function collectIdsFromDir(dir, key) {
  const ids = new Set();
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.json')).sort(compareCodeUnits)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      // A neighbouring container's unparseable record is that container's
      // verifier's business. Skipping it here means an id fails to resolve,
      // which is reported against the record that cited it rather than
      // silently accepted.
      continue;
    }
    if (typeof parsed?.[key] === 'string') ids.add(parsed[key]);
  }
  return ids;
}

/** Normalised for comparison: an axis endpoint differing only in case is one. */
const normalise = (text) => String(text).trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Verify one record. `ctx` supplies `record`, `file`, `schema`, `sourceIds`
 * (a `{ kind -> Set<id> }` map), `datasetIds` and `claimIds`. Returns
 * `[{ rule, message }]`; empty means the record verifies. Rule ids are stable
 * so a test can assert which refusal fired, not merely that one did.
 */
export function collectGeneralizationProblems(ctx) {
  const { record: r, file, schema, sourceIds, datasetIds, claimIds } = ctx;
  const problems = [];
  const add = (rule, message) => problems.push({ rule, message: `${file}: ${message}` });

  // ── G1. Shape first, so no rule below reads a field that is not there ──────
  const schemaErrors = [];
  validateAgainstSchema(r, schema, schema, '$', schemaErrors);
  for (const e of schemaErrors) add('G1-SCHEMA', e);
  if (schemaErrors.length > 0) return problems;

  // ── G2. An example is marked as one on both sides ─────────────────────────
  const prefixed = r.recordId.startsWith('EXAMPLE-');
  if (prefixed !== r.example) {
    add('G2-EXAMPLE', `recordId ${prefixed ? 'is' : 'is not'} prefixed EXAMPLE- but example is ${r.example}; a template must be unmistakable from either field alone.`);
  }
  if (r.example && !UNCOUNTED_STATUSES.has(r.status)) {
    add('G2-EXAMPLE', `an example record may only sit at ${[...UNCOUNTED_STATUSES].sort(compareCodeUnits).join(' or ')}, not "${r.status}"; a template that asserts or refuses a generalisation is asserting one.`);
  }

  // ── G3. The study it reasons from has to resolve ──────────────────────────
  const known = sourceIds[r.source.kind];
  if (!known) {
    add('G3-SOURCE-UNRESOLVED', `source.kind "${r.source.kind}" has no register to look "${r.source.id}" up in.`);
  } else if (!known.has(r.source.id)) {
    add('G3-SOURCE-UNRESOLVED', `source.id "${r.source.id}" is not in ${SOURCE_REGISTRIES[r.source.kind].path}; a generalisation of a study nobody can find is a sentence with no subject, and a reach from a study that does not exist reads exactly like a reach from one that does. Name a ${r.source.kind} that is on file, or file the study first.`);
  }

  // ── G4. A real record may not reason from a template ──────────────────────
  if (r.example !== true && r.source.id.startsWith('EXAMPLE-')) {
    add('G4-SOURCE-IS-EXAMPLE', `source.id "${r.source.id}" is an EXAMPLE record, which measured nothing; there is nothing there to generalise from.`);
  }

  // ── G5. The basis decides what the status is allowed to be ────────────────
  //        This is what the container is for. See the header.
  const basis = r.basis;
  if (r.status === 'supported' && !MEASURED_BASES.has(basis.kind)) {
    add('G5-BASIS-NOT-EVIDENCE', `status "supported" on basis "${basis.kind}", which measured nothing. An argument from mechanism, an analogy and an assumption are all reasons to LOOK; none of them is a result, and counting one as evidence is the failure this register exists to make visible. Use status "argued" for a mechanism or an analogy, "proposed" or "untested" for an assumption, or go and measure it.`);
  }
  if (basis.kind === 'assumed' && ASSERTING_STATUSES.has(r.status)) {
    add('G5-BASIS-NOT-EVIDENCE', `status "${r.status}" on basis "assumed"; nothing supports this reach, not even an argument, so it may only be recorded as proposed, untested, refused or withdrawn.`);
  }
  if (r.status === 'argued' && !UNSUPPORTED_BASES.has(basis.kind)) {
    add('G5-BASIS-NOT-EVIDENCE', `status "argued" on basis "${basis.kind}"; a measured basis is either supported or refused by its own measurement, and filing it as an argument hides a result that exists.`);
  }

  // ── G6. A measured basis has to name the second measurement ───────────────
  if (MEASURED_BASES.has(basis.kind)) {
    const m = basis.measurement;
    if (!m) {
      add('G6-MEASUREMENT-MISSING', `basis.kind is "${basis.kind}" with no basis.measurement; "we measured it elsewhere" without naming the elsewhere is an assertion about evidence rather than evidence.`);
    } else {
      const secondKnown = sourceIds[m.sourceKind];
      for (const id of m.sourceIds) {
        if (secondKnown && !secondKnown.has(id)) {
          add('G6-MEASUREMENT-MISSING', `basis.measurement.sourceIds names "${id}", which is not in ${SOURCE_REGISTRIES[m.sourceKind].path}.`);
        }
        if (m.sourceKind === r.source.kind && id === r.source.id) {
          add('G6-MEASUREMENT-MISSING', `basis.measurement.sourceIds names "${id}", which is the source study itself; a second dataset that is the first one is not a second one, and re-reading a study is not re-measuring it.`);
        }
        if (r.example !== true && id.startsWith('EXAMPLE-')) {
          add('G6-MEASUREMENT-MISSING', `basis.measurement.sourceIds names the EXAMPLE record "${id}", which measured nothing.`);
        }
      }
      for (const id of m.datasetIds ?? []) {
        if (!datasetIds.has(id)) {
          add('G6-MEASUREMENT-MISSING', `basis.measurement.datasetIds names "${id}", which is not in ${DATASET_REGISTER_PATH}; data nobody registered cannot be checked for being independent of the first study's data.`);
        }
      }
      if (basis.kind === 'measured-second-dataset' && (m.datasetIds ?? []).length === 0) {
        add('G6-MEASUREMENT-MISSING', 'basis.kind is "measured-second-dataset" but basis.measurement.datasetIds is empty; the second dataset is the entire claim being made.');
      }
    }
  } else if (basis.measurement) {
    add('G6-MEASUREMENT-MISSING', `basis.kind is "${basis.kind}" but a basis.measurement block is present; a measurement sitting under an unmeasured basis reads as support the basis does not claim. State the measured basis, or drop the block.`);
  }

  // ── G7. A reach that reaches nowhere is not a generalisation ──────────────
  if (normalise(r.dimension.measuredRange) === normalise(r.dimension.extrapolatedTo)) {
    add('G7-DIMENSION-DEGENERATE', `dimension.extrapolatedTo repeats dimension.measuredRange (${JSON.stringify(r.dimension.measuredRange)}), so nothing is being extrapolated. Either the record restates the study, in which case it belongs in the study, or the reach was never written down.`);
  }

  // ── G8. Measured breadth has to be stated as breadth, not as "any" ────────
  if (r.status === 'supported' && UNBOUNDED_REACH.test(r.dimension.extrapolatedTo)) {
    add('G8-UNBOUNDED-REACH', `status "supported" reaching to ${JSON.stringify(r.dimension.extrapolatedTo)}; no measurement covers an unbounded set, so this states more than any second dataset could have shown. Name the range that was actually measured.`);
  }

  // ── G9. Dates have to be real, and in order ───────────────────────────────
  if (!isIsoDate(r.reviewedAt)) {
    add('G9-DATES', `reviewedAt "${r.reviewedAt}" is not a real calendar date.`);
  }
  const retrievedAt = basis.measurement?.retrievedAt;
  if (retrievedAt !== undefined) {
    if (!isIsoDate(retrievedAt)) {
      add('G9-DATES', `basis.measurement.retrievedAt "${retrievedAt}" is not a real calendar date.`);
    } else if (isIsoDate(r.reviewedAt) && retrievedAt > r.reviewedAt) {
      add('G9-DATES', `basis.measurement.retrievedAt ${retrievedAt} is after reviewedAt ${r.reviewedAt}; the review cannot have read a measurement that did not exist yet.`);
    }
  }

  // ── G10. Referenced claims must exist ─────────────────────────────────────
  for (const id of r.claimIds ?? []) {
    if (!claimIds.has(id)) {
      add('G10-CLAIM-UNKNOWN', `claimIds names "${id}", which is not in ${CLAIM_REGISTER_PATH}.`);
    }
  }

  return problems;
}

/**
 * Read every *.json record in `dir`, sorted by filename for determinism. A file
 * that will not parse is returned with its error rather than thrown, so the
 * register reports which record broke instead of dying on the first one.
 */
export function loadRecords(dir) {
  const names = readdirSync(dir).filter((f) => f.endsWith('.json')).sort(compareCodeUnits);
  return names.map((name) => {
    try {
      return { name, record: JSON.parse(readFileSync(join(dir, name), 'utf8')) };
    } catch (err) {
      return { name, record: null, parseError: err.message };
    }
  });
}

/** Read every id space a source may point into. Throws if one is missing. */
export function loadSourceIds(root) {
  const out = {};
  for (const [kind, spec] of Object.entries(SOURCE_REGISTRIES)) {
    const path = resolve(root, spec.path);
    out[kind] = spec.kind === 'yaml'
      ? parseRegisterIds(readFileSync(path, 'utf8'), spec.key)
      : collectIdsFromDir(path, spec.key);
  }
  return out;
}

/** Verify a whole register. Returns `{ recordsDir, records, problems }`. */
export function verifyGeneralizationRecords(opts = {}) {
  const root = resolve(opts.root ?? ROOT);
  const recordsDir = resolve(opts.recordsDir ?? join(root, RECORDS_DIR));
  const registerPath = resolve(opts.registerPath ?? join(ROOT, CLAIM_REGISTER_PATH));

  const schema = JSON.parse(readFileSync(resolve(ROOT, SCHEMA_PATH), 'utf8'));
  const sourceIds = loadSourceIds(ROOT);
  const claimIds = parseRegisterIds(readFileSync(registerPath, 'utf8'), 'claimId');
  sourceIds.claim = claimIds;
  const datasetIds = parseRegisterIds(
    readFileSync(resolve(ROOT, DATASET_REGISTER_PATH), 'utf8'),
    'datasetId',
  );

  const loaded = loadRecords(recordsDir);
  const registerProblems = [];

  // ── G11. A register with nothing in it must not report success ────────────
  if (loaded.length === 0) {
    registerProblems.push({
      rule: 'G11-REGISTER-EMPTY',
      message: `${recordsDir} holds no *.json record. A verifier that passes over zero records certifies nothing while looking exactly like one that certified something; if this register is meant to be empty, that is a decision to write down in validation/generalization/README.md and a record to file, not a check to leave green.`,
    });
  }

  const seenIds = new Map();
  const seenInferences = new Map();
  const records = loaded.map(({ name, record, parseError }) => {
    // ── G12. A record that will not parse is a failure, not a skip ──────────
    if (parseError !== undefined) {
      return {
        name,
        record: null,
        problems: [{
          rule: 'G12-REGISTER-UNREADABLE',
          message: `${name}: not valid JSON (${parseError}). An unreadable record is not an absent one; skipping it would drop whatever reach it recorded out of the register without anyone deciding to.`,
        }],
      };
    }

    const problems = collectGeneralizationProblems({ record, file: name, schema, sourceIds, datasetIds, claimIds });
    const id = record?.recordId;
    if (typeof id === 'string') {
      if (seenIds.has(id)) {
        problems.push({ rule: 'G13-DUPLICATE-RECORD', message: `${name}: recordId "${id}" is already used by ${seenIds.get(id)}.` });
      } else seenIds.set(id, name);
    }
    // The same reach filed twice can sit at two statuses at once, which lets a
    // reader pick the one they like.
    const key = `${record?.source?.kind}:${record?.source?.id}:${record?.dimension?.axis}:${normalise(record?.dimension?.extrapolatedTo ?? '')}`;
    if (record?.source?.id && record?.dimension?.axis) {
      if (seenInferences.has(key)) {
        problems.push({ rule: 'G13-DUPLICATE-RECORD', message: `${name}: the same reach (${key}) is already recorded by ${seenInferences.get(key)}; one inference filed twice can carry two statuses, and a reader will read the kinder one.` });
      } else seenInferences.set(key, name);
    }
    return { name, record, problems };
  });

  return {
    recordsDir,
    records,
    problems: [...registerProblems, ...records.flatMap((x) => x.problems)],
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function isMain() {
  return isCliEntry(import.meta.url);
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  let out;
  try {
    out = verifyGeneralizationRecords({ recordsDir: opt('--records'), registerPath: opt('--register') });
  } catch (err) {
    console.error(`verify:generalization-record cannot read its inputs: ${err.message}`);
    process.exit(2);
  }

  if (out.problems.length > 0) {
    console.error('verify:generalization-record FAILED\n');
    for (const p of out.problems) console.error(`  • [${p.rule}] ${p.message}`);
    console.error('\nA generalisation is the step between what was measured and what is');
    console.error('believed. Fix the record, or stop making the inference.');
    process.exit(1);
  }

  const real = out.records.filter((x) => x.record.example !== true);
  const byStatus = new Map();
  for (const x of real) byStatus.set(x.record.status, (byStatus.get(x.record.status) ?? 0) + 1);
  const tally = [...byStatus.entries()]
    .sort((a, b) => compareCodeUnits(a[0], b[0]))
    .map(([k, v]) => `${k} ${v}`)
    .join(', ') || 'none';
  const supported = real.filter((x) => x.record.status === 'supported').length;
  console.log(
    `verify:generalization-record OK — ${out.records.length} record(s) in ${out.recordsDir}, ` +
      `${out.records.length - real.length} of them examples that count for nothing. ` +
      `Non-example records: ${tally}. Generalisations carried on a second measurement: ${supported}. ` +
      'No claim is promoted by this check, and an argued generalisation is not evidence.',
  );
  process.exit(0);
}
