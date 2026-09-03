#!/usr/bin/env node
/**
 * lint-method-literals.mjs — a registered method id written as a literal in
 * source must carry the version METHOD_REGISTRY declares.
 *
 * The stockpile estimator shipped `olv.volume.stockpile-area-grid@1` in three
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
    else if (p.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

const versions = declaredVersions();
if (versions.size === 0) {
  console.error('lint:method-literals FAILED — parsed no versions from the registry.');
  process.exit(1);
}

const problems = [];
for (const file of walk(SRC)) {
  if (file === REGISTRY) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
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
