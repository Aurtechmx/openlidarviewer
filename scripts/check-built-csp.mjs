#!/usr/bin/env node
/**
 * check-built-csp.mjs: every inline <style> in the built index.html has its
 * sha256 in the CSP of index.html, public/_headers and public/.htaccess.
 *
 * The hashes are taken from the source index.html. A build step that rewrites
 * the style text (a minifier, a whitespace change) changes the hash, and the
 * browser then drops the style with no error in the build.
 *
 *   node scripts/check-built-csp.mjs [distDir]   (default: dist)
 *
 * Run it after `npm run build:live`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  if (problems.length) {
    for (const p of problems) console.error(`[check-built-csp] ${p}`);
    process.exit(1);
  }
  console.log(`[check-built-csp] OK: ${inlineStyles(built).length} inline style block(s) match the CSP in 3 files`);
}
