#!/usr/bin/env node
/**
 * lint-unit-factor-literals.mjs — a unit conversion factor must be imported
 * from `src/units/units.ts`, never written as a numeric literal.
 *
 * The Measure panel and the report section each declared a rounded 3.28084
 * while three profile/format modules kept their own 16-digit
 * `FEET_PER_METRE`, and `spaceMetrics` converted through the exact 0.3048.
 * Six declarations of one constant, two of them spelled differently enough
 * that a pattern written for one could not see the others.
 *
 * So this lint compares VALUES, not spellings: every decimal literal in
 * source is parsed and measured against the factors the units module owns.
 * A rule that matched text would keep missing the next spelling, which is how
 * the first version of this file passed green with three offenders in tree.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const UNITS = join('src', 'units', 'units.ts');

/**
 * Derived factors the units module exports. The DEFINITIONS (0.3048 and
 * 1200/3937) stay legal everywhere: they are what a CRS scale is compared
 * against, and writing one is not a duplicated conversion.
 */
const OWNED = [
  { value: 1 / 0.3048, importAs: 'FT_PER_M', of: 'metres → feet' },
  { value: 180 / Math.PI, importAs: 'UNIT_FACTORS.DEG_PER_RAD', of: 'radians → degrees' },
  { value: Math.PI / 180, importAs: 'degToRad', of: 'degrees → radians' },
];

/** Within 0.1 %: catches every spelling from five significant digits up. */
const TOLERANCE = 1e-3;

/**
 * Blank out comments AND string literals while preserving line numbers. Prose
 * must not fail the gate, and a number inside a string is not a conversion —
 * an EPSG WKT block quotes `UNIT["degree",0.0174532925199433,…]` as data.
 */
function stripNonCode(text) {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  out = out.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
  out = out.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, (m) =>
    m.replace(/[^\n]/g, ' '),
  );
  return out;
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) acc.push(p);
  }
  return acc;
}

const failures = [];
let scanned = 0;
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file);
  if (rel === UNITS) continue;
  scanned += 1;
  const raw = readFileSync(file, 'utf8');
  const lines = stripNonCode(raw).split('\n');
  lines.forEach((code, i) => {
    for (const m of code.matchAll(/\b\d+\.\d+\b/g)) {
      const n = Number(m[0]);
      if (!Number.isFinite(n)) continue;
      for (const { value, importAs, of } of OWNED) {
        if (Math.abs(n - value) / value < TOLERANCE) {
          failures.push(
            `${rel}:${i + 1} — ${m[0]} is the ${of} factor; import ${importAs} from units/units\n` +
              `      ${raw.split('\n')[i].trim()}`,
          );
        }
      }
    }
  });
}

if (failures.length > 0) {
  console.error(`lint:unit-factor-literals FAILED — ${failures.length} inlined conversion factor(s):\n`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`lint:unit-factor-literals OK — ${scanned} files, no inlined conversion factors.`);
