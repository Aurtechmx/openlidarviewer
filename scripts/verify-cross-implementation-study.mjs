#!/usr/bin/env node
/**
 * verify-cross-implementation-study.mjs — refuse a cross-implementation study
 * record that cannot be believed.
 *
 *   node scripts/verify-cross-implementation-study.mjs
 *   node scripts/verify-cross-implementation-study.mjs --studies <dir> --artifact-root <dir>
 *   node scripts/verify-cross-implementation-study.mjs --dataset-register <path>
 *
 * WHY THIS EXISTS. `REFERENCE_SLOTS` in src/validation/crossCheck.ts carries one
 * reference comparison per claim. Three claims are at E4 on the strength of one
 * GDAL run over one frozen analytic DEM each, and the slot model has nowhere to
 * put a second dataset, a second parameter set, or a second reference tool. The
 * manifests under validation/cross-implementation/studies/ are the canonical
 * record; the slots stay as the compact runtime summary the UI and the release
 * lints already read.
 *
 * WHAT IT DOES NOT DO. It does not run a comparison, does not compute agreement,
 * and does not promote anything. A verified manifest says "this record is
 * internally consistent and its artifacts are on disk as recorded". Evidence
 * levels live in docs/validation/claim-register.yaml and move only by a human
 * change to that file.
 *
 * WHAT A RECOMPUTED DIGEST PROVES, AND WHAT IT DOES NOT. `protocolDigest` is
 * recomputed from the manifest, so it cannot detect a record rewritten wholesale
 * — a rewriter can recompute the digest too. What it does is turn a silent edit
 * into a visible one: loosening `toleranceAbs` after seeing the result changes
 * the digest, so the diff stops being "one number moved" and becomes "the frozen
 * protocol changed", which is the thing a reviewer can see. The independent
 * witness is the commit that first registered the study at `pending`.
 *
 * `protocolRef` is the second half of that. It points at a record under
 * validation/protocols/ written before the study ran, so the manifest has to
 * agree with a file a result cannot reach back and adjust, and rule R12 requires
 * one from any real manifest that asserts a measured outcome.
 *
 * Exit 0 when every manifest verifies, 1 when any is rejected, 2 on a usage,
 * read or parse error.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, isAbsolute, sep } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const STUDIES_DIR = 'validation/cross-implementation/studies';
export const SCHEMA_PATH = 'validation/cross-implementation/manifest.schema.json';
export const CLAIM_REGISTER_PATH = 'docs/validation/claim-register.yaml';

/**
 * The frozen protocols a study manifest can point at, and their shape.
 *
 * WHY A SEPARATE FILE FROM THE MANIFEST. `protocolDigest` is recomputed from the
 * manifest itself, so it detects an edit to one field but not a record rewritten
 * whole — the rewriter recomputes that digest too. A protocol record lives
 * outside the manifest and is written before the study runs, so the manifest has
 * to agree with a second file that a result cannot reach back and adjust. To
 * loosen a tolerance quietly you now have to edit the protocol, restamp its
 * digest, restamp the manifest's protocolRef and restamp the manifest's own
 * protocolDigest, and every one of those is a line in the diff.
 */
export const PROTOCOLS_DIR = 'validation/protocols';
export const PROTOCOL_SCHEMA_PATH = 'validation/protocols/protocol.schema.json';

/**
 * The register R2 checks membership against by default. It is a default and not
 * a fixed read: see `readDatasetIds` for why the path is an argument.
 */
export const DATASET_REGISTER_PATH = 'validation/datasets/dataset-register.yaml';

/**
 * Every permitted status, and what each one means. The distinctions are the
 * point: a summary that lumps them together would report "no result" for four
 * different reasons that need four different actions.
 *
 *   pending          registered, tolerance frozen, not yet run
 *   not-executed     a step deliberately left unrun (container pinning, say)
 *   unavailable      could be run here, but the tool is not installed on this host
 *   blocked-external cannot be done from inside a repository at all
 *   insufficient     ran, too few comparable cells to conclude anything
 *   agree            within the preregistered tolerance on the registered scope
 *   partial          within tolerance on part of the registered scope only
 *   disagree         outside the preregistered tolerance
 *   invalid          the study itself was mis-run; its numbers must not be read
 *   inconclusive     ran and valid, but the instrument cannot discriminate
 *
 * WHY `blocked-external` IS SEPARATE FROM `unavailable`. `unavailable` used to
 * carry both meanings, and they are different boundaries. "GDAL is not installed
 * on this workstation" is a host problem: install the tool and the study runs,
 * so it belongs in a queue of work. "This needs a survey crew, or a person with
 * no connection to this project" cannot be closed from inside a repository by
 * anyone, however well equipped — it is the E5/E6 boundary, not a missing
 * package. Summarising them under one word would let permanent boundaries read
 * as a to-do list, and would let a to-do list read as a permanent boundary.
 */
export const STUDY_STATUSES = [
  'pending',
  'not-executed',
  'unavailable',
  'blocked-external',
  'insufficient',
  'agree',
  'partial',
  'disagree',
  'invalid',
  'inconclusive',
];

/** Statuses that assert a measured outcome, so raw records must exist. */
export const RESULT_STATUSES = new Set(['agree', 'partial', 'disagree']);

/** Statuses that may never reach a summary count: nothing has been measured. */
export const UNCOUNTED_STATUSES = new Set(['pending', 'not-executed']);

/** Statuses under which a scope entry may be declared supported. */
export const SCOPE_CLAIMABLE_STATUSES = new Set(['agree', 'partial']);

/**
 * A dataset id is an identifier, not a sentence. Uppercase, digit and dot
 * segments joined by hyphens, at least two segments.
 *
 * This is the weaker half of R2 and it does not need a register: it rejects free
 * prose, but cannot reject a well-shaped id nobody registered. Membership is the
 * stronger half, and the R2 branch below applies it whenever a register was read.
 */
export const DATASET_ID_PATTERN = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9.]+)+$/;

/** Names that mean "our own output", which may never be the reference side. */
const SELF_REFERENCE = /openlidar|\bolv\b|openlidarviewer/i;

/** A reference command that runs this project's own toolchain is not independent. */
const OWN_TOOLCHAIN = /(^|\s)(npm|npx|pnpm|yarn)\s|(^|\s)node\s+scripts\//;

/** A tag is not a pin: `latest` (or any bare tag) moves under the record. */
const FLOATING_TAG = /(^|:)latest$|(^|\s)latest(\s|$)/i;

// ── canonical form + digests ────────────────────────────────────────────────

/**
 * UTF-16 code-unit order, written out rather than left to the default.
 *
 * Digests here depend on sort order, so the order has to be fixed by the
 * specification and not by the machine that ran the script. That rules out
 * `localeCompare`, whose result moves with the locale and the ICU build. A
 * bare `.sort()` already does the right thing, but nothing on the page says
 * so, and "the default happens to be what we need" is the kind of claim that
 * gets refactored away.
 */
export function byCodeUnit(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Key-sorted JSON, so a digest depends on values and not on key order. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const body = Object.keys(value)
      .sort(byCodeUnit)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/**
 * The frozen protocol: what was decided before the study ran. The tolerance is
 * inside it deliberately — that is the number a disappointing result tempts
 * someone to adjust.
 */
export function protocolOf(manifest) {
  return {
    claimId: manifest.claimId,
    datasetIds: (manifest.datasets ?? []).map((d) => d.datasetId).sort(),
    parameterSets: [...(manifest.parameterSets ?? [])].sort((a, b) =>
      String(a?.id) < String(b?.id) ? -1 : String(a?.id) > String(b?.id) ? 1 : 0,
    ),
    metrics: manifest.metrics ?? null,
  };
}

export function protocolDigestOf(manifest) {
  return `sha256:${sha256(canonicalJson(protocolOf(manifest)))}`;
}

/**
 * A protocol record's own digest: over every field except the digest itself.
 * Everything else is inside it on purpose, the tolerance most of all.
 */
export function protocolRecordDigestOf(record) {
  const body = { ...record };
  delete body.digest;
  return `sha256:${sha256(canonicalJson(body))}`;
}

/**
 * The digest a derived artifact must carry: over the {path, sha256} pairs of the
 * raw artifacts it came from, in path order. `rawByPath` holds the digests the
 * verifier computed from the files on disk, not the ones the manifest claims, so
 * the chain is disk -> raw digest -> inputsDigest -> derived artifact.
 */
export function derivedInputsDigest(derivedFrom, rawByPath) {
  const pairs = [...derivedFrom]
    .sort(byCodeUnit)
    .map((path) => ({ path, sha256: rawByPath.get(path) ?? null }));
  return `sha256:${sha256(canonicalJson(pairs))}`;
}

// ── registers ───────────────────────────────────────────────────────────────

/**
 * Claim ids from the register. Line-based on purpose: no YAML parser is a
 * declared dependency of this project, and scripts/lint-claim-register.mjs
 * parses the same file the same way. READ ONLY — nothing here writes it.
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
 * Dataset ids from the register at `registerPath`, or null when that file is not
 * there, which leaves R2 checking id shape only.
 *
 * WHY THE PATH IS AN ARGUMENT. This used to read the module constant directly. A
 * verifier that reads ambient state cannot be tested for both of its behaviours:
 * whichever mode the tree happened to be in was the only mode a test could
 * reach, so the register landing silently changed what the suite was asserting.
 * Callers name the register they mean, and both modes are reachable on purpose.
 */
export function readDatasetIds(read, registerPath = DATASET_REGISTER_PATH) {
  const text = read(registerPath);
  if (text == null) return null;
  const ids = new Set();
  for (const raw of text.split('\n')) {
    const m = raw.trim().match(/^-?\s*datasetId:\s*(\S+)/);
    if (m) ids.add(m[1]);
  }
  return ids;
}

// ── schema subset ───────────────────────────────────────────────────────────

/**
 * The keywords manifest.schema.json is allowed to use. A keyword outside this
 * set is an error rather than a no-op, so a schema that grows past the validator
 * fails loudly instead of quietly checking less than it appears to.
 *
 * Written here rather than imported: scripts/check-defect-registry.mjs holds an
 * equivalent validator but does not export it, and no schema validator is a
 * declared dependency (the archive-portability suite requires every import to
 * be one).
 */
const SUPPORTED_KEYWORDS = new Set([
  '$schema', '$id', '$defs', '$ref', 'title', 'description',
  'type', 'required', 'properties', 'additionalProperties',
  'items', 'minItems', 'uniqueItems', 'enum', 'pattern',
  'minLength', 'minimum',
]);

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function typeMatches(value, expected) {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'integer' || actual === 'number';
  return actual === expected;
}

function deref(node, root) {
  const seen = new Set();
  let cur = node;
  while (cur && typeof cur.$ref === 'string') {
    if (seen.has(cur.$ref)) throw new Error(`circular $ref at ${cur.$ref}`);
    seen.add(cur.$ref);
    if (!cur.$ref.startsWith('#/')) throw new Error(`unsupported $ref ${cur.$ref}`);
    cur = cur.$ref.slice(2).split('/').reduce((acc, key) => acc?.[key], root);
    if (!cur) throw new Error('unresolvable $ref');
  }
  return cur;
}

function validateAgainstSchema(value, schema, root, path, errors) {
  const node = deref(schema, root);
  for (const keyword of Object.keys(node)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      errors.push(`${path}: schema uses unimplemented keyword "${keyword}"`);
    }
  }

  if (node.type !== undefined) {
    const allowed = Array.isArray(node.type) ? node.type : [node.type];
    if (!allowed.some((t) => typeMatches(value, t))) {
      errors.push(`${path}: expected ${allowed.join(' or ')}, found ${typeOf(value)}`);
      return;
    }
  }

  if (node.enum !== undefined && !node.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of the ${node.enum.length} permitted values`);
  }

  if (typeof value === 'string') {
    if (node.minLength !== undefined && value.length < node.minLength) {
      errors.push(`${path}: shorter than minLength ${node.minLength}`);
    }
    if (node.pattern !== undefined && !new RegExp(node.pattern).test(value)) {
      errors.push(`${path}: ${JSON.stringify(value)} does not match ${node.pattern}`);
    }
  }

  if (typeof value === 'number' && node.minimum !== undefined && value < node.minimum) {
    errors.push(`${path}: below minimum ${node.minimum}`);
  }

  if (Array.isArray(value)) {
    if (node.minItems !== undefined && value.length < node.minItems) {
      errors.push(`${path}: has ${value.length} items, minItems is ${node.minItems}`);
    }
    if (node.uniqueItems === true && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) {
      errors.push(`${path}: contains duplicate items`);
    }
    if (node.items !== undefined) {
      value.forEach((item, i) => validateAgainstSchema(item, node.items, root, `${path}[${i}]`, errors));
    }
    return;
  }

  if (value !== null && typeof value === 'object') {
    for (const key of node.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}: missing required property "${key}"`);
    }
    const props = node.properties ?? {};
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(props, key)) {
        validateAgainstSchema(child, props[key], root, `${path}.${key}`, errors);
      } else if (node.additionalProperties === false) {
        errors.push(`${path}: unexpected property "${key}"`);
      }
    }
  }
}

// ── protocol rules ──────────────────────────────────────────────────────────

/**
 * Verify one protocol record. `ctx` supplies:
 *   protocol   the parsed record
 *   file       its filename, for messages
 *   schema     the parsed protocol schema
 *   claimIds   Set of ids read from the claim register
 *
 * Returns `[{ rule, message }]`; empty means the record verifies.
 */
export function collectProtocolProblems(ctx) {
  const { protocol: p, file, schema, claimIds } = ctx;
  // Injectable so the negative controls can drive P10 without inventing
  // commits, and so a caller with no repository gets a stated no-op.
  const resolveCommitDate = ctx.resolveCommitDate ?? commitDate;
  const problems = [];
  const add = (rule, message) => problems.push({ rule, message: `${file}: ${message}` });

  const schemaErrors = [];
  validateAgainstSchema(p, schema, schema, '$', schemaErrors);
  for (const e of schemaErrors) add('P1-SCHEMA', e);
  if (schemaErrors.length > 0) return problems;

  // P2. The record's digest must describe the record on disk. This is what a
  // study manifest repeats, so if it drifts the manifests that cite it drift.
  const expected = protocolRecordDigestOf(p);
  if (p.digest !== expected) {
    add('P2-PROTOCOL-DIGEST', `digest does not describe this file (recorded ${p.digest}, recomputed ${expected}); a tolerance edited after a result is exactly what this catches.`);
  }

  // P3. An example is marked as one on both sides, like a manifest.
  const prefixed = p.protocolId.startsWith('EXAMPLE-');
  if (prefixed !== p.example) {
    add('P3-EXAMPLE', `protocolId ${prefixed ? 'is' : 'is not'} prefixed EXAMPLE- but example is ${p.example}; a template must be unmistakable from either field alone.`);
  }

  const seenClaims = new Set();
  for (const c of p.claims) {
    if (!claimIds.has(c.claimId)) {
      add('P4-CLAIM-UNKNOWN', `claims entry "${c.claimId}" is not in ${CLAIM_REGISTER_PATH}; a protocol cannot govern a claim nobody registered.`);
    }
    if (seenClaims.has(c.claimId)) {
      add('P4-CLAIM-UNKNOWN', `claims lists "${c.claimId}" twice, so which metrics block governs it is undecided.`);
    }
    seenClaims.add(c.claimId);

    // P5. A gate that passes everything is not a gate — the same rule the
    // manifests are held to, applied where the number is actually frozen.
    const frac = c.metrics.requiredWithinToleranceFraction;
    if (!(frac > 0) || frac > 1) {
      add('P5-METRICS', `claims entry "${c.claimId}" sets requiredWithinToleranceFraction ${frac}, which must be inside (0, 1]; 0 would call any comparison agreement.`);
    }

    // P6. A record cannot be written before the decision it records.
    const f = c.freeze;
    if (p.recordWrittenOn < f.on) {
      add('P6-FREEZE-DATES', `claims entry "${c.claimId}": recordWrittenOn ${p.recordWrittenOn} is before its freeze date ${f.on}; a protocol cannot be written before the decision it records.`);
    }

    // ── P9. "Preregistered" has to mean what it says ────────────────────────
    //
    // This rule exists because the first version of this record got it wrong.
    // It claimed one frozen date for three claims, and for ASPECT-RASTER that
    // claim was false: the slot, its tolerance and its result all arrived in
    // one commit, so no commit shows the tolerance while aspect had no result.
    // A reviewer caught it by walking the history by hand. The check below is
    // that walk, mechanised, so the next such statement fails instead of being
    // believed.
    const landed = f.resultLandedOn ?? null;
    if ((f.resultCommit ?? null) !== null && landed === null) {
      add('P9-FREEZE-PROVENANCE', `claims entry "${c.claimId}" names a resultCommit but no resultLandedOn; the date is the half a reader can compare against the freeze.`);
    }
    if (f.status === 'preregistered' && landed !== null && !(f.on < landed)) {
      add('P9-FREEZE-PROVENANCE', `claims entry "${c.claimId}" says its tolerance was preregistered, but the freeze date ${f.on} does not precede the result date ${landed}. A tolerance fixed alongside its result is "adopted-with-result"; it may be defensible on the merits, and it is still not a preregistration.`);
    }
    if (f.status === 'adopted-with-result' && landed !== null && f.on < landed) {
      add('P9-FREEZE-PROVENANCE', `claims entry "${c.claimId}" says its tolerance was adopted with the result, but the freeze date ${f.on} precedes the result date ${landed}; if the witness commit really shows the tolerance before the result, this claim is stronger than the record admits and should say "preregistered".`);
    }

    // ── P10. A date has to belong to the commit that witnesses it ───────────
    const witnessDate = resolveCommitDate(f.witnessCommit);
    if (witnessDate !== null && witnessDate !== f.on) {
      add('P10-WITNESS-DATE', `claims entry "${c.claimId}" dates its freeze ${f.on}, but witnessCommit ${f.witnessCommit} is dated ${witnessDate}. A freeze date that does not belong to the commit offered as its witness is not evidence of anything.`);
    }
    if (landed !== null && (f.resultCommit ?? null) !== null) {
      const resultDate = resolveCommitDate(f.resultCommit);
      if (resultDate !== null && resultDate !== landed) {
        add('P10-WITNESS-DATE', `claims entry "${c.claimId}" dates its result ${landed}, but resultCommit ${f.resultCommit} is dated ${resultDate}.`);
      }
    }
  }

  return problems;
}

/**
 * The author date of `commit`, as YYYY-MM-DD, or null when it cannot be
 * resolved here.
 *
 * WHY THIS IS A LOOKUP AND NOT A PROOF. P9 compares a record's own dates, so it
 * catches a record that contradicts itself. It cannot catch a date that is
 * simply wrong: writing an earlier freeze date than the truth satisfies every
 * arithmetic check in this file. That is the shape the defect this rule exists
 * for actually took. Pinning the date to the commit named as the witness closes
 * the easy version of it: to back-date a freeze you must now also name a commit
 * that carries that date, and a reviewer following the hash lands somewhere the
 * tolerance is not.
 *
 * What remains uncovered, and is stated here rather than papered over: nothing
 * mechanical reads the witness commit's CONTENT. Whether the tolerance really
 * stands there with the claim unresolved is a human check, and the hash is what
 * makes that check one git command instead of an archaeology exercise.
 */
export function commitDate(commit, cwd = ROOT) {
  try {
    const out = execFileSync('git', ['show', '-s', '--format=%ad', '--date=short', commit], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const date = out.trim().split('\n').pop()?.trim() ?? '';
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
  } catch {
    // No git, no repository, or an unknown commit. An extracted archive has no
    // history, and this check is not a reason to fail there.
    return null;
  }
}

/** Read every *.protocol.json in `dir`, sorted by filename for determinism. */
export function loadProtocols(dir) {
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir).filter((f) => f.endsWith('.protocol.json')).sort(byCodeUnit);
  return names.map((name) => {
    const path = join(dir, name);
    return { name, path, protocol: JSON.parse(readFileSync(path, 'utf8')) };
  });
}

// ── the rules ───────────────────────────────────────────────────────────────

/**
 * Verify one manifest. `ctx` supplies:
 *   manifest        the parsed record
 *   file            its path, for messages
 *   schema          the parsed manifest schema
 *   claimIds        Set of ids read from the claim register
 *   datasetIds      Set of registered dataset ids, or null when no register was
 *                   supplied, which leaves R2 checking id shape only
 *   datasetRegisterPath  the register the ids came from, for messages
 *   readArtifact    (repoRelativePath) => Buffer | null
 *   artifactRoot    absolute root the artifact paths are resolved against
 *
 * Returns `[{ rule, message }]`; empty means the record verifies. Each rule id
 * is stable so tests can assert which rule fired, not merely that one did.
 */
export function collectStudyProblems(ctx) {
  const {
    manifest: m, file, schema, claimIds, datasetIds, readArtifact, artifactRoot,
    datasetRegisterPath = DATASET_REGISTER_PATH,
  } = ctx;
  const problems = [];
  const add = (rule, message) => problems.push({ rule, message: `${file}: ${message}` });

  // ── S1. Shape first, so no rule below reads a field that is not there ─────
  const schemaErrors = [];
  validateAgainstSchema(m, schema, schema, '$', schemaErrors);
  for (const e of schemaErrors) add('S1-SCHEMA', e);
  if (schemaErrors.length > 0) return problems;

  // ── S2. An example is marked as one on both sides ─────────────────────────
  const prefixed = m.studyId.startsWith('EXAMPLE-');
  if (prefixed !== m.example) {
    add('S2-EXAMPLE', `studyId ${prefixed ? 'is' : 'is not'} prefixed EXAMPLE- but example is ${m.example}; a template must be unmistakable from either field alone.`);
  }
  if (m.example && !UNCOUNTED_STATUSES.has(m.status)) {
    add('S2-EXAMPLE', `example manifests may only sit at ${[...UNCOUNTED_STATUSES].join(' or ')}, not "${m.status}".`);
  }

  // ── R1. The claim must exist in the register ──────────────────────────────
  if (!claimIds.has(m.claimId)) {
    add('R1-CLAIM-UNKNOWN', `claimId "${m.claimId}" is not in ${CLAIM_REGISTER_PATH}; a study cannot be evidence for a claim nobody registered.`);
  }

  // ── R2. Dataset ids are identifiers, not prose ────────────────────────────
  for (const d of m.datasets) {
    if (!DATASET_ID_PATTERN.test(d.datasetId)) {
      add('R2-DATASET-ID', `datasetId ${JSON.stringify(d.datasetId)} is free text, not a registered identifier (expected ${DATASET_ID_PATTERN}).`);
    } else if (datasetIds && !datasetIds.has(d.datasetId)) {
      add('R2-DATASET-ID', `datasetId "${d.datasetId}" is not in ${datasetRegisterPath}.`);
    }
  }
  const datasetIdSet = new Set(m.datasets.map((d) => d.datasetId));
  if (datasetIdSet.size !== m.datasets.length) {
    add('R2-DATASET-ID', 'the same datasetId is listed twice.');
  }

  const parameterSetIds = new Set(m.parameterSets.map((p) => p.id));
  if (parameterSetIds.size !== m.parameterSets.length) {
    add('S3-PARAMETER-SET', 'the same parameter-set id is listed twice.');
  }

  // ── S4. A gate that passes everything is not a gate ───────────────────────
  const frac = m.metrics.requiredWithinToleranceFraction;
  if (!(frac > 0) || frac > 1) {
    add('S4-METRICS', `requiredWithinToleranceFraction ${frac} must be inside (0, 1]; 0 would call any comparison agreement.`);
  }

  // ── R3. The tolerance is frozen by the protocol digest ────────────────────
  const expectedDigest = protocolDigestOf(m);
  if (m.protocolDigest !== expectedDigest) {
    add('R3-PROTOCOL-DIGEST', `metrics, datasets or parameter sets disagree with the frozen protocolDigest (recorded ${m.protocolDigest}, recomputed ${expectedDigest}); a tolerance edited after the result is exactly what this catches.`);
  }

  // ── R11 / R12. The manifest must agree with its frozen protocol ───────────
  const protocols = ctx.protocols ?? new Map();
  if (m.protocolRef) {
    const entry = protocols.get(m.protocolRef.protocolId);
    if (!entry) {
      add('R11-PROTOCOL-REF', `protocolRef names protocol "${m.protocolRef.protocolId}", which is not a record under ${PROTOCOLS_DIR}; a study cannot cite a protocol nobody wrote.`);
    } else {
      const actual = protocolRecordDigestOf(entry.protocol);
      if (m.protocolRef.digest !== actual) {
        add('R11-PROTOCOL-REF', `protocolRef.digest ${m.protocolRef.digest} does not match protocol "${m.protocolRef.protocolId}", which now digests to ${actual}; the protocol changed under a study that had already cited it.`);
      }
      if (entry.protocol.example !== m.example) {
        add('R11-PROTOCOL-REF', `example is ${m.example} but protocol "${m.protocolRef.protocolId}" is example ${entry.protocol.example}; a real study may not run under a template protocol, nor a template under a real one.`);
      }
      const governed = (entry.protocol.claims ?? []).find((c) => c.claimId === m.claimId);
      if (!governed) {
        add('R11-PROTOCOL-REF', `protocol "${m.protocolRef.protocolId}" governs ${(entry.protocol.claims ?? []).map((c) => c.claimId).join(', ') || 'no claim'}, not claimId "${m.claimId}".`);
      } else {
        // A measured outcome must be able to be compared against its freeze.
        // Without the result date the protocol's freeze claim cannot be
        // falsified from the record, and a freeze nobody can falsify is a
        // sentence rather than a control.
        if (RESULT_STATUSES.has(m.status) && !governed.freeze?.resultLandedOn) {
          add('R11-PROTOCOL-REF', `status "${m.status}" asserts a measured outcome, but protocol "${m.protocolRef.protocolId}" records no resultLandedOn for ${m.claimId}; without it, whether the tolerance predates the result cannot be checked from these records.`);
        }
        if (canonicalJson(m.metrics) !== canonicalJson(governed.metrics)) {
          add('R11-PROTOCOL-REF', `metrics ${canonicalJson(m.metrics)} disagree with the frozen protocol's metrics for ${m.claimId} ${canonicalJson(governed.metrics)}; the gate a study is judged by is decided in the protocol, not in the record of the result.`);
        }
        const admittedDatasets = new Set(governed.datasetIds);
        for (const d of m.datasets) {
          if (!admittedDatasets.has(d.datasetId)) {
            add('R11-PROTOCOL-REF', `datasetId "${d.datasetId}" is not admitted by protocol "${m.protocolRef.protocolId}" for ${m.claimId}; a dataset added after the freeze is a different study.`);
          }
        }
        const admittedParameterSets = new Set(governed.parameterSetIds);
        for (const ps of m.parameterSets) {
          if (!admittedParameterSets.has(ps.id)) {
            add('R11-PROTOCOL-REF', `parameterSet "${ps.id}" is not admitted by protocol "${m.protocolRef.protocolId}" for ${m.claimId}; a parameter set added after the freeze is a different study.`);
          }
        }
      }
    }
  } else if (!m.example && RESULT_STATUSES.has(m.status)) {
    add('R12-PROTOCOL-MISSING', `status "${m.status}" asserts a measured outcome, so protocolRef is required; without a protocol frozen outside this record there is nothing the tolerance can be checked against.`);
  }

  // ── R4. The reference may not be our own output ───────────────────────────
  const ref = m.reference;
  const selfHits = [];
  if (SELF_REFERENCE.test(ref.tool)) selfHits.push(`tool "${ref.tool}"`);
  if (ref.executablePath && SELF_REFERENCE.test(ref.executablePath)) selfHits.push(`executablePath "${ref.executablePath}"`);
  if (ref.commandLine && SELF_REFERENCE.test(ref.commandLine)) selfHits.push('commandLine');
  if (ref.commandLine && OWN_TOOLCHAIN.test(ref.commandLine)) selfHits.push('commandLine runs this project\'s own toolchain');
  if (ref.executablePath && isAbsolute(ref.executablePath) && (ref.executablePath + sep).startsWith(artifactRoot + sep)) {
    selfHits.push('executablePath is inside this repository');
  }
  if (selfHits.length > 0) {
    add('R4-REFERENCE-IS-CANDIDATE', `the reference side names the candidate implementation (${selfHits.join('; ')}); comparing our output to our output measures nothing.`);
  }

  // ── R10. The reference must be pinned ─────────────────────────────────────
  const digest = ref.containerDigest ?? null;
  const digestIsPin = typeof digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(digest);
  if (digest !== null && !digestIsPin) {
    add('R10-REFERENCE-UNPINNED', `containerDigest ${JSON.stringify(digest)} is not a sha256 digest; a tag moves under the record and is not a pin.`);
  }
  if (digestIsPin) {
    if (ref.containerPinning !== 'pinned') {
      add('R10-REFERENCE-UNPINNED', 'a container digest is recorded but containerPinning does not say "pinned".');
    }
  } else {
    // Docker is not running on the host these studies are produced on, so the
    // container pin is the ideal and not the requirement. What replaces it must
    // be complete: a real path, a reported version, and the exact command.
    const missing = [];
    if (!ref.executablePath || !ref.executablePath.includes('/')) missing.push('executablePath (a path, not a bare tool name)');
    if (!ref.version || FLOATING_TAG.test(ref.version) || /^(unknown|unpinned|\*)$/i.test(ref.version)) missing.push('a reported version (not a floating tag)');
    if (!ref.commandLine || ref.commandLine.trim() === '') missing.push('commandLine');
    if (missing.length > 0) {
      add('R10-REFERENCE-UNPINNED', `no containerDigest, so ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required.`);
    }
    if (ref.containerPinning !== 'not-executed') {
      add('R10-REFERENCE-UNPINNED', 'no containerDigest, so containerPinning must state "not-executed" rather than leave the reader to assume a container was used.');
    }
    if (!ref.containerPinningNote) {
      add('R10-REFERENCE-UNPINNED', 'containerPinningNote must say why container pinning was not executed.');
    }
  }

  // ── R9. Recorded digests must match the files on disk ─────────────────────
  const rawByPath = new Map();
  for (const a of m.rawArtifacts) {
    const bytes = readArtifact(a.path);
    if (bytes === null) {
      add('R9-ARTIFACT-DIGEST', `rawArtifacts entry "${a.path}" is not on disk under ${artifactRoot}.`);
      continue;
    }
    const actual = sha256(bytes);
    rawByPath.set(a.path, actual);
    if (actual !== a.sha256) {
      add('R9-ARTIFACT-DIGEST', `rawArtifacts entry "${a.path}" records sha256 ${a.sha256} but the file on disk hashes to ${actual}.`);
    }
  }

  // ── R5. A measured outcome needs its raw records ──────────────────────────
  if (RESULT_STATUSES.has(m.status)) {
    if (m.rawArtifacts.length === 0) {
      add('R5-RAW-MISSING', `status "${m.status}" asserts a measured outcome, so rawArtifacts may not be empty.`);
    } else if (!m.rawArtifacts.some((a) => a.role === 'reference-output')) {
      add('R5-RAW-MISSING', `status "${m.status}" asserts agreement with a reference, but no rawArtifacts entry has role "reference-output".`);
    }
    if (!m.result) {
      add('R5-RAW-MISSING', `status "${m.status}" asserts a measured outcome, so a result block is required.`);
    }
  }

  // ── R6. A derived summary must re-derive from the raw artifacts ───────────
  for (const d of m.derivedArtifacts) {
    const bytes = readArtifact(d.path);
    if (bytes === null) {
      add('R9-ARTIFACT-DIGEST', `derivedArtifacts entry "${d.path}" is not on disk under ${artifactRoot}.`);
    } else {
      const actual = sha256(bytes);
      if (actual !== d.sha256) {
        add('R9-ARTIFACT-DIGEST', `derivedArtifacts entry "${d.path}" records sha256 ${d.sha256} but the file on disk hashes to ${actual}.`);
      }
    }
    const unknown = d.derivedFrom.filter((p) => !rawByPath.has(p));
    if (unknown.length > 0) {
      add('R6-DERIVED-NOT-REDERIVABLE', `derivedArtifacts entry "${d.path}" claims to come from ${unknown.map((p) => JSON.stringify(p)).join(', ')}, which ${unknown.length === 1 ? 'is not a raw artifact' : 'are not raw artifacts'} of this study.`);
      continue;
    }
    const expected = derivedInputsDigest(d.derivedFrom, rawByPath);
    if (d.inputsDigest !== expected) {
      add('R6-DERIVED-NOT-REDERIVABLE', `derivedArtifacts entry "${d.path}" cannot be re-derived from its raw artifacts: inputsDigest ${d.inputsDigest}, recomputed from the files on disk ${expected}.`);
    }
  }

  // ── R7. Nothing unmeasured may reach a count ──────────────────────────────
  if (UNCOUNTED_STATUSES.has(m.status)) {
    if (m.result) {
      add('R7-UNCOUNTED-CARRIES-RESULT', `status "${m.status}" means nothing was measured, so a result block may not be present; scripts/build-cross-implementation-summary.mjs excludes this study from every count and a result here would be a number with nothing behind it.`);
    }
    if (m.derivedArtifacts.length > 0) {
      add('R7-UNCOUNTED-CARRIES-RESULT', `status "${m.status}" means nothing was measured, so there is nothing to derive from; derivedArtifacts must be empty.`);
    }
  }

  // ── R8. Approved scope may not exceed what was studied ────────────────────
  for (const s of m.scope.supported) {
    if (!datasetIdSet.has(s.datasetId)) {
      add('R8-SCOPE-BROADER', `scope.supported approves datasetId "${s.datasetId}", which this study does not list; approved scope may not exceed the datasets actually compared.`);
    }
    if (!parameterSetIds.has(s.parameterSetId)) {
      add('R8-SCOPE-BROADER', `scope.supported approves parameterSetId "${s.parameterSetId}", which this study does not list; approved scope may not exceed the parameter sets actually compared.`);
    }
  }
  if (m.scope.supported.length > 0 && !SCOPE_CLAIMABLE_STATUSES.has(m.status)) {
    add('R8-SCOPE-BROADER', `status "${m.status}" supports nothing, so scope.supported must be empty.`);
  }

  // ── S5. The status must follow from the numbers ────────────────────────────
  if (m.result) {
    const r = m.result;
    const enough = r.comparableCells >= m.metrics.minimumComparableCells;
    const meets = r.withinToleranceFraction >= m.metrics.requiredWithinToleranceFraction;
    if (m.status === 'agree' && !(enough && meets)) {
      add('S5-STATUS-VS-RESULT', `status "agree" but ${r.comparableCells} comparable cells (minimum ${m.metrics.minimumComparableCells}) and ${r.withinToleranceFraction} within tolerance (required ${m.metrics.requiredWithinToleranceFraction}).`);
    }
    if ((m.status === 'partial' || m.status === 'disagree') && meets && enough) {
      add('S5-STATUS-VS-RESULT', `status "${m.status}" but the numbers meet the registered gate; say so or correct the numbers.`);
    }
    if (m.status === 'insufficient' && enough) {
      add('S5-STATUS-VS-RESULT', `status "insufficient" but ${r.comparableCells} comparable cells meets the registered minimum ${m.metrics.minimumComparableCells}.`);
    }
    if (r.maxAbsDiff > m.metrics.toleranceAbs && r.withinToleranceFraction === 1) {
      add('S5-STATUS-VS-RESULT', `every cell is reported within ±${m.metrics.toleranceAbs} while maxAbsDiff is ${r.maxAbsDiff}.`);
    }
  }

  return problems;
}

// ── loading ─────────────────────────────────────────────────────────────────

/** Read every *.json manifest in `dir`, sorted by filename for determinism. */
export function loadStudies(dir) {
  const names = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  return names.map((name) => {
    const path = join(dir, name);
    return { name, path, manifest: JSON.parse(readFileSync(path, 'utf8')) };
  });
}

/**
 * Verify a whole directory. Returns `{ studies, problems }` where `studies` is
 * `[{ name, manifest, problems }]`. The summary builder consumes this so it can
 * never summarise a record this file rejects.
 */
export function verifyStudies(opts = {}) {
  const root = resolve(opts.root ?? ROOT);
  const studiesDir = resolve(opts.studiesDir ?? join(root, STUDIES_DIR));
  const protocolsDir = resolve(opts.protocolsDir ?? join(root, PROTOCOLS_DIR));
  const artifactRoot = resolve(opts.artifactRoot ?? root);
  const registerPath = resolve(opts.registerPath ?? join(ROOT, CLAIM_REGISTER_PATH));
  // Kept unresolved so messages name what the caller asked for, and so the
  // default reads as the repo-relative path it always did.
  const datasetRegisterPath = opts.datasetRegisterPath ?? DATASET_REGISTER_PATH;
  const read = (rel) => {
    const p = resolve(ROOT, rel);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  };
  const readArtifact = (rel) => {
    const p = resolve(artifactRoot, rel);
    return existsSync(p) ? readFileSync(p) : null;
  };

  const schema = JSON.parse(readFileSync(resolve(ROOT, SCHEMA_PATH), 'utf8'));
  const protocolSchema = JSON.parse(readFileSync(resolve(ROOT, PROTOCOL_SCHEMA_PATH), 'utf8'));
  const claimIds = parseClaimIds(readFileSync(registerPath, 'utf8'));
  const datasetIds = readDatasetIds(read, datasetRegisterPath);

  // Protocols first: a manifest is checked against them, so a protocol that
  // does not verify has to be visible before any manifest cites it.
  const loadedProtocols = loadProtocols(protocolsDir);
  const protocols = new Map();
  const protocolProblems = [];
  const seenProtocolIds = new Map();
  for (const { name, protocol } of loadedProtocols) {
    protocolProblems.push(...collectProtocolProblems({
      protocol, file: name, schema: protocolSchema, claimIds, resolveCommitDate: opts.resolveCommitDate,
    }));
    const id = protocol?.protocolId;
    if (typeof id !== 'string') continue;
    if (seenProtocolIds.has(id)) {
      protocolProblems.push({ rule: 'P7-DUPLICATE-PROTOCOL', message: `${name}: protocolId "${id}" is already used by ${seenProtocolIds.get(id)}.` });
      continue;
    }
    seenProtocolIds.set(id, name);
    if (`${id}.protocol.json` !== name) {
      protocolProblems.push({ rule: 'P8-PROTOCOL-FILENAME', message: `${name}: protocolId "${id}" does not match the filename; a record must be findable from the id a manifest cites.` });
    }
    protocols.set(id, { name, protocol });
  }

  const loaded = loadStudies(studiesDir);
  const seenIds = new Map();
  const studies = loaded.map(({ name, manifest }) => {
    const problems = collectStudyProblems({
      manifest, file: name, schema, claimIds, datasetIds, readArtifact, artifactRoot,
      datasetRegisterPath, protocols,
    });
    const id = manifest?.studyId;
    if (typeof id === 'string') {
      if (seenIds.has(id)) {
        problems.push({ rule: 'S6-DUPLICATE-STUDY', message: `${name}: studyId "${id}" is already used by ${seenIds.get(id)}.` });
      } else seenIds.set(id, name);
    }
    return { name, manifest, problems };
  });

  return {
    studiesDir,
    protocolsDir,
    artifactRoot,
    datasetRegisterPath,
    datasetRegisterPresent: datasetIds !== null,
    protocols: loadedProtocols.map(({ name, protocol }) => ({ name, protocol })),
    studies,
    problems: [...protocolProblems, ...studies.flatMap((s) => s.problems)],
  };
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
  const studiesDir = opt('--studies');
  const protocolsDir = opt('--protocols');
  const artifactRoot = opt('--artifact-root');
  const registerPath = opt('--register');
  const datasetRegisterPath = opt('--dataset-register');

  let out;
  try {
    out = verifyStudies({ studiesDir, protocolsDir, artifactRoot, registerPath, datasetRegisterPath });
  } catch (err) {
    console.error(`verify:cross-implementation-study cannot read its inputs: ${err.message}`);
    process.exit(2);
  }

  if (out.problems.length > 0) {
    console.error('verify:cross-implementation-study FAILED\n');
    for (const p of out.problems) console.error(`  • [${p.rule}] ${p.message}`);
    console.error('\nA study manifest is the canonical record of a cross-implementation');
    console.error('comparison. Fix the record, or the study, rather than the check.');
    process.exit(1);
  }

  const byStatus = new Map();
  for (const s of out.studies) byStatus.set(s.manifest.status, (byStatus.get(s.manifest.status) ?? 0) + 1);
  const tally = [...byStatus.entries()].sort((a, b) => byCodeUnit(a[0], b[0])).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  console.log(
    `verify:cross-implementation-study OK — ${out.studies.length} manifest(s) in ${out.studiesDir} ` +
      `(${tally}); ${out.protocols.length} protocol(s) in ${out.protocolsDir}; ` +
      `dataset register ${out.datasetRegisterPath} ` +
      `${out.datasetRegisterPresent ? 'present, membership enforced' : 'absent, dataset id shape only'}. ` +
      'No claim is promoted by this check.',
  );
  process.exit(0);
}
