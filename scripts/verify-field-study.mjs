#!/usr/bin/env node
/**
 * verify-field-study.mjs — refuse a field study record that cannot be believed.
 *
 *   node scripts/verify-field-study.mjs
 *   node scripts/verify-field-study.mjs --studies <dir> --artifact-root <dir>
 *
 * WHY THIS EXISTS. E5_EXTERNALLY_VALIDATED is the level where a claim stops
 * resting on this project's own code and its own synthetic fixtures. Reaching it
 * needs an instrument, a survey, operators and checkpoints, none of which can be
 * produced from inside a repository. What CAN be built here is the container: a
 * schema for what a believable field study states, and a verifier that refuses
 * the shapes that make one worthless. That is what this is.
 *
 * THE DIRECTORY IS EMPTY ON PURPOSE. validation/field/studies/ holds one record,
 * prefixed EXAMPLE- and marked example: true, and no field study has been run.
 * Filling it with plausible-looking numbers would be the single most damaging
 * thing anyone could do to this repository, whose entire pitch is honesty about
 * evidence. An empty verified container is a true statement; a populated one
 * that nobody surveyed is not.
 *
 * THE RULE THAT MATTERS MOST. src/validation/checkpointAccuracy.ts refuses a
 * checkpoint array whose members were used as control, in registration, for
 * parameter tuning or for manual correction: an accuracy figure over them
 * measures the fit rather than the error. That refusal protects a function call.
 * It does nothing about a RECORD that says "312 checkpoints, 40 of them control"
 * and then reports an RMSE, because the record never passes through that
 * function. F5 below applies the same refusal at record level, which is the half
 * that was missing. The usage vocabulary is duplicated here because a .mjs
 * script cannot import a .ts module without pulling the application build into
 * the scripts directory; tests/fieldStudyRecord.test.ts imports both and asserts
 * they are still the same list, so the duplication cannot drift silently.
 *
 * WHAT IT DOES NOT DO. It does not compute accuracy, does not promote anything,
 * and cannot tell a true record from a well-formed invention. A verified record
 * says "this is internally consistent, its arithmetic agrees with its own gate,
 * and its artifacts are on disk as recorded". Evidence levels live in
 * docs/validation/claim-register.yaml and move only by a human change there.
 *
 * Exit 0 when every record verifies, 1 when any is rejected, 2 on a usage, read
 * or parse error.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { isCliEntry } from './lib/isCliEntry.mjs';

import {
  validateAgainstSchema,
  canonicalJson,
  digestOf,
  sha256,
  isIsoDate,
  compareCodeUnits,
} from './lib/recordSchema.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const STUDIES_DIR = 'validation/field/studies';
export const SCHEMA_PATH = 'validation/field/field-study.schema.json';
export const CLAIM_REGISTER_PATH = 'docs/validation/claim-register.yaml';

/**
 * Every permitted status. The distinctions are the point: a record that reports
 * "no result" for four different reasons needs four different words, because
 * they call for four different actions.
 *
 *   pending          registered, protocol frozen, nobody has been to the site
 *   not-executed     a step deliberately left unrun
 *   unavailable      could be done, but the instrument or the site was not had
 *   blocked-external cannot be done from inside a repository at all
 *   insufficient     surveyed, too few usable checkpoints to conclude anything
 *   meets            within the preregistered tolerance on the registered scope
 *   partial          within tolerance on part of the registered scope only
 *   fails            outside the preregistered tolerance
 *   invalid          the study itself was mis-run; its numbers must not be read
 *   inconclusive     ran and valid, but the survey cannot discriminate
 */
export const FIELD_STATUSES = [
  'pending',
  'not-executed',
  'unavailable',
  'blocked-external',
  'insufficient',
  'meets',
  'partial',
  'fails',
  'invalid',
  'inconclusive',
];

/** Statuses that assert an observed outcome, so raw observations must exist. */
export const RESULT_STATUSES = new Set(['meets', 'partial', 'fails']);

/** Statuses that may never reach a count: nothing was observed. */
export const UNCOUNTED_STATUSES = new Set(['pending', 'not-executed']);

/** Statuses under which a scope entry may be declared supported. */
export const SCOPE_CLAIMABLE_STATUSES = new Set(['meets', 'partial']);

/**
 * CHECKPOINT_USAGES from src/validation/checkpointAccuracy.ts, duplicated for
 * the reason given in the header. Kept in the same order as the source.
 */
export const CHECKPOINT_USAGES = [
  'independent',
  'control',
  'registration',
  'parameter-tuning',
  'manual-correction',
];

/** LEAKING_USAGES from the same module: usages that disqualify a checkpoint. */
export const LEAKING_USAGES = [
  'control',
  'registration',
  'parameter-tuning',
  'manual-correction',
];

/** The evidence level this container is for, and the only one it accepts. */
export const EVIDENCE_LEVEL = 'E5_EXTERNALLY_VALIDATED';

/** Names that mean this project, which cannot supply an independent operator. */
const SELF_AFFILIATION = /openlidar|openlidarviewer|(^|[^a-z])olv([^a-z]|$)|aurtech/i;

/**
 * The frozen protocol: what was decided before anyone went to the site. The
 * tolerance and the instrument's stated accuracy are both inside it, because
 * those are the two numbers a disappointing residual tempts someone to revisit.
 */
export function protocolOf(record) {
  return {
    claimId: record.claimId,
    product: record.candidate?.product ?? null,
    instrument: {
      make: record.instrument?.make ?? null,
      model: record.instrument?.model ?? null,
      statedAccuracy: record.instrument?.statedAccuracy ?? null,
    },
    surveyMethod: record.surveyMethod?.method ?? null,
    checkpoints: {
      count: record.checkpoints?.count ?? null,
      provenance: record.checkpoints?.provenance ?? null,
    },
    strata: [...(record.site?.strata ?? [])].sort(compareCodeUnits),
    metrics: record.metrics ?? null,
  };
}

export function protocolDigestOf(record) {
  return digestOf(protocolOf(record));
}

/**
 * Claim ids from the register. Line-based on purpose: no YAML parser is a
 * declared dependency, and scripts/lint-claim-register.mjs reads the same file
 * the same way. READ ONLY — nothing here writes it.
 */
export function parseClaimIds(yamlText) {
  const ids = new Set();
  for (const raw of yamlText.split('\n')) {
    const m = raw.trim().match(/^-?\s*claimId:\s*(\S+)/);
    if (m) ids.add(m[1]);
  }
  return ids;
}

/**
 * Verify one record. `ctx` supplies `record`, `file`, `schema`, `claimIds`,
 * `readArtifact` and `artifactRoot`. Returns `[{ rule, message }]`; empty means
 * the record verifies. Rule ids are stable so a test can assert which rule
 * fired, not merely that one did.
 */
export function collectFieldProblems(ctx) {
  const { record: r, file, schema, claimIds, readArtifact, artifactRoot } = ctx;
  const problems = [];
  const add = (rule, message) => problems.push({ rule, message: `${file}: ${message}` });

  // ── F1. Shape first, so no rule below reads a field that is not there ──────
  const schemaErrors = [];
  validateAgainstSchema(r, schema, schema, '$', schemaErrors);
  for (const e of schemaErrors) add('F1-SCHEMA', e);
  if (schemaErrors.length > 0) return problems;

  // ── F2. An example is marked as one on both sides ─────────────────────────
  const prefixed = r.studyId.startsWith('EXAMPLE-');
  if (prefixed !== r.example) {
    add('F2-EXAMPLE', `studyId ${prefixed ? 'is' : 'is not'} prefixed EXAMPLE- but example is ${r.example}; a template must be unmistakable from either field alone.`);
  }
  if (r.example && !UNCOUNTED_STATUSES.has(r.status)) {
    add('F2-EXAMPLE', `an example record may only sit at ${[...UNCOUNTED_STATUSES].sort(compareCodeUnits).join(' or ')}, not "${r.status}"; a template that reports an outcome is a fabricated study.`);
  }

  // ── F3. The claim must exist in the register ──────────────────────────────
  if (!claimIds.has(r.claimId)) {
    add('F3-CLAIM-UNKNOWN', `claimId "${r.claimId}" is not in ${CLAIM_REGISTER_PATH}; a study cannot be evidence for a claim nobody registered.`);
  }

  // ── F4. This container holds E5 and nothing else ──────────────────────────
  if (r.evidenceLevelClaimed !== EVIDENCE_LEVEL) {
    add('F4-EVIDENCE-LEVEL', `evidenceLevelClaimed is "${r.evidenceLevelClaimed}", but a field study is the ${EVIDENCE_LEVEL} container; an independent reproduction belongs in validation/reproduction.`);
  }

  // ── F5. Checkpoint leakage, the record-level form of the refusal in ───────
  //        src/validation/checkpointAccuracy.ts.
  const cp = r.checkpoints;
  const seenUsages = new Set();
  const leaked = [];
  let independentCount = 0;
  let usageTotal = 0;
  for (const u of cp.usages) {
    usageTotal += u.count;
    if (!CHECKPOINT_USAGES.includes(u.usage)) {
      add('F6-CHECKPOINT-USAGE-UNKNOWN', `checkpoints.usages names usage ${JSON.stringify(u.usage)}, which is not one of ${CHECKPOINT_USAGES.join(', ')}; an unreadable usage cannot be shown to be independent, and defaulting it to independent is exactly how control points enter an accuracy figure.`);
      continue;
    }
    if (seenUsages.has(u.usage)) {
      add('F7-CHECKPOINT-COUNT', `checkpoints.usages lists "${u.usage}" twice; the counts cannot be reconciled with checkpoints.count.`);
    }
    seenUsages.add(u.usage);
    if (u.usage === 'independent') independentCount = u.count;
    if (LEAKING_USAGES.includes(u.usage) && u.count > 0) leaked.push(`${u.count} ${u.usage}`);
  }
  if (leaked.length > 0) {
    add('F5-CHECKPOINT-LEAKAGE', `${leaked.join(', ')} checkpoint(s) were used on the surface under test (${r.candidate.product}). They are part of what was built, so accuracy over them measures the fit and not the error. src/validation/checkpointAccuracy.ts refuses such a set as a typed result; a record that carries them is refused here for the same reason. Survey a set that was held back, or file the study without an accuracy figure.`);
  }
  if (cp.independentOfProcessing !== (leaked.length === 0)) {
    add('F5-CHECKPOINT-LEAKAGE', `checkpoints.independentOfProcessing says ${cp.independentOfProcessing} while the usage counts say ${leaked.length === 0 ? 'no checkpoint leaked' : 'some did'}; the statement and the counts must agree.`);
  }
  if (usageTotal !== cp.count) {
    add('F7-CHECKPOINT-COUNT', `checkpoints.usages sums to ${usageTotal} but checkpoints.count is ${cp.count}; a sample nobody can reconstruct is not a sample.`);
  }
  const stratumTotal = cp.byStratum.reduce((a, s) => a + s.count, 0);
  if (stratumTotal !== cp.count) {
    add('F7-CHECKPOINT-COUNT', `checkpoints.byStratum sums to ${stratumTotal} but checkpoints.count is ${cp.count}.`);
  }
  const declaredStrata = new Set(r.site.strata);
  for (const s of cp.byStratum) {
    if (!declaredStrata.has(s.stratum)) {
      add('F7-CHECKPOINT-COUNT', `checkpoints.byStratum names stratum "${s.stratum}", which site.strata does not declare.`);
    }
  }
  if (independentCount < r.metrics.minimumCheckpoints && RESULT_STATUSES.has(r.status)) {
    add('F7-CHECKPOINT-COUNT', `${independentCount} independent checkpoint(s), but the preregistered minimum is ${r.metrics.minimumCheckpoints}; the status may not be "${r.status}".`);
  }

  // ── F8. Provenance has to be stated honestly ──────────────────────────────
  if (cp.provenance === 'project-own-survey' && r.operators.independent) {
    add('F8-PROVENANCE', 'checkpoints came from this project\'s own survey while operators.independent claims independence; one of the two is wrong.');
  }

  // ── F9. Operator independence means more than a boolean ───────────────────
  const op = r.operators;
  if (op.independent) {
    if (op.count < 2) {
      add('F9-OPERATORS', `operators.independent is true with ${op.count} operator(s); one operator cannot be independent of themselves, so operator technique stays an unmeasured confound.`);
    }
    const selfAffiliated = op.affiliations.filter((a) => SELF_AFFILIATION.test(a));
    if (selfAffiliated.length > 0) {
      add('F9-OPERATORS', `operators.independent is true but ${selfAffiliated.map((a) => JSON.stringify(a)).join(', ')} names this project; someone who built the software is not an independent operator of it.`);
    }
  }

  // ── F10. A protocol written afterwards is a report ────────────────────────
  const pre = r.preregistration;
  for (const [label, value] of [
    ['preregistration.registeredAt', pre.registeredAt],
    ['fieldwork.startedAt', r.fieldwork.startedAt],
    ['fieldwork.endedAt', r.fieldwork.endedAt],
    ['instrument.calibration.lastCalibratedAt', r.instrument.calibration.lastCalibratedAt],
  ]) {
    if (!isIsoDate(value)) add('F11-DATES', `${label} "${value}" is not a real calendar date.`);
  }
  if (r.fieldwork.endedAt < r.fieldwork.startedAt) {
    add('F11-DATES', `fieldwork ended ${r.fieldwork.endedAt}, before it started ${r.fieldwork.startedAt}.`);
  }
  if (r.instrument.calibration.lastCalibratedAt > r.fieldwork.startedAt) {
    add('F11-DATES', `the instrument was last calibrated ${r.instrument.calibration.lastCalibratedAt}, after fieldwork started ${r.fieldwork.startedAt}; the certificate does not cover the observations.`);
  }
  if (!pre.registeredBeforeFieldwork) {
    add('F10-PREREGISTRATION', 'preregistration.registeredBeforeFieldwork is false; a protocol written after the observations is a report, and its tolerance was chosen knowing the answer.');
  }
  if (pre.registeredAt > r.fieldwork.startedAt) {
    add('F10-PREREGISTRATION', `the protocol was registered ${pre.registeredAt}, after fieldwork started ${r.fieldwork.startedAt}; that is not a preregistration whatever registeredBeforeFieldwork says.`);
  }
  const protocolBytes = readArtifact(pre.protocolPath);
  if (protocolBytes === null) {
    add('F10-PREREGISTRATION', `preregistration.protocolPath "${pre.protocolPath}" is not on disk under ${artifactRoot}; the frozen protocol is the record, so a missing file leaves nothing frozen.`);
  } else {
    const actual = sha256(protocolBytes);
    if (actual !== pre.protocolSha256) {
      add('F10-PREREGISTRATION', `preregistration.protocolSha256 is ${pre.protocolSha256} but the file on disk hashes to ${actual}; the protocol changed after it was frozen.`);
    }
  }

  // ── F12. The protocol digest freezes the gate ─────────────────────────────
  const expected = protocolDigestOf(r);
  if (r.protocolDigest !== expected) {
    add('F12-PROTOCOL-DIGEST', `the instrument accuracy, survey method, checkpoint plan or metrics disagree with the frozen protocolDigest (recorded ${r.protocolDigest}, recomputed ${expected}); a tolerance edited after seeing the residuals is exactly what this catches.`);
  }

  // ── F13. A gate that passes everything is not a gate ──────────────────────
  const frac = r.metrics.requiredWithinToleranceFraction;
  if (!(frac > 0)) {
    add('F13-METRICS', `requiredWithinToleranceFraction ${frac} must be inside (0, 1]; 0 would call any survey a pass.`);
  }
  if (r.metrics.toleranceAbs <= 0) {
    add('F13-METRICS', 'toleranceAbs must be greater than 0; a zero tolerance can only be met by an exact match no survey produces.');
  }

  // ── F14. Nothing unobserved may carry a number ────────────────────────────
  if (UNCOUNTED_STATUSES.has(r.status)) {
    if (r.result) {
      add('F14-UNCOUNTED-CARRIES-RESULT', `status "${r.status}" means nobody has observed anything, so a result block may not be present; it would be a number with nothing behind it.`);
    }
    if (r.scope.supported.length > 0) {
      add('F14-UNCOUNTED-CARRIES-RESULT', `status "${r.status}" supports nothing, so scope.supported must be empty.`);
    }
  }

  // ── F15. An observed outcome needs its raw observations ───────────────────
  if (RESULT_STATUSES.has(r.status)) {
    if (!r.result) {
      add('F15-RAW-MISSING', `status "${r.status}" asserts an observed outcome, so a result block is required.`);
    }
    if (!cp.rawPath || !cp.rawSha256) {
      add('F15-RAW-MISSING', `status "${r.status}" asserts an observed outcome, so checkpoints.rawPath and checkpoints.rawSha256 are required; an accuracy figure whose observations nobody can read is not evidence.`);
    }
  }
  if (cp.rawPath) {
    const bytes = readArtifact(cp.rawPath);
    if (bytes === null) {
      add('F15-RAW-MISSING', `checkpoints.rawPath "${cp.rawPath}" is not on disk under ${artifactRoot}.`);
    } else if (cp.rawSha256 && sha256(bytes) !== cp.rawSha256) {
      add('F15-RAW-MISSING', `checkpoints.rawPath "${cp.rawPath}" records sha256 ${cp.rawSha256} but the file on disk hashes to ${sha256(bytes)}.`);
    }
  }

  // ── F16. The status must follow from the numbers ──────────────────────────
  if (r.result) {
    const res = r.result;
    const enough = res.usableCheckpoints >= r.metrics.minimumCheckpoints;
    const meets = res.withinToleranceFraction >= r.metrics.requiredWithinToleranceFraction;
    if (r.status === 'meets' && !(enough && meets)) {
      add('F16-STATUS-VS-RESULT', `status "meets" but ${res.usableCheckpoints} usable checkpoint(s) (minimum ${r.metrics.minimumCheckpoints}) and ${res.withinToleranceFraction} within tolerance (required ${r.metrics.requiredWithinToleranceFraction}).`);
    }
    if ((r.status === 'partial' || r.status === 'fails') && enough && meets) {
      add('F16-STATUS-VS-RESULT', `status "${r.status}" but the numbers meet the preregistered gate; say so or correct the numbers.`);
    }
    if (r.status === 'insufficient' && enough) {
      add('F16-STATUS-VS-RESULT', `status "insufficient" but ${res.usableCheckpoints} usable checkpoint(s) meets the preregistered minimum ${r.metrics.minimumCheckpoints}.`);
    }
    if (res.usableCheckpoints > independentCount) {
      add('F16-STATUS-VS-RESULT', `${res.usableCheckpoints} checkpoint(s) entered the statistics but only ${independentCount} are recorded as independent.`);
    }
    if (res.maxAbsResidual > r.metrics.toleranceAbs && res.withinToleranceFraction === 1) {
      add('F16-STATUS-VS-RESULT', `every checkpoint is reported within ±${r.metrics.toleranceAbs} ${r.metrics.toleranceUnit} while maxAbsResidual is ${res.maxAbsResidual}.`);
    }
    // A survey cannot resolve an error smaller than the survey's own accuracy.
    const instrumentSigma = r.instrument.statedAccuracy.verticalMetres;
    if (res.rmse < instrumentSigma) {
      add('F17-BELOW-INSTRUMENT-RESOLUTION', `the reported RMSE ${res.rmse} is below the reference instrument's own stated accuracy ${instrumentSigma} (${r.instrument.statedAccuracy.confidenceLevel}, ${r.instrument.statedAccuracy.source}); the survey cannot resolve an error smaller than its own uncertainty, so the figure describes the instrument and not the product.`);
    }
  }

  // ── F18. Approved scope may not exceed what was surveyed ──────────────────
  for (const s of r.scope.supported) {
    if (!declaredStrata.has(s.stratum)) {
      add('F18-SCOPE-BROADER', `scope.supported approves stratum "${s.stratum}", which site.strata does not declare.`);
    }
    const stratum = cp.byStratum.find((b) => b.stratum === s.stratum);
    if (stratum && stratum.count < r.metrics.minimumStratumCheckpoints) {
      add('F18-SCOPE-BROADER', `scope.supported approves stratum "${s.stratum}" on ${stratum.count} checkpoint(s), below the preregistered per-stratum minimum ${r.metrics.minimumStratumCheckpoints}.`);
    }
  }
  if (r.scope.supported.length > 0 && !SCOPE_CLAIMABLE_STATUSES.has(r.status)) {
    add('F18-SCOPE-BROADER', `status "${r.status}" supports nothing, so scope.supported must be empty.`);
  }

  return problems;
}

/** Read every *.json record in `dir`, sorted by filename for determinism. */
export function loadStudies(dir) {
  const names = readdirSync(dir).filter((f) => f.endsWith('.json')).sort(compareCodeUnits);
  return names.map((name) => {
    const path = join(dir, name);
    return { name, path, record: JSON.parse(readFileSync(path, 'utf8')) };
  });
}

/** Verify a whole directory. Returns `{ studies, problems }`. */
export function verifyFieldStudies(opts = {}) {
  const root = resolve(opts.root ?? ROOT);
  const studiesDir = resolve(opts.studiesDir ?? join(root, STUDIES_DIR));
  const artifactRoot = resolve(opts.artifactRoot ?? root);
  const registerPath = resolve(opts.registerPath ?? join(ROOT, CLAIM_REGISTER_PATH));
  const readArtifact = (rel) => {
    const p = resolve(artifactRoot, rel);
    return existsSync(p) ? readFileSync(p) : null;
  };

  const schema = JSON.parse(readFileSync(resolve(ROOT, SCHEMA_PATH), 'utf8'));
  const claimIds = parseClaimIds(readFileSync(registerPath, 'utf8'));

  const seenIds = new Map();
  const studies = loadStudies(studiesDir).map(({ name, record }) => {
    const problems = collectFieldProblems({ record, file: name, schema, claimIds, readArtifact, artifactRoot });
    const id = record?.studyId;
    if (typeof id === 'string') {
      if (seenIds.has(id)) {
        problems.push({ rule: 'F19-DUPLICATE-STUDY', message: `${name}: studyId "${id}" is already used by ${seenIds.get(id)}.` });
      } else seenIds.set(id, name);
    }
    return { name, record, problems };
  });

  return {
    studiesDir,
    artifactRoot,
    studies,
    problems: studies.flatMap((s) => s.problems),
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
    out = verifyFieldStudies({
      studiesDir: opt('--studies'),
      artifactRoot: opt('--artifact-root'),
      registerPath: opt('--register'),
    });
  } catch (err) {
    console.error(`verify:field-study cannot read its inputs: ${err.message}`);
    process.exit(2);
  }

  if (out.problems.length > 0) {
    console.error('verify:field-study FAILED\n');
    for (const p of out.problems) console.error(`  • [${p.rule}] ${p.message}`);
    console.error('\nA field study record is the canonical account of work done with real');
    console.error('instruments on real ground. Fix the record, or the study, never the check.');
    process.exit(1);
  }

  const real = out.studies.filter((s) => s.record.example !== true);
  const byStatus = new Map();
  for (const s of real) byStatus.set(s.record.status, (byStatus.get(s.record.status) ?? 0) + 1);
  const tally = [...byStatus.entries()].sort((a, b) => compareCodeUnits(a[0], b[0])).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  console.log(
    `verify:field-study OK — ${out.studies.length} record(s) in ${out.studiesDir}, ` +
      `${out.studies.length - real.length} of them examples that count for nothing. ` +
      `Non-example records: ${tally}. No claim is promoted by this check, and no field ` +
      'study has been run.',
  );
  process.exit(0);
}

export { canonicalJson };
