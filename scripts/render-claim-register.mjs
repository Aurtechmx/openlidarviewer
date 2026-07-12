#!/usr/bin/env node
/**
 * render-claim-register.mjs
 *
 * The scientific claim register lives in ONE place — `docs/validation/
 * claim-register.yaml` — and the docs site must publish it as a readable table
 * without anyone hand-mirroring twenty rows (the same drift class
 * `generate-claim-registry.mjs` closes for the runtime registry). This script
 * derives `docs-site/validation/claim-register.generated.md` from the YAML;
 * the docs-site wrapper page includes that file, so the published table can
 * only ever say what the register says.
 *
 * The generated file is COMMITTED (the repo's convention for derived
 * artifacts — see src/validation/claimRegistry.generated.ts), and
 * `tests/renderClaimRegister.test.ts` re-renders the real YAML and fails on
 * any drift, so a register edit that skips `npm run docs:render` is caught in
 * the unit bucket, not on a stale published page.
 *
 * The YAML is hand-parsed with the same flat one-field-per-line reader the
 * lint / unit test / generator already use — no YAML dependency.
 *
 * Usage: node scripts/render-claim-register.mjs   (also `npm run docs:render`)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YAML = resolve(ROOT, 'docs/validation/claim-register.yaml');
const OUT = resolve(ROOT, 'docs-site/validation/claim-register.generated.md');

/**
 * Parse the register's flat, one-field-per-line YAML into the fields the
 * published table renders. Pure — exported for the unit test.
 */
export function parseClaimRegister(yaml) {
  // A scalar may carry a trailing `# comment` (e.g. softwareVersion); strip it.
  const scalar = (v) => v.replace(/\s+#.*$/, '').trim();
  const claims = [];
  let softwareVersion = null;
  let generated = null;
  let cur = null;
  for (const raw of yaml.split('\n')) {
    const line = raw.trim();
    let m;
    if ((m = line.match(/^softwareVersion:\s*(.+)$/))) softwareVersion = scalar(m[1]);
    else if ((m = line.match(/^generated:\s*(.+)$/))) generated = scalar(m[1]);
    else if ((m = line.match(/^-?\s*claimId:\s*(\S+)/))) {
      cur = {
        id: m[1],
        product: null,
        algorithm: null,
        algorithmVersion: null,
        current: null,
        required: null,
        externalStatus: null,
        approvedClaim: null,
        prohibitedClaims: [],
      };
      claims.push(cur);
    } else if (cur && (m = line.match(/^product:\s*(.+)$/))) cur.product = scalar(m[1]);
    else if (cur && (m = line.match(/^algorithmVersion:\s*(\S+)/))) cur.algorithmVersion = m[1];
    else if (cur && (m = line.match(/^algorithm:\s*(.+)$/))) cur.algorithm = scalar(m[1]);
    else if (cur && (m = line.match(/^currentEvidence:\s*(\S+)/))) cur.current = m[1];
    else if (cur && (m = line.match(/^requiredEvidence:\s*(\S+)/))) cur.required = m[1];
    else if (cur && (m = line.match(/^externalValidationStatus:\s*(\S+)/))) cur.externalStatus = m[1];
    else if (cur && (m = line.match(/^approvedClaim:\s*"(.+)"\s*$/))) cur.approvedClaim = m[1];
    else if (cur && (m = line.match(/^prohibitedClaim:\s*(\[.*\])\s*$/))) {
      // The list is written inline with double-quoted items, which is valid
      // JSON as-is — the same trick generate-claim-registry.mjs relies on for
      // its fields, extended to the one array this table needs.
      cur.prohibitedClaims = JSON.parse(m[1]);
    }
  }
  return { softwareVersion, generated, claims };
}

/**
 * Render the parsed register as the markdown partial the docs site includes.
 * Pure — exported for the unit test.
 */
export function renderClaimRegisterMarkdown({ softwareVersion, generated, claims }) {
  // A literal `|` inside a cell would end the cell; nothing else in the
  // register's prose needs escaping inside a markdown table.
  const cell = (s) => String(s ?? '—').replace(/\|/g, '\\|');
  const header =
    '| Claim | Product | Method@version | Current evidence | Required | External status | Approved claim | Prohibited claims |';
  const rule = `|${' --- |'.repeat(8)}`;
  const rows = claims.map((c) =>
    [
      '',
      `\`${c.id}\``,
      cell(c.product),
      cell(`${c.algorithm} @ ${c.algorithmVersion}`),
      `\`${cell(c.current)}\``,
      `\`${cell(c.required)}\``,
      cell(c.externalStatus),
      cell(c.approvedClaim),
      cell(c.prohibitedClaims.join('; ')),
      '',
    ].join(' | ').trim(),
  );
  return [
    '<!--',
    '  claim-register.generated.md — AUTO-GENERATED. DO NOT EDIT.',
    '',
    '  Rendered from docs/validation/claim-register.yaml by',
    '  scripts/render-claim-register.mjs. Edit the YAML and run',
    '  `npm run docs:render`. tests/renderClaimRegister.test.ts fails on drift.',
    '-->',
    '',
    `_Register last reviewed at software version **${softwareVersion}**, dated ${generated}. ${claims.length} claims._`,
    '',
    header,
    rule,
    ...rows,
    '',
  ].join('\n');
}

// CLI entry — only when run directly, not when imported by the test.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const parsed = parseClaimRegister(readFileSync(YAML, 'utf8'));
  const missing = parsed.claims.filter(
    (c) => !c.product || !c.algorithm || !c.current || !c.required || !c.approvedClaim,
  );
  if (missing.length > 0 || parsed.claims.length === 0) {
    console.error(
      `render-claim-register: register parse incomplete — ${parsed.claims.length} claims, ` +
        `${missing.length} with missing fields (${missing.map((c) => c.id).join(', ')}).`,
    );
    process.exit(1);
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, renderClaimRegisterMarkdown(parsed));
  console.log(
    `render-claim-register OK — wrote ${parsed.claims.length} claims to ${OUT.replace(ROOT + '/', '')}`,
  );
}
