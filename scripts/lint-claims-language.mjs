#!/usr/bin/env node
/**
 * lint-claims-language.mjs — bans marketing superlatives from public documents.
 *
 * The claims policy (CLAIMS_AND_LIMITATIONS.md) reserves subtle vocabulary
 * discipline — "validated" vs "accurate", "agreement" vs "correctness" — for
 * review, because those words have honest uses a regex cannot judge. This
 * lint enforces only the phrases with NO honest use in any document this
 * project publishes: comparative marketing claims. If one appears, either it
 * is a mistake, or the sentence should not exist.
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

const problems = [];
for (const file of publicDocs()) {
  // The policy file DEFINES the banned vocabulary; it must be able to name it.
  if (file.endsWith('CLAIMS_AND_LIMITATIONS.md')) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const re of BANNED) {
      const m = line.match(re);
      if (m) {
        problems.push(
          `  • ${relative(ROOT, file)}:${i + 1}: "${m[0]}" — marketing superlatives have no honest use; state what was validated instead.`,
        );
      }
    }
  });
}

if (problems.length > 0) {
  console.error('lint:claims-language FAILED\n');
  console.error(problems.join('\n'));
  console.error('\nSee CLAIMS_AND_LIMITATIONS.md for the vocabulary policy.');
  process.exit(1);
}
console.log('lint:claims-language OK — no marketing superlatives in public documents.');
