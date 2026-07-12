#!/usr/bin/env node
/**
 * lint-docs-site.mjs
 *
 * Publication guard for the docs site. The site publishes repo markdown by
 * explicit opt-in only: wrapper pages under docs-site/ `<!--@include: ...-->`
 * the canonical files, so nothing can reach the public site without a wrapper
 * naming it. This guard makes the boundary enforceable instead of
 * conventional:
 *
 *   1. FORBIDDEN list — internal plans, audits, and research notes must never
 *      be included by any page. A wrapper that includes one fails here.
 *   2. Include integrity — every `@include` target must exist. VitePress
 *      leaves an unresolved include as literal text on the published page, so
 *      a typo'd path would otherwise ship silently.
 *   3. Built-output check — when docs-site/.vitepress/dist exists (i.e. after
 *      `vitepress build`), no emitted file may match a forbidden name, and no
 *      page may carry the tell-tale text of an unresolved include.
 *
 * Usage: `node scripts/lint-docs-site.mjs` (runs as part of `npm run docs:build`).
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = resolve(ROOT, 'docs-site');
const DIST = resolve(SITE, '.vitepress/dist');

// Never published — internal working documents, not user- or reviewer-facing.
// Matched against the repo-relative path of every include target and against
// every path emitted into the built site.
const FORBIDDEN = [
  /^docs\/_audit\//,
  /^docs\/architecture\/v0\.5\.8-cleanup-plan\.md$/,
  /^docs\/gate2-per-cloud-filter-plan\.md$/,
  /^docs\/v0\.5\.7-plan\.md$/,
  /^docs\/v0\.5\.7-object-e57-capture-lens\.md$/,
  /^docs\/research-notes\.md$/,
];

const problems = [];

function walk(dir, filter) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, filter));
    else if (filter.test(name)) out.push(p);
  }
  return out;
}

// ── 1 + 2. Every include target must exist and must not be forbidden ─────────
const INCLUDE_RE = /<!--\s*@include:\s*([^\s>]+?)(?:\{[^}]*\})?\s*-->/g;
for (const page of walk(SITE, /\.md$/)) {
  const text = readFileSync(page, 'utf8');
  let m;
  while ((m = INCLUDE_RE.exec(text)) !== null) {
    const target = m[1].split('#')[0]; // strip a region anchor
    const abs = resolve(dirname(page), target);
    const rel = relative(ROOT, abs);
    if (!existsSync(abs)) {
      problems.push(`${relative(ROOT, page)} includes missing file ${rel}`);
    }
    for (const f of FORBIDDEN) {
      if (f.test(rel)) problems.push(`${relative(ROOT, page)} includes FORBIDDEN file ${rel}`);
    }
  }
}

// ── 3. Built output must not carry a forbidden document or a raw include ─────
if (existsSync(DIST)) {
  for (const file of walk(DIST, /./)) {
    const rel = relative(DIST, file);
    for (const f of FORBIDDEN) {
      // The dist tree mirrors page paths, so a forbidden doc that somehow
      // became a page shows up under its own name.
      if (f.test(rel) || f.test(`docs/${rel}`)) {
        problems.push(`built site contains forbidden path ${rel}`);
      }
    }
    if (rel.endsWith('.html') && readFileSync(file, 'utf8').includes('@include:')) {
      problems.push(`built page ${rel} contains an unresolved @include`);
    }
  }
} else {
  console.log('lint:docs-site — no dist/ yet; checked page includes only.');
}

if (problems.length === 0) {
  console.log('lint:docs-site OK — all includes resolve; no forbidden document is published.');
  process.exit(0);
}

console.error('lint:docs-site FAILED');
console.error('');
for (const p of problems) console.error(`  • ${p}`);
console.error('');
process.exit(1);
