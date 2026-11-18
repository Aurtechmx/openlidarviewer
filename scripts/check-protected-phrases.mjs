#!/usr/bin/env node
/**
 * check-protected-phrases.mjs
 *
 * Fails when a statement the app must keep saying is no longer in the source.
 * scripts/protected-phrases.json lists each statement with the surfaces it
 * must reach. Three rules, applied to `src/**\/*.ts` with comments removed:
 *   - ui: the phrase occurs somewhere in src/.
 *   - export: the phrase also occurs outside src/ui/ (or in the export panel).
 *   - use: an entry that names a `constant` has that identifier referenced at
 *     least once outside its own definition. Without this rule, deleting the
 *     only display site would leave the string in place and the check green.
 *     An entry marked `knownUnused` is exempt: its constant had no reference
 *     when the entry was added.
 *
 * The rules are a pure function of `read(path)` and `list(dir)` so
 * tests/protectedPhrases.test.ts can prove each one fails without touching the
 * real tree. `read` returns the file text or null; `list` returns the .ts files
 * under a directory.
 *
 * Usage: `node scripts/check-protected-phrases.mjs` (also
 * `npm run check:protected-phrases`).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { isCliEntry } from './lib/isCliEntry.mjs';

// Export text is written by code under src/export/, src/report/ and
// src/render/measure/, but much of it is defined in the science, terrain and
// validation modules those call. So "reaches an export" means "lives outside
// the UI layer", with the export panel's own wording as the one UI exception.
const UI_DIR = 'src/ui/';
const EXPORT_PANEL = 'src/ui/ExportPanel.ts';

/**
 * Blank out line and block comments, keeping string and template literals and
 * every newline, so a phrase or identifier that only appears in a comment is
 * not counted.
 */
export function stripComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
    } else if (c === "'" || c === '"' || c === '`') {
      const q = c;
      out += c;
      i++;
      while (i < n && text[i] !== q) {
        if (text[i] === '\\' && i + 1 < n) {
          out += text[i] + text[i + 1];
          i += 2;
          continue;
        }
        if (text[i] === '\n' && q !== '`') break;
        out += text[i];
        i++;
      }
      if (i < n && text[i] === q) {
        out += q;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}


/**
 * Reduce comment-free source to the text that can actually use an identifier:
 * import statements and export lists are removed, and the text of string and
 * template literals is blanked. A `${...}` interpolation is code and stays.
 */
export function codeOnly(text) {
  const t = text
    .replace(/\bimport\s+[^;'"`]*?\bfrom\s*(['"])[^'"\n]*\1/g, ' ')
    .replace(/\bexport\s*(?:type\s*)?(?:\{[^}]*\}|\*(?:\s*as\s+[\w$]+)?)\s*from\s*(['"])[^'"\n]*\1/g, ' ')
    .replace(/\bexport\s*(?:type\s*)?\{[^}]*\}/g, ' ');
  let out = '';
  let i = 0;
  const n = t.length;
  // Each entry is the brace depth of an open `${` inside a template literal.
  const stack = [];
  let depth = 0;
  const skipString = (q) => {
    out += q;
    i++;
    while (i < n && t[i] !== q) {
      if (t[i] === '\\') i++;
      else if (t[i] === '\n' && q !== '`') break;
      if (t[i] === '\n') out += '\n';
      i++;
    }
    if (i < n && t[i] === q) {
      out += q;
      i++;
    }
  };
  const skipTemplate = () => {
    out += '`';
    i++;
    while (i < n && t[i] !== '`') {
      if (t[i] === '\\') i += 2;
      else if (t[i] === '$' && t[i + 1] === '{') {
        out += '${';
        i += 2;
        stack.push(depth);
        depth = 0;
        return false;
      } else {
        if (t[i] === '\n') out += '\n';
        i++;
      }
    }
    if (i < n) {
      out += '`';
      i++;
    }
    return true;
  };
  while (i < n) {
    const c = t[i];
    if (c === "'" || c === '"') skipString(c);
    else if (c === '`') skipTemplate();
    else if (c === '{') {
      depth++;
      out += c;
      i++;
    } else if (c === '}') {
      if (stack.length > 0 && depth === 0) {
        depth = stack.pop();
        out += '}';
        i++;
        // Back in the template text that follows the interpolation.
        while (skipTemplateTail());
      } else {
        depth--;
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;

  /** Continue a template literal after a closing `}`; true if another `${` opened. */
  function skipTemplateTail() {
    while (i < n && t[i] !== '`') {
      if (t[i] === '\\') i += 2;
      else if (t[i] === '$' && t[i + 1] === '{') {
        out += '${';
        i += 2;
        stack.push(depth);
        depth = 0;
        return false;
      } else {
        if (t[i] === '\n') out += '\n';
        i++;
      }
    }
    if (i < n) {
      out += '`';
      i++;
    }
    return false;
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Check every entry. Returns `{ missing }`: one `{ id, surface }` per rule an
 * entry fails, with surface 'ui', 'export' or 'use'.
 */
export function checkProtectedPhrases(phrases, read, list) {
  const files = list('src').filter((p) => p.endsWith('.ts'));
  const texts = new Map();
  for (const p of files) {
    const raw = read(p);
    if (raw != null) texts.set(p, stripComments(raw));
  }
  // Built on first use: only entries with a constant need it.
  let codes = null;
  const inExportCode = (p) => !p.startsWith(UI_DIR) || p === EXPORT_PANEL;

  const missing = [];
  for (const e of phrases) {
    const hasIn = (filter) => {
      for (const [p, t] of texts) if (filter(p) && t.includes(e.phrase)) return true;
      return false;
    };
    if (e.surfaces.includes('ui') && !hasIn(() => true)) missing.push({ id: e.id, surface: 'ui' });
    if (e.surfaces.includes('export') && !hasIn(inExportCode)) missing.push({ id: e.id, surface: 'export' });
    if (e.constant && !e.knownUnused) {
      const name = escapeRe(e.constant);
      const ident = new RegExp(`(?<![\\w$])${name}(?![\\w$])`, 'g');
      const definition = new RegExp(`\\bconst\\s+${name}(?![\\w$])`, 'g');
      if (codes == null) codes = new Map([...texts].map(([p, t]) => [p, codeOnly(t)]));
      let refs = 0;
      for (const t of codes.values()) {
        refs += (t.match(ident) || []).length - (t.match(definition) || []).length;
      }
      if (refs < 1) missing.push({ id: e.id, surface: 'use' });
    }
  }
  return { missing };
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function listTs(dir) {
  const out = [];
  const walk = (rel) => {
    for (const name of readdirSync(resolve(ROOT, rel))) {
      const p = join(rel, name);
      if (statSync(resolve(ROOT, p)).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) out.push(p.split('\\').join('/'));
    }
  };
  walk(dir);
  return out;
}

function main() {
  const phrases = JSON.parse(readFileSync(resolve(ROOT, 'scripts/protected-phrases.json'), 'utf8'));
  const { missing } = checkProtectedPhrases(phrases, (p) => readFileSync(resolve(ROOT, p), 'utf8'), listTs);
  if (missing.length > 0) {
    console.error('check:protected-phrases FAILED. A protected statement is no longer in the app:');
    for (const m of missing) console.error(`  ${m.id} (${m.surface})`);
    process.exit(1);
  }
  console.log(`check:protected-phrases OK — ${phrases.length} phrases`);
}

if (isCliEntry(import.meta.url)) main();
