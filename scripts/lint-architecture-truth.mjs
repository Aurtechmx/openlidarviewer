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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');
const countLines = (rel) => read(rel).split('\n').length;

const problems = [];
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

  const PLAN = 'docs/architecture/float64-frame-migration-plan.md';
  const planText = read(PLAN);
  const claim = planText.match(/([\d,]+)\s+direct\s+`?\.positions`?\s+reads\s+across\s+(\d+)\s+files/i);
  if (claim) {
    const statedReads = Number(claim[1].replace(/,/g, ''));
    const statedFiles = Number(claim[2]);
    if (statedReads !== reads) {
      problems.push(
        `${PLAN}: states ${claim[1]} direct .positions reads; the tree has ${reads} `
        + `in the plan's scope (${PLAN_SCOPE.label}). `
        + `Run "npm run lint:positions-reads" for the live list.`,
      );
    }
    if (statedFiles !== files.size) {
      problems.push(
        `${PLAN}: states ${statedFiles} files with direct .positions reads; the tree has `
        + `${files.size} in the plan's scope (${PLAN_SCOPE.label}).`,
      );
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
