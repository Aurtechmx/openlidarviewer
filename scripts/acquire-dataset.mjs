#!/usr/bin/env node
/**
 * acquire-dataset.mjs — fetch an `acquired` dataset and check it is the bytes
 * the register names.
 *
 * `storage: acquired` means the bytes live outside this repository and the
 * record carries the hash they must match. Until now nothing could perform that
 * match: the verifier confirms an acquired record does not need a local file,
 * which is a check about the record, not about the data. So the hash was a
 * promise with no way to collect on it, and a study citing the dataset had no
 * route from the id to the bytes.
 *
 * This closes that. It reads the register, fetches `sourceUrl`, and compares
 * length and sha256 against `sourceBytes` and `sourceSha256`. A mismatch is a
 * failure and says which field disagreed, because "the file moved" and "the
 * file changed" need different responses.
 *
 * Deliberately NOT in the release gate. It reaches the network, and a gate that
 * depends on someone else's bucket fails for reasons that have nothing to do
 * with this repository. Run it when adding a record, and when a study is about
 * to cite one.
 *
 *   node scripts/acquire-dataset.mjs                    # every acquired record
 *   node scripts/acquire-dataset.mjs OLV-DS-019-...     # one record
 *   node scripts/acquire-dataset.mjs --out ./downloads  # keep what it fetched
 *
 * EXAMPLE- records are skipped. They document the required shape with an
 * invented host, so fetching them is expected to fail and that failure would
 * say nothing.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTER = resolve(ROOT, 'validation/datasets/dataset-register.yaml');

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outDir = outIdx === -1 ? null : args[outIdx + 1];
// `outIdx + 1` is 0 when --out is absent, and an unguarded `i !== outIdx + 1`
// then drops argv[0] — so a mistyped id was silently read as "no filter" and
// the run passed over every record instead of failing on the unknown one.
const outValueIdx = outIdx === -1 ? -1 : outIdx + 1;
const wanted = args.filter((a, i) => !a.startsWith('--') && i !== outValueIdx);

/**
 * The acquired records, read without a YAML dependency.
 *
 * The register is a flat list of `- datasetId:` blocks with two-space keys, and
 * this reads exactly those five fields. A parser that silently returned nothing
 * on a format change would make this script pass over zero records, so an
 * unparseable field on an acquired record is an error rather than a skip.
 */
function acquiredRecords() {
  const text = readFileSync(REGISTER, 'utf8');
  const out = [];
  for (const block of text.split(/^ {2}- datasetId:/m).slice(1)) {
    if (!/^\s*storage:\s*acquired\s*$/m.test(block)) continue;
    const id = block.split('\n')[0].trim();
    const field = (name) => {
      const m = new RegExp(`^\\s{4}${name}:\\s*(.+?)\\s*$`, 'm').exec(block);
      return m ? m[1].replace(/^["']|["']$/g, '') : null;
    };
    out.push({
      id,
      url: field('sourceUrl'),
      sha256: field('sourceSha256'),
      bytes: field('sourceBytes'),
    });
  }
  return out;
}

const records = acquiredRecords().filter((r) => !r.id.startsWith('EXAMPLE-'));
const selected = wanted.length > 0 ? records.filter((r) => wanted.includes(r.id)) : records;

if (wanted.length > 0 && selected.length !== wanted.length) {
  const missing = wanted.filter((w) => !selected.some((r) => r.id === w));
  console.error(`acquire-dataset FAILED — not an acquired record in the register: ${missing.join(', ')}`);
  process.exit(1);
}

if (selected.length === 0) {
  // A run over zero records is not a pass. Either the register lost its
  // acquired entries or the block parser stopped matching; both are failures,
  // and reporting OK here is exactly the vacuous-check shape this repository
  // keeps finding.
  console.error(
    'acquire-dataset FAILED — no acquired records selected. The register has none, '
    + 'or the parser no longer matches its format.',
  );
  process.exit(1);
}

const problems = [];

for (const rec of selected) {
  if (!rec.url || !rec.sha256 || !rec.bytes) {
    problems.push(`${rec.id}: record is missing sourceUrl, sourceSha256 or sourceBytes.`);
    continue;
  }
  if (rec.sha256 === 'not-fetched') {
    problems.push(`${rec.id}: sourceSha256 is "not-fetched", which is legal only for storage: restricted.`);
    continue;
  }

  process.stdout.write(`${rec.id} … `);
  let buf;
  try {
    const res = await fetch(rec.url, { redirect: 'follow' });
    if (!res.ok) {
      problems.push(`${rec.id}: ${rec.url} returned HTTP ${res.status}.`);
      console.log(`HTTP ${res.status}`);
      continue;
    }
    buf = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    problems.push(`${rec.id}: fetching ${rec.url} failed — ${err instanceof Error ? err.message : String(err)}`);
    console.log('fetch failed');
    continue;
  }

  const gotBytes = buf.length;
  const gotSha = createHash('sha256').update(buf).digest('hex');
  const wantBytes = Number(rec.bytes);

  // Length and hash are reported separately on purpose. A length match with a
  // hash mismatch means the file was edited in place; a length mismatch means
  // it was replaced. Collapsing both into "does not match" loses that.
  if (gotBytes !== wantBytes) {
    problems.push(`${rec.id}: sourceBytes says ${wantBytes}, the host served ${gotBytes}.`);
  }
  if (gotSha !== rec.sha256) {
    problems.push(`${rec.id}: sourceSha256 says ${rec.sha256}, the fetched bytes hash to ${gotSha}.`);
  }
  console.log(gotBytes === wantBytes && gotSha === rec.sha256 ? 'ok' : 'MISMATCH');

  if (outDir) {
    const dir = resolve(ROOT, outDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, `${rec.id}__${basename(new URL(rec.url).pathname)}`), buf);
  }
}

if (problems.length > 0) {
  console.error('\nacquire-dataset FAILED\n');
  for (const p of problems) console.error(`  • ${p}`);
  console.error('');
  process.exit(1);
}

console.log(
  `\nacquire-dataset OK — ${selected.length} acquired record(s) match the bytes their host serves today.`,
);
process.exit(0);
