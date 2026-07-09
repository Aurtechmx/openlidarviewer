#!/usr/bin/env node
/**
 * generate-claim-registry.mjs
 *
 * The claim register lives in ONE place — `docs/validation/claim-register.yaml`
 * — and this script derives the runtime TypeScript map from it, so nobody has to
 * hand-mirror the two (the drift risk the reviewer flagged). Edit the YAML, run
 * `npm run gen:claim-registry`, commit. `lint:claim-register` fails if the
 * generated file ever drifts from the YAML, so a forgotten regen is caught in CI.
 *
 * Usage: node scripts/generate-claim-registry.mjs   (writes the generated file)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YAML = resolve(ROOT, 'docs/validation/claim-register.yaml');
const OUT = resolve(ROOT, 'src/validation/claimRegistry.generated.ts');

// Hand-parse the YAML (mirrors the lint / unit test; no YAML dependency).
const yaml = readFileSync(YAML, 'utf8');
const claims = [];
let cur = null;
for (const raw of yaml.split('\n')) {
  const line = raw.trim();
  let m;
  if ((m = line.match(/^-?\s*claimId:\s*(\S+)/))) {
    cur = { id: m[1], current: null, required: null, exportAllowed: null };
    claims.push(cur);
  } else if (cur && (m = line.match(/^currentEvidence:\s*(\S+)/))) cur.current = m[1];
  else if (cur && (m = line.match(/^requiredEvidence:\s*(\S+)/))) cur.required = m[1];
  else if (cur && (m = line.match(/^exportAllowed:\s*(true|false)/))) cur.exportAllowed = m[1] === 'true';
}

for (const c of claims) {
  if (!c.current || !c.required || c.exportAllowed === null) {
    console.error(`generate-claim-registry: claim ${c.id} is missing a field in the YAML.`);
    process.exit(1);
  }
}

const body = claims
  .map(
    (c) =>
      `  '${c.id}': { current: '${c.current}', required: '${c.required}', exportAllowed: ${c.exportAllowed} },`,
  )
  .join('\n');

const out = `/**
 * claimRegistry.generated.ts — AUTO-GENERATED. DO NOT EDIT.
 *
 * Generated from docs/validation/claim-register.yaml by
 * scripts/generate-claim-registry.mjs. Edit the YAML and run
 * \`npm run gen:claim-registry\`. lint:claim-register fails on drift.
 */
import type { EvidenceLevel } from './evidenceLevel';

export interface RegistryEntry {
  readonly current: EvidenceLevel;
  readonly required: EvidenceLevel;
  readonly exportAllowed: boolean;
}

export const EVIDENCE_REGISTRY: Readonly<Record<string, RegistryEntry>> = {
${body}
};
`;

writeFileSync(OUT, out);
console.log(`generate-claim-registry OK — wrote ${claims.length} claims to ${OUT.replace(ROOT + '/', '')}`);
