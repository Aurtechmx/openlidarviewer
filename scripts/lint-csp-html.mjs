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

import { matchesOutsideComments } from './lib/htmlComments.mjs';

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

/** Directive name to its source list. */
function parsePolicy(policy) {
  const directives = new Map();
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) directives.set(name.toLowerCase(), sources);
  }
  return directives;
}

/**
 * Whether the policy permits inline content of a kind.
 *
 * A nonce or hash counts: both are legitimate ways to allow one specific inline
 * block, and treating them as failures would push people toward 'unsafe-inline'
 * instead, which is worse.
 */
function allowsInline(directives, directive) {
  const sources = directives.get(directive) ?? directives.get('default-src') ?? [];
  return sources.some(
    (s) => s === "'unsafe-inline'" || s.startsWith("'nonce-") || s.startsWith("'sha256-"),
  );
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
 * Commented-out markup is ignored by offset, never by deleting it. Deleting can
 * expose markup that was not previously there, which would let a page hide an
 * inline script from this count. See scripts/lib/htmlComments.mjs.
 */
function inlineScriptCount(html) {
  return matchesOutsideComments(html, /<script\b[^>]*>/gi).filter(
    (m) => !/\bsrc\s*=/i.test(m[0]),
  ).length;
}

function inlineHandlerCount(html) {
  // Attributes only: `\son...=` inside a tag. Prose containing "on" is not a match.
  return matchesOutsideComments(
    html,
    /<[^>]*?\son(?:click|load|error|change|input|submit|focus|blur)\s*=/gi,
  ).length;
}

function hasInlineStyle(html) {
  return matchesOutsideComments(html, /<style\b/gi).length > 0;
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
function readMirroredPolicy() {
  const file = resolve(ROOT, 'public/_headers');
  if (!existsSync(file)) return { present: false, policy: null };
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .find((l) => /^\s*Content-Security-Policy:/i.test(l));
  if (!line) return { present: true, policy: null };
  return { present: true, policy: line.replace(/^\s*Content-Security-Policy:\s*/i, '').trim() };
}

const policy = readPolicy();
if (!policy) {
  console.error('lint:csp-html FAILED\n');
  console.error('  • No enforcing Content-Security-Policy found in public/.htaccess.');
  console.error('\nThis check exists because the policy and the pages drift apart.');
  console.error('If the policy was removed on purpose, remove this check too and say why.');
  process.exit(1);
}

const directives = parsePolicy(policy);
const scriptInlineOk = allowsInline(directives, 'script-src');
const styleInlineOk = allowsInline(directives, 'style-src');

const problems = [];

const mirrored = readMirroredPolicy();
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

for (const file of shippedHtml()) {
  const html = readFileSync(resolve(ROOT, file), 'utf8');

  if (!scriptInlineOk) {
    const inline = inlineScriptCount(html);
    if (inline > 0) {
      problems.push(
        `${file}: ${inline} inline <script> block(s), which script-src refuses. ` +
          'Move the code to its own file and load it with src.',
      );
    }
    const handlers = inlineHandlerCount(html);
    if (handlers > 0) {
      problems.push(
        `${file}: ${handlers} inline event handler attribute(s), which script-src refuses. ` +
          'Attach the listener from the external script instead.',
      );
    }
  }

  if (!styleInlineOk && hasInlineStyle(html)) {
    problems.push(
      `${file}: inline <style>, which style-src refuses. Move it to a stylesheet.`,
    );
  }
}

if (problems.length > 0) {
  console.error('lint:csp-html FAILED\n');
  for (const p of problems) console.error(`  • ${p}`);
  console.error('\nThese pages load without complaint from disk and break once deployed.');
  console.error(`Enforced policy: ${policy}`);
  process.exit(1);
}

const checked = shippedHtml();
console.log(
  `lint:csp-html OK — ${checked.length} shipped page(s) match the enforced policy ` +
    `(script inline ${scriptInlineOk ? 'allowed' : 'refused'}, ` +
    `style inline ${styleInlineOk ? 'allowed' : 'refused'})` +
    `${mirrored.present ? ', and .htaccess matches _headers' : ''}.`,
);
