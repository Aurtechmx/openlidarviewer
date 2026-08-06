#!/usr/bin/env node
/**
 * lint-spatial-context.mjs — the SpatialContext migration cannot drift.
 *
 * `src/geo/SpatialContext.ts` exists so every consumer that makes a metric or
 * coordinate claim reads ONE description of the frame instead of re-deriving
 * unit, datum, axis and permission for itself. That property is not something a
 * test can hold: a consumer that quietly goes back to `isLinearUnitKnown(crs)`
 * still passes its own suite, and the inventory document that says otherwise
 * still reads as true. Both failures are invisible until two surfaces disagree
 * about one scan in front of a user.
 *
 * So this checks the three things only a machine reading the whole tree can:
 *
 *   1. INVENTORY PARITY. `docs/architecture/spatial-context-consumers.md`
 *      declares, per consumer, the files that route through the context. The
 *      set of files the document calls migrated must equal the set of files
 *      that actually import the context module. A file that starts importing it
 *      without being written down fails; a file written down that does not
 *      import it fails.
 *
 *   2. NO DEPRECATED AD-HOC PREDICATE IN A MIGRATED CONSUMER. Once a consumer
 *      reads the context, re-introducing a hand-rolled unit / datum / axis test
 *      beside it re-opens the divergence — two answers in one file. The banned
 *      forms are the ones the context replaced, listed with what to read instead.
 *
 *   3. COUNT CLAIMS. Architecture prose that states how many consumers exist,
 *      or how many have moved, is checked against the table and the tree. A
 *      document that says "13 consumers" over a 12-row table, or claims a
 *      migrated count the imports do not support, fails here rather than being
 *      believed.
 *
 * Exit 0 = the document and the tree agree; exit 1 = they do not, with the
 * disagreement named.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'src');
const INVENTORY = 'docs/architecture/spatial-context-consumers.md';

/** The context module itself — it cannot import itself. */
const CONTEXT_MODULES = new Set(['src/geo/SpatialContext.ts']);

/**
 * Boundary BUILDERS, not consumers. `CrsService` owns the active scan's context
 * and hands it out; it is where the context is constructed, so it imports the
 * module without being a row in the inventory. Listing it as a consumer would
 * make the table claim a metric surface that does not exist.
 */
const BUILDERS = new Set(['src/geo/CrsService.ts']);

/**
 * Import specifiers that count as "routes through the context". A relative
 * specifier is resolved against the importing file, so `../geo/SpatialContext`
 * and `./SpatialContext` are the same edge.
 */
const CONTEXT_TARGETS = new Set([
  'src/geo/SpatialContext',
  'src/geo/frameCompatibility',
]);

/**
 * Predicates a migrated consumer must not go back to. Each is a form the
 * context already answers; the `instead` text is printed with the failure so
 * the fix is the message, not an archaeology exercise.
 */
const DEPRECATED = [
  {
    re: /\bisLinearUnitKnown\s*\(/,
    what: 'isLinearUnitKnown(...)',
    instead: 'read `ctx.linearUnitKnown` (or `ctx.metricClaimsPermitted` for the full gate)',
  },
  {
    re: /\bverticalReferenceFromDatum\s*\(/,
    what: 'verticalReferenceFromDatum(...)',
    instead: 'read `ctx.verticalReference` / `ctx.verticalReferenceKnown`',
  },
  {
    re: /\bvalidateCrsForMeasurement\s*\(/,
    what: 'validateCrsForMeasurement(...)',
    instead: 'read `ctx.metricValidity` / `ctx.metricSeverity` / `ctx.metricClaimsPermitted`',
  },
  {
    // Only the hand-derived form: a `?.` on a possibly-absent CRS, or one of the
    // conventional CRS variable names. `ctx.kind === 'geographic'` is a READ of
    // the context and is not banned — `kind` is one of its fields.
    re: /(?:\?\.kind|\b(?:crs|cur|resolved|info|srcCrs|crsInfo)\.kind)\s*===\s*'geographic'/,
    // `kind === 'projected' || kind === 'geographic'` asks a DIFFERENT question
    // — is this a real-world frame at all — which no context field answers.
    // Banning it would push a correct test into a worse shape.
    unless: /===\s*'projected'/,
    what: "a hand-derived `crs.kind === 'geographic'`",
    instead: 'read `ctx.isGeographic`',
  },
  {
    re: /verticalUnitToMetres\s*\?\?\s*[A-Za-z_$][\w$]*[.?]/,
    what: 'a hand-written `verticalUnitToMetres ?? <horizontal>` fallback chain',
    instead: "call `verticalMetresPerUnit(ctx, 'none' | 'horizontal-when-known' | 'horizontal')`",
  },
  {
    re: /['"]epsg:4979['"]|['"]4979['"]/i,
    what: 'a local vertical-datum allow-list (EPSG:4979 spelled out)',
    instead: "read the carried `verticalReference === 'ellipsoidal'`",
  },
];

/**
 * Every deprecated form present in `source`, as `{ line, what, instead }`.
 * Pure over a string so the gate can be tested without a tree on disk — the
 * failure mode this guard exists to prevent is exactly a guard that silently
 * stops matching.
 */
export function scanDeprecated(source) {
  const lines = stripComments(source).split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    for (const dep of DEPRECATED) {
      if (!dep.re.test(lines[i])) continue;
      if (dep.unless && dep.unless.test(lines[i])) continue;
      hits.push({ line: i + 1, what: dep.what, instead: dep.instead });
    }
  }
  return hits;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tree
// ─────────────────────────────────────────────────────────────────────────────

/** Every non-declaration .ts file under src/. */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/**
 * Strip block and line comments so a file that DOCUMENTS a banned predicate
 * (this migration is full of prose about the forms it replaced) is not read as
 * using one. Strings are left alone: a banned form inside a string literal is
 * still a live call site in every case that matters here.
 */
export function stripComments(src) {
  // Newlines are PRESERVED inside a stripped block comment: the reported line
  // number has to point at the real call site, and collapsing a 20-line doc
  // comment to one space shifts every line below it.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Import specifiers of a module, resolved to repo-relative paths where local. */
export function importsOf(absFile, src) {
  const out = new Set();
  const re = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    const abs = resolve(dirname(absFile), spec);
    out.add(relative(ROOT, abs).split('\\').join('/'));
  }
  return out;
}

/**
 * The gate itself. Wrapped so the module can be imported for its pure
 * helpers — a test that exercises the scanner must not exit the process.
 */
function main() {
  const files = walk(SRC);
  /** Repo-relative path → { imports:Set<string>, code:string }. */
  const tree = new Map();
  for (const abs of files) {
    const rel = relative(ROOT, abs).split('\\').join('/');
    const raw = readFileSync(abs, 'utf8');
    tree.set(rel, { imports: importsOf(abs, raw), raw });
  }

  /** Files that actually route through the context, excluding the model itself. */
  const actualImporters = new Set();
  for (const [rel, info] of tree) {
    if (CONTEXT_MODULES.has(rel) || BUILDERS.has(rel)) continue;
    for (const spec of info.imports) {
      if (CONTEXT_TARGETS.has(spec)) {
        actualImporters.add(rel);
        break;
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Document
  // ─────────────────────────────────────────────────────────────────────────────

  const docPath = resolve(ROOT, INVENTORY);
  let doc;
  try {
    doc = readFileSync(docPath, 'utf8');
  } catch {
    fail([`${INVENTORY} is missing — the inventory this gate checks does not exist.`]);
  }

  /**
   * The inventory table. Every row is
   * `| # | Consumer | Status | Routes through | … |`, where Status is one of
   * `migrated` (the consumer reads a SpatialContext directly), `carrier` (it
   * reads a fact the context computed, carried on an export model), or `pending`.
   */
  const ROW_RE = /^\|\s*(\d+)\s*\|([^|]*)\|\s*(migrated|carrier|pending)\s*\|([^|]*)\|/gm;
  const rows = [];
  let rm;
  while ((rm = ROW_RE.exec(doc)) !== null) {
    const paths = [...rm[4].matchAll(/`([^`]+)`/g)]
      .map((x) => x[1].trim())
      .filter((x) => x.endsWith('.ts'));
    rows.push({
      n: Number(rm[1]),
      name: rm[2].trim(),
      status: rm[3],
      paths,
    });
  }

  const problems = [];

  if (rows.length === 0) {
    problems.push(
      `${INVENTORY}: no inventory rows parsed. Each row must read ` +
        '`| n | Consumer | migrated|carrier|pending | `path/to/file.ts` | … |`.',
    );
  }

  // ── 1. Inventory parity ──────────────────────────────────────────────────────
  const declaredMigrated = new Set();
  const declaredAll = new Set();
  for (const row of rows) {
    if (row.status !== 'pending' && row.paths.length === 0) {
      problems.push(
        `${INVENTORY} row ${row.n} (${row.name}) is "${row.status}" but names no file. ` +
          'A routed consumer must say which file routes.',
      );
    }
    for (const p of row.paths) {
      declaredAll.add(p);
      if (row.status === 'migrated') declaredMigrated.add(p);
      if (!tree.has(p)) {
        problems.push(
          `${INVENTORY} row ${row.n} (${row.name}) names \`${p}\`, which is not a file in src/.`,
        );
      }
    }
  }

  for (const p of declaredMigrated) {
    if (!actualImporters.has(p)) {
      problems.push(
        `${INVENTORY} calls \`${p}\` migrated, but it does not import the spatial context. ` +
          'Either route it through `geo/SpatialContext` or move the row back to "pending".',
      );
    }
  }
  for (const p of actualImporters) {
    if (!declaredMigrated.has(p)) {
      problems.push(
        `\`${p}\` imports the spatial context but ${INVENTORY} does not list it as migrated. ` +
          'Add it to the consumer it belongs to — an undocumented consumer is how the inventory rots.',
      );
    }
  }

  // ── 2. No deprecated ad-hoc predicate in a routed consumer ───────────────────
  for (const p of declaredAll) {
    const info = tree.get(p);
    if (!info) continue; // already reported above
    for (const hit of scanDeprecated(info.raw)) {
      problems.push(
        `${p}:${hit.line} — ${hit.what} reappeared in a consumer the inventory calls routed. ` +
          `Instead: ${hit.instead}.`,
      );
    }
  }

  // ── 3. Count claims across the architecture docs ─────────────────────────────
  const TOTAL = rows.length;
  const MIGRATED = rows.filter((r) => r.status === 'migrated').length;
  const CARRIER = rows.filter((r) => r.status === 'carrier').length;
  const ROUTED = MIGRATED + CARRIER;

  /**
   * Prose that states a consumer count. Both the inventory and the roadmap make
   * these claims, and a stale one is exactly as misleading as stale code. `~13`
   * counts too: an approximate claim about an exact, countable set is a claim.
   */
  const COUNT_DOCS = [
    INVENTORY,
    'docs/architecture/coordinate-integrity-roadmap.md',
    'src/geo/SpatialContext.ts',
  ];
  const TOTAL_CLAIM = /~?(\d+)\s+consumers?\b/gi;
  const ROUTED_CLAIM = /~?(\d+)\s+(?:of them\s+)?(?:consumers?\s+)?(?:are\s+)?routed\b/gi;

  for (const rel of COUNT_DOCS) {
    let text;
    try {
      text = readFileSync(resolve(ROOT, rel), 'utf8');
    } catch {
      continue; // an optional doc that does not exist makes no claim
    }
    for (const m of text.matchAll(TOTAL_CLAIM)) {
      if (Number(m[1]) !== TOTAL) {
        problems.push(
          `${rel} claims "${m[0].trim()}", but the inventory table has ${TOTAL} rows. ` +
            'The prose and the table must state the same number.',
        );
      }
    }
    for (const m of text.matchAll(ROUTED_CLAIM)) {
      if (Number(m[1]) !== ROUTED) {
        problems.push(
          `${rel} claims "${m[0].trim()}", but ${ROUTED} of ${TOTAL} consumers are routed ` +
            `(${MIGRATED} migrated + ${CARRIER} carrier) according to the table and the tree.`,
        );
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────

  function fail(list) {
    console.error('lint:spatial-context FAILED\n');
    for (const p of list) console.error(`  • ${p}`);
    console.error(
      '\nThe inventory at ' + INVENTORY + ' is the machine-checked record of which ' +
        'consumers read one spatial context. Update the tree or the table so they agree.',
    );
    process.exit(1);
  }

  if (problems.length > 0) fail(problems);

  console.log(
    `lint:spatial-context OK — ${ROUTED}/${TOTAL} consumers routed ` +
      `(${MIGRATED} migrated, ${CARRIER} via an export carrier), ` +
      `${actualImporters.size} source files import the context, no deprecated predicate in a routed consumer.`,
  );
}

// Run only when invoked as a script, not when imported by a test.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
