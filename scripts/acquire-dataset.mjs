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
import { resolve, dirname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkUrl, fetchValidated } from './lib/fetchGuard.mjs';

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
    const id = block.split('\n')[0].trim();
    // Read a 4-space-indented scalar the way the canonical verify-dataset-
    // register.mjs does: trim, then strip a matched surrounding quote pair.
    const field = (name) => {
      const m = new RegExp(`^\\s{4}${name}:\\s*(.+?)\\s*$`, 'm').exec(block);
      if (!m) return null;
      const v = m[1].trim();
      if (v.length > 1 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
        return v.slice(1, -1);
      }
      return v;
    };
    // Classify by the PARSED storage value, not a raw-line regex. The detector
    // used to be `/^\s*storage:\s*acquired\s*$/m`, which matches only the bare
    // token — so a schema-valid `storage: "acquired"` was silently dropped:
    // never fetched, never hashed, while the script still printed OK. Quoting
    // is an established convention in this register (title, citation are
    // quoted), and the canonical gate counts the quoted record as acquired via
    // its parseScalar, so the two tools disagreed about what a record IS. A
    // dropped record also slips past the empty-selection guard as long as one
    // other record matches. Keying off the same parsed value the gate uses
    // closes that.
    if (field('storage') !== 'acquired') continue;
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

  // Validate the URL before it reaches fetch() (SSRF sink). A private/loopback/
  // metadata host is refused loudly rather than requested, and the validated
  // URL object is what gets fetched.
  const checked = checkUrl(rec.url);
  if (checked.problem) {
    problems.push(`${rec.id}: ${checked.problem}.`);
    continue;
  }

  process.stdout.write(`${rec.id} … `);
  let buf;
  try {
    const fetched = await fetchValidated(checked.url);
    if (fetched.problem) {
      problems.push(`${rec.id}: ${fetched.problem}.`);
      console.log('refused');
      continue;
    }
    const res = fetched.res;
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
    // The filename is built from record data (path-injection sink). Reduce both
    // parts to a safe charset, then resolve the target and assert it stays
    // inside `dir` — so a record id or url basename carrying `..` or a
    // separator cannot write outside the requested directory.
    const safe = (s) => s.replace(/[^A-Za-z0-9._-]/g, '_');
    const name = `${safe(rec.id)}__${safe(basename(new URL(rec.url).pathname))}`;
    const target = resolve(dir, name);
    if (target !== dir && !target.startsWith(dir + sep)) {
      problems.push(`${rec.id}: refusing to write outside ${outDir} (resolved to ${target}).`);
      continue;
    }
    writeFileSync(target, buf);
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
