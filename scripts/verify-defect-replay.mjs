#!/usr/bin/env node
/**
 * Recompute the defect replay from its raw records and refuse any alteration.
 *
 *   node scripts/verify-defect-replay.mjs
 *
 * The comparison files are not read for their content and then agreed with.
 * They are regenerated from the raw records by the same code that wrote them
 * and compared byte for byte, and every derived value inside a raw record is
 * recomputed from the primitive captures beside it.
 *
 * WHY REFRESHING A HASH DOES NOT HELP
 *
 * Nothing here trusts a stored digest as evidence about the thing it hashes.
 * A digest is recomputed and compared, so a refreshed one only agrees with
 * itself. Four independent layers have to agree:
 *
 *   1. The three comparison files are regenerated from the raw records and
 *      compared byte for byte, so editing a comparison file is caught whatever
 *      digest sits beside it.
 *   2. Every derived field in a raw record (outcome, state, counts) is
 *      recomputed from that record's transcript, reporter capture and exit
 *      code, so a record cannot carry a verdict its captures do not support.
 *   3. Each run's numbers exist twice, in two encodings written by different
 *      code paths and neither derived from the other: the reporter JSON and the
 *      human summary the same process printed. An edit to one disagrees with
 *      the other. Test totals, failure counts and the success flag against the
 *      exit code are all cross-read, so a hash refreshed over an edited capture
 *      still lands on a contradiction.
 *   4. The manifest digest over the raw set is recomputed, never read. It is
 *      reported for reference and can never be the reason a run passes.
 *
 * Exit 0 when everything recomputes, 1 when anything does not, 2 on a read
 * error.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  RAW_DIR, REPLAY_DIR, REGISTRY_PATH,
  planProbes, probeStates, deriveDefectState,
  renderComparisons, crossCheck, digestOf, canonicalJson, STATES,
} from './defect-replay-lib.mjs';

const problems = [];
const note = (m) => problems.push(m);

if (!existsSync(RAW_DIR)) {
  console.error('no raw records: run npm run validation:defects:replay first');
  process.exit(2);
}

let registry;
try {
  registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
} catch (err) {
  console.error(`cannot read the registry: ${err.message}`);
  process.exit(2);
}

const files = readdirSync(RAW_DIR).filter((f) => f.endsWith('.json')).sort();
const records = [];
for (const f of files) {
  const text = readFileSync(join(RAW_DIR, f), 'utf8');
  let record;
  try {
    record = JSON.parse(text);
  } catch (err) {
    note(`${f}: not readable JSON (${err.message})`);
    continue;
  }
  // Layer 2, part one: the file is the canonical serialisation of its own
  // content. An edit that does not round-trip through the canonical form is a
  // hand edit, whatever else it changed.
  if (text !== `${canonicalJson(record)}\n`) {
    note(`${f}: the file is not the canonical serialisation of its content, so it was edited by hand`);
  }
  const expectedName = `${record.defect}--probe-${String(record.probeIndex).padStart(2, '0')}--${record.environment?.label}.json`;
  if (f !== expectedName) {
    note(`${f}: the record names itself ${expectedName}`);
  }
  for (const field of ['defect', 'probeIndex', 'probeKind', 'probeFile', 'environment', 'command', 'exitCode', 'transcript']) {
    if (record[field] === undefined) note(`${f}: the record has no ${field}`);
  }
  records.push(record);
}

// Layer 3: two encodings of one run have to agree with each other.
for (const record of records) {
  for (const p of crossCheck(record)) {
    note(`${record.defect} probe ${record.probeIndex} ${record.environment?.label}: ${p}`);
  }
}

// Layer 2, part two: the pairing is complete and each side is the tree it says.
const probes = planProbes(registry, process.cwd());
const expectedRuns = probes.filter((p) => p.kind !== 'none').length * 2;
if (records.length !== expectedRuns) {
  note(`the raw set holds ${records.length} runs; the registry plans ${expectedRuns}`);
}
const commits = new Map();
for (const record of records) {
  const label = record.environment?.label;
  if (!commits.has(label)) commits.set(label, record.environment.commit);
  else if (commits.get(label) !== record.environment.commit) {
    note(`${record.defect} probe ${record.probeIndex}: the ${label} side ran at a different commit from the rest of the set`);
  }
}

// Layer 1: regenerate the comparison files and compare byte for byte.
const comparisons = renderComparisons(registry, probes, records);
for (const [name, expected] of Object.entries(comparisons)) {
  const path = join(REPLAY_DIR, name);
  if (!existsSync(path)) {
    note(`${name}: missing; it is generated, not written by hand`);
    continue;
  }
  const actual = readFileSync(path, 'utf8');
  if (actual !== expected) {
    const at = [...expected].findIndex((ch, i) => actual[i] !== ch);
    note(`${name}: does not match what the raw records regenerate (first difference at byte ${at < 0 ? actual.length : at})`);
  }
}

// Layer 4: recompute the digest over the raw set. Reported, never trusted.
const rawDigest = digestOf(records.map((r) => canonicalJson(r)).join('\n'));

const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
for (const d of registry.defects) counts[deriveDefectState(d.id, probes, records)] += 1;

console.log(`raw records: ${records.length} in ${files.length} files`);
console.log(`raw digest (recomputed): ${rawDigest}`);
for (const state of STATES) console.log(`  ${state}: ${counts[state]}`);

// Printed apart from the tally above, and printed every run. These are the
// probes the aggregate does NOT rest on, so a reader can see which ones they
// are without opening the comparison files.
const states = probeStates(probes, records);
for (const [state, heading] of [
  ['non-discriminating', 'probes that passed on both trees, so they show nothing about the old behaviour'],
  ['component-absent-at-baseline', 'probes that could not observe the baseline'],
  ['inconclusive', 'probes whose pair produced no readable result'],
]) {
  const group = states.filter((s) => s.state === state);
  if (group.length === 0) continue;
  console.log('');
  console.log(`${heading}: ${group.length}`);
  for (const s of group) console.log(`  ${s.probe.defect} probe ${s.probe.index}: ${s.why}`);
}

if (problems.length > 0) {
  console.error('');
  console.error(`recomputation failed on ${problems.length} point${problems.length === 1 ? '' : 's'}:`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log('');
console.log('every derived value recomputes from the raw records');
process.exit(0);
