#!/usr/bin/env node
/**
 * check-dep-singletons.mjs
 *
 * A guard against silent dependency duplication. Walks the installed
 * `node_modules` tree and fails (exit 1) if any package on the CRITICAL list
 * resolves to more than one physical on-disk copy.
 *
 * Why this exists: a single physical copy of these runtime packages is a
 * correctness invariant, not just a size win. Two copies of `three` means two
 * WebGPU/TSL runtimes whose classes fail `instanceof` across the seam; two
 * copies of `proj4` or `laz-perf` split state and WASM init; two copies of
 * `pdf-lib` bloat the already-budgeted `vendor-pdf` chunk. npm normally
 * hoists a single copy, but a transitive version bump can quietly nest a
 * second one — this catches that the moment it lands, in CI, rather than at
 * runtime.
 *
 * How it counts: it does NOT trust `npm ls` (which reports the logical tree,
 * not physical dedupe). It scans the filesystem for every directory named
 * `<pkg>/package.json` under any `node_modules` and reads its `version`. Each
 * distinct install directory is one physical copy. A single directory that
 * appears once — regardless of how many packages depend on it — passes.
 *
 * The list is intentionally SMALL: only runtime packages where a second copy
 * is an actual defect. It is not a general "no duplicates anywhere" linter —
 * duplication deep in the dev/build graph is normal and harmless.
 */

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NODE_MODULES = join(ROOT, 'node_modules');

/**
 * Runtime packages that MUST resolve to exactly one physical copy. Scoped
 * names (e.g. `@scope/pkg`) are supported.
 */
const CRITICAL = ['three', 'laz-perf', 'proj4', 'pdf-lib'];

/**
 * Recursively collect the install directory of every physical copy of the
 * given package name found under a `node_modules` root. Returns a Map of
 * absolute install dir → version string.
 */
function findCopies(pkgName, nmDir, out) {
  let entries;
  try {
    entries = readdirSync(nmDir, { withFileTypes: true });
  } catch {
    return out; // no such node_modules (e.g. a leaf without nested deps)
  }

  for (const entry of entries) {
    const name = entry.name;
    if (name === '.bin' || name === '.cache') continue;

    const full = join(nmDir, name);

    // Scoped packages: `@scope` is a directory of real package dirs.
    if (name.startsWith('@')) {
      let scopedEntries;
      try {
        scopedEntries = readdirSync(full, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const scoped of scopedEntries) {
        const scopedFull = join(full, scoped.name);
        const scopedId = `${name}/${scoped.name}`;
        recordAndRecurse(pkgName, scopedId, scopedFull, out);
      }
      continue;
    }

    recordAndRecurse(pkgName, name, full, out);
  }

  return out;
}

function recordAndRecurse(pkgName, id, dir, out) {
  // Is this directory itself an install of the package we care about?
  if (id === pkgName) {
    const pkgJson = join(dir, 'package.json');
    try {
      if (statSync(pkgJson).isFile()) {
        const { version } = JSON.parse(readFileSync(pkgJson, 'utf8'));
        out.set(dir, version ?? '(unknown)');
      }
    } catch {
      /* not a readable package — ignore */
    }
  }

  // Recurse into a nested node_modules if one exists (where a second,
  // un-hoisted copy would hide).
  const nested = join(dir, 'node_modules');
  try {
    if (statSync(nested).isDirectory()) {
      findCopies(pkgName, nested, out);
    }
  } catch {
    /* no nested node_modules */
  }
}

function main() {
  try {
    if (!statSync(NODE_MODULES).isDirectory()) throw new Error('not a dir');
  } catch {
    console.error(
      `check:deps — node_modules not found at ${NODE_MODULES}. Run \`npm install\` first.`,
    );
    process.exit(1);
  }

  let failed = false;

  for (const pkg of CRITICAL) {
    const copies = findCopies(pkg, NODE_MODULES, new Map());
    const dirs = [...copies.keys()].sort();

    if (dirs.length === 0) {
      // A critical runtime package that is not installed at all is itself a
      // problem worth failing on — the list should track real dependencies.
      console.error(`✗ ${pkg}: not found in node_modules (expected exactly 1 copy)`);
      failed = true;
      continue;
    }

    const versions = dirs.map((d) => `${copies.get(d)}  (${relativize(d)})`);

    if (dirs.length === 1) {
      console.log(`✓ ${pkg}: single copy @ ${copies.get(dirs[0])}`);
    } else {
      failed = true;
      console.error(`✗ ${pkg}: ${dirs.length} physical copies:`);
      for (const v of versions) console.error(`    - ${v}`);
    }
  }

  if (failed) {
    console.error(
      '\ncheck:deps FAILED — a critical runtime package is duplicated. ' +
        'Reconcile the version ranges (or add a targeted dedupe) so exactly ' +
        'one physical copy is installed. Do NOT force incompatible majors.',
    );
    process.exit(1);
  }

  console.log('\ncheck:deps OK — all critical packages are single-copy.');
}

function relativize(absDir) {
  return absDir.startsWith(ROOT + '/') ? absDir.slice(ROOT.length + 1) : absDir;
}

main();
