#!/usr/bin/env node
/**
 * lint-known-limitations.mjs
 *
 * Cross-checks the current release's known-limitations document against the
 * machine files that settle what it says:
 *
 *   (a) every "about N KiB against an M KiB ceiling" sentence: M must equal the
 *       `index` ceiling in scripts/check-bundle-budget.mjs, and N must sit within
 *       2 KiB of `bundle.liveEntryKiB` in docs/validation/test-evidence.json;
 *   (b) every clause naming a CI leg (Chromium, Firefox, WebKit, Windows) as
 *       advisory or as blocking must agree with the `needs` list of the
 *       `ci-green` job in .github/workflows/ci.yml;
 *   (c) every ledger id the document cites in a sentence that calls it open
 *       must not read FIXED in the ledger table, and each phrase in
 *       PHRASE_GUARDS must not appear while its ledger id reads FIXED.
 *
 * The rule logic is a pure function of a `read(path)` accessor, so
 * tests/knownLimitationsLint.test.ts can feed it stale text without touching
 * the tree. `read(path)` returns the file text, or null if absent.
 *
 * Usage: `node scripts/lint-known-limitations.mjs` (also
 * `npm run lint:known-limitations`, in the static gate group).
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { isCliEntry } from './lib/isCliEntry.mjs';

export const BUNDLE_TOLERANCE_KIB = 2;

/** CI leg names as the document writes them, and the ci.yml job that runs each. */
export const LEG_JOBS = {
  Chromium: 'e2e-deterministic',
  Firefox: 'e2e-firefox',
  WebKit: 'e2e-webkit',
  Windows: 'windows',
};

/**
 * Sentences that were true once and are false while the named ledger entry
 * reads FIXED. Each is a pattern over whitespace-collapsed document text.
 */
export const PHRASE_GUARDS = [
  { id: 'L26', pattern: /polygon Volume tool[^.]*still read/i, what: 'the polygon Volume tool reading Withheld points' },
  { id: 'L26', pattern: /Withheld point as an ordinary return/i, what: 'Withheld points read as ordinary returns' },
  { id: 'L26', pattern: /Withheld points were excluded is not recorded for the terrain/i, what: 'terrain not recording the Withheld exclusion' },
  { id: 'L13', pattern: /Firefox, WebKit and Windows do not/i, what: 'Firefox, WebKit and Windows as non-blocking' },
  { id: 'L13', pattern: /browser matrix is advisory/i, what: 'the browser matrix as advisory' },
  { id: 'L05', pattern: /stockpile split was half closed/i, what: 'the stockpile split as half closed' },
];

const ADVISORY = /\badvisory\b|\bnon-blocking\b|\bdo(?:es)? not(?=\s*(?:block\b|,|$))/i;
const BLOCKING = /\bblocks?\b|\bblocking\b/i;
const OPEN_WORDS = /\b(?:open|outstanding|unresolved|not fixed)\b/i;

/** `ci-green`'s `needs`, or null when the job or its list cannot be found. */
export function ciGreenNeeds(ciYaml) {
  const m = ciYaml.match(/^ {2}ci-green:\s*\n(?:^ {4}.*\n)*?^ {4}needs:\s*\[([^\]]*)\]/m);
  if (!m) return null;
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

/** The `index` chunk ceiling in KiB from check-bundle-budget.mjs, or null. */
export function indexCeilingKiB(budgetSource) {
  const m = budgetSource.match(/\{\s*prefix:\s*'index',\s*maxKiB:\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

/** Map of ledger id to the status its summary table records. */
export function ledgerStatuses(ledger) {
  const out = new Map();
  for (const m of ledger.matchAll(/^\|\s*(L\d+)\s*\|[^|]*\|[^|]*\|[^|]*\|\s*([A-Z][A-Z ]*?)\s*\|/gm)) {
    out.set(m[1], m[2]);
  }
  return out;
}

/** Split prose into clauses at sentence ends and semicolons. */
function clauses(text) {
  return text.split(/(?<=[.;])\s+|;\s*/).map((c) => c.trim()).filter(Boolean);
}

export function collectKnownLimitationsProblems(read) {
  const problems = [];
  const pkgText = read('package.json');
  if (pkgText == null) return { problems: ['package.json is missing.'], doc: null };
  const version = JSON.parse(pkgText).version;
  const DOC = `docs/releases/KNOWN_LIMITATIONS_v${version}.md`;
  const raw = read(DOC);
  if (raw == null) return { problems, doc: null };
  // Headings count as sentences of their own.
  const text = raw.replace(/^#+\s*(.*)$/gm, '$1.').replace(/\s+/g, ' ');

  // ── (a) eager bundle size and ceiling ─────────────────────────────────────
  const budgetSrc = read('scripts/check-bundle-budget.mjs');
  const evidenceText = read('docs/validation/test-evidence.json');
  const ceiling = budgetSrc == null ? null : indexCeilingKiB(budgetSrc);
  const live = evidenceText == null ? null : JSON.parse(evidenceText).bundle?.liveEntryKiB ?? null;
  for (const m of text.matchAll(/(\d+)\s*KiB\s+against\s+an?\s+(\d+)\s*KiB\s+ceiling/gi)) {
    const [n, c] = [Number(m[1]), Number(m[2])];
    if (ceiling == null) {
      problems.push(`${DOC}: states a ${c} KiB ceiling, but no index ceiling was found in scripts/check-bundle-budget.mjs.`);
    } else if (c !== ceiling) {
      problems.push(`${DOC}: states a ${c} KiB ceiling; scripts/check-bundle-budget.mjs sets the index chunk at ${ceiling} KiB.`);
    }
    if (live == null) {
      problems.push(`${DOC}: states ${n} KiB eager, but docs/validation/test-evidence.json records no bundle.liveEntryKiB.`);
    } else if (Math.abs(n - live) > BUNDLE_TOLERANCE_KIB) {
      problems.push(`${DOC}: states the eager bundle at ${n} KiB; docs/validation/test-evidence.json records ${live} KiB (tolerance ${BUNDLE_TOLERANCE_KIB} KiB).`);
    }
  }

  // ── (b) CI legs, advisory or blocking ────────────────────────────────────
  const ciText = read('.github/workflows/ci.yml');
  const needs = ciText == null ? null : ciGreenNeeds(ciText);
  if (needs == null) {
    problems.push('.github/workflows/ci.yml: no `ci-green` job with a `needs` list was found.');
  } else {
    for (const clause of clauses(text)) {
      const legs = Object.keys(LEG_JOBS).filter((leg) => new RegExp(`\\b${leg}\\b`).test(clause));
      if (legs.length === 0) continue;
      if (ADVISORY.test(clause)) {
        for (const leg of legs) {
          if (needs.includes(LEG_JOBS[leg])) {
            problems.push(`${DOC}: "${clause.slice(0, 80)}" calls ${leg} advisory, but \`${LEG_JOBS[leg]}\` is in ci-green's needs.`);
          }
        }
      } else if (BLOCKING.test(clause)) {
        for (const leg of legs) {
          if (!needs.includes(LEG_JOBS[leg])) {
            problems.push(`${DOC}: "${clause.slice(0, 80)}" says ${leg} blocks, but \`${LEG_JOBS[leg]}\` is not in ci-green's needs.`);
          }
        }
      }
    }
  }

  // ── (c) ledger ids and phrase guards ─────────────────────────────────────
  const ledgerText = read('docs/releases/V070_IMPLEMENTATION_LEDGER.md');
  if (ledgerText == null) {
    problems.push('docs/releases/V070_IMPLEMENTATION_LEDGER.md is missing.');
  } else {
    const status = ledgerStatuses(ledgerText);
    for (const clause of clauses(text)) {
      if (!OPEN_WORDS.test(clause)) continue;
      for (const m of clause.matchAll(/\b(L\d+)\b/g)) {
        if (status.get(m[1]) === 'FIXED') {
          problems.push(`${DOC}: "${clause.slice(0, 80)}" cites ${m[1]} as open; the ledger records it FIXED.`);
        }
      }
    }
    for (const g of PHRASE_GUARDS) {
      if (status.get(g.id) === 'FIXED' && g.pattern.test(text)) {
        problems.push(`${DOC}: still describes ${g.what}; ${g.id} is FIXED in the ledger.`);
      }
    }
  }

  return { problems, doc: DOC };
}

if (isCliEntry(import.meta.url)) {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const read = (p) => (existsSync(resolve(ROOT, p)) ? readFileSync(resolve(ROOT, p), 'utf8') : null);
  const { problems, doc } = collectKnownLimitationsProblems(read);
  if (problems.length === 0) {
    console.log(`lint:known-limitations OK: ${doc ?? 'no limitations document for this version'} agrees with the bundle ceiling, the evidence record, ci-green and the ledger.`);
    process.exit(0);
  }
  console.error('lint:known-limitations FAILED');
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}
