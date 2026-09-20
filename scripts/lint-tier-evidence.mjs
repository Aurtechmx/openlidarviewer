#!/usr/bin/env node
/**
 * lint-tier-evidence.mjs
 *
 * Ties the continuity ladder's shipped default to the evidence for it.
 *
 * The rule the phase states is short: no benchmark record, no production
 * default above `source`. It is easy to hold while somebody is watching and
 * easy to lose in a hurry, because turning a rung on is a one-word edit to a
 * defaults table and nothing else in the build has an opinion about it.
 *
 * So the defaults table and the record directory are read together. A default
 * of `source` needs nothing. A default above it needs a record that measured
 * that rung, and `verify:renderer-benchmark` is what decides whether the
 * record itself is sound; this only decides whether one exists and covers the
 * rung being shipped.
 *
 * What it deliberately does not do is judge the numbers. Whether a measured
 * rung was fast enough, or leaked too much at an edge, is a reading of a
 * record that a person makes. This refuses the case where there is nothing to
 * read.
 *
 * Exit 0 = the default is backed, or is `source`. Exit 1 = a rung ships with
 * no measurement of it.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/**
 * The two inputs, overridable by argument so a test can point at copies.
 *
 * A test that made its point by editing the real defaults table would be
 * writing to a source file while the rest of the suite reads it, and would
 * leave the tree edited if it died between the write and the restore.
 */
const FLAGS = process.argv[2] ?? join(ROOT, 'src', 'perf', 'devFlags.ts');
const RECORDS = process.argv[3] ?? join(ROOT, 'validation', 'renderer-benchmark');
const SCHEMA = 'manifest.schema.json';

/** Rungs in order, richest first, matching `TIER_ORDER`. */
const TIER_ORDER = ['full', 'closure', 'sizing', 'source'];

const problems = [];
const fail = (message) => problems.push(message);

/**
 * The shipped default, read from the defaults table rather than from a
 * parsed URL: the question is what a viewer gets with no flags at all.
 */
function shippedTier() {
  const source = readFileSync(FLAGS, 'utf8');
  const match = /continuityTier:\s*'([a-z]+)'/.exec(source);
  if (!match) {
    fail(`${FLAGS}: no continuityTier default found. `
      + 'This lint reads that line to learn what ships; if the flag moved, move this with it.');
    return null;
  }
  return match[1];
}

/** Every rung some record measured, from the continuity side of each case. */
function measuredTiers() {
  if (!existsSync(RECORDS)) return new Set();
  const tiers = new Set();
  for (const file of readdirSync(RECORDS)) {
    if (!file.endsWith('.json') || file === SCHEMA) continue;
    let record;
    try {
      record = JSON.parse(readFileSync(join(RECORDS, file), 'utf8'));
    } catch {
      // A malformed record is verify:renderer-benchmark's to report. Counting
      // it as evidence here would let a broken file authorise a default.
      continue;
    }
    for (const c of record.cases ?? []) {
      if (typeof c?.continuity?.mode === 'string') tiers.add(c.continuity.mode);
    }
  }
  return tiers;
}

const shipped = shippedTier();
if (shipped !== null) {
  if (!TIER_ORDER.includes(shipped)) {
    fail(`${FLAGS}: the default tier "${shipped}" is not a rung on the ladder.`);
  } else if (shipped !== 'source') {
    const measured = measuredTiers();
    // Every rung up to and including the one shipped: a default of `full` that
    // measured only `full` skipped the two it is built on.
    const owed = TIER_ORDER.slice(TIER_ORDER.indexOf(shipped)).filter((t) => t !== 'source');
    const missing = owed.filter((t) => !measured.has(t));
    if (missing.length > 0) {
      fail(`the continuity default ships "${shipped}" with no benchmark record for `
        + `${missing.map((t) => `"${t}"`).join(', ')}. `
        + 'Add a record under validation/renderer-benchmark/ that measures it, '
        + 'or ship "source" until one exists.');
    }
  }
}

if (problems.length > 0) {
  console.error('\nlint:tier-evidence FAILED\n');
  for (const p of problems) console.error(`  • ${p}`);
  console.error('');
  process.exit(1);
}

const measured = measuredTiers();
console.log(
  `lint:tier-evidence OK — the continuity default is "${shipped}"`
  + (shipped === 'source'
    ? ', which needs no measurement.'
    : `, backed by records measuring ${[...measured].sort().join(', ')}.`),
);
