#!/usr/bin/env node
/**
 * lint-claim-register.mjs
 *
 * Release gate over the scientific claim register. The runtime evidence gate
 * (`src/validation/evidenceRegistry.ts`) is only trustworthy if it stays in
 * lock-step with the machine-readable register (`docs/validation/claim-register.yaml`)
 * and if no code gates an export on a claim id that does not exist. A vitest
 * cross-check already asserts value-for-value equality; this lint is the
 * structural guard that runs in `test:release` and CI, and it adds the checks
 * the equality test does not make:
 *
 *   1. No duplicate claim ids in the YAML.
 *   2. Every `currentEvidence` / `requiredEvidence` is a real evidence level.
 *   3. Exporter-without-claim: every id passed to `exportGate(...)` /
 *      `isValidatedExport(...)` in src/ is registered.
 *   4. No affirmative survey-grade wording in a claim's `product` / `algorithm`
 *      descriptor (those must never assert survey-grade; a `prohibitedClaim`
 *      line may name the phrase to disclaim it).
 *
 * It also confirms the YAML id set and the registry id set are identical, so a
 * claim added to one but not the other fails here (not only in the unit bucket).
 *
 * ─── WHAT THE C-RULES ADD ───────────────────────────────────────────────────
 *
 * Checks 1-4 read the register as a document: are the fields well formed, and do
 * they agree with the code. None of them asks the question that actually matters
 * about a claim register, which is whether the evidence level a claim asserts is
 * backed by evidence that exists. Before these rules, moving a claim from E3 to
 * E4 was a one-word edit in a YAML file that every check in the tree accepted.
 *
 *   C1  Every claim states its scope, in the shape the study manifests use:
 *       `scope.supported` (dataset + parameter set pairs) and
 *       `scope.unsupported` (what the evidence does not reach). A claim with no
 *       stated boundary reads as a claim with no boundary.
 *   C2  An E4 claim names the cross-implementation studies supporting it. Each
 *       id must be a manifest under validation/cross-implementation/studies/,
 *       must be for this claim, and must carry a status that asserts a measured
 *       outcome. `pending` and `not-executed` measured nothing; `disagree` and
 *       `invalid` measured something that does not support a claim.
 *   C3  An E5 or E6 claim fails outright unless the record it names exists.
 *       Neither level can be produced from inside this repository: E5 needs
 *       external ground truth, E6 needs someone with no connection to this
 *       project. No claim is at either level today, which is exactly why the
 *       rule has to be here before one is.
 *   C4  A claim's supported scope may not exceed the scope of the studies
 *       behind it. This is the rule that stops a real study on one fixture from
 *       being read as evidence about everything the product does.
 *
 * Exit 0 = clean; exit 1 = a violation (prints each problem).
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve, dirname } from 'node:path';
import { loadStudies, STUDIES_DIR } from './verify-cross-implementation-study.mjs';
import { isCliEntry } from './lib/isCliEntry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const VALID_LEVELS = new Set([
  'E0_IMPLEMENTED',
  'E1_UNIT_VERIFIED',
  'E2_ANALYTICALLY_VERIFIED',
  'E3_SYNTHETICALLY_VALIDATED',
  'E4_CROSS_IMPLEMENTATION_VALIDATED',
  'E5_EXTERNALLY_VALIDATED',
  'E6_INDEPENDENTLY_REPRODUCED',
]);

const BANNED_WORDING = /survey[-\s]?grade|guaranteed accuracy|certified accuracy/i;

/**
 * Study statuses that may stand behind a promoted claim. Deliberately narrower
 * than the verifier's RESULT_STATUSES, which also holds `disagree`: a study that
 * measured a disagreement asserts a measured outcome, and that outcome is not
 * support. `pending` and `not-executed` are excluded for the simpler reason that
 * nothing was measured at all.
 */
export const SUPPORTING_STATUSES = new Set(['agree', 'partial']);

/**
 * Where the record for a level this repository cannot reach has to live. The
 * directories are named, not created: naming them is how a future E5 claim is
 * told what would have to exist, and a rule that quietly passed because the
 * directory was missing would be worse than no rule.
 */
export const EXTERNAL_RECORD_ROOTS = {
  E5_EXTERNALLY_VALIDATED: 'validation/field/',
  E6_INDEPENDENTLY_REPRODUCED: 'validation/reproduction/',
};

// ── register parsing ────────────────────────────────────────────────────────

const stripComment = (v) => v.replace(/\s+#.*$/, '').trim();

/** `[A, B]` or `[]` → array of trimmed, unquoted items. */
function inlineList(text) {
  const body = text.trim().replace(/^\[/, '').replace(/\]$/, '').trim();
  if (body === '') return [];
  return body.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

/**
 * Parse the register into the fields the rules below read.
 *
 * Hand-parsed, like every other reader of this file (the generator, the
 * renderer, the study verifier): no YAML parser is a declared dependency. The
 * flat one-field-per-line readers elsewhere cannot see the nested `scope` block,
 * so this one tracks indentation for that block and stays line-based everywhere
 * else. Exported so the negative controls can feed it text directly.
 */
export function parseRegister(yamlText) {
  const claims = [];
  let cur = null;
  const lines = yamlText.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    let m;

    if ((m = line.match(/^-?\s*claimId:\s*(\S+)/))) {
      cur = {
        id: m[1],
        // Empty string, not null. The value is filled in from the line below
        // this one, and static analysis that reads only the literal infers the
        // field as null and calls every later comparison against a level name
        // dead code. An empty string is not a valid level either, so the
        // INVALID-LEVEL rule still catches a claim that never sets one.
        current: '',
        required: '',
        exportAllowed: null,
        supportingStudies: null,
        externalValidationRecords: null,
        externalValidationStatus: null,
        scope: null,
        line: i + 1,
      };
      claims.push(cur);
      continue;
    }
    if (!cur) continue;

    if ((m = line.match(/^currentEvidence:\s*(\S+)/))) cur.current = m[1];
    else if ((m = line.match(/^requiredEvidence:\s*(\S+)/))) cur.required = m[1];
    else if ((m = line.match(/^exportAllowed:\s*(true|false)/))) cur.exportAllowed = m[1] === 'true';
    else if ((m = line.match(/^supportingStudies:\s*(\[.*\])\s*$/))) cur.supportingStudies = inlineList(m[1]);
    else if ((m = line.match(/^externalValidationRecords:\s*(\[.*\])\s*$/))) {
      cur.externalValidationRecords = inlineList(m[1]);
    } else if ((m = line.match(/^externalValidationStatus:\s*(\S+)/))) {
      cur.externalValidationStatus = stripComment(m[1]);
    } else if ((m = line.match(/^(product|algorithm):\s*(.+)$/))) {
      cur.descriptors = cur.descriptors ?? [];
      cur.descriptors.push({ field: m[1], text: stripComment(m[2]) });
    } else if (line === 'scope:') {
      // The one nested block. Consume every line indented deeper than `scope:`.
      const scope = { supported: [], unsupported: [] };
      cur.scope = scope;
      let bucket = null;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const sub = lines[j];
        if (sub.trim() === '' || sub.trimStart().startsWith('#')) continue;
        const subIndent = sub.length - sub.trimStart().length;
        if (subIndent <= indent) break;
        const text = sub.trim();
        let sm;
        if ((sm = text.match(/^(supported|unsupported):\s*(\[.*\])?\s*$/))) {
          bucket = sm[1];
          if (sm[2] !== undefined) inlineList(sm[2]).forEach((v) => scope[bucket].push(v));
          continue;
        }
        if (bucket === 'unsupported' && (sm = text.match(/^-\s*(.+)$/))) {
          scope.unsupported.push(sm[1].trim().replace(/^["']|["']$/g, ''));
          continue;
        }
        if (bucket === 'supported') {
          if ((sm = text.match(/^-\s*datasetId:\s*(\S+)/))) {
            scope.supported.push({ datasetId: sm[1], parameterSetId: null });
          } else if ((sm = text.match(/^parameterSetId:\s*(\S+)/)) && scope.supported.length > 0) {
            scope.supported[scope.supported.length - 1].parameterSetId = sm[1];
          }
        }
      }
      i = j - 1;
    }
  }
  return claims;
}

// ── the rules ───────────────────────────────────────────────────────────────

/**
 * Collect every problem with the register. `ctx` supplies:
 *   registerText  the YAML
 *   registryText  src/validation/claimRegistry.generated.ts
 *   gateIds       [{ file, id }] read from src/
 *   studies       [{ studyId, claimId, status, scope }] from the study manifests
 *   recordExists  (repoRelativePath) => boolean
 *
 * Returns `[{ rule, message }]`; empty means the register verifies. Exported so
 * each rule can be shown rejecting its own bad input without a temp tree.
 */
export function collectRegisterProblems(ctx) {
  const { registerText, registryText, gateIds = [], studies = [], recordExists = () => false } = ctx;
  const problems = [];
  const add = (rule, message) => problems.push({ rule, message });

  const claims = parseRegister(registerText);

  // 1. No duplicate ids, and 4. no survey-grade wording in a descriptor.
  const seen = new Set();
  for (const c of claims) {
    if (seen.has(c.id)) add('DUPLICATE-ID', `Duplicate claimId in YAML: ${c.id}`);
    seen.add(c.id);
    for (const d of c.descriptors ?? []) {
      if (BANNED_WORDING.test(d.text)) {
        add('BANNED-WORDING', `Claim ${c.id}: "${d.field}" asserts banned wording ("${d.text}").`);
      }
    }
  }

  // 2. Every evidence level must be real.
  for (const c of claims) {
    if (!VALID_LEVELS.has(c.current)) add('INVALID-LEVEL', `Claim ${c.id}: invalid currentEvidence "${c.current}".`);
    if (!VALID_LEVELS.has(c.required)) add('INVALID-LEVEL', `Claim ${c.id}: invalid requiredEvidence "${c.required}".`);
  }

  // The runtime map is GENERATED from the YAML (src/validation/claimRegistry.generated.ts);
  // checking it against the YAML here proves the generated output is fresh.
  const registryIds = new Set();
  const entryRe = /'([A-Z0-9-]+)':\s*\{\s*current:/g;
  let em;
  while ((em = entryRe.exec(registryText)) !== null) registryIds.add(em[1]);

  const yamlIds = new Set(claims.map((c) => c.id));
  for (const id of yamlIds) if (!registryIds.has(id)) add('REGISTRY-DRIFT', `Claim ${id} is in the YAML but missing from EVIDENCE_REGISTRY.`);
  for (const id of registryIds) if (!yamlIds.has(id)) add('REGISTRY-DRIFT', `Claim ${id} is in EVIDENCE_REGISTRY but missing from the YAML.`);

  // 3. Exporter-without-claim: every gated id must be registered.
  for (const { file, id } of gateIds) {
    if (!registryIds.has(id)) add('UNREGISTERED-GATE', `${file} gates on claim "${id}", which is not registered.`);
  }

  // ── C1. Every claim states its scope ──────────────────────────────────────
  for (const c of claims) {
    if (!c.scope) {
      add('C1-SCOPE-MISSING', `Claim ${c.id}: no scope block. Every claim states what its evidence covers (scope.supported) and what it does not (scope.unsupported), in the shape the study manifests use.`);
      continue;
    }
    if (c.scope.unsupported.length === 0) {
      add('C1-SCOPE-MISSING', `Claim ${c.id}: scope.unsupported is empty. A claim whose evidence has no stated boundary reads as a claim with no boundary; say what it does not reach.`);
    }
    for (const s of c.scope.supported) {
      if (!s.parameterSetId) {
        add('C1-SCOPE-MISSING', `Claim ${c.id}: scope.supported entry for datasetId "${s.datasetId}" has no parameterSetId; a dataset alone does not say which parameters were compared.`);
      }
    }
  }

  // ── C2. An E4 claim names the studies behind it ───────────────────────────
  const byStudyId = new Map(studies.map((s) => [s.studyId, s]));
  for (const c of claims) {
    if (c.current === 'E4_CROSS_IMPLEMENTATION_VALIDATED'
      && (!c.supportingStudies || c.supportingStudies.length === 0)) {
      add('C2-E4-STUDY', `Claim ${c.id} is at E4_CROSS_IMPLEMENTATION_VALIDATED but names no supportingStudies. E4 means a second implementation agreed; the record of that comparison has to be citable.`);
    }
    // A claim below E4 may cite studies too, and the binding below still holds:
    // a cited study has to be real, for this claim, and to have measured something.
    for (const studyId of c.supportingStudies ?? []) {
      const study = byStudyId.get(studyId);
      if (!study) {
        add('C2-E4-STUDY', `Claim ${c.id} cites supporting study "${studyId}", which is not a manifest in ${STUDIES_DIR}.`);
        continue;
      }
      if (study.claimId !== c.id) {
        add('C2-E4-STUDY', `Claim ${c.id} cites study "${studyId}", but that study is a comparison for ${study.claimId}; a study supports the claim it was run for and no other.`);
      }
      if (!SUPPORTING_STATUSES.has(study.status)) {
        add('C2-E4-STUDY', `Claim ${c.id} cites study "${studyId}", whose status is "${study.status}". Only ${[...SUPPORTING_STATUSES].join(' or ')} asserts a measured outcome that supports a claim; a pending or not-executed study measured nothing, and a disagreement is not support.`);
      }
    }
  }

  // ── C5. An E4+ claim's externalValidationStatus must reflect a measured
  //    cross-implementation outcome ─────────────────────────────────────────
  // C2 proves the study exists and agreed; this proves the claim's own status
  // field records that. A claim at E4+ with status `pending`/`not-executed`
  // contradicts its own evidence level — the exact drift where CONTOURS reached
  // E4 but its status still read `pending`. Slope/aspect/hillshade already read
  // `partial`; this makes the register refuse the inconsistency rather than ship
  // it (and a truth-doc then reading "pending" cannot trace back to a clean YAML).
  const LEVELS = [...VALID_LEVELS];
  const E4_RANK = LEVELS.indexOf('E4_CROSS_IMPLEMENTATION_VALIDATED');
  const VALIDATED_STATUSES = new Set(['partial', 'complete']);
  for (const c of claims) {
    const rank = LEVELS.indexOf(c.current);
    if (rank !== -1 && rank >= E4_RANK && !VALIDATED_STATUSES.has(c.externalValidationStatus)) {
      add(
        'C5-E4-STATUS',
        `Claim ${c.id} is at ${c.current} but its externalValidationStatus is "${c.externalValidationStatus ?? '(unset)'}". A claim at E4 or above rests on a cross-implementation comparison that ran and agreed, so its status must be one of ${[...VALIDATED_STATUSES].join(' or ')} — not pending/not-executed.`,
      );
    }
  }

  // ── C3. E5 and E6 need a record this repository cannot produce ────────────
  for (const c of claims) {
    const root = EXTERNAL_RECORD_ROOTS[c.current];
    if (!root) continue;
    const records = c.externalValidationRecords ?? [];
    if (records.length === 0) {
      add('C3-EXTERNAL-RECORD', `Claim ${c.id} is at ${c.current} but names no externalValidationRecords. Neither level can be produced from inside this repository: E5 needs external ground truth and E6 needs an independent party, so the level may not be asserted without pointing at the record that was produced outside it, under ${root}.`);
      continue;
    }
    for (const path of records) {
      if (!path.startsWith(root)) {
        add('C3-EXTERNAL-RECORD', `Claim ${c.id} names externalValidationRecord "${path}", which is not under ${root}; a record for ${c.current} lives there so it cannot be confused with evidence generated in this tree.`);
        continue;
      }
      if (!recordExists(path)) {
        add('C3-EXTERNAL-RECORD', `Claim ${c.id} names externalValidationRecord "${path}", which does not exist. An evidence level whose record is missing is a level nobody can check.`);
      }
    }
  }

  // ── C4. A claim's scope may not exceed the studies behind it ──────────────
  for (const c of claims) {
    if (!c.scope || c.scope.supported.length === 0) continue;
    const supporting = (c.supportingStudies ?? []).map((id) => byStudyId.get(id)).filter(Boolean);
    if (supporting.length === 0) {
      add('C4-SCOPE-EXCEEDS-STUDY', `Claim ${c.id}: scope.supported names ${c.scope.supported.length} dataset/parameter-set pair(s) but the claim cites no study that verifies. Supported scope comes from a study's own scope.supported; without one there is nothing for it to come from.`);
      continue;
    }
    const covered = new Set();
    for (const s of supporting) {
      for (const entry of s.scope?.supported ?? []) covered.add(`${entry.datasetId} ${entry.parameterSetId}`);
    }
    for (const entry of c.scope.supported) {
      if (!covered.has(`${entry.datasetId} ${entry.parameterSetId}`)) {
        add('C4-SCOPE-EXCEEDS-STUDY', `Claim ${c.id}: scope.supported approves datasetId "${entry.datasetId}" with parameterSetId "${entry.parameterSetId}", which no supporting study supports. A claim may not approve more than the studies behind it measured.`);
      }
    }
  }

  return { claims, problems };
}

// ── loading ─────────────────────────────────────────────────────────────────

/** Every `exportGate('X')` / `isValidatedExport('X')` id under `dir`. */
export function readGateIds(dir, root = ROOT) {
  const files = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) files.push(p);
    }
  };
  walk(dir);
  const out = [];
  const gateRe = /(?:exportGate|isValidatedExport)\(\s*'([A-Z0-9-]+)'/g;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    let gm;
    while ((gm = gateRe.exec(text)) !== null) out.push({ file: relative(root, file), id: gm[1] });
  }
  return out;
}

/** The study fields the C-rules read, from the committed manifests. */
export function readStudies(dir) {
  if (!existsSync(dir)) return [];
  return loadStudies(dir).map(({ manifest }) => ({
    studyId: manifest.studyId,
    claimId: manifest.claimId,
    status: manifest.status,
    scope: manifest.scope,
  }));
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function isMain() {
  return isCliEntry(import.meta.url);
}

if (isMain()) {
  const read = (p) => readFileSync(join(ROOT, p), 'utf8');
  const { claims, problems } = collectRegisterProblems({
    registerText: read('docs/validation/claim-register.yaml'),
    registryText: read('src/validation/claimRegistry.generated.ts'),
    gateIds: readGateIds(join(ROOT, 'src')),
    studies: readStudies(join(ROOT, STUDIES_DIR)),
    recordExists: (p) => existsSync(join(ROOT, p)),
  });

  if (problems.length === 0) {
    console.log(
      `lint:claim-register OK — ${claims.length} claims, YAML and runtime registry in sync, no unregistered gate ids, `
        + 'no banned wording, every claim scoped, every E4 claim bound to a study that measured something.',
    );
    process.exit(0);
  }

  console.error('lint:claim-register FAILED');
  console.error('');
  for (const p of problems) console.error(`  • [${p.rule}] ${p.message}`);
  console.error('');
  process.exit(1);
}
