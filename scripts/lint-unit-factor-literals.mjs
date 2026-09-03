#!/usr/bin/env node
/**
 * lint-unit-factor-literals.mjs — a unit conversion factor must be imported
 * from `src/units/units.ts`, never written as a rounded literal.
 *
 * The Measure panel and the report measurement section each declared their own
 * `3.28084` while `spaceMetrics` and the space-report PDF converted through the
 * exact `0.3048`, so one length converted two different ways depending on the
 * surface. Nothing caught it: the unit tests read the shared constant, which
 * was correct, and never the literal the panel actually multiplied by.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const UNITS = join('src', 'units', 'units.ts');

/**
 * Rounded spellings of factors whose exact form the units module owns. The
 * exact forms (0.3048, 1200/3937) stay legal: they ARE the definition, and
 * parsers legitimately compare a CRS scale against them.
 */
const BANNED = [
  { pattern: /\b3\.28084\b/, exact: 'FT_PER_M', of: 'metres → feet' },
  { pattern: /\b3\.280839?\b/, exact: 'FT_PER_M', of: 'metres → feet' },
  { pattern: /\b57\.29578\b/, exact: 'UNIT_FACTORS.DEG_PER_RAD', of: 'radians → degrees' },
  { pattern: /\b0\.0174533\b/, exact: 'UNIT_FACTORS.DEG_PER_RAD', of: 'degrees → radians' },
];

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
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    // A comment may name a rounded factor to explain one; only code counts.
    const code = line.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const { pattern, exact, of } of BANNED) {
      if (pattern.test(code)) {
        failures.push(`${rel}:${i + 1} — rounded ${of} factor; import ${exact} from units/units instead\n    ${line.trim()}`);
      }
    }
  });
}

if (failures.length > 0) {
  console.error(`lint:unit-factor-literals FAILED — ${failures.length} rounded conversion factor(s):\n`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`lint:unit-factor-literals OK — ${scanned} files, no rounded conversion factors.`);
