#!/usr/bin/env node
/**
 * lint-claims-language.mjs — bans marketing superlatives from public documents
 * AND from the shipped source (UI labels, report text, HTML shell).
 *
 * The claims policy (docs/project/CLAIMS_AND_LIMITATIONS.md) reserves subtle vocabulary
 * discipline — "validated" vs "accurate", "agreement" vs "correctness" — for
 * review, because those words have honest uses a regex cannot judge. This
 * lint enforces only the phrases with NO honest use in any document this
 * project publishes: comparative marketing claims. If one appears, either it
 * is a mistake, or the sentence should not exist.
 *
 * A superlative reaches the user through two surfaces: the docs the project
 * publishes AND the strings the app renders. The docs are scanned below; the
 * runtime surface (src/ + index.html) is scanned with the SAME ban list so an
 * overclaim compiled into a button label, a report heading, or a PDF caption
 * cannot ship unreviewed just because it never appeared in a .md file.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** No honest use, anywhere, ever. Case-insensitive. */
const BANNED = [
  /\bindustry[- ]leading\b/i,
  /\bbest[- ]in[- ]class\b/i,
  /\bworld[- ]class\b/i,
  /\bmost accurate\b/i,
  /\bstate[- ]of[- ]the[- ]art\b/i,
  /\bprofessional[- ]grade\b/i,
  /\bmilitary[- ]grade\b/i,
  /\bthe (strongest|fastest|best) .{0,40}(implementation|viewer|tool)/i,
];

// "survey-grade accuracy" is deliberately NOT in the ban list: its honest
// uses — disclaimers and advice ("validate against ground control where
// survey-grade accuracy is required") — wrap across lines in ways a regex
// cannot judge. That phrase is a review concern; this lint holds only to
// phrases with no honest use at all.

/** Public prose: root markdown + docs/, excluding internal audit notes. */
function publicDocs() {
  const out = [];
  for (const f of readdirSync(ROOT)) {
    if (f.endsWith('.md')) out.push(join(ROOT, f));
  }
  const docs = join(ROOT, 'docs');
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === '_audit') continue; // internal working notes
        walk(full);
      } else if (entry.endsWith('.md')) out.push(full);
    }
  };
  if (existsSync(docs)) walk(docs);
  return out;
}

/** Shipped runtime surface: the source tree + the HTML shell. */
function sourceFiles() {
  const out = [];
  const src = join(ROOT, 'src');
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx|html)$/.test(entry)) {
        out.push(full);
      }
    }
  };
  if (existsSync(src)) walk(src);
  const shell = join(ROOT, 'index.html');
  if (existsSync(shell)) out.push(shell);
  return out;
}

const problems = [];
const scan = (file, hint, skipComments) => {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    // Source comments are stripped from the shipped bundle, so the runtime
    // guard judges only code (where the user-facing strings live). Prose files
    // pass skipComments=false and are scanned whole.
    if (skipComments) {
      const t = line.trim();
      if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return;
    }
    for (const re of BANNED) {
      const m = line.match(re);
      if (m) {
        problems.push(`  • ${relative(ROOT, file)}:${i + 1}: "${m[0]}" — ${hint}`);
      }
    }
  });
};

for (const file of publicDocs()) {
  // The policy file DEFINES the banned vocabulary; it must be able to name it.
  if (file.endsWith('docs/project/CLAIMS_AND_LIMITATIONS.md')) continue;
  scan(file, 'marketing superlatives have no honest use; state what was validated instead.', false);
}
for (const file of sourceFiles()) {
  scan(file, 'a shipped UI/report string; superlatives have no honest use — say what was measured.', true);
}

if (problems.length > 0) {
  console.error('lint:claims-language FAILED\n');
  console.error(problems.join('\n'));
  console.error('\nSee docs/project/CLAIMS_AND_LIMITATIONS.md for the vocabulary policy.');
  process.exit(1);
}
console.log('lint:claims-language OK — no marketing superlatives in public documents or shipped UI/report strings.');
