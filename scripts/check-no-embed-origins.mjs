#!/usr/bin/env node
/**
 * check-no-embed-origins.mjs: the build carries no embed allow-list unless the
 * packager said it should.
 *
 * `OLV_EMBED_ORIGINS` is read at build time and compiled into the bundle
 * (`__OLV_EMBED_ORIGINS__`). Exported in a packaging shell and forgotten, it
 * makes every release archive trust those origins to frame the viewer and
 * drive its bridge, with nothing in the output to say so. A build with a
 * non-empty list records it in a `<meta name="olv-embed-origins">` in each
 * page; this check fails when it finds one, unless `OLV_ALLOW_EMBED_ORIGINS=1`
 * says the list is intended.
 *
 *   node scripts/check-no-embed-origins.mjs [distDir]   (default: dist)
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from './lib/isCliEntry.mjs';
import { findEmbedOriginsStamp } from './lib/viteDefines.mjs';

function* htmlFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* htmlFiles(p);
    else if (/\.html?$/i.test(name)) yield p;
  }
}

/**
 * The embed origins the pages of `dir` carry, keyed by page. Empty for a build
 * with no allow-list.
 *
 * @param {string} dir
 * @returns {Record<string, string[]>}
 */
export function embedOriginsIn(dir) {
  const found = {};
  for (const file of htmlFiles(dir)) {
    const origins = findEmbedOriginsStamp(readFileSync(file, 'utf8'));
    if (origins !== null) found[relative(dir, file).split(sep).join('/')] = origins;
  }
  return found;
}

/**
 * The problems with `dir` under `env`: one line per page that carries a list
 * when `OLV_ALLOW_EMBED_ORIGINS` is not `1`.
 *
 * @param {string} dir
 * @param {Record<string, string | undefined>} [env]
 * @returns {string[]}
 */
export function embedOriginsProblems(dir, env = process.env) {
  if (env.OLV_ALLOW_EMBED_ORIGINS === '1') return [];
  return Object.entries(embedOriginsIn(dir)).map(([page, origins]) =>
    `${page}: the build trusts ${origins.length === 0 ? 'an empty list of' : origins.join(', ')} to frame the viewer ` +
    '(OLV_EMBED_ORIGINS was set when it was built). Unset it, or set OLV_ALLOW_EMBED_ORIGINS=1 if that list is intended.');
}

if (isCliEntry(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const dist = resolve(root, process.argv[2] ?? 'dist');
  if (!existsSync(join(dist, 'index.html'))) {
    console.error(`[check-no-embed-origins] No build found at ${dist}. Run "npm run build:live" first.`);
    process.exit(1);
  }
  const problems = embedOriginsProblems(dist);
  if (problems.length > 0) {
    console.error('[check-no-embed-origins] FAILED:');
    for (const p of problems) console.error(`  • ${p}`);
    process.exit(1);
  }
  const ack = Object.keys(embedOriginsIn(dist)).length > 0 ? ' (an embed allow-list is present and was acknowledged)' : '';
  console.log(`[check-no-embed-origins] OK: ${relative(root, dist) || dist}${ack}.`);
}
