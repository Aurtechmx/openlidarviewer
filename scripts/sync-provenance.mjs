#!/usr/bin/env node
/**
 * sync-provenance.mjs
 *
 * Every Dependabot npm bump (e.g. proj4 2.20.9 -> 2.21.0) moves the resolved
 * version in package-lock.json — and sometimes the declared range in
 * package.json — out from under three HAND-MAINTAINED provenance files:
 *   - THIRD_PARTY_NOTICES.md  (curated: license text, upstream URLs)
 *   - codemeta.json           (curated: authorship, citations, identifiers)
 *   - sbom.json               (curated CycloneDX: descriptions, hashes, refs)
 * When they drift, `lint:release-truth` and `lint:sbom` fail. Before this tool
 * that meant editing three files by hand on every bump and getting the
 * CycloneDX bom-ref / purl / dependency-graph formats right each time.
 *
 * WHY SYNC, NOT REGENERATE. These files are not machine output we can rebuild.
 * Regenerating THIRD_PARTY_NOTICES.md would drop the reproduced MIT text, the
 * per-license attribution, and the test-fixture provenance notes. Regenerating
 * codemeta.json would drop the DOI/SWH identifiers, authors, and citations.
 * Regenerating sbom.json with cyclonedx-npm would rewrite descriptions,
 * timestamps, and serial numbers, producing a churny diff no reviewer can read.
 * So this tool touches ONLY the version-dependent fields and preserves every
 * other byte: it reads package.json + package-lock.json and rewrites, in place,
 * exactly the values the two linters derive from those two machine files.
 *
 * What it syncs, per file:
 *   THIRD_PARTY_NOTICES.md  each dependency row's "Declared range" (package.json)
 *                           and "Resolved" (lockfile) columns.
 *   codemeta.json           each softwareRequirements entry's `version`
 *                           (the DECLARED range, matching package.json).
 *   sbom.json               each component's version, bom-ref
 *                           (openlidarviewer@<root>|<name>@<version>), purl
 *                           (pkg:npm/<name>@<version>), the tarball URL version,
 *                           AND every dependency-graph ref/dependsOn that points
 *                           at a changed bom-ref (or the root) — those MUST move
 *                           together or the graph dangles.
 *
 * Faithfulness is provable: on a clean checkout the committed files already
 * match the lockfile, so running this MUST produce an empty diff. If it doesn't,
 * the writer is not format-faithful and is wrong. (The JSON writers rely on the
 * files being `JSON.stringify(obj, null, 2)` output — verified by a roundtrip so
 * a parse/mutate/stringify pass is byte-identical when nothing changed.)
 *
 * Usage:
 *   node scripts/sync-provenance.mjs           rewrite the three files in place
 *   node scripts/sync-provenance.mjs --check    exit 1 if any file is out of sync
 *                                               (write nothing) — for CI drift.
 *
 * Dependency-free by contract (scripts/ may only import existing deps): this
 * uses node built-ins and reads package-lock.json directly.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => (existsSync(resolve(ROOT, p)) ? readFileSync(resolve(ROOT, p), 'utf8') : null);

/**
 * Build the two lookups every writer needs from the authoritative machine files:
 *   declaredRange(name) -> the range in package.json (deps or devDeps), or null.
 *   lockedVersion(name) -> the resolved version in package-lock.json, or null.
 * The locked version is the top-level install; all three provenance files
 * describe the deduped top-level tree, so `node_modules/<name>` is the key.
 */
function buildLookups() {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  const declared = { ...pkg.dependencies, ...pkg.devDependencies };
  const declaredRange = (name) => (Object.prototype.hasOwnProperty.call(declared, name) ? declared[name] : null);
  const lockedVersion = (name) => lock.packages?.[`node_modules/${name}`]?.version ?? null;
  return { pkg, declaredRange, lockedVersion };
}

/** Preserve a markdown-cell's exact surrounding whitespace, swap only the token. */
function replaceCellToken(cell, value) {
  return cell.replace(/^(\s*)(.*?)(\s*)$/, (_, lead, _tok, trail) => `${lead}${value}${trail}`);
}

/**
 * THIRD_PARTY_NOTICES.md: for every table row whose package (column 1) is a
 * declared dependency, rewrite column 2 (Declared range) from package.json and
 * column 3 (Resolved) from the lockfile. Header/separator rows and prose are
 * left untouched; a row for a package we don't declare is left alone.
 */
function syncNotices(text, { declaredRange, lockedVersion }) {
  return text
    .split('\n')
    .map((line) => {
      if (!line.startsWith('|')) return line;
      const cells = line.split('|'); // ['', ' name ', ' range ', ' resolved ', ...]
      if (cells.length < 5) return line;
      const name = cells[1].trim();
      const range = declaredRange(name);
      if (range == null) return line; // header, separator, or a non-declared row
      const locked = lockedVersion(name);
      cells[2] = replaceCellToken(cells[2], range);
      if (locked != null) cells[3] = replaceCellToken(cells[3], locked);
      return cells.join('|');
    })
    .join('\n');
}

/** Re-serialize an object the way cyclonedx-npm / codemeta do, preserving the
 *  original trailing-newline convention so a no-op pass is byte-identical. */
function stringifyLike(original, obj) {
  return JSON.stringify(obj, null, 2) + (original.endsWith('\n') ? '\n' : '');
}

/**
 * codemeta.json: each softwareRequirements entry is an npm dependency; its
 * `version` mirrors the DECLARED range in package.json (not the resolved one).
 * The `citation` block (GDAL, proj4js) is external provenance, not an npm
 * dependency, so it is deliberately left alone.
 */
function syncCodemeta(text, { declaredRange }) {
  const doc = JSON.parse(text);
  for (const req of doc.softwareRequirements ?? []) {
    const range = declaredRange(req.identifier ?? req.name);
    if (range != null) req.version = range;
  }
  return stringifyLike(text, doc);
}

/** Swap the version segment of a purl (pkg:npm/name@VERSION[?qualifiers]),
 *  keeping any qualifier string intact. Scoped names encode '@' as '%40', so
 *  the last literal '@' is always the version separator. */
function bumpPurlVersion(purl, version) {
  const at = purl.lastIndexOf('@');
  if (at === -1) return purl;
  const q = purl.indexOf('?', at);
  const end = q === -1 ? purl.length : q;
  return purl.slice(0, at + 1) + version + purl.slice(end);
}

/**
 * sbom.json (CycloneDX): rewrite the version-dependent fields of the root and
 * every component to the locked tree, then repoint the dependency graph.
 *
 * bom-ref carries the root version too (openlidarviewer@<root>|<name>@<ver>), so
 * a root bump would move every ref — we build an old->new map from the actual
 * strings in the file and remap the graph's `ref`/`dependsOn` through it, which
 * keeps the graph consistent whether a dependency version or the root moved.
 */
function syncSbom(text, { pkg, lockedVersion }) {
  const sbom = JSON.parse(text);
  const rootVersion = pkg.version;
  const rootRef = `openlidarviewer@${rootVersion}`;
  const refMap = new Map();

  // Root component.
  const rootC = sbom.metadata?.component;
  if (rootC) {
    refMap.set(rootC['bom-ref'], rootRef);
    rootC.version = rootVersion;
    rootC['bom-ref'] = rootRef;
    if (rootC.purl) rootC.purl = bumpPurlVersion(rootC.purl, rootVersion);
  }

  // Every listed component -> its locked version.
  for (const c of sbom.components ?? []) {
    if (!c || !c.name) continue;
    const full = c.group ? `${c.group}/${c.name}` : c.name;
    const locked = lockedVersion(full);
    if (locked == null) continue; // not in the locked tree; leave as curated
    const oldVersion = c.version;
    const newRef = `${rootRef}|${full}@${locked}`;
    refMap.set(c['bom-ref'], newRef);
    c.version = locked;
    c['bom-ref'] = newRef;
    if (c.purl) c.purl = bumpPurlVersion(c.purl, locked);
    // The distribution tarball URL ends with '-<version>.tgz'. Only the version
    // moves; the integrity hash is not recomputed here (that needs the tarball).
    for (const ref of c.externalReferences ?? []) {
      if (typeof ref.url === 'string' && ref.url.endsWith(`-${oldVersion}.tgz`)) {
        ref.url = ref.url.slice(0, -`-${oldVersion}.tgz`.length) + `-${locked}.tgz`;
      }
    }
  }

  // Repoint the dependency graph through the old->new bom-ref map.
  for (const dep of sbom.dependencies ?? []) {
    if (dep.ref != null && refMap.has(dep.ref)) dep.ref = refMap.get(dep.ref);
    if (Array.isArray(dep.dependsOn)) {
      dep.dependsOn = dep.dependsOn.map((r) => refMap.get(r) ?? r);
    }
  }

  return stringifyLike(text, sbom);
}

// ── Driver ────────────────────────────────────────────────────────────────
const TARGETS = [
  { path: 'THIRD_PARTY_NOTICES.md', sync: syncNotices },
  { path: 'codemeta.json', sync: syncCodemeta },
  { path: 'sbom.json', sync: syncSbom },
];

function run({ check }) {
  const lookups = buildLookups();
  const drifted = [];
  for (const { path, sync } of TARGETS) {
    const current = read(path);
    if (current == null) {
      console.error(`sync-provenance: ${path} is missing.`);
      process.exitCode = 1;
      continue;
    }
    const next = sync(current, lookups);
    if (next === current) continue;
    drifted.push(path);
    if (!check) writeFileSync(resolve(ROOT, path), next);
  }

  if (check) {
    if (drifted.length === 0) {
      console.log('sync-provenance --check OK — all three provenance files match package.json + package-lock.json.');
      process.exit(process.exitCode || 0);
    }
    console.error('sync-provenance --check FAILED — these files are out of sync with the manifest/lockfile:');
    for (const p of drifted) console.error(`  • ${p}`);
    console.error('\n  Run: npm run gen:provenance');
    process.exit(1);
  }

  if (drifted.length === 0) {
    console.log('sync-provenance OK — all three provenance files already matched the manifest/lockfile; nothing to write.');
  } else {
    console.log(`sync-provenance: rewrote ${drifted.length} file(s) to match package.json + package-lock.json:`);
    for (const p of drifted) console.log(`  • ${p}`);
  }
  process.exit(process.exitCode || 0);
}

run({ check: process.argv.includes('--check') });
