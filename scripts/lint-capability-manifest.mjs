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
 *   M7  no public document (README.md, docs/*.md) describes a hidden capability
 *       as available: a paragraph naming a docTerm must say, in that paragraph
 *       or in the document's opening lines, that the code is not reachable
 *
 * Flags, for tests: --manifest <file>, --unreachable <file>, --claims <file>,
 * --docs <file,file,...> (replaces the public document set).
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

function defaultDocs() {
  const docs = [resolve(ROOT, 'README.md')];
  for (const f of readdirSync(resolve(ROOT, 'docs'))) {
    if (f.endsWith('.md')) docs.push(resolve(ROOT, 'docs', f));
  }
  return docs;
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
  const docs = docsArg ? docsArg.split(',').map((d) => resolve(d)) : defaultDocs();

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
    if (!existsSync(doc)) continue;
    const text = readFileSync(doc, 'utf8');
    const headerQualified = QUALIFIER.test(text.split('\n').slice(0, 15).join('\n'));
    if (headerQualified) continue;
    const paragraphs = text.split(/\n\s*\n/);
    for (const cap of hidden) {
      for (const term of cap.docTerms) {
        const needle = term.toLowerCase();
        for (const p of paragraphs) {
          if (p.toLowerCase().includes(needle) && !QUALIFIER.test(p)) {
            fail('M7', `${relative(ROOT, doc)}: describes hidden capability ${cap.id} ("${term}") as available`);
            break;
          }
        }
      }
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
