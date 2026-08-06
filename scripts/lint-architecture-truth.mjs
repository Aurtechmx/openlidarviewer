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
  const monoFiles = { 'src/main.ts': null, 'src/render/Viewer.ts': null, 'src/style.css': null };
  for (const f of Object.keys(monoFiles)) monoFiles[f] = countLines(f);
  fact('main.ts lines', monoFiles['src/main.ts']);
  fact('Viewer.ts lines', monoFiles['src/render/Viewer.ts']);
  fact('style.css lines', monoFiles['src/style.css']);

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
// Same walk the report-only scanner uses (src/, excluding src/model and tests),
// counting occurrences outside comments.
{
  const MODEL = resolve(ROOT, 'src/model');
  let reads = 0;
  const files = new Set();
  for (const f of walk(resolve(ROOT, 'src'), MODEL)) {
    const n = countPositionReads(readFileSync(f, 'utf8'));
    if (n > 0) { reads += n; files.add(f); }
  }
  fact('positions reads', reads);
  fact('positions read files', files.size);

  // This plan is `export-ignore`d (.gitattributes), so it is present in the
  // repository and ABSENT from the published source archive. Reading it
  // unguarded made the whole release gate ENOENT when run from that archive —
  // the gate passed for us and failed for anyone who downloaded the source.
  // A cross-check against a document that ships nowhere is a repo-only check:
  // skip it when the document is absent, and say so rather than passing
  // silently. Fact 7 below already guards its document this way.
  const PLAN = 'docs/architecture/float64-frame-migration-plan.md';
  const planText = existsSync(resolve(ROOT, PLAN)) ? read(PLAN) : null;
  if (planText === null) {
    notes.push(`${PLAN} is not present (export-ignored); its position-read claim was not cross-checked.`);
  }
  const claim = planText?.match(/([\d,]+)\s+direct\s+`?\.positions`?\s+reads\s+across\s+(\d+)\s+files/i);
  if (claim) {
    const statedReads = Number(claim[1].replace(/,/g, ''));
    const statedFiles = Number(claim[2]);
    if (statedReads !== reads) {
      problems.push(`${PLAN}: states ${claim[1]} direct .positions reads; the tree has ${reads}.`);
    }
    if (statedFiles !== files.size) {
      problems.push(`${PLAN}: states ${statedFiles} files with direct .positions reads; the tree has ${files.size}.`);
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
function walk(dir, exclude) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (exclude && full === exclude) continue;
      out.push(...walk(full, exclude));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Count `.positions` occurrences outside comment lines / trailing comments. */
function countPositionReads(text) {
  let n = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('*') || line.startsWith('//') || line.startsWith('/*')) continue;
    const stripped = raw.replace(/\/\/.*$/, '');
    n += (stripped.match(/\.positions\b/g) ?? []).length;
  }
  return n;
}

/** Living architecture docs (the *.md under docs/architecture). */
function archDocs() {
  const dir = resolve(ROOT, 'docs/architecture');
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => `docs/architecture/${f}`);
}
