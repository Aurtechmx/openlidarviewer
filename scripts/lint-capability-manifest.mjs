#!/usr/bin/env node
/**
 * lint-capability-manifest.mjs: hold docs/validation/capability-manifest.json
 * to the source tree, the unreachable-module register, the claim register and
 * the public documents.
 *
 *   M1  manifest shape: unique id, title, a known status, a non-empty module list
 *   M2  every listed module (file or directory) exists under the repository
 *   M3  a stable or preview capability rests on no module the unreachable
 *       register lists (a directory entry counts every file under it)
 *   M4  every referenced claimId exists in the claim register
 *   M5  a declared interface label appears verbatim in the named file
 *   M6  a hidden capability declares docTerms, the phrases M7 searches for
 *   M7  no current public document describes a hidden capability as available.
 *       Every sentence naming one of a hidden capability's docTerms must be
 *       qualified (QUALIFIER, e.g. "staged", "not reachable") by that sentence
 *       or by another sentence in the same paragraph that names the same
 *       capability. A qualifying sentence that names no hidden capability also
 *       counts when the paragraph names only that one hidden capability. A
 *       qualifier elsewhere in the document, or about another capability,
 *       excuses nothing. Headings are not read as claims.
 *   M8  every document in CURRENT_DOCS exists
 *
 * CURRENT_DOCS is the explicit list M7 reads. Release notes, the changelog and
 * the implementation ledger (docs/releases/, docs/release/, CHANGELOG.md)
 * record past states and are left out. A new current document is added here.
 *
 * Flags, for tests: --manifest <file>, --unreachable <file>, --claims <file>,
 * --docs <file,file,...> (replaces the document set).
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, join } from 'node:path';
import { isCliEntry } from './lib/isCliEntry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATUSES = new Set(['stable', 'preview', 'hidden']);
const QUALIFIER =
  /not reachable|unreachable|switched off|not (yet )?(available|offered|shipped|wired)|staged|later release|hidden from users|no capability can be enabled/i;

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export const CURRENT_DOCS = [
  'README.md',
  'docs/AUTHORS.md',
  'docs/CLA.md',
  'docs/CONTRIBUTORS.md',
  'docs/DESIGN_NOTES.md',
  'docs/README.md',
  'docs/USER_GUIDE.md',
  'docs/acquisition-grid.md',
  'docs/analysis-architecture.md',
  'docs/architecture.md',
  'docs/benchmarks.md',
  'docs/continuity-field.md',
  'docs/contour-studio.md',
  'docs/coordinate-precision.md',
  'docs/copc.md',
  'docs/credits.md',
  'docs/developer-manual.md',
  'docs/disposal-contracts.md',
  'docs/limitations.md',
  'docs/mobile-browser-support.md',
  'docs/navigation.md',
  'docs/performance.md',
  'docs/public-lidar-catalog.md',
  'docs/research-impact.md',
  'docs/research-notes.md',
  'docs/screenshots.md',
  'docs/streaming.md',
  'docs/supported-formats.md',
  'docs/terrain-access.md',
  'docs/terrain-flow-pulse.md',
  'docs/terrain-intelligence.md',
  'docs/threat-model.md',
  'docs/usage.md',
  'docs/architecture/continuity-bundle-strategy.md',
  'docs/observatory/SPEC.md',
  'docs/observatory/methods.md',
  'docs/project/CLAIMS_AND_LIMITATIONS.md',
  'docs/project/STABILITY_POLICY.md',
  'docs/project/SUPPORT.md',
  'docs/science/METHOD_REGISTRY.md',
  'src/observation/README.md',
  'validation/control-network/README.md',
];

/** Paragraphs split on blank lines, each split into sentences. Headings name a topic and make no claim, so they are dropped. */
function sentencesByParagraph(text) {
  return text
    .replace(/^#{1,6}\s.*$/gm, '')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').split(/(?<=[.!?;:])\s+(?=[^a-z])/).filter((s) => s.trim() !== ''));
}

/** Hidden capabilities whose docTerms the sentence names. */
function namedIn(sentence, hidden) {
  const low = sentence.toLowerCase();
  return hidden.filter((c) => c.docTerms.some((t) => low.includes(t.toLowerCase())));
}

/**
 * M7 for one document: the hidden capabilities it describes as available, each
 * with the first unqualified term.
 */
export function unqualifiedClaims(text, hidden) {
  const out = new Map();
  for (const sentences of sentencesByParagraph(text)) {
    const named = sentences.map((s) => namedIn(s, hidden));
    const inParagraph = new Set(named.flat());
    for (let i = 0; i < sentences.length; i++) {
      for (const cap of named[i]) {
        if (out.has(cap.id)) continue;
        const qualified = sentences.some((s, j) => QUALIFIER.test(s) && (
          named[j].includes(cap) || (named[j].length === 0 && inParagraph.size === 1)
        ));
        if (qualified) continue;
        const low = sentences[i].toLowerCase();
        out.set(cap.id, cap.docTerms.find((t) => low.includes(t.toLowerCase())));
      }
    }
  }
  return out;
}

function filesUnder(rel) {
  const abs = resolve(ROOT, rel);
  if (!statSync(abs).isDirectory()) return [rel];
  const out = [];
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const child = join(rel, e.name);
    if (e.isDirectory()) out.push(...filesUnder(child));
    else out.push(child);
  }
  return out;
}

export function lintCapabilityManifest(argv = []) {
  const manifestPath = resolve(arg(argv, '--manifest') ?? resolve(ROOT, 'docs/validation/capability-manifest.json'));
  const unreachablePath = resolve(arg(argv, '--unreachable') ?? resolve(ROOT, 'docs/validation/unreachable-modules.json'));
  const claimsPath = resolve(arg(argv, '--claims') ?? resolve(ROOT, 'docs/validation/claim-register.yaml'));
  const docsArg = arg(argv, '--docs');
  const docs = docsArg ? docsArg.split(',').map((d) => resolve(d)) : CURRENT_DOCS.map((d) => resolve(ROOT, d));

  const errors = [];
  const fail = (rule, msg) => errors.push(`${rule} ${msg}`);

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const unreachable = new Set(
    JSON.parse(readFileSync(unreachablePath, 'utf8')).modules.map((m) => m.path),
  );
  const claimIds = new Set(
    [...readFileSync(claimsPath, 'utf8').matchAll(/^\s*-?\s*claimId:\s*(\S+)/gm)].map((m) => m[1]),
  );

  const caps = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
  if (caps.length === 0) fail('M1', 'manifest lists no capabilities');
  const seen = new Set();
  const hidden = [];

  for (const cap of caps) {
    const id = cap?.id;
    if (typeof id !== 'string' || id === '') { fail('M1', 'a capability has no id'); continue; }
    if (seen.has(id)) fail('M1', `${id}: duplicate id`);
    seen.add(id);
    if (typeof cap.title !== 'string' || cap.title === '') fail('M1', `${id}: no title`);
    if (!STATUSES.has(cap.status)) { fail('M1', `${id}: status "${cap.status}" is not stable, preview or hidden`); continue; }
    if (!Array.isArray(cap.modules) || cap.modules.length === 0) { fail('M1', `${id}: no backing module`); continue; }

    for (const mod of cap.modules) {
      if (!existsSync(resolve(ROOT, mod))) { fail('M2', `${id}: backing module ${mod} does not exist`); continue; }
      if (cap.status === 'hidden') continue;
      for (const f of filesUnder(mod)) {
        if (unreachable.has(f)) fail('M3', `${id}: ${cap.status} capability rests on unreachable module ${f}`);
      }
    }

    for (const claim of cap.claims ?? []) {
      if (!claimIds.has(claim)) fail('M4', `${id}: claim ${claim} is not in the claim register`);
    }

    if (cap.uiLabel) {
      const file = resolve(ROOT, cap.uiLabel.file ?? '');
      if (!cap.uiLabel.file || !existsSync(file) || !readFileSync(file, 'utf8').includes(cap.uiLabel.text)) {
        fail('M5', `${id}: label "${cap.uiLabel.text}" not found in ${cap.uiLabel.file}`);
      }
    }

    if (cap.status === 'hidden') {
      if (!Array.isArray(cap.docTerms) || cap.docTerms.length === 0) fail('M6', `${id}: hidden capability declares no docTerms`);
      else hidden.push(cap);
    }
  }

  for (const doc of docs) {
    if (!existsSync(doc)) { fail('M8', `${relative(ROOT, doc)}: listed document does not exist`); continue; }
    for (const [id, term] of unqualifiedClaims(readFileSync(doc, 'utf8'), hidden)) {
      fail('M7', `${relative(ROOT, doc)}: describes hidden capability ${id} ("${term}") as available`);
    }
  }

  const counts = { stable: 0, preview: 0, hidden: 0 };
  for (const c of caps) if (c && STATUSES.has(c.status)) counts[c.status] += 1;
  return { errors, counts };
}

if (isCliEntry(import.meta.url)) {
  const { errors, counts } = lintCapabilityManifest(process.argv.slice(2));
  if (errors.length > 0) {
    for (const e of errors) console.error(`lint:capability-manifest ${e}`);
    console.error(`lint:capability-manifest FAILED (${errors.length} problem${errors.length === 1 ? '' : 's'})`);
    process.exit(1);
  }
  console.log(
    `lint:capability-manifest OK (${counts.stable} stable, ${counts.preview} preview, ${counts.hidden} hidden)`,
  );
}
