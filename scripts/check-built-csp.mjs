#!/usr/bin/env node
/**
 * check-built-csp.mjs: every inline <style> in the built index.html has its
 * sha256 in the CSP of index.html, public/_headers and public/.htaccess, and
 * every other inline <script> or <style> in any HTML file of the build is named
 * by the policies that ship with it.
 *
 * The hashes are taken from the source index.html. A build step that rewrites
 * the style text (a minifier, a whitespace change) changes the hash, and the
 * browser then drops the style with no error in the build. A static page such as
 * credits.html carries no policy of its own, so the same holds for it under the
 * policy the host sends.
 *
 *   node scripts/check-built-csp.mjs [distDir]   (default: dist)
 *
 * Run it after `npm run build:live`, and on the staged or extracted deploy
 * directory before it is zipped or served.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { inlineProblems } from './lib/cspInline.mjs';
import { isCliEntry } from './lib/isCliEntry.mjs';

/** The text of each inline <style> block, as the browser hashes it. */
export function inlineStyles(html) {
  return [...html.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
}

export function styleHash(text) {
  return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}

/** The style-src source list of every enforcing CSP line in `text`. */
export function styleSources(text) {
  return text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l) && /Content-Security-Policy/i.test(l) && !/Report-Only/i.test(l) && /default-src/.test(l))
    .map((l) => {
      const m = /style-src(?:-elem)?\s+([^;"]+)/.exec(l);
      return m ? m[1].trim().split(/\s+/) : [];
    });
}

/**
 * One line per problem: the built page has no inline style, or a different
 * count from the source page, or a policy line does not name a style's hash.
 */
export function cspStyleProblems(builtHtml, sourceHtml, policies) {
  const problems = [];
  const styles = inlineStyles(builtHtml);
  const expected = inlineStyles(sourceHtml).length;
  if (styles.length === 0) problems.push('the built index.html has no inline <style>');
  if (styles.length !== expected) problems.push(`the built index.html has ${styles.length} inline <style> block(s); the source has ${expected}`);
  for (const [name, text] of Object.entries(policies)) {
    const lists = styleSources(text);
    if (lists.length === 0) problems.push(`${name}: no Content-Security-Policy found`);
    lists.forEach((sources, i) => {
      for (const style of styles) {
        const hash = styleHash(style);
        if (!sources.includes(hash)) problems.push(`${name}: policy ${i + 1} style-src does not list ${hash}`);
      }
    });
  }
  return problems;
}

/** The value of every enforcing Content-Security-Policy in `text` (a header file or an HTML page). */
export function policyValues(text) {
  const values = [];
  for (const line of text.split('\n')) {
    if (/^\s*#/.test(line) || /Report-Only/i.test(line) || !/Content-Security-Policy/i.test(line)) continue;
    const header = /Content-Security-Policy:\s*(.+)$/i.exec(line);
    const htaccess = /Content-Security-Policy\s+"([^"]+)"/i.exec(line);
    const meta = /<meta[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*\scontent\s*=\s*"([^"]+)"/i.exec(line);
    const value = meta?.[1] ?? htaccess?.[1] ?? header?.[1];
    if (value && /default-src/.test(value)) values.push(value.trim());
  }
  return values;
}

/**
 * One line per inline <script> or <style> in `pages` (file name to HTML) that a
 * policy does not name. A page is held to the policies in `policies` (file name
 * to text), plus any its own <meta> sets.
 */
export function builtHtmlProblems(pages, policies) {
  const problems = [];
  for (const [file, html] of Object.entries(pages)) {
    const own = policyValues(html).map((v) => [`${file} (meta)`, v]);
    const shipped = Object.entries(policies).flatMap(([name, text]) =>
      policyValues(text).map((v, i) => [policyValues(text).length > 1 ? `${name} policy ${i + 1}` : name, v]),
    );
    for (const [name, value] of [...own, ...shipped]) {
      for (const p of inlineProblems(file, html, value)) problems.push(`${p} [${name}]`);
    }
  }
  return problems;
}

function* htmlFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* htmlFiles(p);
    else if (/\.html?$/i.test(name)) yield p;
  }
}

if (isCliEntry(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const dist = resolve(root, process.argv[2] ?? 'dist');
  const read = (p) => readFileSync(p, 'utf8');
  if (!existsSync(join(dist, 'index.html'))) {
    console.error(`[check-built-csp] No build found at ${dist}. Run "npm run build:live" first.`);
    process.exit(1);
  }
  const source = read(join(root, 'index.html'));
  const built = read(join(dist, 'index.html'));
  const problems = cspStyleProblems(built, source, {
    'index.html': source,
    'public/_headers': read(join(root, 'public/_headers')),
    'public/.htaccess': read(join(root, 'public/.htaccess')),
  });
  // Every HTML file of the build, under the policies the build itself ships (its
  // own _headers and .htaccess), falling back to the repository's when the
  // directory holds none.
  const policyFile = (name) => {
    const shipped = join(dist, name);
    return existsSync(shipped) ? read(shipped) : read(join(root, 'public', name));
  };
  const pages = {};
  for (const file of htmlFiles(dist)) pages[relative(dist, file)] = read(file);
  problems.push(
    ...builtHtmlProblems(pages, { _headers: policyFile('_headers'), '.htaccess': policyFile('.htaccess') }),
  );
  if (problems.length) {
    for (const p of problems) console.error(`[check-built-csp] ${p}`);
    process.exit(1);
  }
  console.log(
    `[check-built-csp] OK: ${inlineStyles(built).length} inline style block(s) match the CSP in 3 files; ` +
      `${Object.keys(pages).length} HTML file(s) in the build checked against the shipped policies`,
  );
}
