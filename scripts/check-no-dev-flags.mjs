#!/usr/bin/env node
/**
 * check-no-dev-flags.mjs: the deployed (live) build carries no maintainer A/B
 * flag handling.
 *
 * `?benchmark=nav`, `?governor=on` and the src/perf/devFlags.ts URL parsing
 * are compiled in behind `__OLV_DEV_FLAGS__` (vite.config.ts), which is false
 * for `vite build --mode live`. This scans a built output directory for the
 * markers that only the flag handling contains and fails if any survive.
 *
 *   node scripts/check-no-dev-flags.mjs [distDir]   (default: dist)
 *
 * Run it after `npm run build:live`. A plain build (the bench/preview build)
 * keeps the flags on purpose and fails this check.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dist = process.argv[2] ?? 'dist';

/** Strings that exist only in the gated flag handling. */
const MARKERS = [
  '__olvNavDriver', // ?benchmark=nav scripted camera driver
  '__olvNavProbe', // ?benchmark=nav frame probe hook
  '__olvGovernor', // ?governor=on wiring slot
  'governor', // the ?governor= query key
  'stickiness', // a devFlags query key that is not also a field name
];
/** Chunks that only the flags reach. */
const CHUNK_PREFIXES = ['navDriver-', 'governorWiring-'];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(js|mjs|html)$/.test(name)) out.push(p);
  }
  return out;
}

let files;
try {
  files = walk(dist);
} catch {
  console.error(`check-no-dev-flags: No build found at ${dist}; run npm run build:live first`);
  process.exit(2);
}
if (files.length === 0) {
  console.error(`check-no-dev-flags: ${dist} holds no .js/.html files`);
  process.exit(2);
}

const problems = [];
for (const f of files) {
  const base = f.split('/').pop();
  for (const prefix of CHUNK_PREFIXES) {
    if (base.startsWith(prefix)) problems.push(`${f}: flag-only chunk emitted`);
  }
  const text = readFileSync(f, 'utf8');
  for (const m of MARKERS) {
    if (text.includes(m)) problems.push(`${f}: contains "${m}"`);
  }
}

if (problems.length) {
  console.error('check-no-dev-flags: maintainer flag handling found in the build:');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`check-no-dev-flags: ok (${files.length} files, ${MARKERS.length} markers, none present)`);
