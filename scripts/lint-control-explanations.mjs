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
 * scans src/ui for four ways a control has shipped with no real hover/focus
 * explanation, three of which slipped past an earlier, narrower version of
 * this same guard (a 2026-09 browser check on feat/control-tooltips-v070
 * found all three live):
 *
 *   1. `el('button', { ... })` with none of `tip` / `title` / `ariaLabel`,
 *      inline or deferred onto the same target a few lines below (the
 *      original check).
 *   2. A "panel head builder": any other tag (`el('div', ...)`, etc.) later
 *      given `.setAttribute('role', 'button')` — a click/keydown-driven
 *      toggle wearing a non-`<button>` tag — with no tip/title/ariaLabel.
 *      Caught the Scan Intelligence panel head (Inspector.ts).
 *   3. A "link-styled button": `el('button', ...)` whose className contains
 *      `-link`, relying on `ariaLabel` alone. `ariaLabel` gives assistive
 *      tech a name but shows nothing to a hovering sighted user, and a
 *      link-styled control reads as plain inline text until clicked — it
 *      needs a real `tip`/`title`, not just a background aria-label. Caught
 *      the "Open Dataset Story" link (DatasetIntelligenceCard.ts).
 *   4. An icon/glyph-only button: `el('button', ...)` with no `text` (or a
 *      short non-alphanumeric glyph like `×`/`✕`) and only `ariaLabel`. Same
 *      reasoning as #3 — a glyph alone tells a hovering mouse user nothing.
 *      Caught the project card "Dismiss" `×` (ProjectCard.ts).
 *
 * A direct `document.createElement('button')` (bypassing `el()` entirely,
 * as a couple of the field-simulation lab controls once did) is scanned the
 * same way as #1: it needs a deferred `target.title =` / `target.dataset.tip
 * =` / `target.setAttribute('aria-label' | 'title', ...)` nearby.
 *
 * `ariaLabel` remains an accepted explanation on its own for an ordinary
 * `el('button', ...)` that already carries real visible text (e.g. `{ text:
 * 'Close', ariaLabel: 'Close the workbench' }`) — the visible word already
 * tells a hovering mouse user what the control does, so a native glass tip
 * would only repeat it. Checks #2-#4 exist because that assumption breaks
 * down for a role-mimicking non-button, a link-styled button, or a
 * glyph/icon with nothing readable in it.
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

/** `el(<tag>, { ... })`, optionally preceded by an assignment target this
 * scan re-uses to look for a follow-up explanation a few lines below. */
const EL_CALL = /(?:([\w.]+)\s*=\s*)?\bel\(\s*'([a-zA-Z][\w-]*)'\s*,/g;
/** Bare `document.createElement('button')`, same deferred-target idea. */
const CREATE_BUTTON = /(?:([\w.]+)\s*=\s*)?\bdocument\.createElement\(\s*'button'\s*\)/g;
// Matches both `tip: '...'` and the object-literal shorthand `title` (i.e.
// `{ title }`, equivalent to `{ title: title }`) that several call sites use.
const HAS_TIP_OR_TITLE = /\b(tip|title)\b/;
const HAS_ARIA = /\bariaLabel\b/;
const FOLLOWUP_WINDOW = 700; // chars scanned after the call for a deferred explanation

/** A literal `text: '...'`/`"..."`/`` `...` `` value, or null if `text` is
 * absent or set from a dynamic expression this scan can't evaluate. */
function literalTextValue(props) {
  const m = props.match(/\btext:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`([^`]*)`)/);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? '';
}

/** True once `text` is absent (icon-only) or a short glyph with no letters
 * (`×`, `✕`, `+`, `…`) — neither tells a hovering mouse user anything. A
 * dynamic `text` (a variable/expression this scan can't read) is treated as
 * real text: better a false negative than flagging every runtime label. */
function isGlyphOrIconOnly(props) {
  if (!/\btext\s*:/.test(props)) return !/\bunsafeHtml\s*:/.test(props) ? true : false;
  const value = literalTextValue(props);
  if (value === null) return false; // dynamic text — assume it's real
  return value.length <= 2 && !/[A-Za-z]/.test(value);
}

/** True when `className` contains a `-link` segment — a button deliberately
 * styled to read as inline text rather than button chrome. */
function isLinkStyled(props) {
  const m = props.match(/\bclassName:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`([^`]*)`)/);
  const value = m ? (m[1] ?? m[2] ?? m[3] ?? '') : '';
  return /-link\b/.test(value);
}

function hasDeferredExplanation(text, target, fromIdx) {
  if (!target) return false;
  const after = text.slice(fromIdx, fromIdx + FOLLOWUP_WINDOW);
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const followup = new RegExp(
    `${escaped}\\.title\\s*=|${escaped}\\.dataset\\.tip\\s*=|` +
      `${escaped}\\.setAttribute\\(\\s*['"](aria-label|title)['"]`,
  );
  return followup.test(after);
}

function hasDeferredRoleButton(text, target, fromIdx) {
  if (!target) return false;
  const after = text.slice(fromIdx, fromIdx + FOLLOWUP_WINDOW);
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}\\.setAttribute\\(\\s*['"]role['"]\\s*,\\s*['"]button['"]`).test(after);
}

/**
 * Scan one file's source for controls with no real hover/focus explanation:
 * `el('button', {...})` (and a bare `document.createElement('button')`)
 * lacking tip/title/ariaLabel inline or deferred; a role="button" control on
 * a non-button tag lacking any of the three; a link-styled or icon/glyph-only
 * button relying on `ariaLabel` alone. Returns offending line numbers.
 * Exported for unit tests.
 */
export function findUnexplainedButtons(text) {
  const offenders = [];

  EL_CALL.lastIndex = 0;
  let match;
  while ((match = EL_CALL.exec(text))) {
    const [, target, tag] = match;
    const braceIdx = text.indexOf('{', match.index);
    if (braceIdx === -1) continue;
    const props = extractBalanced(text, braceIdx);
    if (props === null) continue;

    if (tag === 'button') {
      const explained =
        HAS_TIP_OR_TITLE.test(props) ||
        (HAS_ARIA.test(props) && !isGlyphOrIconOnly(props) && !isLinkStyled(props)) ||
        hasDeferredExplanation(text, target, braceIdx);
      if (!explained) offenders.push(text.slice(0, match.index).split('\n').length);
      continue;
    }

    // Any other tag: only in scope once it is dressed up as a button.
    if (HAS_TIP_OR_TITLE.test(props) || HAS_ARIA.test(props)) continue;
    if (!hasDeferredRoleButton(text, target, braceIdx)) continue;
    if (hasDeferredExplanation(text, target, braceIdx)) continue;
    offenders.push(text.slice(0, match.index).split('\n').length);
  }

  CREATE_BUTTON.lastIndex = 0;
  while ((match = CREATE_BUTTON.exec(text))) {
    const target = match[1];
    if (hasDeferredExplanation(text, target, match.index)) continue;
    offenders.push(text.slice(0, match.index).split('\n').length);
  }

  return offenders.sort((a, b) => a - b);
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
    console.error('lint:control-explanations: controls with no hover/focus explanation (tip/title, or ariaLabel with real visible text):');
    for (const r of regressions) {
      console.error(`  ${r.file}: ${r.found} offender(s) (baseline allows ${r.allowed}) at line(s) ${r.lines.join(', ')}`);
    }
    console.error('Add a `tip` (preferred, wires the shared tooltip + aria-describedby), `title`, or (for a text-labelled button) `ariaLabel`.');
    process.exit(1);
  }

  console.log(`lint:control-explanations: OK (${totalOffenders} offender(s) within baseline; target is zero).`);
}

if (isCliEntry(import.meta.url)) main();
