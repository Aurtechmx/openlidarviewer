/**
 * knownLimitationsLint.test.ts — proves scripts/lint-known-limitations.mjs
 * passes on the real tree and fails on each stale sentence it guards.
 *
 * Each case reads the real tree and replaces one file, so a rule that stopped
 * firing would let the same drift ship again.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectKnownLimitationsProblems,
  ciGreenNeeds,
  indexCeilingKiB,
  ledgerStatuses,
  // @ts-expect-error — plain .mjs script, no types
} from '../scripts/lint-known-limitations.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const realRead = (p: string): string | null =>
  existsSync(resolve(ROOT, p)) ? readFileSync(resolve(ROOT, p), 'utf8') : null;

const VERSION = JSON.parse(realRead('package.json')!).version as string;
const DOC = `docs/releases/KNOWN_LIMITATIONS_v${VERSION}.md`;
const LEDGER = 'docs/releases/V070_IMPLEMENTATION_LEDGER.md';
const CI = '.github/workflows/ci.yml';

const withOverride = (path: string, text: string) =>
  (p: string): string | null => (p === path ? text : realRead(p));
const problemsFor = (read: (p: string) => string | null) =>
  collectKnownLimitationsProblems(read).problems as string[];
const withDocAppended = (extra: string) => withOverride(DOC, `${realRead(DOC)}\n\n${extra}\n`);

const live = JSON.parse(realRead('docs/validation/test-evidence.json')!).bundle.liveEntryKiB as number;
const ceiling = indexCeilingKiB(realRead('scripts/check-bundle-budget.mjs')!) as number;

describe('lint:known-limitations', () => {
  it('passes on the real current tree', () => {
    expect(problemsFor(realRead)).toEqual([]);
  });

  it('reads the machine files it compares against', () => {
    expect(ceiling).toBeGreaterThan(0);
    expect(ciGreenNeeds(realRead(CI)!)).toEqual(expect.arrayContaining(['e2e-firefox', 'e2e-webkit', 'windows']));
    expect(ledgerStatuses(realRead(LEDGER)!).get('L13')).toBe('FIXED');
  });

  describe('(a) eager bundle sentence', () => {
    it('fails on the old size and ceiling', () => {
      const p = problemsFor(withDocAppended('The eager bundle measures about 799 KiB against an 812 KiB ceiling.'));
      expect(p.some((x) => x.includes('812 KiB ceiling'))).toBe(true);
      expect(p.some((x) => x.includes('799 KiB'))).toBe(true);
    });

    it('accepts a size within 2 KiB of the evidence record', () => {
      expect(problemsFor(withDocAppended(`About ${live + 2} KiB against a ${ceiling} KiB ceiling.`))).toEqual([]);
      expect(problemsFor(withDocAppended(`About ${live + 3} KiB against a ${ceiling} KiB ceiling.`))).toHaveLength(1);
    });
  });

  describe('(b) CI legs', () => {
    it('fails when a blocking leg is called advisory', () => {
      const p = problemsFor(withDocAppended(
        'Chromium blocks a release; Firefox, WebKit and Windows do not, and no ruleset requires the smoke workflow.',
      ));
      expect(p.filter((x) => x.includes('advisory'))).toHaveLength(3);
    });

    it('fails when a leg outside ci-green is said to block', () => {
      const ci = realRead(CI)!.replace(/(needs: \[[^\]]*), e2e-firefox/, '$1');
      expect(ciGreenNeeds(ci)).not.toContain('e2e-firefox');
      const p = problemsFor(withOverride(CI, ci));
      expect(p.some((x) => x.includes('says Firefox blocks'))).toBe(true);
    });
  });

  describe('(c) ledger citations and phrase guards', () => {
    it('fails on an id cited as open that the ledger records FIXED', () => {
      const p = problemsFor(withDocAppended('The cross-browser gap stays open under ledger L13.'));
      expect(p.some((x) => x.includes('cites L13 as open'))).toBe(true);
    });

    it('fails on each guarded sentence from the old text', () => {
      for (const old of [
        'The polygon Volume tool and the other analyses still read a Withheld point as an ordinary return.',
        'Whether Withheld points were excluded is not recorded for the terrain behind it.',
        '## The browser matrix is advisory',
        'Of the inherited set, the stockpile split was half closed.',
      ]) {
        expect(problemsFor(withDocAppended(old)).length, old).toBeGreaterThan(0);
      }
    });

    it('lets a guarded sentence stand while its entry is not FIXED', () => {
      const ledger = realRead(LEDGER)!.replace(/^(\| L05 \|[^|]*\|[^|]*\|[^|]*\|) FIXED \|/m, '$1 PARTIAL |');
      const read = (p: string) => (p === LEDGER ? ledger : p === DOC ? `${realRead(DOC)}\nThe stockpile split was half closed.\n` : realRead(p));
      expect(problemsFor(read)).toEqual([]);
    });
  });
});
