#!/usr/bin/env node
/**
 * lint-architecture-truth.mjs — machine-checks that the architecture docs state
 * the same facts the tree actually holds.
 *
 * Architecture prose drifts. A doc says a flag is on after it was turned off, or
 * that nothing imports a module after two consumers adopted it, and the claim
 * reads as authoritative long after it stopped being true. This guard derives a
 * fixed set of facts straight from the source — line counts, a build flag, a
 * schema version, importer and read counts, worker and migration-step counts —
 * and fails when an architecture document states a contradicting value.
 *
 * SCOPE: only machine-derivable numbers, flags and booleans. Prose caveats,
 * design rationale and historical planning snapshots are deliberately out of
 * scope; a check here fires only on a value the tree can settle exactly. Each
 * check targets a specific, present-tense claim in a living architecture doc, so
 * historical "Done at N lines" notes in planning docs do not trip it.
 *
 * There is no baseline and no --update: the tree is the source of truth, so the
 * only way to make this pass is to correct the doc.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCOPES, scanPositionReads } from './lib/positionReads.mjs';
import { measureModuleGraph } from './lint-module-graph.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * Read a tracked file, turning a missing one into a stated lint failure rather
 * than an uncaught ENOENT. A stack trace from inside a release stage reads as a
 * broken toolchain; "required document is missing" reads as what it is, and
 * names the file the gate expected.
 */
const read = (rel) => {
  try {
    return readFileSync(resolve(ROOT, rel), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new Error(`required file is missing: ${rel}`);
    }
    throw err;
  }
};
const countLines = (rel) => read(rel).split('\n').length;

/** Every .ts line under a file or directory, counted the way `wc -l` does. */
function countTsLines(rel) {
  const abs = resolve(ROOT, rel);
  if (!existsSync(abs)) return 0;
  if (statSync(abs).isFile()) return rel.endsWith('.ts') ? countLines(rel) : 0;
  let n = 0;
  for (const entry of readdirSync(abs)) {
    n += countTsLines(join(rel, entry));
  }
  return n;
}

/**
 * How the layer table writes a size. Bucketed so ordinary commits do not churn
 * the document: a layer has to move by ~500 lines before its cell is wrong.
 */
function sizeBucket(lines) {
  if (lines >= 10_000) return `~${Math.round(lines / 1000)}k`;
  if (lines >= 1000) return `~${(lines / 1000).toFixed(1)}k`;
  return `~${Math.round(lines / 10) * 10}`;
}

/**
 * The mount state a document asserts in words, as 'enabled' | 'disabled', or
 * null when it makes no present-tense assertion. Matches a PRESENT-TENSE verb
 * (is/ships/shipped/remains/stays/now) so a historical "was disabled before
 * v0.6.5" does not register; runs on whitespace-normalised text because the
 * assertion wraps across a line break ("Multi-layer mounting\nshipped
 * enabled"); and the [^.] gap stops at a sentence period, so a historical
 * clause cannot reach a later present-tense verb inside the same match.
 */
export function mountStateFromProse(text) {
  const re = /multi-layer\s+mount(?:ing)?\b[^.]{0,30}?\b(?:is|ships|shipped|remains|stays|now)\s+(enabled|disabled)\b/i;
  const m = String(text).replace(/\s+/g, ' ').match(re);
  return m ? m[1].toLowerCase() : null;
}

const problems = [];
/** Checks deliberately not performed (absent optional documents). */
const notes = [];
const facts = [];
const fact = (name, value) => {
  facts.push(`${name} = ${value}`);
  return value;
};

// ── Fact 1: monolith line counts ────────────────────────────────────────────
// Reuse the monolith-size baseline as the recorded current counts, and derive
// the live counts the same way the ratchet does. The baseline must not drift
// from the tree, and the architecture map's stated current sizes must match.
{
  const BASELINE = 'docs/validation/monolith-size-baseline.json';
  const monoFiles = { 'src/main.ts': null, 'src/render/Viewer.ts': null };
  for (const f of Object.keys(monoFiles)) monoFiles[f] = countLines(f);
  fact('main.ts lines', monoFiles['src/main.ts']);
  fact('Viewer.ts lines', monoFiles['src/render/Viewer.ts']);
  // style.css was split into ordered section files under src/styles/; record
  // the partition's combined line count in its place.
  const styleTotal = readdirSync(resolve(ROOT, 'src/styles'))
    .filter((f) => f.endsWith('.css'))
    .reduce((n, f) => n + countLines(`src/styles/${f}`), 0);
  fact('src/styles/*.css lines', styleTotal);

  if (existsSync(resolve(ROOT, BASELINE))) {
    const baseline = JSON.parse(read(BASELINE));
    for (const f of ['src/main.ts', 'src/render/Viewer.ts']) {
      const recorded = baseline.files?.[f]?.lines;
      if (recorded !== undefined && recorded !== monoFiles[f]) {
        problems.push(
          `${BASELINE}: records ${f} at ${recorded} lines, tree has ${monoFiles[f]}. `
          + 'Run "node scripts/lint-monolith-size.mjs --update" to re-bank the count.',
        );
      }
    }
  }

  // The architecture map states each monolith's current size in a table row and
  // a section header: `| \`src/main.ts\` | 5,927 |` and `**\`src/main.ts\` (5,927)**`.
  const MAP = 'docs/architecture/architecture-map.md';
  const mapText = read(MAP);
  const sizeRe = /`src\/(main\.ts|render\/Viewer\.ts)`\s*[|(]\s*([\d,]+)/g;
  const expected = { 'main.ts': monoFiles['src/main.ts'], 'render/Viewer.ts': monoFiles['src/render/Viewer.ts'] };
  for (const m of mapText.matchAll(sizeRe)) {
    const stated = Number(m[2].replace(/,/g, ''));
    if (stated !== expected[m[1]]) {
      problems.push(
        `${MAP}: states src/${m[1]} at ${m[2]} lines; the tree has ${expected[m[1]]}. `
        + 'Update the stated current size.',
      );
    }
  }
}

// ── Fact 1b: the layer table's stated sizes ─────────────────────────────────
// The map opens with a layer table whose Size column described the tree when it
// was written. Nothing derived those figures, so decomposition moving code
// between layers left them behind: at the v0.6.8 archive every row was stale,
// `src/app` by a factor of nine, while this lint still reported OK because it
// only read the two monolith counts. The sizes are derived here and the row for
// each layer must state the current bucket.
{
  const MAP = 'docs/architecture/architecture-map.md';
  const mapText = read(MAP);
  // The layer groups exactly as the table's Path column lists them.
  const LAYERS = [
    ['src/process', 'src/numeric.ts', 'src/units'],
    ['src/model'],
    ['src/geo'],
    ['src/terrain', 'src/validation', 'src/analysis', 'src/science'],
    ['src/io'],
    ['src/render'],
    ['src/export', 'src/report', 'src/convert'],
    ['src/app'],
    ['src/ui'],
  ];
  for (const paths of LAYERS) {
    const lines = paths.reduce((n, p) => n + countTsLines(p), 0);
    const stated = sizeBucket(lines);
    fact(`${paths[0]} layer lines`, lines);
    // The row is the one whose Path cell names every path in the group.
    const row = mapText
      .split('\n')
      .find((l) => l.startsWith('|') && paths.every((p) => l.includes(`\`${p}\``)));
    if (row === undefined) {
      problems.push(`${MAP}: no layer row names ${paths.join(', ')}. The table no longer covers the tree.`);
      continue;
    }
    if (!row.includes(stated)) {
      problems.push(
        `${MAP}: the ${paths.join(' + ')} row states a size the tree does not have; it is ${lines} lines, `
        + `which this table writes as "${stated}". Update the Size cell.`,
      );
    }
  }
}

// ── Fact 2: SpatialContext importer count ───────────────────────────────────
// Real importers of the façade, counted from actual import statements.
{
  const importerRe = /import[^;]*\bfrom\s*['"][^'"]*geo\/SpatialContext['"]/;
  let importers = 0;
  for (const f of walk(resolve(ROOT, 'src'))) {
    if (f.endsWith('SpatialContext.ts')) continue;
    if (importerRe.test(readFileSync(f, 'utf8'))) importers += 1;
  }
  fact('SpatialContext importers', importers);

  // If consumers have adopted the façade, no doc may still assert none do.
  const noImporterClaims = [
    { file: 'src/geo/SpatialContext.ts', re: /Nothing imports this module yet/i },
    { file: 'docs/architecture/spatial-context-consumers.md', re: /has no importers yet/i },
    { file: 'docs/architecture/spatial-context-consumers.md', re: /routes\s+\*\*zero\*\*\s+consumers/i },
  ];
  if (importers > 0) {
    for (const c of noImporterClaims) {
      if (existsSync(resolve(ROOT, c.file)) && c.re.test(read(c.file))) {
        problems.push(
          `${c.file}: claims nothing imports SpatialContext, but ${importers} file(s) do. `
          + 'Correct the importer-status text.',
        );
      }
    }
  }
}

// ── Fact 3: MULTI_LAYER_MOUNT_ENABLED flag ──────────────────────────────────
{
  const svc = read('src/app/LayerService.ts');
  const m = svc.match(/export\s+const\s+MULTI_LAYER_MOUNT_ENABLED\s*=\s*(true|false)/);
  if (!m) {
    problems.push('src/app/LayerService.ts: could not read MULTI_LAYER_MOUNT_ENABLED.');
  } else {
    const enabled = m[1] === 'true';
    fact('MULTI_LAYER_MOUNT_ENABLED', enabled);
    // Any doc stating "MULTI_LAYER_MOUNT_ENABLED is true/false" must match.
    for (const rel of archDocs()) {
      const text = read(rel);
      const claim = text.match(/MULTI_LAYER_MOUNT_ENABLED`?\s+is\s+(true|false)/i);
      if (claim && (claim[1].toLowerCase() === 'true') !== enabled) {
        problems.push(
          `${rel}: states MULTI_LAYER_MOUNT_ENABLED is ${claim[1]}; the code sets it to ${m[1]}.`,
        );
      }
    }
    // The policy prose states the mount state in words, not by flag name — the
    // The policy prose states the mount state in words, not by flag name — the
    // v0.6.4 "mount is disabled" line outlived the v0.6.5 flip and no check
    // covered STABILITY_POLICY. Hold that present-tense assertion to the flag.
    for (const rel of ['docs/project/STABILITY_POLICY.md', ...archDocs()]) {
      const abs = resolve(ROOT, rel);
      if (!existsSync(abs)) continue;
      const stated = mountStateFromProse(read(rel));
      if (stated && (stated === 'enabled') !== enabled) {
        problems.push(
          `${rel}: describes multi-layer mounting as ${stated}; the code sets `
          + `MULTI_LAYER_MOUNT_ENABLED = ${m[1]}.`,
        );
      }
    }
  }
}

// ── Fact 4: session schema version ──────────────────────────────────────────
{
  const m = read('src/io/session.ts').match(/export\s+const\s+SESSION_VERSION\s*=\s*(\d+)/);
  if (m) {
    const version = Number(m[1]);
    fact('SESSION_VERSION', version);
    for (const rel of archDocs()) {
      const text = read(rel);
      const claim = text.match(/session schema (?:is (?:at )?)?version\s+(\d+)/i);
      if (claim && Number(claim[1]) !== version) {
        problems.push(`${rel}: states session schema version ${claim[1]}; the code sets SESSION_VERSION = ${version}.`);
      }
    }
  }
}

// ── Fact 5: direct .positions read surface ──────────────────────────────────
// Counted through scripts/lib/positionReads.mjs, the same module the gate
// (lint:position-access) and the report (lint:positions-reads) count through.
//
// This check is against the migration PLAN, so it uses the plan's scope:
// `outside-model`. The gate uses `all-src` and therefore reports a LARGER
// total, because it also counts the reads inside `src/model/` where the
// accessors are built. That is a scope difference, not a disagreement — and it
// was previously invisible, because both scanners printed a bare "positions
// reads" number with no scope attached and each carried its own private copy of
// the walk and the counting rule. Two unexplained numbers for one fact is the
// exact drift this lint exists to catch, so both scopes are reported here and
// both are named in the output.
{
  const SRC = resolve(ROOT, 'src');
  const PLAN_SCOPE = SCOPES['outside-model'];
  const GATE_SCOPE = SCOPES['all-src'];
  const scan = scanPositionReads(SRC, PLAN_SCOPE.id);
  const gateScan = scanPositionReads(SRC, GATE_SCOPE.id);
  const reads = scan.total;
  const files = scan.byFile;
  fact(`positions reads [${PLAN_SCOPE.id}]`, reads);
  fact(`positions read files [${PLAN_SCOPE.id}]`, files.size);
  fact(`positions reads [${GATE_SCOPE.id}, lint:position-access scope]`, gateScan.total);
  fact(`positions read files [${GATE_SCOPE.id}, lint:position-access scope]`, gateScan.fileCount);

}

// ── Fact 9: module-graph facts a CURRENT release document states in prose ───
// The release documents describe the architecture in sentences — "across 886
// modules", "fan-out is 112 for the shell, 76 for the renderer" — and no lint
// read those sentences. `lint:release-truth` checks the monolith LINE counts
// and `lint:module-graph` checks the graph against its own baseline, so a
// document could sit three numbers out of date with every check green. It did:
// KNOWN_LIMITATIONS_v0.7.0-alpha.1 stated 843 modules against a tree of 886,
// a renderer fan-out of 77 against 76, and an eager bundle of 805 KiB.
//
// Scope is deliberately the CURRENT alpha's documents only. A shipped v0.6.x
// document describes the tree as it was and must not be "corrected" into
// describing a tree it never saw.
{
  const CURRENT_DOCS = [
    'docs/releases/KNOWN_LIMITATIONS_v0.7.0-alpha.1.md',
    'docs/releases/RELEASE_NOTES_v0.7.0-alpha.1.md',
    'docs/releases/VALIDATION_REPORT_v0.7.0-alpha.1.md',
  ].filter((f) => existsSync(resolve(ROOT, f)));

  const measurement = measureModuleGraph();
  const modules = measurement.graph.size;
  const fanOutOf = (f) => (measurement.fanOut.get(f) ?? measurement.watchFanOut.get(f))?.runtime ?? null;
  const shell = fanOutOf('src/main.ts');
  const renderer = fanOutOf('src/render/Viewer.ts');
  fact('module-graph modules', modules);
  fact('main.ts runtime fan-out', shell);
  fact('Viewer.ts runtime fan-out', renderer);

  for (const doc of CURRENT_DOCS) {
    const text = read(doc).replace(/\s+/g, ' ');

    const mods = text.match(/across\s+([\d,]+)\s+modules\b/i);
    if (mods && Number(mods[1].replace(/,/g, '')) !== modules) {
      problems.push(
        `${doc}: states "across ${mods[1]} modules"; the module graph scans ${modules}. `
        + 'Run "npm run lint:module-graph" for the live figure.',
      );
    }

    // "Fan-out is 112 for the shell, 76 for the renderer" — both in one
    // sentence, so one regex settles both and a half-corrected sentence
    // cannot pass.
    const fo = text.match(/fan-out\s+is\s+(\d+)\s+for\s+the\s+shell,\s+(\d+)\s+for\s+the\s+renderer/i);
    if (fo) {
      if (shell !== null && Number(fo[1]) !== shell) {
        problems.push(`${doc}: states the shell's runtime fan-out as ${fo[1]}; the tree has ${shell}.`);
      }
      if (renderer !== null && Number(fo[2]) !== renderer) {
        problems.push(`${doc}: states the renderer's runtime fan-out as ${fo[2]}; the tree has ${renderer}.`);
      }
    }
  }
}

// ── Fact 6: active worker modules ───────────────────────────────────────────
// Worker entry modules are the `*Worker.ts` files (not their `*WorkerClient.ts`).
{
  let workers = 0;
  for (const f of walk(resolve(ROOT, 'src'))) {
    const base = f.split('/').pop();
    if (/Worker\.ts$/.test(base) && !/WorkerClient\.ts$/.test(base)) workers += 1;
  }
  fact('worker modules', workers);
  for (const rel of archDocs()) {
    const claim = read(rel).match(/(\d+)\s+worker\s+modules?/i);
    if (claim && Number(claim[1]) !== workers) {
      problems.push(`${rel}: states ${claim[1]} worker modules; the tree has ${workers}.`);
    }
  }
}

// ── Fact 7: Float64 flip-sequence step count ────────────────────────────────
// The migration roadmap enumerates a numbered flip sequence and a Status line
// "steps 1–N landed". N must equal the count of steps marked DONE.
{
  const DOC = 'docs/architecture/float64-transform.md';
  if (existsSync(resolve(ROOT, DOC))) {
    const text = read(DOC);
    const doneSteps = (text.match(/^\d+\.\s+\*\*DONE/gm) ?? []).length;
    fact('Float64 DONE steps', doneSteps);
    const status = text.match(/steps\s+1[–-](\d+)\s+landed/i);
    if (status && Number(status[1]) !== doneSteps) {
      problems.push(`${DOC}: Status says steps 1–${status[1]} landed; ${doneSteps} steps are marked DONE.`);
    }
  }
}

// ── Fact 8: persistent OOC cache reality vs the docs ────────────────────────
// The out-of-core index is a PERSISTENT, generation-gated cache (PR #760/#761):
// a build semantics version invalidates stale indices, and a whole-file digest
// gates reuse. Guard the two ways the docs could drift back to the old truth:
// (a) the semantics-version constant must exist and be folded into the cache
// generation; (b) no current architecture/limitations/README surface may call
// the OOC index temporary / removed-on-close / cross-session-reuse-is-future.
{
  const map = read('src/io/heavy/oocCacheMap.ts');
  const hasSemVer = /export\s+const\s+HEAVY_INGEST_SEMANTICS_VERSION\s*=\s*\d+/.test(map);
  const inGeneration = /cacheGeneration\s*\([^)]*\)\s*:\s*string\s*\{[\s\S]*HEAVY_INGEST_SEMANTICS_VERSION[\s\S]*\}/.test(map);
  if (!hasSemVer) {
    problems.push('src/io/heavy/oocCacheMap.ts: HEAVY_INGEST_SEMANTICS_VERSION is not defined; the persistent cache needs a build-semantics generation.');
  } else if (!inGeneration) {
    problems.push('src/io/heavy/oocCacheMap.ts: HEAVY_INGEST_SEMANTICS_VERSION is not folded into cacheGeneration(); a semantics change would not invalidate stale indices.');
  } else {
    fact('OOC persistent cache', 'generation-gated');
  }
  // The OOC index must not be described as temporary in current surfaces.
  const STALE = /out-of-core[\s\S]{0,120}?(temporary|removed when the (scan|source) closes)|OOC[\s\S]{0,80}?temporary|cross-session reuse[\s\S]{0,40}?(is|remains) future work/i;
  for (const rel of ['README.md', 'docs/limitations.md', ...archDocs()]) {
    const abs = resolve(ROOT, rel);
    if (!existsSync(abs)) continue;
    const m = read(rel).match(STALE);
    if (m) {
      problems.push(`${rel}: describes the OOC cache as temporary/removed-on-close/future ("${m[0].slice(0, 50).replace(/\s+/g, ' ')}…"); it is a persistent, generation-gated cache.`);
    }
  }
}

// ── Report ──────────────────────────────────────────────────────────────────
if (problems.length > 0) {
  console.error('lint:architecture-truth FAILED\n');
  for (const p of problems) console.error(`  • ${p}`);
  console.error('\nEach line is a fact the tree settles; correct the doc, not the guard.');
  process.exit(1);
}

console.log(`lint:architecture-truth OK — ${facts.length} facts checked against the docs.`);
console.log(facts.map((f) => `    ${f}`).join('\n'));
// Printed on the passing path too: a check that did not run is not a check that
// passed, and the difference is invisible unless it is stated.
for (const n of notes) console.log(`    (skipped) ${n}`);

// ── helpers ─────────────────────────────────────────────────────────────────
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Living architecture docs (the *.md under docs/architecture). */
function archDocs() {
  const dir = resolve(ROOT, 'docs/architecture');
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => `docs/architecture/${f}`);
}
