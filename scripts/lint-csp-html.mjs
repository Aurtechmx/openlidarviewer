#!/usr/bin/env node
/**
 * lint-csp-html.mjs — shipped pages must survive the policy that ships with them.
 *
 * The site sends an enforcing Content-Security-Policy from .htaccess. The
 * external testing form kept all of its behaviour in an inline <script>, which
 * script-src 'self' refuses outright, so every button on the published page did
 * nothing. It reached production and stayed there.
 *
 * Nothing caught it, and the reason is worth stating: the failure is invisible
 * wherever the page gets tested. Opened from disk there is no policy to
 * violate, so the form works perfectly right up until it is deployed. The
 * policy and the page also live in different files, and only one of them was
 * being changed.
 *
 * So this reads the actual policy rather than a copy of it. Relaxing the CSP
 * relaxes this check automatically, and tightening it fails the build instead
 * of the browser — which is the whole point, because a browser failing this is
 * silent.
 *
 * Scope is the HTML the site serves. Vite's own entry is included: it is
 * transformed on build, not exempt from the header.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { inlineProblems } from './lib/cspInline.mjs';
import { isCliEntry } from './lib/isCliEntry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HTACCESS = resolve(ROOT, 'public/.htaccess');

/** Pull the enforced policy out of the deployed .htaccess. */
function readPolicy() {
  const text = readFileSync(HTACCESS, 'utf8');
  // Only the enforcing header. A Report-Only header, if one is ever added,
  // breaks nothing and must not be read as a constraint.
  const line = text
    .split('\n')
    .find((l) => /Header\s+always\s+set\s+Content-Security-Policy\s+"/i.test(l));
  if (!line) return null;
  const value = /Content-Security-Policy\s+"([^"]+)"/i.exec(line);
  return value ? value[1] : null;
}

/** Every HTML file the site serves. */
function shippedHtml() {
  const files = [];
  if (existsSync(resolve(ROOT, 'index.html'))) files.push('index.html');
  const pub = resolve(ROOT, 'public');
  if (existsSync(pub)) {
    for (const name of readdirSync(pub)) {
      if (name.endsWith('.html')) files.push(`public/${name}`);
    }
  }
  return files;
}

/**
 * The policy is written twice, once per host: .htaccess for Apache, _headers
 * for Netlify-style hosts. A comment in _headers says it matches .htaccess,
 * which was true when written and is exactly the kind of claim that quietly
 * stops being true.
 *
 * Drift here is worse than an ordinary duplicate, because whichever copy is
 * wrong only misbehaves on the host that reads it. The check below would keep
 * passing against .htaccess while the deployed pages broke somewhere else.
 */
export function readMirroredPolicy() {
  const file = resolve(ROOT, 'public/_headers');
  if (!existsSync(file)) return { present: false, policy: null };
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .find((l) => /^\s*Content-Security-Policy:/i.test(l));
  if (!line) return { present: true, policy: null };
  return { present: true, policy: line.replace(/^\s*Content-Security-Policy:\s*/i, '').trim() };
}

/**
 * Every problem with the shipped pages and the two copies of the policy, as one
 * line each. Pure: `pages` maps a file name to its HTML.
 */
export function lintPages(policy, mirrored, pages) {
  const problems = [];
  if (mirrored.present && mirrored.policy === null) {
    problems.push('public/_headers exists but sets no Content-Security-Policy.');
  } else if (mirrored.present && mirrored.policy !== policy) {
    problems.push(
      'public/.htaccess and public/_headers send different policies. Whichever is ' +
        'wrong only misbehaves on the host that reads it.\n' +
        `      .htaccess: ${policy}\n` +
        `      _headers:  ${mirrored.policy}`,
    );
  }
  for (const [file, html] of Object.entries(pages)) problems.push(...inlineProblems(file, html, policy));
  return problems;
}

if (isCliEntry(import.meta.url)) {
  const policy = readPolicy();
  if (!policy) {
    console.error('lint:csp-html FAILED\n');
    console.error('  • No enforcing Content-Security-Policy found in public/.htaccess.');
    console.error('\nThis check exists because the policy and the pages drift apart.');
    console.error('If the policy was removed on purpose, remove this check too and say why.');
    process.exit(1);
  }

  const checked = shippedHtml();
  const mirrored = readMirroredPolicy();
  const problems = lintPages(
    policy,
    mirrored,
    Object.fromEntries(checked.map((file) => [file, readFileSync(resolve(ROOT, file), 'utf8')])),
  );

  if (problems.length > 0) {
    console.error('lint:csp-html FAILED\n');
    for (const p of problems) console.error(`  • ${p}`);
    console.error('\nThese pages load without complaint from disk and break once deployed.');
    console.error(`Enforced policy: ${policy}`);
    process.exit(1);
  }

  console.log(
    `lint:csp-html OK — ${checked.length} shipped page(s): every inline <script> and <style> ` +
      `is named by the enforced policy by hash${mirrored.present ? ', and .htaccess matches _headers' : ''}.`,
  );
}
