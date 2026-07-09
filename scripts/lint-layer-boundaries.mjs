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
 *   src/terrain, src/validation, src/analysis, src/science (when present)
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

const ROOT = new URL('..', import.meta.url).pathname;
const LAYERS = ['src/terrain', 'src/validation', 'src/analysis', 'src/science'];

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

const files = [];
for (const layer of LAYERS) walk(join(ROOT, layer), files);

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
