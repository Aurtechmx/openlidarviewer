#!/usr/bin/env node
/**
 * lint-method-literals.mjs — a registered method id written as a literal in
 * source must carry the version METHOD_REGISTRY declares.
 *
 * The stockpile estimator shipped `olv.volume.stockpile-area-grid@1 (method-literal-ok: quoting the incident)` in three
 * places after the registry moved it to v2, so every exported figure claimed a
 * version whose meaning the registry says it does not have. CI passed because
 * the method-version tests read the registry, never the value the
 * implementation returns.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const REGISTRY = join(SRC, 'science', 'methodRegistry.ts');
/**
 * Everywhere a method tag can be WRITTEN, not just where it can be run.
 *
 * Scanning `src/` alone left roughly thirty tag literals in `tests/`, the
 * fixture-matching id in `scripts/verify-classifier-corpus.mjs`, and every
 * occurrence in the public method documents outside the gate. All of them
 * agreed with the registry, which is exactly the problem: the next version
 * bump would have left this lint green while the fixtures and the published
 * docs went on describing the old method — the `@1`-after-v2 shape this file's
 * own docstring was written for.
 */
const ROOTS = ['src', 'tests', 'scripts', 'docs'].map((d) => join(ROOT, d));
const SCANNED = new Set(['.ts', '.tsx', '.mjs', '.js', '.md', '.json']);

/** id -> declared version, parsed from the registry source. */
function declaredVersions() {
  const text = readFileSync(REGISTRY, 'utf8');
  const out = new Map();
  const entry = /'(olv\.[\w.-]+)':\s*\{[\s\S]*?version:\s*(\d+)/g;
  for (let m = entry.exec(text); m !== null; m = entry.exec(text)) out.set(m[1], Number(m[2]));
  return out;
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (SCANNED.has(p.slice(p.lastIndexOf('.')))) acc.push(p);
  }
  return acc;
}

const versions = declaredVersions();
if (versions.size === 0) {
  console.error('lint:method-literals FAILED — parsed no versions from the registry.');
  process.exit(1);
}

const problems = [];
const files = [];
for (const root of ROOTS) {
  try { walk(root, files); } catch { /* an absent root is not a failure */ }
}
for (const file of files) {
  if (file === REGISTRY) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    // An explicit, per-site exemption for a tag that is QUOTED rather than
    // stamped: a negative-case fixture, a docstring recounting a past
    // incident, a superseded plan. Narrow on purpose — the marker sits on the
    // line it excuses, so it is visible to anyone reading that line, and no
    // whole file or directory is waved through.
    if (line.includes('method-literal-ok')) return;
    const tag = /(olv\.[\w.-]+)@(\d+)/g;
    for (let m = tag.exec(line); m !== null; m = tag.exec(line)) {
      const [, id, ver] = m;
      const declared = versions.get(id);
      if (declared === undefined) {
        problems.push(`${relative(ROOT, file)}:${i + 1} names ${id}@${ver}, which the registry does not define.`);
      } else if (Number(ver) !== declared) {
        problems.push(
          `${relative(ROOT, file)}:${i + 1} writes ${id}@${ver}; the registry declares v${declared}.`,
        );
      }
    }
  });
}

if (problems.length > 0) {
  console.error('lint:method-literals FAILED\n');
  for (const p of problems) console.error(`  • ${p}`);
  console.error('\nDerive the tag from METHOD_REGISTRY (methodTag(methodRef(id))) rather than writing it out.');
  process.exit(1);
}
console.log(`lint:method-literals OK — every written method tag matches the registry (${versions.size} registered).`);
