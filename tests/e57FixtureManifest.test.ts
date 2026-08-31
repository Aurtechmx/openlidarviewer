/**
 * e57FixtureManifest.test.ts
 *
 * Every committed `.e57` test fixture must resolve to a per-fixture record in
 * `validation/datasets/dataset-register.yaml` — an id, source, licence,
 * sha256/bytes and what it exercises — rather than leaning on a single shared
 * comment. This walks `tests/` for `.e57` files and asserts each one's
 * repo-relative path appears as some record's `localPath`, and that the
 * recorded sha256 matches the committed bytes.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error - plain .mjs script, no type declarations
import { parseRegister } from '../scripts/verify-dataset-register.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TESTS_DIR = resolve(ROOT, 'tests');
const REGISTER_PATH = resolve(ROOT, 'validation/datasets/dataset-register.yaml');

function findE57Files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...findE57Files(full));
    } else if (entry.toLowerCase().endsWith('.e57')) {
      out.push(full);
    }
  }
  return out;
}

type Dataset = {
  datasetId: string;
  storage: string;
  localPath?: string;
  sourceSha256: string;
};

const register = parseRegister(readFileSync(REGISTER_PATH, 'utf8')) as { datasets: Dataset[] };
const byLocalPath = new Map<string, Dataset>();
for (const ds of register.datasets) {
  if (ds.storage === 'committed' && ds.localPath) {
    byLocalPath.set(ds.localPath, ds);
  }
}

const fixtures = findE57Files(TESTS_DIR).map((abs) => relative(ROOT, abs).split('\\').join('/'));

describe('every committed .e57 test fixture resolves to a dataset-register manifest id', () => {
  it('found at least one .e57 fixture to check', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(fixtures)('%s resolves to a manifest record', (path) => {
    const ds = byLocalPath.get(path);
    expect(ds, `no committed dataset-register record has localPath: ${path}`).toBeDefined();
    expect(ds!.datasetId).toMatch(/^OLV-DS-\d{3}/);
  });

  it.each(fixtures)('%s bytes match the recorded sha256', (path) => {
    const ds = byLocalPath.get(path)!;
    const bytes = readFileSync(resolve(ROOT, path));
    const actual = createHash('sha256').update(bytes).digest('hex');
    expect(actual).toBe(ds.sourceSha256);
  });
});
