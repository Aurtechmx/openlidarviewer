#!/usr/bin/env node
/**
 * lint-control-explanations.mjs: every interactive control explains itself.
 *
 * The maintainer requirement is simple: hovering or keyboard-focusing any
 * button, toggle, pill, chip, or icon control should show what it does.
 *
 * The app's `el()` helper (src/ui/dom.ts) already wires a `tip` (or native
 * `title`, or `ariaLabel`) into the shared `[data-tip]` glass tooltip plus an
 * `aria-describedby` text node; see that file for the mechanism. This guard
 * scans every `el('button', { ... })` construction under src/ui for one of
 * those three props, and a bare `el('button', { className, onClick... })`
 * with no explanation text anywhere counts as an offender.
 *
 * The ratchet is shrink-only, matching lint-monolith-size.mjs. The baseline
 * records today's offender count per file, and a file may drop below its
 * baseline (bank the improvement with --update) or stay level, but it must
 * never rise.
 *
 * Zero everywhere is the long-run target.
 */

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from './lib/isCliEntry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UI_DIR = resolve(ROOT, 'src/ui');
const BASELINE = resolve(ROOT, 'docs/validation/control-explanations-baseline.json');

function collectFiles(dir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const entry of readdirSync(abs)) {
      const childAbs = join(abs, entry);
      const childRel = rel ? `${rel}/${entry}` : entry;
      if (statSync(childAbs).isDirectory()) walk(childAbs, childRel);
      else if (/\.ts$/.test(entry) && !entry.endsWith('.test.ts')) out.push(childRel);
    }
  };
  walk(dir, '');
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Find the substring of `text` from `openIdx` (index of an opening brace)
 * to its matching close, inclusive. Returns null if unbalanced. */
function extractBalanced(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(openIdx, i + 1);
    }
  }
  return null;
}

// `el('button', ...)`, optionally preceded by an assignment target this scan
// re-uses to look for a follow-up `target.title = ...` / `target.setAttribute
// ('aria-label', ...)` a few lines below: a common pattern where the title
// is set on the returned element rather than passed as a prop.
const EL_CALL = /(?:([\w.]+)\s*=\s*)?\bel\(\s*'button'\s*,/g;
// Matches both `tip: '...'` and the object-literal shorthand `title` (i.e.
// `{ title }`, equivalent to `{ title: title }`) that several call sites use.
const EXPLAINS = /\b(tip|title|ariaLabel)\b/;
const FOLLOWUP_WINDOW = 700; // chars scanned after the call for a deferred title/aria-label

/**
 * Scan one file's source for `el('button', {...})` calls lacking an
 * explanation prop AND lacking a deferred `target.title =` /
 * `target.setAttribute('aria-label', ...)` shortly after. Returns offending
 * line numbers. Exported for unit tests.
 */
export function findUnexplainedButtons(text) {
  const offenders = [];
  let match;
  EL_CALL.lastIndex = 0;
  while ((match = EL_CALL.exec(text))) {
    const braceIdx = text.indexOf('{', match.index);
    if (braceIdx === -1) continue;
    const props = extractBalanced(text, braceIdx);
    if (props === null) continue;
    if (EXPLAINS.test(props)) continue;

    const target = match[1];
    let explainedLater = false;
    if (target) {
      const after = text.slice(braceIdx, braceIdx + FOLLOWUP_WINDOW);
      const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const followup = new RegExp(
        `${escaped}\\.title\\s*=|${escaped}\\.setAttribute\\(\\s*['"](aria-label|title)['"]`,
      );
      explainedLater = followup.test(after);
    }
    if (!explainedLater) {
      const line = text.slice(0, match.index).split('\n').length;
      offenders.push(line);
    }
  }
  return offenders;
}

function loadBaseline() {
  if (!existsSync(BASELINE)) return {};
  return JSON.parse(readFileSync(BASELINE, 'utf8'));
}

function main() {
  const update = process.argv.includes('--update');
  const files = collectFiles(UI_DIR);
  const baseline = loadBaseline();
  const current = {};
  let totalOffenders = 0;
  let regressions = [];

  for (const rel of files) {
    const text = readFileSync(join(UI_DIR, rel), 'utf8');
    const offenders = findUnexplainedButtons(text);
    if (offenders.length === 0) continue;
    current[rel] = offenders.length;
    totalOffenders += offenders.length;
    const allowed = baseline[rel] ?? 0;
    if (offenders.length > allowed) {
      regressions.push({ file: rel, lines: offenders, allowed, found: offenders.length });
    }
  }

  if (update) {
    // Refuse a bank that hides a regression: --update only lowers or holds.
    for (const rel of Object.keys(current)) {
      if (!(rel in baseline)) continue; // first-time seeding, not a regression
      const allowed = baseline[rel];
      if (current[rel] > allowed) {
        console.error(
          `lint:control-explanations: refusing --update: ${rel} rose from ${allowed} to ${current[rel]}.`,
        );
        process.exit(1);
      }
    }
    writeFileSync(BASELINE, JSON.stringify(current, null, 2) + '\n');
    console.log(`lint:control-explanations: baseline updated (${totalOffenders} offenders across ${Object.keys(current).length} files).`);
    return;
  }

  if (regressions.length > 0) {
    console.error('lint:control-explanations: buttons with no hover/focus explanation (tip/title/ariaLabel):');
    for (const r of regressions) {
      console.error(`  ${r.file}: ${r.found} offender(s) (baseline allows ${r.allowed}) at line(s) ${r.lines.join(', ')}`);
    }
    console.error('Add a `tip` (preferred, wires the shared tooltip + aria-describedby), `title`, or `ariaLabel`.');
    process.exit(1);
  }

  console.log(`lint:control-explanations: OK (${totalOffenders} offender(s) within baseline; target is zero).`);
}

if (isCliEntry(import.meta.url)) main();
