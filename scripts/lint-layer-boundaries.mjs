#!/usr/bin/env node
/**
 * lint-layer-boundaries.mjs
 *
 * Enforces the dependency-direction rule the v0.5.8 architecture requires:
 *
 *     core math → science domain → application services → UI adapters → views
 *
 * The SCIENCE / CORE layers must never import UI or three.js — otherwise a pure,
 * worker-safe, deterministic scientific module quietly gains a DOM/render
 * dependency and can no longer run off the main thread or be reasoned about in
 * isolation. An audit confirmed these layers are clean today; this lint keeps
 * them that way (the boundary was previously self-discipline, not a gate).
 *
 * Scanned layers (must stay UI/three-free):
 *   src/terrain, src/validation, src/analysis, src/science (when present),
 *   src/geo/context
 *
 * A new pure layer has to be added to LAYERS or this lint says nothing about
 * it, and says it in the same words it uses for a clean tree. src/geo/context
 * arrived describing itself as a pure core that never imports proj4, and the
 * lint reported the same 135 files before and after, because it read none of
 * the new ones. An unchanged count reads like confirmation and was the absence
 * of a check. Adding the directory is the whole fix.
 *
 * Banned import specifiers from within those layers:
 *   - anything under a `ui/` path (UI adapters / views)
 *   - `three` or `three/*` (the render engine)
 *
 * Note: hardware access like `navigator.gpu` in the WebGPU compute backend is
 * NOT an import and is intentionally allowed — this lint only inspects module
 * import specifiers, which is where a layering violation actually enters.
 *
 * Exit 0 = clean; exit 1 = a violation (prints file, line, specifier).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// `new URL(...).pathname` is a URL path, not a filesystem path. On Windows it
// is `/C:/…` with percent-encoded spaces, which `readdirSync` cannot open —
// and `walk` swallows that ENOENT by design (a layer directory is allowed not
// to exist), so the lint would print success having read zero files. A gate
// that passes vacuously is worse than one that fails, hence fileURLToPath.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LAYERS = ['src/terrain', 'src/validation', 'src/analysis', 'src/science', 'src/geo/context', 'src/geo/frame'];

/** A specifier that reaches into the UI layer or pulls in three.js. */
function isBanned(spec) {
  if (spec === 'three' || spec.startsWith('three/')) return 'three.js render engine';
  // UI paths: relative (`../ui/…`, `../../ui/…`) or a `src/ui/…` alias.
  if (/(^|\/)ui\//.test(spec)) return 'UI layer';
  return null;
}

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return; // layer dir may not exist yet (e.g. src/science)
  }
  for (const name of entries) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(p);
  }
}

// `walk` returns silently when a directory cannot be read, which is correct for
// a layer that does not exist yet and wrong for every other cause. On Windows
// the path bug above made all four unreadable at once and the lint reported
// success over zero files. Counting per layer is what catches that: a total
// would still pass while three of the four layers went unread.
//
// A layer with files today is a layer that must keep having them. Deleting one
// is a real change and should fail here rather than quietly shrink the gate.
const POPULATED_LAYERS = ['src/terrain', 'src/validation', 'src/analysis', 'src/science'];

const files = [];
const perLayer = new Map();
for (const layer of LAYERS) {
  const found = [];
  walk(join(ROOT, layer), found);
  perLayer.set(layer, found.length);
  files.push(...found);
}

const unread = POPULATED_LAYERS.filter((layer) => (perLayer.get(layer) ?? 0) === 0);
if (unread.length > 0) {
  console.error('lint:layer-boundaries FAILED — read no files in a layer that has them');
  console.error('');
  for (const layer of unread) console.error(`  ${layer} contributed 0 files`);
  console.error('');
  console.error('This lint inspects import specifiers, so a layer it cannot read is a layer it');
  console.error('cannot check. Either the path resolution is broken or the layer was removed.');
  console.error('If a layer is genuinely gone, drop it from POPULATED_LAYERS in this script.');
  process.exit(1);
}

// Match `import ... from '<spec>'`, `export ... from '<spec>'`, and dynamic
// `import('<spec>')`.
const IMPORT_RE = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

const violations = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    IMPORT_RE.lastIndex = 0;
    let m;
    while ((m = IMPORT_RE.exec(lines[i])) !== null) {
      const spec = m[1] ?? m[2];
      if (!spec) continue;
      const why = isBanned(spec);
      if (why) {
        violations.push({ file: relative(ROOT, file), line: i + 1, spec, why });
      }
    }
  }
}

if (violations.length === 0) {
  console.log(
    `lint:layer-boundaries OK — ${files.length} science/core files import no UI or three.js`,
  );
  process.exit(0);
}

console.error('lint:layer-boundaries FAILED');
console.error('');
console.error('Science/core modules (terrain, validation, analysis, science) must not import');
console.error('the UI layer or three.js. Move the boundary crossing to an application service:');
console.error('');
for (const v of violations) {
  console.error(`  • ${v.file}:${v.line} imports "${v.spec}" (${v.why})`);
}
console.error('');
process.exit(1);
