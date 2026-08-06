#!/usr/bin/env node
/**
 * lint-position-access.mjs: the gate on direct `.positions` reads.
 *
 * It enforces two rules at once, because they answer two different questions
 * about the same surface.
 *
 * 1. SHRINK-ONLY (how much raw access is there?). Counts may fall, never rise.
 *    A file that drops to zero leaves the baseline and can never come back.
 *
 * 2. CLASSIFIED (what does each raw read MEAN?). Every remaining read must be
 *    covered by an entry in `docs/validation/position-frames.json` naming the
 *    coordinate frame it expects: `source-local`, `project-local`,
 *    `render-local` or `world`, plus a one-sentence reason. An unclassified
 *    read fails the gate. A site that truly reads more than one frame (a
 *    combined estimator over static layers and streaming nodes) names them all.
 *
 * Rule 2 is the residual risk the coordinate-integrity work left behind. A raw
 * read is not automatically wrong: loaders create the buffer, the model owns
 * it, the render upload boundary hands it to the GPU, and reviewed numeric
 * kernels work in whatever frame their caller passed. What was missing was any
 * record of WHICH frame each site believes it is in, so a frame mistake
 * (source-local where project-local was meant, render-local where world was
 * meant) was invisible to review and invisible to CI. The buffer is the same
 * `Float32Array` in all four frames, so nothing else catches it.
 *
 * Entries are keyed by file plus the enclosing SYMBOL, not by line number: a
 * line number churns on every edit above it, a function name does not. Nested
 * scopes are dotted (`Viewer.clipKeptCount`, `computeLassoVolume.pack`).
 *
 * The accessors that let a site avoid a raw read entirely:
 *   `sourcePositions` / `renderLocalPositions`   src/model/pointFrames.ts
 *   `worldXYZ` / `projectXYZ`                    src/model/PointCloud.ts
 *   `forEachPlacedPoint` / `iteratePlacedPoints` src/geo/placementIterator.ts
 *   `copyPlacedPositions`                        src/render/measure/lassoVolumeCompute.ts
 *
 * To bank a reduction, or to pick up a symbol rename:
 *   node scripts/lint-position-access.mjs --update
 * That rewrites the counts and carries every existing classification across.
 * It deliberately CANNOT classify a new read: new keys are written as
 * `UNCLASSIFIED` and keep failing until a human names the frame. There is no
 * flag that raises a baseline either. Growth is always a hand-edited act.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = resolve(ROOT, 'docs/validation/position-access-baseline.json');
const FRAMES = resolve(ROOT, 'docs/validation/position-frames.json');
const FRAME_DOC = 'docs/validation/position-frames.json';
const SRC = resolve(ROOT, 'src');

/** The four frames a position can be in. Anything else is a typo, not a frame. */
const VALID_FRAMES = ['source-local', 'project-local', 'render-local', 'world'];
/** What `--update` writes for a read it found and nobody has classified. */
const UNCLASSIFIED = 'UNCLASSIFIED';
/** The one-line reminder every unclassified-read message ends with. */
const USE_AN_ACCESSOR =
  'Either read through an accessor (sourcePositions / renderLocalPositions / worldXYZ / '
  + 'projectXYZ / copyPlacedPositions / forEachPlacedPoint), or classify the read.';

/** Every .ts file under src/, excluding tests. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/**
 * The direct `.positions` reads on one line, ignoring comments.
 *
 * A comment mentioning the field is documentation, not a call site, and
 * counting it would make the ratchet fire on someone explaining the migration.
 * This is the ORIGINAL detection rule, unchanged. The classification layer
 * below must not quietly narrow what counts as a read.
 */
function readsOnLine(raw) {
  const line = raw.trim();
  if (line.startsWith('*') || line.startsWith('//') || line.startsWith('/*')) return 0;
  const stripped = raw.replace(/\/\/.*$/, '');
  return (stripped.match(/\.positions\b/g) ?? []).length;
}

/** Leading whitespace width. Tabs count as one, which is enough to order lines. */
const indentOf = (line) => line.length - line.trimStart().length;

/** True for a line that carries no code: blank, or comment. */
function isVoidLine(raw) {
  const t = raw.trim();
  return t === '' || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/** Words that open a block but declare nothing, so they never name a scope. */
const CONTROL_WORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'do', 'try', 'new',
  'typeof', 'await', 'yield', 'throw', 'case', 'delete', 'void', 'in', 'of',
]);

/**
 * The name this line declares, or null.
 *
 * Deliberately conservative. A false positive invents a scope that vanishes on
 * the next rename and churns the allowlist; a false negative only attributes a
 * read to the enclosing scope instead, which is still stable and still names a
 * real place in the file.
 */
function declaredName(raw) {
  const line = raw.trim();

  let m = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(line);
  if (m) return m[1];

  m = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(line);
  if (m) return m[1];

  // `const f = (…) =>`, `const f = function`, `const f: T = async (…) =>`
  m = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s+)?(?:function\b|\(|<|[A-Za-z_$][\w$]*\s*=>)/.exec(line);
  if (m) return m[1];

  // An object-literal member whose value is a function: `onNodeReady: (n) => {`.
  m = /^([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?(?:function\b|\()/.exec(line);
  if (m && !CONTROL_WORDS.has(m[1])) return m[1];

  // A handler assigned onto an object: `ctx.onmessage = (event) => {`. The two
  // worker entry points are written this way, and `(module)` would be a poorer
  // name for the only scope in the file that reads positions.
  m = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*=\s*(?:async\s+)?(?:function\b|\()/.exec(line);
  if (m) return m[1];

  // A class method, constructor or accessor. Guarded hard against a CALL,
  // which has the same `name(` shape. A declaration never ends in a semicolon
  // and never has an `=` or a `.` ahead of its parameter list; beyond that its
  // parameters are either absent, type-annotated, or wrapped onto the next
  // line, none of which a plain call argument list looks like.
  m = /^(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set)\s+)*\*?\s*([A-Za-z_$#][\w$]*)\s*(?:<[^(]*>)?\s*\(/.exec(line);
  if (m && !CONTROL_WORDS.has(m[1]) && !line.endsWith(';')) {
    const open = line.indexOf('(');
    const head = line.slice(0, open);
    const params = line.slice(open + 1);
    const declarative = line.endsWith('(') || params.startsWith(')') || params.includes(':');
    if (!head.includes('=') && !head.includes('.') && declarative) return m[1];
  }

  return null;
}

/**
 * A line that continues a construct opened above it rather than opening one.
 *
 * A wrapped parameter list closes with `)`, a wrapped object return type with
 * `}`, a wrapped union with `|`. All three sit at the DECLARATION's indent, so
 * treating them as a new, tighter scope bound walks straight past the name.
 */
const CONTINUES_ABOVE = /^[)\]}|&,:?]/;

/**
 * The dotted symbol path enclosing `lineIdx`, for example `Viewer.clipKeptCount`.
 *
 * Walks upward for the nearest declaration at a strictly smaller indent, then
 * repeats from there. Strictly smaller is what makes a CLOSED sibling scope
 * invisible: a nested function that ended above the read sits at the same
 * indent as the read, so it is skipped rather than claimed as the parent.
 *
 * The one exception is a multi-line signature. This repo wraps long parameter
 * lists and inline return types, so the line above the body is `): Return {` or
 * `} | null {` and the name is several lines further up at the SAME indent. A
 * continuation line therefore keeps same-indent lines in play instead of
 * tightening past the head, which is the difference between
 * `Viewer.gatherTerrainPositions` and a bare `Viewer`.
 *
 * A module-level read gets `(module)`, which is a real key like any other.
 */
function symbolPathAt(lines, lineIdx) {
  const path = [];
  let bound = indentOf(lines[lineIdx]);
  for (let i = lineIdx - 1; i >= 0 && bound > 0; i--) {
    const line = lines[i];
    if (isVoidLine(line)) continue;
    const ind = indentOf(line);
    if (ind >= bound) continue;
    const name = declaredName(line);
    if (name) {
      path.unshift(name);
      bound = ind;
      if (ind === 0) break;
    } else {
      // A wrapped signature: its head is above, at this same indent.
      bound = CONTINUES_ABOVE.test(line.trimStart()) ? ind + 1 : ind;
    }
  }
  return path.length > 0 ? path.join('.') : '(module)';
}

/** Every read site in a file, grouped by enclosing symbol. */
function sitesIn(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const bySymbol = new Map();
  for (let i = 0; i < lines.length; i++) {
    const n = readsOnLine(lines[i]);
    if (n === 0) continue;
    const symbol = symbolPathAt(lines, i);
    const site = bySymbol.get(symbol) ?? { reads: 0, lines: [] };
    site.reads += n;
    site.lines.push(i + 1);
    bySymbol.set(symbol, site);
  }
  return bySymbol;
}

/**
 * The baseline and the allowlist are COMMITTED files keyed by
 * repository-relative path, so the key has to be the same string on every
 * operating system. `path.relative` returns `src\core\x.ts` on Windows, which
 * matches nothing in a file written with forward slashes: the gate would then
 * report every counted file as new and fail a clean tree. Normalising the
 * separator is a no-op on POSIX, where `sep` is already `/`.
 */
const posix = (p) => p.split(sep).join('/');

// ── scan ────────────────────────────────────────────────────────────────────

/** file → Map(symbol → { reads, lines }), for every file with at least one read. */
const scanned = new Map();
/** file → total reads, the shape the shrink-only baseline has always used. */
const current = {};
for (const file of walk(SRC)) {
  const bySymbol = sitesIn(file);
  if (bySymbol.size === 0) continue;
  const rel = posix(relative(ROOT, file));
  scanned.set(rel, bySymbol);
  current[rel] = [...bySymbol.values()].reduce((a, s) => a + s.reads, 0);
}
const total = Object.values(current).reduce((a, b) => a + b, 0);

// ── --update ────────────────────────────────────────────────────────────────

const update = process.argv.includes('--update');

/** Existing classifications by key, so `--update` can never lose one. */
function existingClassifications() {
  const kept = new Map();
  if (!existsSync(FRAMES)) return kept;
  for (const e of JSON.parse(readFileSync(FRAMES, 'utf8')).entries ?? []) {
    kept.set(`${e.file}::${e.symbol}`, { frame: e.frame, why: e.why });
  }
  return kept;
}

if (update || !existsSync(BASELINE) || !existsSync(FRAMES)) {
  writeFileSync(BASELINE, `${JSON.stringify({ total, files: current }, null, 2)}\n`);

  const kept = existingClassifications();
  const entries = [];
  let added = 0;
  for (const [file, bySymbol] of [...scanned].sort(([a], [b]) => a.localeCompare(b))) {
    for (const [symbol, site] of [...bySymbol].sort(([a], [b]) => a.localeCompare(b))) {
      const prior = kept.get(`${file}::${symbol}`);
      if (!prior) added++;
      entries.push({
        file,
        symbol,
        frame: prior?.frame ?? UNCLASSIFIED,
        reads: site.reads,
        why: prior?.why ?? '',
      });
    }
  }
  const doc = {
    purpose:
      'Every direct `.positions` read in src/, classified by the coordinate frame the reading '
      + 'site expects. Keyed by file plus enclosing symbol so the key survives edits above it. '
      + '`frame` is one of the four below, or an array of them for a site that genuinely reads '
      + 'more than one (a combined estimator over static layers and streaming nodes). `why` is '
      + 'required and must be the reason, not a restatement of the frame name. '
      + 'Enforced by scripts/lint-position-access.mjs; a read with no entry fails CI.',
    frames: {
      'source-local':
        "The buffer as the loader wrote it, relative to the cloud's own sourceOrigin.",
      'project-local':
        "Source-local plus the layer's Float64 sourceToProject translation, the shared project frame.",
      'render-local':
        'Relative to a render origin picked for float precision: streaming node buffers, GPU uploads.',
      world: "Source-local plus sourceOrigin, in the file's own CRS.",
    },
    entries,
  };
  writeFileSync(FRAMES, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(
    `position-access baseline written: ${total} reads across ${Object.keys(current).length} files, `
    + `${entries.length} classified sites`
    + (added > 0 ? `, ${added} NEW and still ${UNCLASSIFIED}.` : '.'),
  );
  process.exit(0);
}

// ── rule 1: shrink-only ─────────────────────────────────────────────────────

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
const problems = [];

for (const [file, n] of Object.entries(current)) {
  const allowed = baseline.files[file];
  if (allowed === undefined) {
    problems.push(`${file}: ${n} direct .positions read(s) in a file that had none. Route through the transform boundary, or add it to the baseline deliberately.`);
  } else if (n > allowed) {
    problems.push(`${file}: ${n} direct .positions reads, baseline ${allowed}. The migration surface may shrink, never grow.`);
  }
}

if (total > baseline.total) {
  problems.push(`total ${total} reads, baseline ${baseline.total}.`);
}

// ── rule 2: every read names its frame ──────────────────────────────────────

const allow = JSON.parse(readFileSync(FRAMES, 'utf8'));
const classified = new Map();
for (const e of allow.entries ?? []) {
  const key = `${e.file}::${e.symbol}`;
  if (classified.has(key)) {
    problems.push(`${FRAME_DOC}: duplicate entry for ${e.file} · ${e.symbol}.`);
  }
  classified.set(key, e);
  // A site may name SEVERAL frames. A combined estimator that walks static
  // layers and streaming nodes in one pass genuinely reads two frames, and
  // forcing one label there would make the honest answer unwritable.
  const named = Array.isArray(e.frame) ? e.frame : [e.frame];
  const bad = named.filter((f) => !VALID_FRAMES.includes(f));
  if (named.length === 0 || bad.length > 0) {
    problems.push(
      `${e.file} · ${e.symbol}: frame ${JSON.stringify(e.frame)} is not one of `
      + `${VALID_FRAMES.join(', ')} (or a non-empty array of them).`
      + (named.includes(UNCLASSIFIED)
        ? `\n      A direct read here has never been classified. ${USE_AN_ACCESSOR}`
        : ''),
    );
  } else if (typeof e.why !== 'string' || e.why.trim() === '') {
    problems.push(
      `${e.file} · ${e.symbol}: "why" must say, in one sentence, why this site reads `
      + `${named.join(' + ')} coordinates.`,
    );
  }
}

let stale = 0;
for (const [file, bySymbol] of scanned) {
  for (const [symbol, site] of bySymbol) {
    const entry = classified.get(`${file}::${symbol}`);
    if (!entry) {
      problems.push(
        `${file}:${site.lines.join(',')} · ${symbol}: ${site.reads} direct .positions read(s) `
        + `in an UNCLASSIFIED site.\n      ${USE_AN_ACCESSOR}`
        + `\n      To classify: run "node scripts/lint-position-access.mjs --update", then name `
        + `the frame this site expects in ${FRAME_DOC}.`,
      );
      continue;
    }
    if (site.reads > entry.reads) {
      problems.push(
        `${file}:${site.lines.join(',')} · ${symbol}: ${site.reads} direct .positions reads, `
        + `${entry.reads} classified as "${entry.frame}".\n      A NEW read appeared in an `
        + `already-classified site. ${USE_AN_ACCESSOR}\n      Raise the count in ${FRAME_DOC} `
        + `only if the new read really is "${entry.frame}".`,
      );
    } else if (site.reads < entry.reads) {
      stale++;
    }
  }
}
for (const key of classified.keys()) {
  const [file, symbol] = key.split('::');
  if (!scanned.get(file)?.has(symbol)) stale++;
}

if (problems.length > 0) {
  console.error('lint:position-access FAILED\n');
  for (const p of problems) console.error(`  • ${p}`);
  console.error(`\nFrames and what they mean: ${FRAME_DOC}`);
  console.error('Accessors: src/model/pointFrames.ts, src/model/PointCloud.ts, src/geo/placementIterator.ts.');
  console.error('Boundary: docs/architecture/project-spatial-frame.md.');
  process.exit(1);
}

const shrunk = baseline.total - total;
console.log(
  `lint:position-access OK: ${total} direct reads across ${Object.keys(current).length} files, `
  + 'every one classified by frame'
  + (shrunk > 0 ? ` (${shrunk} fewer than baseline; run --update to lower it)` : '')
  + (stale > 0 ? `; ${stale} stale allowlist entr${stale === 1 ? 'y' : 'ies'}, run --update to prune` : '')
  + '.',
);
