/**
 * datasetRegister.test.ts — each of the nine rejections fails for its OWN reason.
 *
 * A negative test that merely asserts "exit code 1" proves nothing: almost any
 * malformed record exits 1, so a rule can be broken while its test stays green
 * because some unrelated check caught the fixture. Every case here starts from a
 * register that the verifier accepts, changes exactly one thing, and then asserts
 * that the reported rule codes are EXACTLY the intended one. If a mutation starts
 * tripping a second rule the test fails, which is the signal that the fixture, or
 * the rule, drifted.
 *
 * The verifier is run as a process rather than imported, so the exit code the
 * gate would see is the exit code under test.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERIFIER = resolve(REPO, 'scripts/verify-dataset-register.mjs');
const SCHEMA = resolve(REPO, 'validation/datasets/dataset-register.schema.json');
const REGISTER = resolve(REPO, 'validation/datasets/dataset-register.yaml');

/** The committed sample the temp-root records point at. */
const SAMPLE_BODY = 'ncols 2\nnrows 2\ncellsize 1\n1.0 2.0\n3.0 4.0\n';
const SAMPLE_SHA = createHash('sha256').update(SAMPLE_BODY).digest('hex');
const SAMPLE_BYTES = Buffer.byteLength(SAMPLE_BODY);

type Scalar = string | number | boolean | readonly string[];
type Record_ = Record<string, Scalar>;

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dsreg-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data/sample.asc'), SAMPLE_BODY);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A record the verifier accepts. Every case below mutates one field of this. */
function baseRecord(): Record_ {
  return {
    datasetId: 'TEST-DS-001',
    title: 'Synthetic 2x2 sample grid',
    sourceUrl: 'tools/make-sample.mjs',
    landingPage: 'docs/sample.md',
    licence: 'MIT',
    licenceUrl: 'https://example.org/licence',
    redistribution: 'permitted',
    acquisitionDate: '2026-07-29',
    sourceSha256: SAMPLE_SHA,
    sourceBytes: SAMPLE_BYTES,
    format: 'asc',
    pointCount: 'not-applicable',
    sensorType: 'synthetic',
    capturePlatform: 'none-synthetic',
    captureDate: 'not-applicable',
    horizontalCrs: 'local-metric-grid',
    verticalCrs: 'local-metric-grid',
    horizontalUnits: 'metre',
    verticalUnits: 'metre',
    nominalDensity: 'not-applicable',
    terrainClasses: ['planar-tilt'],
    landCoverClasses: ['not-applicable'],
    containsIndependentCheckpoints: false,
    checkpointSource: 'not-applicable',
    checkpointUseRestriction: 'not-applicable',
    dataOwner: 'Test fixture author',
    citation: 'Test fixture, not published.',
    knownLimitations: 'Four cells. It pins the verifier, nothing about terrain.',
    storage: 'committed',
    evidenceRole: 'fixture',
    localPath: 'data/sample.asc',
    controlPointIds: [],
    checkpointIds: [],
  };
}

/** Serialise to the YAML subset the verifier reads. */
function toYaml(records: readonly Record_[]): string {
  const lines = ['schemaVersion: 1', 'datasets:'];
  for (const record of records) {
    const entries = Object.entries(record);
    entries.forEach(([key, value], i) => {
      lines.push(`${i === 0 ? '  - ' : '    '}${key}: ${render(value)}`);
    });
  }
  return `${lines.join('\n')}\n`;
}

function render(value: Scalar): string {
  if (Array.isArray(value)) return `[${value.join(', ')}]`;
  if (typeof value !== 'string') return String(value);
  return /[:#'"[\]]/.test(value) || value.trim() !== value ? JSON.stringify(value) : value;
}

interface Run {
  status: number;
  stdout: string;
  stderr: string;
  codes: string[];
}

/** Write a one-record register into the temp root and run the verifier on it. */
function verify(record: Record_, name = 'register.yaml'): Run {
  const path = join(root, name);
  writeFileSync(path, toYaml([record]));
  const proc = spawnSync(process.execPath, [VERIFIER, '--register', path, '--root', root], {
    encoding: 'utf8',
  });
  const stderr = proc.stderr ?? '';
  const codes = [...new Set([...stderr.matchAll(/\[(R\d|RX) [a-z-]+\]/g)].map((m) => m[0]))];
  return { status: proc.status ?? -1, stdout: proc.stdout ?? '', stderr, codes };
}

/** The whole point of the suite: one rule, one reason, exit code 1. */
function expectOnly(run: Run, code: string) {
  expect(run.codes, run.stderr).toEqual([code]);
  expect(run.status).toBe(1);
}

describe('dataset register — the committed register', () => {
  it('passes the verifier with exit code 0', () => {
    const proc = spawnSync(process.execPath, [VERIFIER], { cwd: REPO, encoding: 'utf8' });
    expect(proc.stderr).toBe('');
    expect(proc.status).toBe(0);
    expect(proc.stdout).toMatch(/^verify:dataset-register OK — /);
  });

  it('declares every field a citing study needs, and storage among them', () => {
    const schema = JSON.parse(readFileSync(SCHEMA, 'utf8')) as {
      $defs: { dataset: { required: string[]; properties: Record<string, unknown> } };
    };
    const required = new Set(schema.$defs.dataset.required);
    for (const field of [
      'datasetId', 'title', 'sourceUrl', 'landingPage', 'licence', 'licenceUrl',
      'redistribution', 'acquisitionDate', 'sourceSha256', 'sourceBytes', 'format',
      'pointCount', 'sensorType', 'capturePlatform', 'captureDate', 'horizontalCrs',
      'verticalCrs', 'horizontalUnits', 'verticalUnits', 'nominalDensity',
      'terrainClasses', 'landCoverClasses', 'containsIndependentCheckpoints',
      'checkpointSource', 'checkpointUseRestriction', 'dataOwner', 'citation',
      'knownLimitations', 'storage', 'evidenceRole',
    ]) {
      expect(required.has(field), `${field} must be required`).toBe(true);
    }
  });

  it('gives every registered dataset a distinct id, because ids are cited', () => {
    const text = readFileSync(REGISTER, 'utf8');
    const ids = [...text.matchAll(/^ {2}- datasetId: (\S+)$/gm)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('accepts the unmutated base record used by the negative cases', () => {
    const run = verify(baseRecord(), 'base.yaml');
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });
});

describe('dataset register — the nine rejections', () => {
  it('R1 rejects a dataset with no licence', () => {
    const record = baseRecord();
    delete record.licence;
    expectOnly(verify(record), '[R1 licence-missing]');
  });

  it('R1 rejects a licence recorded as unknown', () => {
    expectOnly(verify({ ...baseRecord(), licence: 'unknown' }), '[R1 licence-missing]');
  });

  it('R2 rejects a mutable sourceUrl with no sourceSha256', () => {
    const record = baseRecord();
    delete record.localPath;
    const run = verify({
      ...record,
      storage: 'acquired',
      sourceUrl: 'https://example.org/programme/tile-0001.copc.laz',
      sourceSha256: 'not-fetched',
    });
    expectOnly(run, '[R2 mutable-source-needs-checksum]');
    expect(run.stderr).toMatch(/replace the bytes at that URL without notice/);
  });

  it('R3 rejects a dataset with no verticalCrs', () => {
    const record = baseRecord();
    delete record.verticalCrs;
    expectOnly(verify(record), '[R3 crs-missing]');
  });

  it('R3 rejects a dataset with no horizontalCrs', () => {
    const record = baseRecord();
    delete record.horizontalCrs;
    expectOnly(verify(record), '[R3 crs-missing]');
  });

  it('R4 rejects verticalUnits metre against a foot vertical CRS', () => {
    const run = verify({
      ...baseRecord(),
      verticalCrs: 'EPSG:6360 (NAVD88 height (ftUS))',
      verticalUnits: 'metre',
    });
    expectOnly(run, '[R4 unit-axis-mismatch]');
    expect(run.stderr).toMatch(/is a foot system but verticalUnits is "metre"/);
  });

  it('R4 rejects foot units against a metre horizontal CRS', () => {
    const run = verify({
      ...baseRecord(),
      horizontalCrs: 'EPSG:25832 (ETRS89 / UTM zone 32N)',
      horizontalUnits: 'us-survey-foot',
    });
    expectOnly(run, '[R4 unit-axis-mismatch]');
  });

  it('R5 rejects the same point ids used as control and as checkpoints', () => {
    const run = verify({
      ...baseRecord(),
      containsIndependentCheckpoints: true,
      checkpointSource: 'Third-party ground survey, total station',
      checkpointUseRestriction: 'none',
      controlPointIds: ['CTRL-001', 'CTRL-002'],
      checkpointIds: ['CTRL-002', 'CHK-101'],
    });
    expectOnly(run, '[R5 checkpoint-reused-as-control]');
    expect(run.stderr).toMatch(/CTRL-002/);
    expect(run.stderr).not.toMatch(/CTRL-001/);
  });

  it('R6 rejects a recorded sha256 that the committed file contradicts', () => {
    const run = verify({ ...baseRecord(), sourceSha256: 'a'.repeat(64) });
    expectOnly(run, '[R6 checksum-drift]');
    expect(run.stderr).toContain(SAMPLE_SHA);
  });

  it('R7 rejects a restricted dataset that is also redistributable', () => {
    const record = baseRecord();
    delete record.localPath;
    const run = verify({
      ...record,
      storage: 'restricted',
      sourceSha256: 'not-fetched',
      redistribution: 'permitted',
    });
    expectOnly(run, '[R7 restricted-but-redistributable]');
  });

  it('R7 rejects internal-only checkpoints declared as redistributable', () => {
    const run = verify({
      ...baseRecord(),
      containsIndependentCheckpoints: true,
      checkpointSource: 'Third-party ground survey under agreement',
      checkpointUseRestriction: 'internal-only',
      redistribution: 'permitted',
    });
    expectOnly(run, '[R7 restricted-but-redistributable]');
  });

  it('R8 rejects checkpoints produced by the software under test', () => {
    const run = verify({
      ...baseRecord(),
      containsIndependentCheckpoints: true,
      checkpointSource: 'OpenLiDARViewer measurement export, v0.6.3',
      checkpointUseRestriction: 'none',
      checkpointIds: ['CHK-101'],
    });
    expectOnly(run, '[R8 candidate-derived-reference]');
    expect(run.stderr).toMatch(/measures repeatability, not accuracy/);
  });

  it("R8 rejects a source path inside this project's own output tree", () => {
    expectOnly(
      verify({ ...baseRecord(), sourceUrl: 'benchmarks/out/dtm-run/surface.asc' }),
      '[R8 candidate-derived-reference]',
    );
  });

  it('R9 rejects storage committed with the file absent', () => {
    const run = verify({ ...baseRecord(), localPath: 'data/not-here.asc' });
    expectOnly(run, '[R9 committed-file-absent]');
    expect(run.stderr).toMatch(/so absence is not read as breakage/);
  });

  it('R9 rejects storage committed with no localPath at all', () => {
    const record = baseRecord();
    delete record.localPath;
    expectOnly(verify(record), '[R9 committed-file-absent]');
  });
});

describe('dataset register — honesty guards', () => {
  it('requires an EXAMPLE- record to label itself in knownLimitations', () => {
    expectOnly(
      verify({ ...baseRecord(), datasetId: 'EXAMPLE-DS-900', knownLimitations: 'Four cells only.' }),
      '[RX example-unlabelled]',
    );
  });

  it('refuses a precise coordinate pair on a restricted record', () => {
    const record = baseRecord();
    delete record.localPath;
    expectOnly(
      verify({
        ...record,
        storage: 'restricted',
        sourceSha256: 'not-fetched',
        redistribution: 'prohibited',
        knownLimitations: 'Site centre is at 46.204391, 6.143158.',
      }),
      '[RX restricted-coordinates]',
    );
  });

  it('rejects a field the schema does not declare', () => {
    expectOnly(verify({ ...baseRecord(), verticalAccuracy: '0.05' }), '[RX schema]');
  });

  it('rejects a committed file whose size disagrees with the record', () => {
    expectOnly(verify({ ...baseRecord(), sourceBytes: SAMPLE_BYTES + 1 }), '[RX size-drift]');
  });
});
