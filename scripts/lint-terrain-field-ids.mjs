#!/usr/bin/env node
/**
 * lint-terrain-field-ids.mjs — namespace guard for the terrain-field harness.
 *
 * THE DEFECT THIS EXISTS FOR. `validation/terrain-field/datasets/manifest.json`
 * and the crop descriptors beside it carried a field called `datasetId` whose
 * values (`USGS-3DEP-WHITESANDS-2020`, `VT-STREAM-LAB-2026`, …) resolve in no
 * record of `validation/datasets/dataset-register.yaml`. The two files shared a
 * field name and no keys, so the name asserted a foreign key that never existed
 * and a reader auditing provenance followed it into nothing.
 *
 * WHY THE NAME CHANGED RATHER THAN THE KEYS. Registering these acquisitions
 * would have been the better fix and the register's contract cannot hold them:
 * `sourceSha256` must be a digest (R2) and `licence` may not be unknown (R1).
 * The raw StREAM Lab, Hyytiala and Pangandaran clouds have no recorded digest
 * anywhere in this tree, and the Zenodo terms behind the latter two were never
 * resolved to a named licence. Inventing either to satisfy the schema is the
 * failure the register exists to prevent, so the harness keeps its own handle
 * under a name that claims nothing: `sourceId`.
 *
 * WHAT IS ENFORCED.
 *   T1 field-name-reasserted   `datasetId` (or a bare `dataset` key) is back in
 *                              a terrain-field descriptor, asserting the key
 *                              again. A convention with no gate is what let the
 *                              original drift in.
 *   T2 crop-source-dangling    a crop cites a `sourceId` no manifest record
 *                              declares, so the bytes it was cut from are
 *                              unnamed.
 *   T3 source-id-duplicated    two manifest records share a `sourceId`, so a
 *                              crop citation resolves to two acquisitions.
 *   T4 source-id-masquerades   a `sourceId` collides with the register's
 *                              `OLV-DS-` namespace, which would make the value
 *                              look like a citation handle again.
 *   T5 source-id-missing       a manifest record declares no handle at all, so
 *                              no crop can say it came from those bytes.
 *
 * `collectTerrainFieldProblems` is a function of the documents it is given, so
 * tests/fieldSourceIdLint.test.ts exercises the rules rather than whatever the
 * repository holds today. The committed tree is checked by the CLI below, in
 * CI and in the release gate.
 */

import { readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from './lib/isCliEntry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIELD_DIR = resolve(ROOT, 'validation/terrain-field');
const MANIFEST = resolve(FIELD_DIR, 'datasets/manifest.json');
const CROPS = resolve(FIELD_DIR, 'crops');
const REGISTER = resolve(ROOT, 'validation/datasets/dataset-register.yaml');

/** Key names that assert a register record. Banned in this harness. */
const BANNED_KEYS = ['datasetId', 'dataset'];

/** The register's citation-handle shape, borrowed here only to reject it. */
const REGISTER_HANDLE = /^(OLV|EXAMPLE)-DS-/;

/** The `datasetId` of every record in the register text, in file order. */
export function parseRegisterIds(registerText) {
  return [...registerText.matchAll(/^ {2}- datasetId: (\S+)$/gm)].map((m) => m[1]);
}

/**
 * Problems in the harness documents.
 *
 * @param manifest  parsed `datasets/manifest.json`
 * @param crops     `{ path, doc }` for each parsed `crops/*.crop.json`
 * @param registerIds ids declared by the canonical register
 * @returns `{ problems, sources, citations }`
 */
export function collectTerrainFieldProblems(manifest, crops, registerIds) {
  const problems = [];
  const records = Array.isArray(manifest?.datasets) ? manifest.datasets : [];
  const known = new Set(registerIds);

  const declared = new Set();
  for (const [i, record] of records.entries()) {
    const where = `manifest datasets[${i}]`;
    for (const key of BANNED_KEYS) {
      if (key in record) {
        problems.push(
          `[T1 field-name-reasserted] ${where} has "${key}", which reads as a key into ` +
            'validation/datasets/dataset-register.yaml. These acquisitions are not registered ' +
            'there and cannot be, so the field is "sourceId".',
        );
      }
    }
    const id = record?.sourceId;
    if (typeof id !== 'string' || id === '') {
      problems.push(`[T5 source-id-missing] ${where} declares no "sourceId", so nothing can cite it.`);
      continue;
    }
    if (declared.has(id)) {
      problems.push(
        `[T3 source-id-duplicated] ${where} repeats sourceId "${id}"; a crop citing it ` +
          'would resolve to two acquisitions.',
      );
    }
    declared.add(id);
    if (REGISTER_HANDLE.test(id) || known.has(id)) {
      problems.push(
        `[T4 source-id-masquerades] ${where} uses sourceId "${id}", which belongs to the ` +
          'register namespace. A harness handle must not read as a register citation.',
      );
    }
  }

  let citations = 0;
  for (const { path, doc } of crops) {
    for (const key of BANNED_KEYS) {
      if (doc && typeof doc === 'object' && key in doc) {
        problems.push(
          `[T1 field-name-reasserted] ${path} has "${key}", which reads as a key into ` +
            'validation/datasets/dataset-register.yaml. Cite the manifest handle as "sourceId".',
        );
      }
    }
    const id = doc?.sourceId;
    if (typeof id !== 'string' || id === '') {
      problems.push(
        `[T5 source-id-missing] ${path} declares no "sourceId", so which bytes it was ` +
          'cut from is unrecorded.',
      );
      continue;
    }
    citations += 1;
    if (!declared.has(id)) {
      problems.push(
        `[T2 crop-source-dangling] ${path} cites sourceId "${id}", which no manifest record ` +
          'declares. Add the acquisition to datasets/manifest.json, or cite the one it came from.',
      );
    }
  }

  return { problems, sources: declared.size, citations };
}

/** True when this module is the entry point rather than an import. */
const real = (p) => { try { return realpathSync(resolve(p)); } catch { return resolve(p); } };
const isCli = isCliEntry(import.meta.url);

if (isCli) {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const registerIds = parseRegisterIds(readFileSync(REGISTER, 'utf8'));
  const crops = [];
  if (existsSync(CROPS)) {
    for (const entry of readdirSync(CROPS).sort()) {
      if (!entry.endsWith('.crop.json')) continue;
      const full = join(CROPS, entry);
      crops.push({ path: relative(ROOT, full), doc: JSON.parse(readFileSync(full, 'utf8')) });
    }
  }

  const { problems, sources, citations } = collectTerrainFieldProblems(manifest, crops, registerIds);

  if (problems.length > 0) {
    console.error(`\nlint-terrain-field-ids: ${problems.length} problem(s):\n`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error('');
    process.exit(1);
  }

  console.log(
    `lint-terrain-field-ids: OK — ${sources} acquisition handle(s), ` +
      `${citations} crop citation(s) all resolve, no register key asserted.`,
  );
}
