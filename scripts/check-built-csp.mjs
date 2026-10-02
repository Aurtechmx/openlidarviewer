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
import { readFileSync } from 'node:fs';
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

/** The style-src source list of the enforcing CSP in `text`, or null when there is none. */
export function styleSources(text) {
  const line = text
    .split('\n')
    .find((l) => !/^\s*#/.test(l) && /Content-Security-Policy/i.test(l) && !/Report-Only/i.test(l) && /default-src/.test(l));
  if (!line) return null;
  const m = /style-src(?:-elem)?\s+([^;"]+)/.exec(line);
  return m ? m[1].trim().split(/\s+/) : [];
}

/** One line per style block whose hash a policy does not name. */
export function cspStyleProblems(builtHtml, policies) {
  const problems = [];
  const styles = inlineStyles(builtHtml);
  for (const [name, text] of Object.entries(policies)) {
    const sources = styleSources(text);
    if (sources === null) {
      problems.push(`${name}: no Content-Security-Policy found`);
      continue;
    }
    for (const style of styles) {
      const hash = styleHash(style);
      if (!sources.includes(hash)) problems.push(`${name}: style-src does not list ${hash}`);
    }
  }
  return problems;
}

if (isCliEntry(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const dist = resolve(root, process.argv[2] ?? 'dist');
  const read = (p) => readFileSync(p, 'utf8');
  const built = read(join(dist, 'index.html'));
  const problems = cspStyleProblems(built, {
    'index.html': read(join(root, 'index.html')),
    'public/_headers': read(join(root, 'public/_headers')),
    'public/.htaccess': read(join(root, 'public/.htaccess')),
  });
  if (inlineStyles(built).length === 0) console.log('[check-built-csp] no inline <style> in the built index.html');
  if (problems.length) {
    for (const p of problems) console.error(`[check-built-csp] ${p}`);
    process.exit(1);
  }
  console.log(`[check-built-csp] OK: ${inlineStyles(built).length} inline style block(s) match the CSP in 3 files`);
}
