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
 *      `vitepress build`), no emitted file may match a forbidden name, no
 *      page may carry the tell-tale text of an unresolved include, and no
 *      page may show an escaped HTML comment as visible prose (the site
 *      renders with `html: false`, so a comment that slips past the
 *      stripping rule in docs-site/.vitepress/stripHtmlComments.mts would
 *      surface to readers as a literal `<!-- ... -->` paragraph).
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

/**
 * True when a built page's VISIBLE text contains an escaped HTML comment.
 * Code contexts are excluded first — inline `<code>` and fenced `<pre>`
 * blocks may legitimately SHOW comment syntax as an example — so the check
 * fires only on comment text a reader would meet as stray page prose.
 * Pure — exported for tests/lintDocsSite.test.ts.
 */
export function htmlShowsEscapedComment(html) {
  const visible = html
    .replace(/<pre[\s\S]*?<\/pre>/g, '')
    .replace(/<code[\s\S]*?<\/code>/g, '');
  return visible.includes('&lt;!--');
}

function walk(dir, filter) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, filter));
    else if (filter.test(name)) out.push(p);
  }
  return out;
}

function run() {
  const problems = [];

  // ── 1 + 2. Every include target must exist and must not be forbidden ───────
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

  // ── 3. Built output: no forbidden document, raw include, or visible comment ─
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
      if (rel.endsWith('.html')) {
        const html = readFileSync(file, 'utf8');
        if (html.includes('@include:')) {
          problems.push(`built page ${rel} contains an unresolved @include`);
        }
        if (htmlShowsEscapedComment(html)) {
          problems.push(`built page ${rel} shows an escaped HTML comment as visible text`);
        }
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
}

// Import-safe: the checks run only when invoked as a script, so the unit test
// can import htmlShowsEscapedComment without triggering a lint pass (the same
// guard lint-unsafe-html.mjs uses).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  run();
}
