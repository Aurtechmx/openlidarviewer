#!/usr/bin/env node
/**
 * lint-claim-register.mjs
 *
 * Release gate over the scientific claim register. The runtime evidence gate
 * (`src/validation/evidenceRegistry.ts`) is only trustworthy if it stays in
 * lock-step with the machine-readable register (`docs/validation/claim-register.yaml`)
 * and if no code gates an export on a claim id that does not exist. A vitest
 * cross-check already asserts value-for-value equality; this lint is the
 * structural guard that runs in `test:release` and CI, and it adds three checks
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
 * Exit 0 = clean; exit 1 = a violation (prints each problem).
 */

import { readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const VALID_LEVELS = new Set([
  'E0_IMPLEMENTED',
  'E1_UNIT_VERIFIED',
  'E2_ANALYTICALLY_VERIFIED',
  'E3_SYNTHETICALLY_VALIDATED',
  'E4_CROSS_IMPLEMENTATION_VALIDATED',
  'E5_EXTERNALLY_VALIDATED',
  'E6_INDEPENDENTLY_REPRODUCED',
]);

const BANNED_WORDING = /survey[-\s]?grade|guaranteed accuracy|certified accuracy/i;

const problems = [];

// ── 1. Parse the YAML register (hand-parsed; mirrors the unit test) ──────────
const yaml = read('docs/validation/claim-register.yaml');
const claims = [];
const seen = new Set();
let cur = null;
for (const raw of yaml.split('\n')) {
  const line = raw.trim();
  let m;
  if ((m = line.match(/^-?\s*claimId:\s*(\S+)/))) {
    cur = { id: m[1], current: null, required: null, exportAllowed: null };
    claims.push(cur);
    if (seen.has(cur.id)) problems.push(`Duplicate claimId in YAML: ${cur.id}`);
    seen.add(cur.id);
  } else if (cur && (m = line.match(/^currentEvidence:\s*(\S+)/))) {
    cur.current = m[1];
  } else if (cur && (m = line.match(/^requiredEvidence:\s*(\S+)/))) {
    cur.required = m[1];
  } else if (cur && (m = line.match(/^exportAllowed:\s*(true|false)/))) {
    cur.exportAllowed = m[1] === 'true';
  } else if (cur && (m = line.match(/^(product|algorithm):\s*(.+)$/))) {
    // 4. Affirmative descriptors must not assert survey-grade.
    if (BANNED_WORDING.test(m[2])) {
      problems.push(`Claim ${cur.id}: "${m[1]}" asserts banned wording ("${m[2].trim()}").`);
    }
  }
}

// 2. Every evidence level must be real.
for (const c of claims) {
  if (!VALID_LEVELS.has(c.current)) problems.push(`Claim ${c.id}: invalid currentEvidence "${c.current}".`);
  if (!VALID_LEVELS.has(c.required)) problems.push(`Claim ${c.id}: invalid requiredEvidence "${c.required}".`);
}

// ── Parse the runtime registry id set ────────────────────────────────────────
const registrySrc = read('src/validation/evidenceRegistry.ts');
const registryIds = new Set();
const entryRe = /'([A-Z0-9-]+)':\s*\{\s*current:/g;
let em;
while ((em = entryRe.exec(registrySrc)) !== null) registryIds.add(em[1]);

// YAML ↔ registry symmetric difference.
const yamlIds = new Set(claims.map((c) => c.id));
for (const id of yamlIds) if (!registryIds.has(id)) problems.push(`Claim ${id} is in the YAML but missing from EVIDENCE_REGISTRY.`);
for (const id of registryIds) if (!yamlIds.has(id)) problems.push(`Claim ${id} is in EVIDENCE_REGISTRY but missing from the YAML.`);

// ── 3. Exporter-without-claim: every gated id must be registered ─────────────
function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(p);
  }
}
const files = [];
walk(join(ROOT, 'src'), files);
const gateRe = /(?:exportGate|isValidatedExport)\(\s*'([A-Z0-9-]+)'/g;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  let gm;
  while ((gm = gateRe.exec(text)) !== null) {
    if (!registryIds.has(gm[1])) {
      problems.push(`${relative(ROOT, file)} gates on claim "${gm[1]}", which is not registered.`);
    }
  }
}

if (problems.length === 0) {
  console.log(
    `lint:claim-register OK — ${claims.length} claims, YAML and runtime registry in sync, no unregistered gate ids, no banned wording.`,
  );
  process.exit(0);
}

console.error('lint:claim-register FAILED');
console.error('');
for (const p of problems) console.error(`  • ${p}`);
console.error('');
process.exit(1);
