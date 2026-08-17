#!/usr/bin/env node
/**
 * lint-claim-prose-sync.mjs
 *
 * Keep the PROSE truth documents in step with the machine-readable claim
 * register. `lint:release-truth` catches a fixed set of obsolete absolutes, but
 * it does not derive the current E4 count/list from the register and compare it
 * to every truth doc — which is how "three E4 products" survived in six places
 * after CONTOURS reached E4 (see the RC audit).
 *
 * This lint reads the authoritative E4 set from `docs/validation/claim-register.yaml`
 * and refuses a truth document that:
 *   1. states a DIFFERENT count word next to an E4 / cross-implementation claim
 *      (e.g. "three products … E4" when the register has four), or
 *   2. carries an obsolete absolute the register now contradicts
 *      ("every reference slot ships pending" once any slot is supplied).
 *
 * It does not try to rewrite prose or parse arbitrary sentences; it pins the two
 * concrete drift classes the audit found. The durable fix — generating the E4
 * block from the register — can subsume this later; until then the register is
 * the single source and this refuses the contradiction.
 *
 * Exit 0 = clean; exit 1 = a contradiction (prints each).
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { parseRegister, VALID_LEVELS } from './lint-claim-register.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Truth documents that describe the evidence state and must not contradict it. */
const TRUTH_DOCS = [
  'docs/releases/KNOWN_LIMITATIONS_v0.6.6.md',
  'docs/project/CLAIMS_AND_LIMITATIONS.md',
  'docs/validation/THREATS_TO_VALIDITY.md',
  'docs/validation/cross-implementation.md',
  'docs/validation/terrain-validation-matrix.md',
  'docs/validation/EVIDENCE_MODEL.md',
  'ARTIFACT_EVALUATION.md',
];

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** The E4+ claim ids and their count, from the register (the single source). */
function e4FromRegister() {
  const levels = [...VALID_LEVELS];
  const e4Rank = levels.indexOf('E4_CROSS_IMPLEMENTATION_VALIDATED');
  const yaml = readFileSync(resolve(ROOT, 'docs/validation/claim-register.yaml'), 'utf8');
  const claims = parseRegister(yaml);
  const ids = claims
    .filter((c) => {
      const r = levels.indexOf(c.current);
      return r !== -1 && r >= e4Rank;
    })
    .map((c) => c.id);
  return { ids, count: ids.length };
}

function collectProseProblems(count) {
  const problems = [];
  const expectedWord = NUMBER_WORDS[count] ?? String(count);
  // A count word paired with an E4 / cross-implementation claim in one sentence.
  const countClaim =
    /\b(one|two|three|four|five|six|seven)\b[^.\n]{0,80}\b(?:E4|cross-implement\w*)\b|\b(?:E4|cross-implement\w*)\b[^.\n]{0,80}\b(one|two|three|four|five|six|seven)\b[^.\n]{0,20}\bproducts?\b/gi;

  for (const rel of TRUTH_DOCS) {
    const abs = resolve(ROOT, rel);
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // 1. Wrong count word next to an E4/cross-implementation claim.
      let m;
      const re = new RegExp(countClaim.source, 'gi');
      while ((m = re.exec(line)) !== null) {
        const word = (m[1] ?? m[2] ?? '').toLowerCase();
        if (word && word !== expectedWord) {
          problems.push(
            `${rel}:${i + 1} says "${word}" next to an E4 / cross-implementation claim, but the register has ${count} E4 product(s) ("${expectedWord}"). Update the prose to match the register.`,
          );
        }
      }
      // 2. Obsolete absolute: ALL reference slots pending. "every reference slot
      //    other than <the supplied ones> is pending" is CORRECT, so a nearby
      //    "other than" / "except" / "besides" exempts the line.
      const allSlotsPending =
        /every reference slot\b(?![^.\n]*\b(?:other than|except|besides|apart from)\b)[^.\n]*\bpending\b/i;
      if (count > 0 && allSlotsPending.test(line)) {
        problems.push(
          `${rel}:${i + 1} says every reference slot is pending, but the register supplies ${count} (${e4Ids.join(', ')}). Remove the obsolete absolute.`,
        );
      }
    }
  }
  return problems;
}

const { ids: e4Ids, count } = e4FromRegister();
const problems = collectProseProblems(count);

if (problems.length > 0) {
  console.error('lint:claim-prose-sync FAILED — truth documents disagree with the claim register:\n');
  for (const p of problems) console.error(`  • ${p}`);
  console.error(
    `\nThe register is the source of truth: ${count} product(s) at E4 (${e4Ids.join(', ')}).`,
  );
  process.exit(1);
}

console.log(
  `lint:claim-prose-sync OK — ${TRUTH_DOCS.length} truth documents agree with the register (${count} E4 product(s): ${e4Ids.join(', ')}).`,
);
