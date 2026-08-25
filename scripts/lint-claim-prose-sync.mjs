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
 *      ("every reference slot ships pending" once any slot is supplied), or
 *   3. states a DIFFERENT TOTAL of registered claims ("Of the 28 registered
 *      claims" while the register holds 29). Rule 1 counts claims AT a rung and
 *      never reads how many are registered at all, which is how that sentence
 *      sat in EVIDENCE_MODEL.md unnoticed.
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
import { execFileSync } from 'node:child_process';
import { parseRegister, VALID_LEVELS } from './lint-claim-register.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Truth documents that describe the evidence state and must not contradict it.
 *
 * A document under `docs/releases/` carrying a version describes THAT release.
 * Its E4 count was true at that tag and stays true; holding it to the live
 * register would make the lint demand that a shipped, archived record be
 * rewritten every time a claim is promoted afterwards. So a versioned release
 * document is compared against the register AT ITS OWN TAG. See
 * {@link expectedCountFor}.
 */
const TRUTH_DOCS = [
  // The release notes and validation report state the E4 count to the public and
  // were NOT scanned, which is half of why "Ten products are now at E4" survived
  // past twelve; the other half was a detector that stopped counting at seven.
  'docs/releases/RELEASE_NOTES_v0.6.6.md',
  'docs/releases/VALIDATION_REPORT_v0.6.6.md',
  'docs/releases/KNOWN_LIMITATIONS_v0.6.6.md',
  'docs/project/CLAIMS_AND_LIMITATIONS.md',
  'docs/validation/THREATS_TO_VALIDITY.md',
  'docs/validation/cross-implementation.md',
  'docs/validation/terrain-validation-matrix.md',
  'docs/validation/EVIDENCE_MODEL.md',
  'ARTIFACT_EVALUATION.md',
];

const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen', 'twenty',
];

/**
 * The alternation the detector matches. It is BUILT from NUMBER_WORDS rather
 * than written out, because the two lists drifted once: the detector stopped at
 * "seven" while the register had grown past ten, so "Ten products are now at E4"
 * and "Eleven products are at E4" were invisible to the very check that exists
 * to catch them. A bare integer counts too, since prose may write "12".
 */
const COUNT_ALTERNATION = NUMBER_WORDS.join('|');

/**
 * A bare integer counts only when it directly quantifies products ("12 products
 * are at E4"). Matching loose digits also swallowed the 0 in "0-255 scale" and
 * the digits of an exponent sitting near an E4 sentence, so the digit form is
 * deliberately narrower than the word form.
 */
const COUNT_DIGITS = '(?<![\\d.×⁻-])\\d{1,3}(?=\\s+products?\\b)';

const TENS_WORDS = ['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/**
 * A spelled number up to ninety-nine. NUMBER_WORDS stops at twenty, which is
 * enough for a rung count but not for a register total: the register passed
 * twenty long ago, so a total written "twenty-nine" needs the tens.
 */
const WORD_NUMBER = `(?:(?:${TENS_WORDS.join('|')})(?:[- ](?:${NUMBER_WORDS.slice(1, 10).join('|')}))?`
  + `|${NUMBER_WORDS.join('|')})`;

/** A number token, spelled or written, as the total constructions may carry either. */
const TOTAL_NUMBER = `(?:${WORD_NUMBER}|(?<![\\d.×⁻-])\\d{1,3})`;

/** The value a matched number token stands for, or null when it is not one. */
export function numberTokenValue(token) {
  const t = String(token ?? '').toLowerCase().trim();
  if (/^\d+$/.test(t)) return Number(t);
  const [head, tail] = t.split(/[- ]/);
  const plain = NUMBER_WORDS.indexOf(head);
  if (plain !== -1) return tail === undefined ? plain : null;
  const tens = TENS_WORDS.indexOf(head);
  if (tens === -1) return null;
  const base = (tens + 2) * 10;
  if (tail === undefined) return base;
  const ones = NUMBER_WORDS.indexOf(tail);
  return ones >= 1 && ones <= 9 ? base + ones : null;
}

/**
 * A count of claims AT a rung is rule 1's business, not this one's. "Of the 29
 * registered claims at E4" is a rung count wearing the total's noun phrase, so
 * a rung qualifier immediately after the phrase disqualifies the match.
 */
const RUNG_TAIL = '(?!\\s+(?:at|carrying|with|holding|reaching)\\s+(?:E\\d|cross-implement))';

/**
 * The constructions that actually state a register TOTAL.
 *
 * Each one marks the WHOLE set: the partitive "of the N …", the universal
 * "all N …", or the register itself as the subject holding N. The looser rule
 * — any number next to the word "claims" — was rejected because the v0.6.6
 * release notes say "Twelve registered claims are now at E4", which shares the
 * exact noun phrase and is a rung count. Flagging that would make the rule
 * wrong on shipped, correct prose, and a rule that is wrong gets switched off.
 */
const TOTAL_FORMS = [
  `\\bof\\s+the\\s+(${TOTAL_NUMBER})\\s+(?:currently\\s+)?registered\\s+claims\\b${RUNG_TAIL}`,
  `\\bof\\s+the\\s+(${TOTAL_NUMBER})\\s+claims\\s+in\\s+the\\s+(?:claim\\s+)?register\\b${RUNG_TAIL}`,
  `\\ball\\s+(${TOTAL_NUMBER})\\s+registered\\s+claims\\b${RUNG_TAIL}`,
  `\\bthe\\s+(?:claim\\s+)?register\\s+(?:holds|contains|lists|has)\\s+(${TOTAL_NUMBER})\\s+claims\\b${RUNG_TAIL}`,
];

/**
 * Every prose statement of the register total in `text` that disagrees with
 * `expectedTotal`, named by document and line and told what the register says.
 */
export function totalCountProblemsIn(rel, text, expectedTotal, basis) {
  const problems = [];
  if (expectedTotal === null || expectedTotal === undefined) return problems;
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const re = new RegExp(TOTAL_FORMS.join('|'), 'gi');
    let m;
    while ((m = re.exec(lines[i])) !== null) {
      const token = m.slice(1).find((g) => g !== undefined);
      const stated = numberTokenValue(token);
      if (stated === null || stated === expectedTotal) continue;
      problems.push(
        `${rel}:${i + 1} states ${stated} registered claim(s) ("${token}"), but ${basis} holds `
        + `${expectedTotal}. Update the prose to match it.`,
      );
    }
  }
  return problems;
}

/** How many claims the register holds (the single source). */
function totalFromRegister() {
  const yaml = readFileSync(resolve(ROOT, 'docs/validation/claim-register.yaml'), 'utf8');
  return parseRegister(yaml).length;
}

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

/** `docs/releases/<anything>_v1.2.3.md` -> "v1.2.3", else null. */
export function releaseVersionOf(rel) {
  const m = /^docs\/releases\/.*_(v\d+\.\d+\.\d+)\.md$/.exec(rel);
  return m ? m[1] : null;
}

/**
 * Whether git can answer questions about this tree at all.
 *
 * An extracted archive has no `.git`, and the release gate runs there. Without
 * this the missing tag looks identical to a release that has not been tagged
 * yet, and a versioned document gets held to the live register in the one
 * environment where it can never match: the archive ships the register of the
 * moment beside release notes describing an earlier count.
 */
function gitUsable(cwd = ROOT) {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd, stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/** Whether the repository has a tag by that name. */
function tagExists(tag, cwd = ROOT) {
  try {
    execFileSync('git', ['rev-parse', '--verify', `refs/tags/${tag}`], {
      cwd, stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/** The E4 count in the register as it stood at `tag`, or null when unreadable. */
export function e4CountAtTag(tag, cwd = ROOT) {
  try {
    const yaml = execFileSync('git', ['show', `${tag}:docs/validation/claim-register.yaml`], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 24,
    });
    const levels = [...VALID_LEVELS];
    const e4Rank = levels.indexOf('E4_CROSS_IMPLEMENTATION_VALIDATED');
    return parseRegister(yaml).filter((c) => {
      const r = levels.indexOf(c.current);
      return r !== -1 && r >= e4Rank;
    }).length;
  } catch {
    return null;
  }
}

/** How many claims the register held at `tag`, or null when unreadable. */
export function totalClaimsAtTag(tag, cwd = ROOT) {
  try {
    const yaml = execFileSync('git', ['show', `${tag}:docs/validation/claim-register.yaml`], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 24,
    });
    return parseRegister(yaml).length;
  } catch {
    return null;
  }
}

/**
 * The count a document must agree with, and why.
 *
 * WHAT THIS DELIBERATELY STILL CATCHES. The failure this lint exists for is a
 * release document understating the count at the moment it ships: "Ten products
 * are now at E4" survived past twelve. A release document for a version with no
 * tag yet is the release being PREPARED, so it is held to the live register and
 * that failure is caught exactly as before. Only an already-tagged release is
 * read against its own tag, and only because it is then a historical record
 * rather than a description of main.
 *
 * When git cannot answer, a tagged document is skipped rather than failed. An
 * extracted archive has no history, and the release gate runs there.
 */
function scopedExpectation(rel, liveCount, atTag, deps) {
  const hasTag = deps.tagExists ?? tagExists;
  const hasGit = deps.gitUsable ?? gitUsable;
  const version = releaseVersionOf(rel);
  if (version === null) return { count: liveCount, basis: 'the register' };

  // Order matters. A missing tag means "not released yet" only when git could
  // have told us; with no git at all it means nothing, and treating the two the
  // same held every release document to the live count inside the archive.
  if (!hasGit()) {
    return { count: null, basis: 'skipped, no git history to read the release tag from' };
  }
  if (!hasTag(version)) {
    return { count: liveCount, basis: `the register, because ${version} is not tagged yet` };
  }
  const tagged = atTag(version);
  if (tagged === null) return { count: null, basis: `unreadable at tag ${version}` };
  return { count: tagged, basis: `the register at tag ${version}` };
}

/** The E4 count a document must agree with, and why. */
export function expectedCountFor(rel, liveCount, deps = {}) {
  return scopedExpectation(rel, liveCount, deps.e4CountAtTag ?? e4CountAtTag, deps);
}

/**
 * The register TOTAL a document must agree with, and why. Same scoping as the
 * E4 count: a shipped release note stating the total at its own release is a
 * historical record and is read against its own tag, so adding a claim does not
 * make every archived document wrong.
 */
export function expectedTotalFor(rel, liveTotal, deps = {}) {
  return scopedExpectation(rel, liveTotal, deps.totalClaimsAtTag ?? totalClaimsAtTag, deps);
}

function collectProseProblems(count, total) {
  const problems = [];
  const skipped = [];
  // A count word paired with an E4 / cross-implementation claim in one sentence.
  const any = `(?:${COUNT_ALTERNATION}|${COUNT_DIGITS})`;
  const countClaim = new RegExp(
    // The count must QUANTIFY products, not merely share a sentence with E4:
    // "clamped at zero, and with both parents at E4" is not a count claim.
    `\\b(${any})\\b\\s+(?:[\\w-]+\\s+){0,3}products?\\b[^.\\n]{0,80}\\b(?:E4|cross-implement\\w*)\\b`
      + `|\\b(?:E4|cross-implement\\w*)\\b[^.\\n]{0,80}\\b(${any})\\b[^.\\n]{0,20}\\bproducts?\\b`,
    'gi',
  );

  for (const rel of TRUTH_DOCS) {
    const abs = resolve(ROOT, rel);
    if (!existsSync(abs)) continue;

    const { count: docCount, basis } = expectedCountFor(rel, count);
    if (docCount === null) {
      skipped.push(`${rel}: ${basis}`);
      continue;
    }
    const docExpectedWord = NUMBER_WORDS[docCount] ?? String(docCount);

    const text = readFileSync(abs, 'utf8');
    const lines = text.split('\n');

    // 3. A stated total of registered claims that the register contradicts.
    const { count: docTotal, basis: totalBasis } = expectedTotalFor(rel, total);
    problems.push(...totalCountProblemsIn(rel, text, docTotal, totalBasis));
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // 1. Wrong count word next to an E4/cross-implementation claim.
      let m;
      const re = new RegExp(countClaim.source, 'gi');
      while ((m = re.exec(line)) !== null) {
        const word = (m[1] ?? m[2] ?? '').toLowerCase();
        if (word && word !== docExpectedWord && word !== String(docCount)) {
          problems.push(
            `${rel}:${i + 1} says "${word}" next to an E4 / cross-implementation claim, but ${basis} has ${docCount} E4 product(s) ("${docExpectedWord}"). Update the prose to match it.`,
          );
        }
      }
      // 2. Obsolete absolute: ALL reference slots pending. "every reference slot
      //    other than <the supplied ones> is pending" is CORRECT, so a nearby
      //    "other than" / "except" / "besides" exempts the line.
      const allSlotsPending =
        /every reference slot\b(?![^.\n]*\b(?:other than|except|besides|apart from)\b)[^.\n]*\bpending\b/i;
      if (docCount > 0 && allSlotsPending.test(line)) {
        problems.push(
          `${rel}:${i + 1} says every reference slot is pending, but ${basis} supplies ${docCount}. Remove the obsolete absolute.`,
        );
      }
    }
  }
  return { problems, skipped };
}

const { ids: e4Ids, count } = e4FromRegister();
const total = totalFromRegister();
const { problems, skipped } = collectProseProblems(count, total);

if (problems.length > 0) {
  console.error('lint:claim-prose-sync FAILED — truth documents disagree with the claim register:\n');
  for (const p of problems) console.error(`  • ${p}`);
  console.error(
    `\nThe register is the source of truth: ${total} registered claim(s), `
      + `${count} product(s) at E4 (${e4Ids.join(', ')}).`,
  );
  process.exit(1);
}

console.log(
  `lint:claim-prose-sync OK — ${TRUTH_DOCS.length} truth documents agree with the register `
    + `(${total} registered claim(s); ${count} E4 product(s): ${e4Ids.join(', ')}).`,
);
