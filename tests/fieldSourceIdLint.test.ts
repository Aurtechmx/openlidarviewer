/**
 * fieldSourceIdLint.test.ts — proves the terrain-field namespace guard REJECTS,
 * and that the committed tree no longer asserts a key it cannot honour.
 *
 * THE DEFECT. `validation/terrain-field/datasets/manifest.json` and the crop
 * descriptors beside it called their handle `datasetId`, the same field name
 * `validation/datasets/dataset-register.yaml` uses for its citation handles.
 * The two namespaces shared no values, so every one of those handles was a
 * dangling foreign key and nothing read them.
 *
 * WHY THE HANDLE IS NOT A REGISTER KEY. The register rejects an unknown licence
 * (R1) and demands a digest for bytes that were fetched (R2). Three of these
 * acquisitions have neither recorded anywhere in this tree, so registering them
 * would mean writing provenance nobody measured. The cases below hold the
 * harness to its own namespace instead.
 *
 * The lint's rules are exercised on synthetic documents, because they are about
 * the rules. Two further cases run the real CLI over a scaffolded tree, so the
 * exit code is observed rather than assumed.
 */
// lint-dataset-citations: synthetic-ids — the register handle below is a fixture
// for the masquerade rule, not a citation of any record.

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Kept on one line: @ts-expect-error applies to the line that follows it.
// @ts-expect-error — plain .mjs script, no types
import { collectTerrainFieldProblems, parseRegisterIds } from '../scripts/lint-terrain-field-ids.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LINT = resolve(ROOT, 'scripts/lint-terrain-field-ids.mjs');
const MANIFEST_PATH = resolve(ROOT, 'validation/terrain-field/datasets/manifest.json');
const REGISTER_PATH = resolve(ROOT, 'validation/datasets/dataset-register.yaml');

interface Result { problems: string[]; sources: number; citations: number }
interface Record_ { sourceId?: string; licence?: string; sourceSha256?: string; [k: string]: unknown }

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
  description: string;
  datasets: Record_[];
};
const registerText = readFileSync(REGISTER_PATH, 'utf8');

const run = (
  m: unknown,
  crops: { path: string; doc: unknown }[] = [],
  ids: string[] = [],
): Result => collectTerrainFieldProblems(m, crops, ids) as Result;

/** A scaffold the real CLI can be pointed at: it resolves paths from its own location. */
function scaffold(manifestDoc: unknown, crops: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'olv-field-ids-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'validation/terrain-field/datasets'), { recursive: true });
  mkdirSync(join(dir, 'validation/terrain-field/crops'), { recursive: true });
  mkdirSync(join(dir, 'validation/datasets'), { recursive: true });
  copyFileSync(LINT, join(dir, 'scripts/lint-terrain-field-ids.mjs'));
  writeFileSync(
    join(dir, 'validation/terrain-field/datasets/manifest.json'),
    JSON.stringify(manifestDoc),
  );
  writeFileSync(join(dir, 'validation/datasets/dataset-register.yaml'), registerText);
  for (const [name, doc] of Object.entries(crops)) {
    writeFileSync(join(dir, 'validation/terrain-field/crops', name), JSON.stringify(doc));
  }
  return dir;
}

function runCli(dir: string): { status: number | null; out: string } {
  const r = spawnSync('node', [join(dir, 'scripts/lint-terrain-field-ids.mjs')], {
    encoding: 'utf8',
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('the committed harness asserts no register key', () => {
  it('no manifest record carries datasetId or a bare dataset key', () => {
    for (const record of manifest.datasets) {
      expect(Object.keys(record)).not.toContain('datasetId');
      expect(Object.keys(record)).not.toContain('dataset');
      expect(typeof record.sourceId).toBe('string');
    }
  });

  it('no crop descriptor carries datasetId or a bare dataset key', () => {
    const crops = ['estonia-tava', 'sl-field', 'whitesands-dune'];
    for (const id of crops) {
      const doc = JSON.parse(
        readFileSync(resolve(ROOT, `validation/terrain-field/crops/${id}.crop.json`), 'utf8'),
      ) as Record<string, unknown>;
      expect(Object.keys(doc)).not.toContain('datasetId');
      expect(Object.keys(doc)).not.toContain('dataset');
      expect(typeof doc.sourceId).toBe('string');
    }
  });

  it('the manifest says what a sourceId is and that it does not resolve in the register', () => {
    expect(manifest.description).toContain('sourceId');
    expect(manifest.description).toContain('dataset-register.yaml');
  });
});

describe('no provenance was invented for these acquisitions', () => {
  it('none of them was added to the canonical register', () => {
    const declared = new Set(parseRegisterIds(registerText) as string[]);
    for (const record of manifest.datasets) {
      expect(declared.has(record.sourceId as string)).toBe(false);
    }
  });

  it('the three the register cannot hold still record no digest', () => {
    const blocked = ['VT-STREAM-LAB-2026', 'HYYTIALA-UAV-2025', 'PANGANDARAN-COASTAL-2025'];
    for (const id of blocked) {
      const record = manifest.datasets.find((d) => d.sourceId === id);
      expect(record, `${id} is gone from the manifest`).toBeDefined();
      expect(record?.sourceSha256).toBeUndefined();
    }
  });

  it('neither Zenodo acquisition was given a named licence it never carried', () => {
    for (const id of ['HYYTIALA-UAV-2025', 'PANGANDARAN-COASTAL-2025']) {
      const record = manifest.datasets.find((d) => d.sourceId === id);
      expect(record?.licence).toBe('see Zenodo record terms');
    }
  });
});

describe('T1 — the banned field name', () => {
  it('rejects datasetId returning to a manifest record', () => {
    const { problems } = run({ datasets: [{ datasetId: 'X-1', sourceId: 'X-1' }] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('[T1 field-name-reasserted]');
    expect(problems[0]).toContain('dataset-register.yaml');
  });

  it('rejects a bare dataset key on a crop', () => {
    const m = { datasets: [{ sourceId: 'X-1' }] };
    const { problems } = run(m, [{ path: 'crops/a.crop.json', doc: { dataset: 'X-1', sourceId: 'X-1' } }]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('[T1 field-name-reasserted]');
  });
});

describe('T2 — a crop citation must resolve', () => {
  it('rejects a crop citing a handle no manifest record declares', () => {
    const m = { datasets: [{ sourceId: 'X-1' }] };
    const { problems } = run(m, [{ path: 'crops/a.crop.json', doc: { sourceId: 'X-2' } }]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('[T2 crop-source-dangling]');
    expect(problems[0]).toContain('X-2');
  });

  it('accepts a crop citing a declared handle', () => {
    const m = { datasets: [{ sourceId: 'X-1' }] };
    const { problems, sources, citations } = run(m, [
      { path: 'crops/a.crop.json', doc: { sourceId: 'X-1' } },
    ]);
    expect(problems).toEqual([]);
    expect(sources).toBe(1);
    expect(citations).toBe(1);
  });
});

describe('T3, T4, T5 — the handle itself', () => {
  it('rejects two records sharing a handle', () => {
    const { problems } = run({ datasets: [{ sourceId: 'X-1' }, { sourceId: 'X-1' }] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('[T3 source-id-duplicated]');
  });

  it('rejects a handle that reads as a register citation', () => {
    const { problems } = run({ datasets: [{ sourceId: 'OLV-DS-099-WHITESANDS' }] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('[T4 source-id-masquerades]');
  });

  it('rejects a handle equal to a real register record even off-pattern', () => {
    const { problems } = run({ datasets: [{ sourceId: 'SOME-REAL-ID' }] }, [], ['SOME-REAL-ID']);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('[T4 source-id-masquerades]');
  });

  it('rejects a manifest record with no handle', () => {
    const { problems } = run({ datasets: [{ title: 'nameless' }] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('[T5 source-id-missing]');
  });
});

describe('the CLI exit code, observed', () => {
  it('exits 0 on a consistent scaffold', () => {
    const dir = scaffold(
      { datasets: [{ sourceId: 'X-1' }] },
      { 'a.crop.json': { sourceId: 'X-1' } },
    );
    const { status, out } = runCli(dir);
    expect(status, out).toBe(0);
    expect(out).toContain('lint-terrain-field-ids: OK');
  });

  it('exits non-zero when a crop cites a handle nothing declares', () => {
    const dir = scaffold(
      { datasets: [{ sourceId: 'X-1' }] },
      { 'a.crop.json': { sourceId: 'X-NOT-DECLARED' } },
    );
    const { status, out } = runCli(dir);
    expect(status, out).not.toBe(0);
    expect(out).toContain('[T2 crop-source-dangling]');
    expect(out).toContain('X-NOT-DECLARED');
  });

  it('exits non-zero when the banned field name comes back', () => {
    const dir = scaffold(
      { datasets: [{ datasetId: 'X-1', sourceId: 'X-1' }] },
      { 'a.crop.json': { sourceId: 'X-1' } },
    );
    const { status, out } = runCli(dir);
    expect(status, out).not.toBe(0);
    expect(out).toContain('[T1 field-name-reasserted]');
  });
});

describe('the release chain runs it', () => {
  it('lint:terrain-field-ids sits in test:release:execute before the test buckets', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const steps = pkg.scripts['test:release:execute']
      .split('&&')
      .map((s) => /^npm run ([\w:.-]+)/.exec(s.trim())?.[1] ?? '');
    const mine = steps.indexOf('lint:terrain-field-ids');
    expect(mine).toBeGreaterThan(-1);
    expect(mine).toBeLessThan(steps.indexOf('test:unit'));
    expect(mine).toBeLessThan(steps.indexOf('test:terrain'));
  });
});
