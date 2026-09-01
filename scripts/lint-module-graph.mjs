#!/usr/bin/env node
/**
 * lint-module-graph.mjs: a shrink-only ratchet on cross-directory coupling.
 *
 * Sibling of scripts/lint-monolith-size.mjs (how big are the two monoliths?)
 * and scripts/lint-position-access.mjs (how much raw buffer access is left?).
 * This one asks a third question: how tangled is the module graph?
 *
 * Seven numbers, measured by a static scan of every non-test `.ts` under `src/`:
 *
 *   render -> ui      render code reaching into the interface layer
 *   io -> render      loaders reaching into the render layer
 *   export -> render  the export layer reaching into the render layer
 *   report -> render  the report layer reaching into the render layer
 *   fan-out of src/main.ts and src/render/Viewer.ts
 *   file-level import cycles
 *
 * THE BASELINE IS A RECORD, NOT A TARGET. It is generated from the tree as it
 * stands, so the first run passes. It states where the architecture is today.
 * It makes no claim that any of these numbers is good, and reaching zero is not
 * this script's call to make. All it enforces is direction: the numbers may
 * fall, never rise. Growth is a hand-edited act, because there is no flag that
 * raises a baseline; `--update` rewrites the file from the current tree, which
 * is how a genuine reduction gets banked.
 *
 * WHAT COUNTS AS AN EDGE, and why the distinctions are the whole point.
 *
 * 1. STATIC vs DYNAMIC. `import()` is a deliberate lazy boundary: the module is
 *    not in the importer's chunk and is not loaded until the call runs. It is
 *    NOT a runtime coupling edge and is NOT part of a cycle. src/lazyChunks.ts
 *    exists to hold exactly these calls; it has zero static imports and 79
 *    dynamic ones. A scanner that conflated the two would rank it as one of the
 *    largest hubs in the repo and would invent a Viewer <-> lazyChunks cycle
 *    out of the seam built to prevent one. Dynamic edges are counted and
 *    recorded separately, and never enforced: adding one is a decoupling.
 *
 * 2. TYPE-ONLY vs VALUE. This repo compiles with `verbatimModuleSyntax`, so a
 *    type-only import must be written `import type ...` and is erased whole.
 *    It creates no runtime edge, no chunk dependency and no cycle. Counting it
 *    would flag, for example, src/geo/CrsRegistry.ts importing a type from
 *    src/io/crs.ts as a live dependency of geo on io, which it is not.
 *    Type-only edges are counted and recorded separately, and never enforced.
 *
 *    One residue of `verbatimModuleSyntax` is recorded but not enforced: an
 *    import whose named bindings are ALL inline `type` specifiers
 *    (`import { type A } from './x'`) keeps its declaration and emits
 *    `import {} from './x'`, so it is a module load with no binding. Those are
 *    counted as runtime edges and their number is reported under `context`.
 *
 * A re-export (`export { x } from './y'`, `export * from './y'`) is a runtime
 * edge like any other import; `export type { x } from './y'` is type-only.
 * `new Worker(new URL(...))` is not an import and is not counted here;
 * scripts/lint-worker-registry.mjs covers that seam.
 *
 * "Edge" means a distinct file pair, so ten imports from one file to another
 * are one edge. "Fan-out" means distinct modules, internal files and external
 * packages alike. "Cycle" means a strongly connected component of two or more
 * files in the static value graph: a finite, decidable count, unlike the number
 * of elementary cycles, which can grow combinatorially inside one component.
 *
 * A failure names the category, the amount of growth, and the specific new
 * edges or modules that caused it, with the line they were written on.
 *
 * To bank a reduction:
 *   node scripts/lint-module-graph.mjs --update
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isCliEntry } from './lib/isCliEntry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = resolve(ROOT, 'docs/validation/module-graph-baseline.json');
const SRC = resolve(ROOT, 'src');

/**
 * The baseline is a COMMITTED file keyed by repository-relative path, so the
 * key has to be the same string on every operating system. `path.relative`
 * returns `src\render\Viewer.ts` on Windows, which matches nothing in a file
 * written with forward slashes, and the gate would then report every edge as
 * new and fail a clean tree.
 */
const posix = (p) => p.split(sep).join('/');
const rel = (abs) => posix(relative(ROOT, abs));

// ── the directory pairs under watch ─────────────────────────────────────────

/** id, the directory an edge leaves, the directory it enters. */
const PAIRS = [
  { id: 'render->ui', from: 'src/render/', to: 'src/ui/' },
  { id: 'io->render', from: 'src/io/', to: 'src/render/' },
  { id: 'export->render', from: 'src/export/', to: 'src/render/' },
  { id: 'report->render', from: 'src/report/', to: 'src/render/' },
];

/** The two files whose fan-out is measured. */
const FAN_OUT_FILES = ['src/main.ts', 'src/render/Viewer.ts'];

// ── source scanning ─────────────────────────────────────────────────────────
//
// TypeScript 7 ships no JavaScript parser API (the `typescript` package exports
// a version stub and a native binary), so the import forms are read by a small
// hand-written scanner. It tracks strings, template literals with their `${}`
// expressions, comments and regular expressions, so an import-shaped substring
// inside any of them is invisible to it.

const ID_START = /[A-Za-z_$]/;
const ID_CHAR = /[A-Za-z0-9_$]/;

/** Punctuation after which a `/` opens a regular expression, not a division. */
const REGEX_AFTER_PUNCT = new Set(
  ['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>'],
);
/** Keywords after which a `/` opens a regular expression. */
const REGEX_AFTER_WORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case',
  'do', 'else', 'yield', 'await', 'throw',
]);

const regexAllowed = (prev) => REGEX_AFTER_PUNCT.has(prev) || REGEX_AFTER_WORD.has(prev);

/** Index just past a quoted string that starts at `i`. */
function skipString(src, i) {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === quote) return j + 1;
    if (c === '\n') return j; // unterminated; do not run to end of file
    j++;
  }
  return j;
}

/** Index just past a `{ … }` run that starts at `i`, strings and comments included. */
function skipBalanced(src, i) {
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === '{') { depth++; j++; continue; }
    if (c === '}') { depth--; j++; if (depth === 0) return j; continue; }
    if (c === '"' || c === "'") { j = skipString(src, j); continue; }
    if (c === '`') { j = skipTemplate(src, j); continue; }
    if (c === '/' && src[j + 1] === '/') { while (j < src.length && src[j] !== '\n') j++; continue; }
    if (c === '/' && src[j + 1] === '*') { const e = src.indexOf('*/', j + 2); j = e < 0 ? src.length : e + 2; continue; }
    j++;
  }
  return j;
}

/** Index just past a template literal that starts at `i`, including `${}` holes. */
function skipTemplate(src, i) {
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '`') return j + 1;
    if (c === '$' && src[j + 1] === '{') { j = skipBalanced(src, j + 1); continue; }
    j++;
  }
  return j;
}

/** Index just past a regular-expression literal that starts at `i`. */
function skipRegex(src, i) {
  let j = i + 1;
  let inClass = false;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '\n') return i + 1; // not a regex after all
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      j++;
      while (j < src.length && ID_CHAR.test(src[j])) j++; // flags
      return j;
    }
    j++;
  }
  return j;
}

/** Index of the next character that is neither whitespace nor a comment. */
function skipTrivia(src, i) {
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { j++; continue; }
    if (c === '/' && src[j + 1] === '/') { while (j < src.length && src[j] !== '\n') j++; continue; }
    if (c === '/' && src[j + 1] === '*') { const e = src.indexOf('*/', j + 2); j = e < 0 ? src.length : e + 2; continue; }
    return j;
  }
  return j;
}

/** `{ value, end }` for the string literal at `i`, or null. */
function literalAt(src, i) {
  if (src[i] !== '"' && src[i] !== "'") return null;
  const end = skipString(src, i);
  return { value: src.slice(i + 1, end - 1), end };
}

/** The identifier at `i`, or null. */
function wordAt(src, i) {
  if (i >= src.length || !ID_START.test(src[i])) return null;
  let e = i;
  while (e < src.length && ID_CHAR.test(src[e])) e++;
  return { value: src.slice(i, e), end: e };
}

/**
 * Whether an import clause is type-only, and whether every named binding in it
 * carries an inline `type`.
 *
 * `import type { A } from` is type-only. `import type from './x'` is a DEFAULT
 * import of a binding called `type`, and `import type, { A } from './x'` is the
 * same binding plus named ones, so both are value imports.
 */
function classifyClause(clause) {
  const text = clause.replace(/\s+/g, ' ').trim();
  const typeMatch = /^type\b(.*)$/.exec(text);
  if (typeMatch) {
    const rest = typeMatch[1].trim();
    if (rest !== '' && !rest.startsWith(',')) return { typeOnly: true, inlineOnly: false };
  }
  const open = text.indexOf('{');
  const close = text.lastIndexOf('}');
  if (open < 0 || close < open) return { typeOnly: false, inlineOnly: false };
  // A default binding ahead of the braces means at least one value binding.
  if (text.slice(0, open).replace(',', '').trim() !== '') return { typeOnly: false, inlineOnly: false };
  const specs = text.slice(open + 1, close).split(',').map((s) => s.trim()).filter(Boolean);
  // `{ type as t }` imports a binding named `type`; `{ type A }` is inline type.
  const isInline = (s) => /^type\s+/.test(s) && !/^type\s+as\b/.test(s);
  return { typeOnly: false, inlineOnly: specs.length > 0 && specs.every(isInline) };
}

/**
 * Every module specifier in one source file, split three ways.
 *
 * Returns `{ statics, dynamics }`. Each static entry is
 * `{ spec, line, typeOnly, inlineOnly }`; each dynamic entry is
 * `{ spec, line }`, with `spec` null for a non-literal `import(expr)`.
 */
function scanSpecifiers(src) {
  const statics = [];
  const dynamics = [];
  // Line numbers come from a prefix scan rather than a slice-and-count per hit.
  const lineAt = (idx) => {
    let n = 1;
    for (let k = 0; k < idx; k++) if (src.charCodeAt(k) === 10) n++;
    return n;
  };
  let prev = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === '"' || c === "'") { i = skipString(src, i); prev = 'literal'; continue; }
    if (c === '`') { i = skipTemplate(src, i); prev = 'literal'; continue; }
    if (c === '/' && regexAllowed(prev)) { i = skipRegex(src, i); prev = 'literal'; continue; }

    const word = wordAt(src, i);
    if (!word) { prev = c; i++; continue; }

    if (word.value === 'import' && prev !== '.') {
      const start = i;
      const r = readImport(src, word.end);
      if (r.dynamic) dynamics.push({ spec: r.dynamic.spec, line: lineAt(start) });
      else if (r.decl) statics.push({ ...r.decl, line: lineAt(start) });
      i = r.next;
      prev = 'literal';
      continue;
    }
    if (word.value === 'export' && prev !== '.') {
      const start = i;
      const r = readExport(src, word.end);
      if (r) {
        statics.push({ ...r.decl, line: lineAt(start) });
        i = r.next;
        prev = 'literal';
        continue;
      }
    }
    prev = word.value;
    i = word.end;
  }
  return { statics, dynamics };
}

/** Read one `import …`, starting just past the keyword. */
function readImport(src, afterKeyword) {
  const k = skipTrivia(src, afterKeyword);

  // `import(...)`: a lazy boundary, never a runtime edge.
  if (src[k] === '(') {
    const arg = skipTrivia(src, k + 1);
    const lit = literalAt(src, arg);
    return lit ? { dynamic: { spec: lit.value }, next: lit.end } : { dynamic: { spec: null }, next: k + 1 };
  }
  // `import.meta.url` and friends.
  if (src[k] === '.') return { next: k + 1 };

  // `import './side-effect'`
  const bare = literalAt(src, k);
  if (bare) return { decl: { spec: bare.value, typeOnly: false, inlineOnly: false }, next: bare.end };

  // A clause, read up to the `from` keyword at brace depth zero.
  let clause = '';
  let depth = 0;
  let j = k;
  while (j < src.length) {
    const t = skipTrivia(src, j);
    if (t !== j) { clause += ' '; j = t; continue; }
    const c = src[j];
    if (c === '{') { depth++; clause += c; j++; continue; }
    if (c === '}') { depth--; clause += c; j++; continue; }
    if (c === ';' || c === '"' || c === "'") break;
    const w = wordAt(src, j);
    if (w) {
      if (w.value === 'from' && depth === 0) { j = w.end; break; }
      clause += ` ${w.value} `;
      j = w.end;
      continue;
    }
    clause += c;
    j++;
  }
  const q = skipTrivia(src, j);
  const lit = literalAt(src, q);
  if (!lit) return { next: k + 1 };
  return { decl: { spec: lit.value, ...classifyClause(clause) }, next: lit.end };
}

/**
 * Read one `export … from '…'`, starting just past the keyword.
 * Returns null for an export that carries no module specifier, which is most
 * of them: `export const`, `export class`, `export type Alias = …`,
 * `export { local }`.
 */
function readExport(src, afterKeyword) {
  let k = skipTrivia(src, afterKeyword);
  let typeOnly = false;
  let clause = '';

  const first = wordAt(src, k);
  if (first) {
    if (first.value !== 'type') return null;
    typeOnly = true;
    k = skipTrivia(src, first.end);
  }

  if (src[k] === '*') {
    k = skipTrivia(src, k + 1);
    const as = wordAt(src, k);
    if (as && as.value === 'as') {
      k = skipTrivia(src, as.end);
      const ns = wordAt(src, k);
      if (!ns) return null;
      k = skipTrivia(src, ns.end);
    }
  } else if (src[k] === '{') {
    const end = skipBalanced(src, k);
    clause = src.slice(k, end);
    k = skipTrivia(src, end);
  } else {
    return null;
  }

  const from = wordAt(src, k);
  if (!from || from.value !== 'from') return null;
  const lit = literalAt(src, skipTrivia(src, from.end));
  if (!lit) return null;

  const inlineOnly = typeOnly ? false : classifyClause(clause).inlineOnly;
  return { decl: { spec: lit.value, typeOnly, inlineOnly }, next: lit.end };
}

// ── module resolution ───────────────────────────────────────────────────────

/** Extension order for a specifier written without one (`moduleResolution: bundler`). */
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.js'];

/**
 * A specifier resolved to a stable key.
 *
 * `internal` is a `.ts` file under src/ and is a node in the graph. `asset` is
 * a resolved non-TypeScript file (a stylesheet). `external` is a bare package
 * specifier. A relative specifier that resolves to nothing is reported: a
 * scanner that silently dropped an edge would under-count in exactly the
 * direction that lets coupling grow unnoticed.
 */
function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return { kind: 'external', key: spec };
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base, ...EXTENSIONS.map((e) => base + e), ...EXTENSIONS.map((e) => join(base, `index${e}`))];
  if (base.endsWith('.js')) candidates.push(base.replace(/\.js$/, '.ts'));
  for (const c of candidates) {
    let s;
    try { s = statSync(c); } catch { continue; }
    if (!s.isFile()) continue;
    const key = rel(c);
    const internal = key.endsWith('.ts') && !key.endsWith('.d.ts') && key.startsWith('src/');
    return { kind: internal ? 'internal' : 'asset', key };
  }
  return { kind: 'unresolved', key: spec };
}

// ── scan ────────────────────────────────────────────────────────────────────

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) { sourceFiles(full, out); continue; }
    if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name.endsWith('.d.ts')) continue;
    out.push(full);
  }
  return out;
}

/** A module reached only by `import type` is not a runtime edge of any kind. */
const typeOnlyKeys = (entry) => [...entry.type.keys()].filter((k) => !entry.value.has(k));

// ── the seven measurements ──────────────────────────────────────────────────

/** Directory-pair edges, one entry per distinct file pair. */
function measurePair(graph, pair) {
  const runtime = [];
  const type = [];
  const dynamic = [];
  for (const [from, entry] of graph) {
    if (!from.startsWith(pair.from)) continue;
    for (const [to, line] of entry.value) if (to.startsWith(pair.to)) runtime.push({ edge: `${from} -> ${to}`, line });
    for (const to of typeOnlyKeys(entry)) if (to.startsWith(pair.to)) type.push(`${from} -> ${to}`);
    for (const to of entry.dynamic.keys()) if (to.startsWith(pair.to)) dynamic.push(`${from} -> ${to}`);
  }
  runtime.sort((a, b) => a.edge.localeCompare(b.edge));
  return {
    runtime: runtime.length,
    typeOnly: type.length,
    dynamic: dynamic.length,
    edges: runtime.map((r) => r.edge),
    lines: new Map(runtime.map((r) => [r.edge, r.line])),
  };
}

/** Distinct modules one file imports, internal files and packages alike. */
function measureFanOut(graph, problems, file) {
  const entry = graph.get(file);
  if (!entry) {
    problems.push(`${file}: not found in src/. The fan-out measurement names a file that does not exist.`);
    return { runtime: 0, typeOnly: 0, dynamic: 0, modules: [], lines: new Map() };
  }
  const modules = [...entry.value.keys()].sort();
  return {
    runtime: modules.length,
    typeOnly: typeOnlyKeys(entry).length,
    dynamic: entry.dynamic.size,
    modules,
    lines: entry.value,
  };
}

/**
 * Strongly connected components of two or more files in the static value graph.
 *
 * Tarjan, iterative: the graph is 682 files deep in places and a recursive walk
 * is a stack-overflow waiting for the wrong import to be added.
 */
function measureCycles(graph) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  let counter = 0;

  const successors = (n) => [...(graph.get(n)?.value.keys() ?? [])].filter((k) => graph.has(k));

  for (const root of graph.keys()) {
    if (index.has(root)) continue;
    const work = [{ node: root, next: 0, succ: successors(root) }];
    index.set(root, counter);
    low.set(root, counter);
    counter++;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame.next < frame.succ.length) {
        const child = frame.succ[frame.next++];
        if (!index.has(child)) {
          index.set(child, counter);
          low.set(child, counter);
          counter++;
          stack.push(child);
          onStack.add(child);
          work.push({ node: child, next: 0, succ: successors(child) });
        } else if (onStack.has(child)) {
          low.set(frame.node, Math.min(low.get(frame.node), index.get(child)));
        }
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1].node;
        low.set(parent, Math.min(low.get(parent), low.get(frame.node)));
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const members = [];
        for (;;) {
          const m = stack.pop();
          onStack.delete(m);
          members.push(m);
          if (m === frame.node) break;
        }
        if (members.length > 1) components.push(members.sort());
      }
    }
  }
  components.sort((a, b) => a[0].localeCompare(b[0]));
  return { count: components.length, components };
}

/**
 * Scan src/ once and return every enforced graph fact.
 *
 * Pure with respect to the working tree: no console output, no process.exit,
 * no side effect, so it is safe to import from a release/build step or a test.
 * The CLI lint below is a thin caller of this same measurement.
 */
export function measureModuleGraph() {
  const problems = [];
  /** file → { value: Map(key → line), type: Map, dynamic: Map, inlineOnly: number } */
  const graph = new Map();

  for (const abs of sourceFiles(SRC)) {
    const from = rel(abs);
    const { statics, dynamics } = scanSpecifiers(readFileSync(abs, 'utf8'));
    const entry = { value: new Map(), type: new Map(), dynamic: new Map(), inlineOnly: 0 };
    for (const s of statics) {
      const r = resolveSpec(abs, s.spec);
      if (r.kind === 'unresolved') {
        problems.push(`${from}:${s.line}: the relative specifier "${s.spec}" resolves to no file. The scan cannot classify an edge it cannot resolve.`);
        continue;
      }
      if (s.inlineOnly) entry.inlineOnly++;
      const bucket = s.typeOnly ? entry.type : entry.value;
      if (!bucket.has(r.key)) bucket.set(r.key, s.line);
    }
    for (const d of dynamics) {
      if (d.spec === null) continue; // a computed specifier names no module
      const r = resolveSpec(abs, d.spec);
      if (r.kind === 'unresolved') continue; // a lazy edge is not enforced either way
      if (!entry.dynamic.has(r.key)) entry.dynamic.set(r.key, d.line);
    }
    graph.set(from, entry);
  }

  const pairs = new Map(PAIRS.map((p) => [p.id, measurePair(graph, p)]));
  const fanOut = new Map(FAN_OUT_FILES.map((f) => [f, measureFanOut(graph, problems, f)]));
  const cycles = measureCycles(graph);
  const inlineOnlyTotal = [...graph.values()].reduce((a, e) => a + e.inlineOnly, 0);
  // Total distinct runtime import edges (internal files and packages alike).
  const totalEdges = [...graph.values()].reduce((a, e) => a + e.value.size, 0);

  return { graph, problems, pairs, fanOut, cycles, inlineOnlyTotal, totalEdges, filesScanned: graph.size };
}

/**
 * A canonical, timestamp-free fingerprint of the enforced architecture facts.
 *
 * `architectureDigest` is the sha256 of a sorted serialization of exactly the
 * facts this gate enforces — the directory-pair edges, the two fan-out module
 * lists, and the file-level cycle components — so the same tree always yields
 * the same hex and any change to the enforced graph moves the digest.
 */
export function computeArchitectureFingerprint(measurement = measureModuleGraph()) {
  if (measurement.problems.length > 0) {
    throw new Error(
      `architecture fingerprint refused; the module-graph scan reported a problem:\n  ${measurement.problems.join('\n  ')}`,
    );
  }
  const enforced = {
    edges: Object.fromEntries(PAIRS.map((p) => [p.id, measurement.pairs.get(p.id).edges])),
    fanOut: Object.fromEntries(FAN_OUT_FILES.map((f) => [f, measurement.fanOut.get(f).modules])),
    cycles: measurement.cycles.components,
  };
  const canonical = JSON.stringify(enforced);
  const architectureDigest = createHash('sha256').update(canonical).digest('hex');
  return {
    moduleCount: measurement.filesScanned,
    edgeCount: measurement.totalEdges,
    cycleCount: measurement.cycles.count,
    mainFanOut: measurement.fanOut.get('src/main.ts').runtime,
    viewerFanOut: measurement.fanOut.get('src/render/Viewer.ts').runtime,
    architectureDigest,
  };
}

// ── --update ────────────────────────────────────────────────────────────────

const PURPOSE =
  'Cross-directory coupling in src/, measured by scripts/lint-module-graph.mjs from a static '
  + 'scan of every non-test .ts file. These numbers are a RECORD OF THE TREE AS IT IS, not a '
  + 'target and not a claim that any of them is good. The gate holds them shrink-only: '
  + '`runtime` may fall, never rise. `typeOnly` and `dynamic` are recorded for context and are '
  + 'never enforced, because neither is a runtime coupling: an `import type` is erased under '
  + 'verbatimModuleSyntax, and an `import()` is a lazy boundary whose whole purpose is to '
  + 'decouple. An edge is a distinct file pair; fan-out is distinct modules, internal files and '
  + 'external packages alike; a cycle is a strongly connected component of two or more files in '
  + 'the static value graph. Run "node scripts/lint-module-graph.mjs --update" to bank a '
  + 'reduction. There is no flag that raises a number.';

function runCli() {
  const { graph, problems, pairs, fanOut, cycles, inlineOnlyTotal } = measureModuleGraph();

  if (process.argv.includes('--update') || !existsSync(BASELINE)) {
    if (problems.length > 0) {
    console.error('module-graph baseline NOT written; the scan itself reported a problem:\n');
    for (const p of problems) console.error(`  • ${p}`);
    process.exit(1);
  }
  const edges = {};
  for (const p of PAIRS) {
    const m = pairs.get(p.id);
    edges[p.id] = { runtime: m.runtime, typeOnly: m.typeOnly, dynamic: m.dynamic, edges: m.edges };
  }
  const fan = {};
  for (const f of FAN_OUT_FILES) {
    const m = fanOut.get(f);
    fan[f] = { runtime: m.runtime, typeOnly: m.typeOnly, dynamic: m.dynamic, modules: m.modules };
  }
  const doc = {
    purpose: PURPOSE,
    edges,
    fanOut: fan,
    cycles: { count: cycles.count, components: cycles.components },
    context: {
      filesScanned: graph.size,
      inlineTypeOnlyImports: inlineOnlyTotal,
      note:
        'inlineTypeOnlyImports counts declarations whose named bindings are all inline `type` '
        + 'specifiers. Under verbatimModuleSyntax the declaration survives as `import {} from "x"`, '
        + 'a module load with no binding, so it is counted as a runtime edge above.',
    },
  };
  writeFileSync(BASELINE, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(
    `module-graph baseline written: ${PAIRS.map((p) => `${p.id} ${pairs.get(p.id).runtime}`).join(', ')}, `
    + `${FAN_OUT_FILES.map((f) => `${f.split('/').pop()} fan-out ${fanOut.get(f).runtime}`).join(', ')}, `
    + `${cycles.count} cycle${cycles.count === 1 ? '' : 's'} across ${graph.size} files.`,
  );
  process.exit(0);
}

// ── shrink-only ─────────────────────────────────────────────────────────────

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));

/** The items measured now that the baseline did not record. */
const added = (now, before) => now.filter((x) => !before.includes(x));

for (const p of PAIRS) {
  const m = pairs.get(p.id);
  const b = baseline.edges?.[p.id];
  if (!b) {
    problems.push(`${p.id}: no baseline entry. Run --update once to record this category, then hold it.`);
    continue;
  }
  if (m.runtime > b.runtime) {
    const fresh = added(m.edges, b.edges ?? []);
    problems.push(
      `${p.id}: ${m.runtime} runtime edges, baseline ${b.runtime} (+${m.runtime - b.runtime}). `
      + 'Cross-directory coupling may shrink, never grow.'
      + fresh.map((e) => `\n      new: ${e} (${e.split(' -> ')[0]}:${m.lines.get(e)})`).join(''),
    );
  }
}

for (const f of FAN_OUT_FILES) {
  const m = fanOut.get(f);
  const b = baseline.fanOut?.[f];
  if (!b) {
    problems.push(`${f}: no baseline fan-out entry. Run --update once to record it, then hold it.`);
    continue;
  }
  if (m.runtime > b.runtime) {
    const fresh = added(m.modules, b.modules ?? []);
    problems.push(
      `${f}: static fan-out ${m.runtime} modules, baseline ${b.runtime} (+${m.runtime - b.runtime}). `
      + 'Import the new module from the cluster that owns the behaviour, or reach it through '
      + 'src/lazyChunks.ts, which is a lazy boundary and is not counted here.'
      + fresh.map((e) => `\n      new: ${e} (${f}:${m.lines.get(e)})`).join(''),
    );
  }
}

const baseCycles = baseline.cycles?.count;
if (baseCycles === undefined) {
  problems.push('cycles: no baseline entry. Run --update once to record the count, then hold it.');
} else if (cycles.count > baseCycles) {
  const before = (baseline.cycles.components ?? []).map((c) => c.join(' <-> '));
  const fresh = added(cycles.components.map((c) => c.join(' <-> ')), before);
  problems.push(
    `cycles: ${cycles.count} file-level static import cycle${cycles.count === 1 ? '' : 's'}, `
    + `baseline ${baseCycles} `
    + `(+${cycles.count - baseCycles}). Break the back edge, or make it an \`import type\`, `
    + 'which is erased and forms no cycle.'
    + fresh.map((c) => `\n      new: ${c}`).join(''),
  );
}

if (problems.length > 0) {
  console.error('lint:module-graph FAILED\n');
  for (const p of problems) console.error(`  • ${p}`);
  console.error('\nIf a decomposition step legitimately lowered a number, run '
    + '"node scripts/lint-module-graph.mjs --update" to bank it.');
  process.exit(1);
}

const summary = [
  ...PAIRS.map((p) => {
    const m = pairs.get(p.id);
    return `${p.id} ${m.runtime}`;
  }),
  ...FAN_OUT_FILES.map((f) => `${f.split('/').pop()} ${fanOut.get(f).runtime}`),
  `${cycles.count} cycle${cycles.count === 1 ? '' : 's'}`,
];
const dropped = PAIRS.reduce((a, p) => a + (baseline.edges[p.id].runtime - pairs.get(p.id).runtime), 0)
  + FAN_OUT_FILES.reduce((a, f) => a + (baseline.fanOut[f].runtime - fanOut.get(f).runtime), 0)
  + (baseCycles - cycles.count);
  console.log(
    `lint:module-graph OK [runtime edges only; ${graph.size} files scanned]: ${summary.join(', ')}`
    + (dropped > 0 ? ` (${dropped} fewer than baseline; run --update to bank it).` : '.'),
  );
}

if (isCliEntry(import.meta.url)) runCli();
