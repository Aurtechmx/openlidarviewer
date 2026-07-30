#!/usr/bin/env node
/**
 * lint-html-assets.mjs — every local reference in a shipped page must resolve.
 *
 * The external testing form links OpenLiDARViewer_Test_Guide.pdf, which is not
 * in the repository. That one turned out to be fine: the PDF is uploaded to the
 * web root by hand and serves correctly. Working that out took a request to the
 * live site, because nothing here could tell a file that ships another way from
 * a link that was simply wrong.
 *
 * That is the gap this closes. A dead link is quiet in a way a dead script is
 * not: nothing throws, the console stays clean, and only the person who clicked
 * it ever knows. Now a reference either resolves in the repository or appears in
 * the list below with a reason, and a typo fails the build either way.
 *
 * It guards the form's own script too. Extracting it to test-report.js fixed a
 * CSP problem, and if that file ever stops shipping the page goes back to having
 * no behaviour at all. Here that is a build failure rather than a silent one.
 *
 * Local references only. External URLs are someone else's uptime and checking
 * them would make the build depend on the network.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = resolve(ROOT, 'public');

/** Pages the site serves, with the directory each one resolves against. */
function shippedPages() {
  const pages = [];
  if (existsSync(resolve(ROOT, 'index.html'))) {
    // Vite's entry resolves bare paths against the project root at build time,
    // and public/ is copied to the same place, so both are candidate bases.
    pages.push({ file: 'index.html', bases: [ROOT, PUBLIC] });
  }
  if (existsSync(PUBLIC)) {
    for (const name of readdirSync(PUBLIC)) {
      if (name.endsWith('.html')) pages.push({ file: `public/${name}`, bases: [PUBLIC] });
    }
  }
  return pages;
}

/**
 * Files that live on the web host but not in this repository.
 *
 * Every entry is a hole in this check, so each one names what it is and why it
 * is not tracked here. Adding a line to silence a failure, rather than because
 * the file genuinely ships another way, defeats the point: the dead link this
 * check was written for would have been "fixed" by an entry exactly like these.
 *
 * Verify one of these is still live by requesting it. The check will not do it
 * for you, because a build that fails when a web host is slow is a build people
 * learn to ignore.
 */
const DEPLOYED_SEPARATELY = new Map([
  [
    'OpenLiDARViewer_Test_Guide.pdf',
    'uploaded to the web root by hand; too large to carry in the repository',
  ],
]);

/** Anything with a scheme, a protocol-relative URL, or a bare fragment. */
function isExternal(ref) {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//') || ref.startsWith('#') || ref === ''
  );
}

function references(html) {
  const found = new Set();
  // src and href only. srcset carries descriptors and is not used here; adding
  // it later means parsing the comma-separated form properly rather than
  // pretending each entry is a plain path.
  for (const m of html.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/gi)) {
    found.add(m[1]);
  }
  return [...found];
}

/**
 * References a page makes from script rather than from markup.
 *
 * The testing form POSTs to an endpoint named in a constant, and imports its
 * formatting from a second module. Neither is an href, so neither is checked
 * by the sweep above, and both fail the same silent way: the page loads, the
 * button appears, and nothing works.
 *
 * Each entry names the file that must exist and what breaks without it, so a
 * failure says more than that a string did not match.
 */
const SCRIPT_REFERENCES = [
  {
    in: 'public/test-report.js',
    pattern: /const ENDPOINT\s*=\s*"([^"]+)"/,
    what: 'the address the form POSTs the report to',
  },
  {
    in: 'public/test-report.js',
    pattern: /from\s+'\.\/([^']+)'/,
    what: 'the module holding the report formatting',
  },
];

const problems = [];
const allowed = [];

for (const { in: file, pattern, what } of SCRIPT_REFERENCES) {
  const full = resolve(ROOT, file);
  if (!existsSync(full)) {
    problems.push(`${file} is missing — it holds ${what}.`);
    continue;
  }
  const match = pattern.exec(readFileSync(full, 'utf8'));
  if (!match) {
    problems.push(`${file} no longer names ${what}; this check cannot see what it points at.`);
    continue;
  }
  if (!existsSync(resolve(PUBLIC, match[1]))) {
    problems.push(`${file} points at ${match[1]} (${what}), which does not ship.`);
  }
}

for (const { file, bases } of shippedPages()) {
  const html = readFileSync(resolve(ROOT, file), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  for (const ref of references(html)) {
    if (isExternal(ref)) continue;
    // Strip a query or fragment; neither is part of the filename on disk.
    const path = ref.split(/[?#]/)[0];
    if (path === '') continue;
    const relativeTo = path.startsWith('/') ? path.slice(1) : path;
    if (DEPLOYED_SEPARATELY.has(relativeTo)) {
      allowed.push(`${relativeTo} (${DEPLOYED_SEPARATELY.get(relativeTo)})`);
      continue;
    }
    const resolved = bases.some((base) => existsSync(resolve(base, relativeTo)));
    if (!resolved) {
      problems.push(`${file} references ${ref}, which does not exist.`);
    }
  }
}

if (problems.length > 0) {
  console.error('lint:html-assets FAILED\n');
  for (const p of problems) console.error(`  • ${p}`);
  console.error('\nA missing asset is silent: no error, no console message, just a');
  console.error('tester clicking a link that 404s. Ship the file or drop the reference.');
  process.exit(1);
}

const pages = shippedPages();
console.log(`lint:html-assets OK — every local reference across ${pages.length} page(s) resolves.`);
// Named rather than counted: an allowance nobody reads is an allowance nobody
// removes when the file finally lands in the repository.
for (const a of new Set(allowed)) console.log(`  allowed, deployed separately: ${a}`);
