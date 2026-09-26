/**
 * v070StatusIndex.test.ts: the ledger status index reports the whole ledger.
 *
 * The generator reads `### Lnn · STATUS · CATEGORY` headings and keeps the
 * last account of each, which is what "current" means in a chronological log.
 * Its first version matched two-digit ids only and dropped L100 to L145
 * without a sound: the document announced 99 entries, `--check` agreed, and
 * the gate passed, because generation and verification read the ledger through
 * the same expression.
 *
 * So the properties worth testing are not "does it parse a heading" but the
 * two that failed silently: every account in the file reaches the index, and
 * an account the parser cannot read is an error rather than an omission. Both
 * are exercised against constructed ledgers, so they hold whatever the real
 * file happens to contain today.
 */
import { describe, expect, it } from 'vitest';

import { readCurrentStatus, renderStatus, staleSummaryRows } from '../scripts/gen-v070-status.mjs';

/** A ledger built from `[id, status, category]` accounts, in file order. */
const ledgerOf = (...accounts: ReadonlyArray<readonly [string, string, string]>): string =>
  accounts.map(([id, status, cat]) => `### ${id} · ${status} · ${cat}\n\nbody\n`).join('\n');

describe('the latest account of an entry is the current one', () => {
  it('keeps the last verdict and counts the revision', () => {
    const { latest, revisited } = readCurrentStatus(
      ledgerOf(['L01', 'OPEN', 'EXPORT'], ['L02', 'FIXED', 'RENDER'], ['L01', 'FIXED', 'EXPORT']),
    );
    expect(latest.get('L01')).toEqual({ status: 'FIXED', category: 'EXPORT' });
    expect(latest.get('L02')).toEqual({ status: 'FIXED', category: 'RENDER' });
    expect(revisited.get('L01')).toBe(2);
    expect(revisited.has('L02')).toBe(false);
  });

  it('reads a status that carries a space', () => {
    const { latest } = readCurrentStatus(ledgerOf(['L07', 'NOT REPRODUCIBLE', 'LOADER']));
    expect(latest.get('L07')?.status).toBe('NOT REPRODUCIBLE');
  });
});

describe('an account the parser cannot read is an error', () => {
  it('refuses a three-digit id it cannot match, naming the shortfall', () => {
    // The shipped bug. The ids exist, the headings are well formed, and the
    // expression simply did not reach them.
    const ledger = ledgerOf(['L01', 'OPEN', 'EXPORT']) + '\n### L100 · OPEN · RENDER\n\nbody\n';
    expect(() => readCurrentStatus(ledger)).not.toThrow();
    const { latest } = readCurrentStatus(ledger);
    expect(latest.has('L100')).toBe(true);
  });

  it('refuses a newer account whose shape is unreadable, even though the id is known', () => {
    // The subtler case: L01 already has a parseable account, so an id-set
    // comparison sees nothing wrong while the index publishes the superseded
    // verdict. Counting accounts is what catches it.
    const ledger = ledgerOf(['L01', 'OPEN', 'EXPORT']) + "\n### L01 · WON'T FIX · EXPORT\n\nbody\n";
    expect(() => readCurrentStatus(ledger)).toThrow(/did not parse/);
  });

  it('says how many accounts it could not read', () => {
    const ledger = ledgerOf(['L01', 'OPEN', 'EXPORT']) + "\n### L02 · WON'T FIX · EXPORT\n\nbody\n";
    expect(() => readCurrentStatus(ledger)).toThrow(/1 of 2/);
  });
});

describe('the rendered document', () => {
  it('orders entries numerically, so L100 follows L99', () => {
    const doc = renderStatus(
      readCurrentStatus(ledgerOf(
        ['L100', 'OPEN', 'RENDER'], ['L99', 'OPEN', 'RENDER'], ['L09', 'OPEN', 'RENDER'],
      )),
    );
    const order = [...doc.matchAll(/^\| (L\d+) \|/gm)].map((m) => m[1]);
    expect(order).toEqual(['L09', 'L99', 'L100']);
  });

  it('totals the statuses it actually holds', () => {
    const doc = renderStatus(
      readCurrentStatus(ledgerOf(
        ['L01', 'FIXED', 'EXPORT'], ['L02', 'FIXED', 'RENDER'], ['L03', 'OPEN', 'RENDER'],
      )),
    );
    expect(doc).toContain('| FIXED | 2 |');
    expect(doc).toContain('| OPEN | 1 |');
    expect(doc).toContain('Entries: 3.');
  });

  it('says it is generated, so nobody edits it by hand', () => {
    const doc = renderStatus(readCurrentStatus(ledgerOf(['L01', 'OPEN', 'EXPORT'])));
    expect(doc).toContain('Generated. Do not edit.');
  });
});

describe('the summary table at the head of the ledger', () => {
  const table = (...rows: ReadonlyArray<readonly [string, string]>): string =>
    '| ID | Category | Repro | Sev | Status | Was | Finding |\n|---|---|---|---|---|---|---|\n' +
    rows.map(([id, status]) => `| ${id} | UI | DOC | med | ${status} | new | A finding. |`).join('\n') + '\n\n';

  it('names a row whose status is behind the latest account', () => {
    const text = table(['L01', 'OPEN'], ['L02', 'FIXED']) +
      ledgerOf(['L01', 'OPEN', 'UI'], ['L02', 'FIXED', 'UI'], ['L01', 'PARTIAL', 'UI']);
    const { latest } = readCurrentStatus(text);
    expect(staleSummaryRows(text, latest)).toEqual([{ id: 'L01', table: 'OPEN', latest: 'PARTIAL' }]);
  });

  it('reads a status that carries a space', () => {
    const text = table(['L07', 'NOT REPRODUCIBLE']) + ledgerOf(['L07', 'NOT REPRODUCIBLE', 'UI']);
    const { latest } = readCurrentStatus(text);
    expect(staleSummaryRows(text, latest)).toEqual([]);
  });

  it('names a row the ledger has no account of', () => {
    const text = table(['L09', 'OPEN']) + ledgerOf(['L01', 'OPEN', 'UI']);
    const { latest } = readCurrentStatus(text);
    expect(staleSummaryRows(text, latest)).toEqual([{ id: 'L09', table: 'OPEN', latest: null }]);
  });

  it('reads only the table above the first entry, not tables inside entries', () => {
    // Entry bodies carry their own tables; a row there is evidence, not a summary.
    const text = table(['L01', 'FIXED']) + ledgerOf(['L01', 'FIXED', 'UI']) +
      '| L01 | UI | DOC | med | OPEN | new | quoted from an earlier account |\n';
    const { latest } = readCurrentStatus(text);
    expect(staleSummaryRows(text, latest)).toEqual([]);
  });
});
