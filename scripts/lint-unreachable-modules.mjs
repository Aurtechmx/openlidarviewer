#!/usr/bin/env node
/**
 * lint-unreachable-modules.mjs — a module the application never reaches must be
 * classified on purpose.
 *
 * Sibling of scripts/lint-module-graph.mjs (how tangled is the module graph?)
 * and scripts/lint-monolith-size.mjs (how big are the two monoliths?). This one
 * asks a fourth question: which modules is the running application not built
 * from, and does anyone still know why?
 *
 * THE PRACTICE THIS BACKS. Staged code is declared, not hidden:
 * docs/releases/RELEASE_NOTES_v0.6.6.md carries a section headed "Foundations
 * added for a later release, not reachable in v0.6.6", so a reader of the
 * source is told which parts the shipped application does not pass through.
 * Nothing enforced it. A module staged deliberately in one release and simply
 * forgotten in the next produce the same tree, and a module superseded by a
 * newer one looks exactly like a module waiting to be wired.
 *
 * So every production-unreachable module is registered in
 * docs/validation/unreachable-modules.json with a status, why it is not
 * reachable, what would make it reachable, and a review date. This gate fails
 * when an unreachable module is ABSENT from that file. It makes no claim that
 * any registered module is right; it only refuses to let the set grow by
 * accident.
 *
 * WHAT REACHABLE MEANS HERE, and where the limits are.
 *
 * The entry is what index.html loads. From there the walk follows every edge
 * that can put a file in the shipped build:
 *
 *   static value      `import { x } from './y'`, `export { x } from './y'`
 *   static type-only  `import type { T } from './y'`
 *   dynamic           `import('./y')` with a literal specifier
 *   worker            `new Worker(new URL('./y.ts', import.meta.url))`
 *
 * Dynamic edges are counted, which is the whole reason src/lazyChunks.ts is
 * not a leaf: it holds this repository's dynamic import() literals and almost
 * every lazy feature hangs off it. A walk that stopped at a lazy boundary would
 * report most of the application as unreachable. Worker edges are counted for
 * the same reason: a worker is loaded by URL, not by import, and its whole
 * subtree would otherwise read as dead.
 *
 * Type-only edges are counted too, and that is a deliberate widening. An
 * `import type` is erased under verbatimModuleSyntax and puts nothing in the
 * bundle, so a module reached only that way IS absent at runtime. Counting it
 * anyway keeps this registry about modules that nothing in the production tree
 * refers to at all, rather than filling it with type-declaration files whose
 * erasure is the point. The narrower runtime-only figure is reported alongside.
 *
 * THREE LIMITS, stated because a reachability number is only as good as them:
 *
 *  1. It is a file-level graph. A file reached for one exported symbol counts
 *     every symbol in it as reached, so this cannot see an unused export.
 *  2. A dynamic `import(expr)` with a computed specifier names no module and is
 *     skipped. There are none in src/ today; lint:inline-imports and
 *     lint:module-graph are what hold that line.
 *  3. Reachable is not the same as executed. A module behind a flag nobody sets
 *     is reachable here and this gate says nothing about it.
 *
 * Build-time consumers are NOT entry points. vite.config.ts imports
 * src/workers/workerRegistry.ts to derive its chunk pins, and that module is
 * therefore registered as reference-only rather than treated as reachable:
 * the register records the fact instead of the graph hiding it.
 *
 * A review date that has passed is REPORTED, never failed. A gate that turns
 * red on a date with no change to the tree teaches people to edit the date.
 *
 * Usage:
 *   node scripts/lint-unreachable-modules.mjs
 *   node scripts/lint-unreachable-modules.mjs --list   # print the measurement
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'src');
const HTML = resolve(ROOT, 'index.html');
const REGISTRY = resolve(ROOT, 'docs/validation/unreachable-modules.json');

/**
 * The registry is a COMMITTED file keyed by repository-relative path, so the
 * key has to be the same string on every operating system. `path.relative`
 * returns `src\render\Viewer.ts` on Windows, which matches nothing in a file
 * written with forward slashes.
 */
const posix = (p) => p.split(sep).join('/');
const rel = (abs) => posix(relative(ROOT, abs));

const STATUSES = new Set(['staged', 'validation-only', 'reference-only', 'orphan', 'unclassified']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ── source scanning ─────────────────────────────────────────────────────────
//
// TypeScript 7 ships no JavaScript parser API (the `typescript` package exports
// a version stub and a native binary), so the import forms are read by a small
// hand-written scanner, the same constraint scripts/lint-module-graph.mjs works
// under.
//
// The scan runs in two steps. First the source is MASKED: every comment body
// and every string body becomes spaces, while quotes, offsets and line breaks
// stay exactly where they were. Then each surviving quote pair is a string
// literal at a known offset, and the masked text immediately before it says
// what the literal is: a module specifier after `from`, after `import`, inside
// `import(`, inside `new URL(`, or none of those, in which case it is ignored.
//
// Masking first is what makes an import-shaped substring inside a comment or a
// string invisible, and it is why `'https://example'` inside a string cannot
// swallow the rest of its line as a comment.

const ID_CHAR = /[A-Za-z0-9_$]/;

/** Punctuation after which a `/` opens a regular expression, not a division. */
const REGEX_AFTER = new Set(
  ['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>'],
);

/**
 * `{ masked, literals }` for one source file.
 *
 * `masked` is the same length as `src`. `literals` is every string literal
 * outside a comment, as `{ value, start }` where `start` is the opening quote.
 * A template literal is masked but never reported: no module specifier in this
 * repository is written as one, and a computed specifier names no module.
 */
function maskSource(src) {
  const masked = src.split('');
  const literals = [];
  /** Blank out `[from, to)` but keep newlines, so line numbers survive. */
  const blank = (from, to) => {
    for (let k = from; k < to && k < src.length; k++) if (src[k] !== '\n') masked[k] = ' ';
  };

  let i = 0;
  let prev = ''; // last significant character, for the regex/division decision
  while (i < src.length) {
    const c = src[i];

    if (c === '/' && src[i + 1] === '/') {
      let j = i;
      while (j < src.length && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      const j = e < 0 ? src.length : e + 2;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c || src[j] === '\n') break;
        j++;
      }
      if (src[j] === c) {
        literals.push({ value: src.slice(i + 1, j), start: i });
        blank(i + 1, j);
        i = j + 1;
      } else {
        // Unterminated before the line ended: not a literal, do not run on.
        i += 1;
      }
      prev = 'x';
      continue;
    }
    if (c === '`') {
      // Template literals nest `${ … }` holes that may hold further strings.
      // Blanking the whole run is enough here: none of the four specifier
      // forms is ever written inside one in this repository.
      let j = i + 1;
      let depth = 0;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '`' && depth === 0) break;
        if (src[j] === '$' && src[j + 1] === '{') { depth++; j += 2; continue; }
        if (src[j] === '}' && depth > 0) { depth--; j++; continue; }
        j++;
      }
      blank(i + 1, j);
      i = Math.min(j + 1, src.length);
      prev = 'x';
      continue;
    }
    if (c === '/' && REGEX_AFTER.has(prev)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '\n') break;
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) { closed = true; j++; break; }
        j++;
      }
      if (closed) {
        while (j < src.length && ID_CHAR.test(src[j])) j++; // flags
        blank(i + 1, j);
        i = j;
        prev = 'x';
        continue;
      }
      // Not a regular expression after all; fall through as division.
    }
    if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') prev = c;
    i++;
  }

  return { masked: masked.join(''), literals };
}

/** `from`, `import`, `import(` or `new URL(` immediately before `start`. */
const SPECIFIER_HEAD = [
  { kind: 'static', re: /\bfrom\s*$/ },
  { kind: 'dynamic', re: /\bimport\s*\(\s*$/ },
  { kind: 'static', re: /\bimport\s+$/ },
  { kind: 'worker', re: /\bnew\s+URL\s*\(\s*$/ },
];

/** Every module specifier in one source file, as `{ spec, kind, line }`. */
function scanSpecifiers(src) {
  const { masked, literals } = maskSource(src);
  const out = [];
  for (const lit of literals) {
    const head = masked.slice(Math.max(0, lit.start - 64), lit.start);
    const hit = SPECIFIER_HEAD.find((h) => h.re.test(head));
    if (!hit) continue;
    let line = 1;
    for (let k = 0; k < lit.start; k++) if (src.charCodeAt(k) === 10) line++;
    out.push({ spec: lit.value, kind: hit.kind, line });
  }
  return out;
}

// ── module resolution ───────────────────────────────────────────────────────

/** Extension order for a specifier written without one (`moduleResolution: bundler`). */
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.js'];

/**
 * A relative specifier resolved to a graph node, or null.
 *
 * A bare package specifier is external and is not a node. A resolved file that
 * is not a `.ts` under src/ (a stylesheet, a wasm blob) is not a node either.
 */
function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base,
    ...EXTENSIONS.map((e) => base + e),
    ...EXTENSIONS.map((e) => join(base, `index${e}`)),
  ];
  if (base.endsWith('.js')) candidates.push(base.replace(/\.js$/, '.ts'));
  for (const c of candidates) {
    let s;
    try { s = statSync(c); } catch { continue; }
    if (!s.isFile()) continue;
    const key = rel(c);
    return key.endsWith('.ts') && !key.endsWith('.d.ts') && key.startsWith('src/') ? key : null;
  }
  return null;
}

// ── the graph ───────────────────────────────────────────────────────────────

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { sourceFiles(full, out); continue; }
    if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name.endsWith('.d.ts')) continue;
    out.push(full);
  }
  return out;
}

const problems = [];

/** file → { all: Set(key), runtime: Set(key) } */
const graph = new Map();
for (const abs of sourceFiles(SRC)) {
  const all = new Set();
  const runtime = new Set();
  for (const s of scanSpecifiers(readFileSync(abs, 'utf8'))) {
    const key = resolveSpec(abs, s.spec);
    if (!key) continue;
    all.add(key);
    // A `from` edge is runtime unless the declaration is type-only; the head
    // scan cannot tell those apart, so the runtime figure is derived from the
    // declaration text instead, below.
    runtime.add(key);
  }
  graph.set(rel(abs), { all, runtime });
}

/**
 * The runtime graph, narrowed by dropping `import type` / `export type`
 * declarations. Reported for context; the register is keyed on the wide graph.
 */
const TYPE_DECL = /\b(?:import|export)\s+type\s[^;]*?\bfrom\s*['"]([^'"]+)['"]/g;
for (const abs of sourceFiles(SRC)) {
  const key = rel(abs);
  const src = readFileSync(abs, 'utf8');
  const { masked } = maskSource(src);
  const entry = graph.get(key);
  const typeOnly = new Set();
  const valued = new Set();
  for (const m of src.matchAll(TYPE_DECL)) {
    // Re-read the specifier from the ORIGINAL text but confirm the declaration
    // survived masking, so a documented example in a comment is not counted.
    if (masked.slice(m.index, m.index + 6).trim() === '') continue;
    const r = resolveSpec(abs, m[1]);
    if (r) typeOnly.add(r);
  }
  for (const t of entry.all) if (!typeOnly.has(t)) valued.add(t);
  entry.runtime = valued;
}

// ── entry points ────────────────────────────────────────────────────────────

/** Every `/src/*.ts` module index.html loads. */
function htmlEntries() {
  const html = readFileSync(HTML, 'utf8');
  const found = new Set();
  for (const m of html.matchAll(/<script[^>]*\bsrc\s*=\s*"(\/src\/[^"]+\.ts)"/g)) {
    found.add(m[1].replace(/^\//, ''));
  }
  return [...found].sort();
}

const entries = htmlEntries();
if (entries.length === 0) {
  problems.push(
    'index.html declares no `/src/*.ts` module script. The reachability walk has no entry, '
    + 'so every module would read as unreachable.',
  );
}
for (const e of entries) {
  if (!graph.has(e)) problems.push(`${e}: index.html loads it, but it is not a file under src/.`);
}

/** Breadth-first closure over `pick(entry)` from the entry points. */
function reach(pick) {
  const seen = new Set(entries.filter((e) => graph.has(e)));
  const queue = [...seen];
  while (queue.length > 0) {
    const node = queue.pop();
    for (const next of pick(graph.get(node))) {
      if (graph.has(next) && !seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return seen;
}

const reachable = reach((e) => e.all);
const runtimeReachable = reach((e) => e.runtime);
const unreachable = [...graph.keys()].filter((f) => !reachable.has(f)).sort();

// ── --list ──────────────────────────────────────────────────────────────────

if (process.argv.includes('--list')) {
  console.log(
    `${graph.size} modules under src/, ${reachable.size} reachable from `
    + `${entries.join(', ')}, ${unreachable.length} unreachable `
    + `(${graph.size - runtimeReachable.size} counting runtime edges only).`,
  );
  for (const f of unreachable) console.log(`  ${f}`);
  process.exit(0);
}

// ── the register ────────────────────────────────────────────────────────────

let register;
try {
  register = JSON.parse(readFileSync(REGISTRY, 'utf8'));
} catch (err) {
  console.error('lint:unreachable-modules FAILED\n');
  console.error(`  • docs/validation/unreachable-modules.json could not be read: ${err.message}`);
  process.exit(1);
}

const entriesById = new Map();
const overdue = [];
const today = new Date().toISOString().slice(0, 10);

for (const item of register.modules ?? []) {
  const path = item.path;
  if (typeof path !== 'string' || path === '') {
    problems.push('[U5 schema] a register entry has no `path`.');
    continue;
  }
  if (entriesById.has(path)) {
    problems.push(`[U4 duplicate] ${path} is registered twice. One module, one entry.`);
    continue;
  }
  entriesById.set(path, item);

  if (!graph.has(path)) {
    problems.push(
      `[U3 absent] ${path} is registered but is not a scanned module under src/. `
      + 'Correct the path, or drop the entry if the file is gone.',
    );
    continue;
  }
  if (!STATUSES.has(item.status)) {
    problems.push(
      `[U5 schema] ${path}: status "${item.status}" is not one of `
      + `${[...STATUSES].join(', ')}.`,
    );
  }
  for (const field of ['why', 'graduation']) {
    if (typeof item[field] !== 'string' || item[field].trim() === '') {
      problems.push(`[U5 schema] ${path}: \`${field}\` is missing. An entry with no ${field} classifies nothing.`);
    }
  }
  if (!ISO_DATE.test(item.review ?? '')) {
    problems.push(`[U5 schema] ${path}: \`review\` must be an ISO date (YYYY-MM-DD), not "${item.review}".`);
  } else if (item.review < today) {
    overdue.push(`${path} (due ${item.review})`);
  }
  if (reachable.has(path)) {
    problems.push(
      `[U2 graduated] ${path} is registered as unreachable, but production now reaches it. `
      + 'Remove the entry: the register describes what the application does not pass through.',
    );
  }
}

for (const path of unreachable) {
  if (entriesById.has(path)) continue;
  problems.push(
    `[U1 unregistered] ${path} is not reachable from ${entries.join(', ')} and is absent from `
    + 'docs/validation/unreachable-modules.json. Add an entry stating its status, why it is not '
    + 'reachable, what would make it reachable, and a review date. Unreachable is allowed here; '
    + 'unclassified is not.',
  );
}

if (problems.length > 0) {
  console.error('lint:unreachable-modules FAILED\n');
  for (const p of problems) console.error(`  • ${p}`);
  console.error(
    '\nRun "node scripts/lint-unreachable-modules.mjs --list" to see the measurement this '
    + 'compared against.',
  );
  process.exit(1);
}

const byStatus = new Map();
for (const item of register.modules ?? []) {
  byStatus.set(item.status, (byStatus.get(item.status) ?? 0) + 1);
}
const breakdown = [...STATUSES]
  .filter((s) => byStatus.has(s))
  .map((s) => `${byStatus.get(s)} ${s}`)
  .join(', ');

console.log(
  `lint:unreachable-modules OK — ${graph.size} modules under src/, ${reachable.size} reachable `
  + `from ${entries.join(', ')}, ${unreachable.length} unreachable and every one registered `
  + `(${breakdown}).`,
);
if (overdue.length > 0) {
  console.log(`    ${overdue.length} review date${overdue.length === 1 ? '' : 's'} passed, reported not enforced:`);
  for (const o of overdue) console.log(`      ${o}`);
}
