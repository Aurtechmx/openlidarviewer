#!/usr/bin/env node
/**
 * gen-v070-status.mjs: the current status of every v0.7 ledger entry.
 *
 * `V070_IMPLEMENTATION_LEDGER.md` is a chronological log, and it is right to
 * be one: an entry revisited later keeps both accounts, so the reasoning that
 * produced each verdict survives.
 *
 * What a chronological log cannot answer is "where does L63 stand today". The
 * summary table at its head answers for L01 to L49 only, and the ledger runs
 * to L145, so most of the file had no current-state view at all while the
 * table read as though it were the whole inventory. This derives that view
 * instead of keeping a second hand-maintained one. Each
 * `### Lnn · STATUS · CATEGORY` heading is an account of an entry at a moment,
 * and the LAST one wins, which is what "current" means in a log. Entries are
 * revisited, so the rule decides real cases rather than being a formality.
 *
 *   node scripts/gen-v070-status.mjs            write the document
 *   node scripts/gen-v070-status.mjs --check     fail if it is stale
 *
 * The check is what the gate runs. A generated document nobody regenerates is
 * a document that lies, and the failure names the command that fixes it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isCliEntry } from './lib/isCliEntry.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = join(ROOT, 'docs/releases/V070_IMPLEMENTATION_LEDGER.md');
const OUT = join(ROOT, 'docs/releases/V070_CURRENT_STATUS.md');

/** `### L90 · PARTIAL · SCIENTIFIC`, with a status that may carry a space. */
const HEADING = /^### (L\d{2,3}) · ([A-Z][A-Z ]*[A-Z]) · ([A-Z][A-Z-]*)$/gm;

/**
 * Any entry heading at all, however it is shaped.
 *
 * Counted separately from {@link HEADING} and on purpose. The first version of
 * this script matched `L\d{2}` and dropped L100 to L145 without a sound: the
 * document said 99 entries, the check agreed, and the gate passed, because
 * generation and verification read the ledger through the same regex. A guard
 * derived from the thing it guards cannot see its own blind spot, so the count
 * below comes from a looser pattern and the two must agree.
 */
const ANY_HEADING = /^### (L\d+)\b/gm;

/** Every entry's latest account, keyed by id. */
export function readCurrentStatus(text = readFileSync(LEDGER, 'utf8')) {
  const latest = new Map();
  const revisited = new Map();
  for (const m of text.matchAll(HEADING)) {
    const [, id, status, category] = m;
    if (latest.has(id)) revisited.set(id, (revisited.get(id) ?? 1) + 1);
    latest.set(id, { status, category });
  }

  // The independent count, compared as ACCOUNTS rather than as ids. Comparing
  // id sets was the first version and it had the same blind spot one level
  // down: an entry with one parseable heading and a later unparseable one is
  // present in `latest`, so the set difference is empty while the document
  // publishes the superseded verdict. Counting every heading catches that,
  // because the newer account is missing from the total even though its id is
  // not.
  let accounts = 0;
  const unparsed = [];
  for (const m of text.matchAll(ANY_HEADING)) {
    accounts++;
    unparsed.push(m[1]);
  }
  let parsed = 0;
  for (const _ of text.matchAll(HEADING)) parsed++;
  if (parsed !== accounts) {
    const ids = [...new Set(unparsed)].filter((id) => !latest.has(id));
    throw new Error(
      `gen-v070-status: ${accounts - parsed} of ${accounts} ledger heading(s) did not parse` +
      `${ids.length > 0 ? ` (entries with no account at all: ${ids.join(', ')})` : ''}. ` +
      'Widen HEADING rather than letting an account vanish.',
    );
  }
  return { latest, revisited };
}

/** The document, derived entirely from the ledger. */
export function renderStatus({ latest, revisited }) {
  const ids = [...latest.keys()].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const counts = new Map();
  for (const { status } of latest.values()) counts.set(status, (counts.get(status) ?? 0) + 1);

  const lines = [
    '# OpenLiDARViewer v0.7: current status per ledger entry',
    '',
    '**Generated. Do not edit.** `node scripts/gen-v070-status.mjs` writes this',
    'from `V070_IMPLEMENTATION_LEDGER.md`, and the gate fails when the two',
    'disagree.',
    '',
    'The ledger is the chronological account and keeps every revision of an',
    'entry. This is the latest account of each, which is a different question',
    'and the one a reader usually has. Where an entry was revisited, the last',
    'heading in the file wins.',
    '',
    `Entries: ${ids.length}. Revisited at least once: ${revisited.size}.`,
    '',
    '## Totals',
    '',
    '| Status | Entries |',
    '| --- | --- |',
    ...[...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([status, n]) => `| ${status} | ${n} |`),
    '',
    '## Entries',
    '',
    '| ID | Status | Area | Accounts |',
    '| --- | --- | --- | --- |',
    ...ids.map((id) => {
      const { status, category } = latest.get(id);
      return `| ${id} | ${status} | ${category} | ${revisited.get(id) ?? 1} |`;
    }),
    '',
  ];
  return lines.join('\n');
}

if (isCliEntry(import.meta.url)) main();

/** Write the document, or check it, depending on the flag. */
function main() {
  const wanted = renderStatus(readCurrentStatus());
  if (process.argv.includes('--check')) {
    let actual = null;
    try {
      actual = readFileSync(OUT, 'utf8');
    } catch {
      actual = null;
    }
    if (actual !== wanted) {
      console.error('lint:v070-status FAILED');
      console.error('');
      console.error(actual === null
        ? '  • docs/releases/V070_CURRENT_STATUS.md is missing.'
        : '  • docs/releases/V070_CURRENT_STATUS.md no longer matches the ledger.');
      console.error('');
      console.error('Run "node scripts/gen-v070-status.mjs" to regenerate it.');
      process.exit(1);
    }
    const { latest } = readCurrentStatus();
    console.log(`lint:v070-status OK — ${latest.size} entries, current status derived from the ledger.`);
  } else {
    writeFileSync(OUT, wanted);
    const { latest, revisited } = readCurrentStatus();
    console.log(`wrote ${OUT} — ${latest.size} entries, ${revisited.size} revisited.`);
  }
}
