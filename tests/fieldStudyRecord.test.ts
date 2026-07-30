/**
 * fieldStudyRecord.test.ts — proves the field-study verifier REJECTS, and for
 * the stated reason.
 *
 * A verifier nobody has watched fail is a decoration. Each rejection below gets
 * its own case: a record that is valid in every other respect, one field bent,
 * and an assertion on the rule id the verifier reports. Asserting the id, not
 * merely a non-zero exit, is what stops a case from passing because a different
 * rule happened to fire on a fixture that drifted.
 *
 * The verifier runs as a child process, so the exit code a release gate would
 * see is the exit code this suite observes.
 *
 * The case that matters most is F5. src/validation/checkpointAccuracy.ts refuses
 * a checkpoint array whose members leaked into the surface under test; this
 * suite proves the same refusal now applies to a whole record, and the parity
 * test below proves the two vocabularies have not drifted apart.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Kept on one line: @ts-expect-error applies to the line that follows it.
// @ts-expect-error — plain .mjs script, no types
import { protocolDigestOf, CHECKPOINT_USAGES as SCRIPT_USAGES, LEAKING_USAGES as SCRIPT_LEAKING, FIELD_STATUSES } from '../scripts/verify-field-study.mjs';
import { CHECKPOINT_USAGES, LEAKING_USAGES, checkpointAccuracy } from '../src/validation/checkpointAccuracy';
import { EVIDENCE_LEVELS } from '../src/validation/evidenceLevel';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERIFIER = join(ROOT, 'scripts/verify-field-study.mjs');
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

type Json = Record<string, any>;

/** Run the verifier and report the literal exit code plus its combined output. */
function run(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [VERIFIER, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status: number | null; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** The rule ids the verifier reported, deduplicated, in first-seen order. */
function rules(out: string): string[] {
  const found: string[] = [];
  for (const m of out.matchAll(/•\s*\[([A-Z0-9-]+)\]/g)) {
    if (!found.includes(m[1])) found.push(m[1]);
  }
  return found;
}

/**
 * A study directory that verifies: a protocol file on disk whose digest matches,
 * a checkpoint plan whose counts add up, and a status that carries no numbers.
 * Every negative case starts here and bends one thing.
 */
function makeStudy(): { dir: string; record: Json } {
  const dir = mkdtempSync(join(tmpdir(), 'olv-field-'));
  mkdirSync(join(dir, 'studies'), { recursive: true });

  const protocolText = '# test protocol\n\nFrozen before fieldwork.\n';
  writeFileSync(join(dir, 'protocol.md'), protocolText);

  const record: Json = {
    schemaVersion: 1,
    studyId: 'TEST-FIELD-001',
    claimId: 'DTM',
    example: false,
    evidenceLevelClaimed: 'E5_EXTERNALLY_VALIDATED',
    protocolDigest: 'sha256:' + '0'.repeat(64),
    preregistration: {
      registeredAt: '2026-01-10',
      protocolPath: 'protocol.md',
      protocolSha256: sha256(protocolText),
      registeredBeforeFieldwork: true,
      witness: 'commit abcdef, which filed this record at pending',
    },
    fieldwork: { startedAt: '2026-02-01', endedAt: '2026-02-03' },
    site: {
      name: 'Test site',
      crs: 'EPSG:32633',
      terrainDescription: 'rolling, 0 to 18 degrees',
      strata: ['open-ground', 'dense-canopy'],
    },
    instrument: {
      make: 'TestMake',
      model: 'TestModel',
      kind: 'gnss-receiver',
      statedAccuracy: {
        horizontalMetres: 0.02,
        verticalMetres: 0.03,
        confidenceLevel: '1-sigma',
        source: 'calibration-certificate',
      },
      calibration: { lastCalibratedAt: '2025-12-01', certificateReference: 'CERT-1' },
    },
    surveyMethod: {
      method: 'gnss-rtk',
      description: '60 s occupations from a network stream',
      referenceFrame: 'ETRF2000 epoch 2026.1',
    },
    checkpoints: {
      count: 50,
      provenance: 'third-party-contractor',
      provenanceNote: 'surveyed under contract before the DTM was produced',
      usages: [{ usage: 'independent', count: 50 }],
      byStratum: [
        { stratum: 'open-ground', count: 30 },
        { stratum: 'dense-canopy', count: 20 },
      ],
      independentOfProcessing: true,
    },
    operators: {
      count: 2,
      independent: true,
      independenceNote: 'separate setups, no shared walkthrough, results exchanged after both finished',
      affiliations: ['Test Survey Co', 'Second Survey Co'],
    },
    candidate: {
      revision: 'a'.repeat(40),
      version: '0.6.3',
      algorithmVersion: 'ground-filter v2',
      product: 'DTM',
    },
    metrics: {
      toleranceAbs: 0.15,
      toleranceUnit: 'metre',
      minimumCheckpoints: 40,
      minimumStratumCheckpoints: 12,
      requiredWithinToleranceFraction: 0.95,
    },
    status: 'pending',
    statusReason: 'registered, not run',
    scope: { supported: [], notCovered: ['any other site'] },
  };
  return { dir, record };
}

/**
 * Write `record` into `dir` with its protocol digest recomputed, then verify.
 * The digest is recomputed on every write on purpose: a case that means to test
 * something else must not trip F12 by accident, and the one case that DOES test
 * F12 bends the digest afterwards.
 */
function verify(dir: string, record: Json, opts: { keepDigest?: boolean } = {}) {
  if (!opts.keepDigest) record.protocolDigest = protocolDigestOf(record);
  writeFileSync(join(dir, 'studies/study.json'), `${JSON.stringify(record, null, 2)}\n`);
  return run(['--studies', join(dir, 'studies'), '--artifact-root', dir]);
}

/** Run one case against a fresh study and clean up after it. */
function check(bend: (r: Json) => void, opts: { keepDigest?: boolean } = {}) {
  const { dir, record } = makeStudy();
  try {
    bend(record);
    return verify(dir, record, opts);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('verify-field-study', () => {
  it('accepts the baseline record it was given', () => {
    const r = check(() => {});
    expect(r.out).toContain('verify:field-study OK');
    expect(r.code).toBe(0);
  });

  it('verifies the committed container, which holds only an example', () => {
    const r = run([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('no field');
    // The committed container must stay empty of real studies. A record without
    // the EXAMPLE- prefix landing here is the failure this line exists to catch.
    const dir = join(ROOT, 'validation/field/studies');
    const names = readFileSync(join(ROOT, 'validation/field/README.md'), 'utf8');
    expect(names).toContain('This container is empty');
    expect(r.out).toContain(dir);
  });

  it('F1 rejects a record missing a required section', () => {
    const r = check((rec) => { delete rec.operators; });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('F1-SCHEMA');
  });

  it('F2 rejects an EXAMPLE- id that is not marked example', () => {
    const r = check((rec) => { rec.studyId = 'EXAMPLE-TEST-FIELD-001'; });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('F2-EXAMPLE');
  });

  it('F3 rejects a claim nobody registered', () => {
    const r = check((rec) => { rec.claimId = 'NO-SUCH-CLAIM'; });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('F3-CLAIM-UNKNOWN');
  });

  it('F4 rejects a record claiming the reproduction level', () => {
    const r = check((rec) => { rec.evidenceLevelClaimed = 'E6_INDEPENDENTLY_REPRODUCED'; });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('F1-SCHEMA');
    expect(r.out).toContain('permitted values');
  });

  // The rule this whole container exists for.
  it('F5 rejects checkpoints that leaked into the surface under test', () => {
    const r = check((rec) => {
      rec.checkpoints.usages = [
        { usage: 'independent', count: 38 },
        { usage: 'control', count: 12 },
      ];
      rec.checkpoints.independentOfProcessing = false;
    });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('F5-CHECKPOINT-LEAKAGE');
    expect(r.out).toContain('measures the fit');
  });

  it('F5 rejects a leakage claim that contradicts the usage counts', () => {
    const r = check((rec) => {
      rec.checkpoints.usages = [
        { usage: 'independent', count: 38 },
        { usage: 'registration', count: 12 },
      ];
      // Says clean, counts say otherwise.
      rec.checkpoints.independentOfProcessing = true;
    });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('F5-CHECKPOINT-LEAKAGE');
  });

  it('F6 rejects a usage string the accuracy module cannot read', () => {
    const r = check((rec) => {
      rec.checkpoints.usages = [{ usage: 'Independent', count: 50 }];
    });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('F6-CHECKPOINT-USAGE-UNKNOWN');
  });

  it('F7 rejects usage counts that do not add up to the checkpoint count', () => {
    const r = check((rec) => {
      rec.checkpoints.usages = [{ usage: 'independent', count: 49 }];
    });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('F7-CHECKPOINT-COUNT');
  });

  it('F8 rejects our own survey described as independent', () => {
    const r = check((rec) => { rec.checkpoints.provenance = 'project-own-survey'; });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('F8-PROVENANCE');
  });

  it('F9 rejects one operator called independent', () => {
    const r = check((rec) => {
      rec.operators.count = 1;
      rec.operators.affiliations = ['Test Survey Co'];
    });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('F9-OPERATORS');
  });

  it('F9 rejects an operator from this project called independent', () => {
    const r = check((rec) => {
      rec.operators.affiliations = ['Test Survey Co', 'OpenLiDARViewer maintainers'];
    });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('F9-OPERATORS');
  });

  it('F10 rejects a protocol registered after fieldwork started', () => {
    const r = check((rec) => { rec.preregistration.registeredAt = '2026-02-02'; });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('F10-PREREGISTRATION');
  });

  it('F10 rejects a protocol digest that does not match the file on disk', () => {
    const r = check((rec) => { rec.preregistration.protocolSha256 = 'b'.repeat(64); });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('F10-PREREGISTRATION');
  });

  it('F11 rejects a calibration certificate that postdates the fieldwork', () => {
    const r = check((rec) => { rec.instrument.calibration.lastCalibratedAt = '2026-02-02'; });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('F11-DATES');
  });

  it('F12 rejects a tolerance edited after the protocol was frozen', () => {
    const { dir, record } = makeStudy();
    try {
      record.protocolDigest = protocolDigestOf(record);
      record.metrics.toleranceAbs = 0.6;
      const r = verify(dir, record, { keepDigest: true });
      expect(r.code).toBe(1);
      expect(rules(r.out)).toContain('F12-PROTOCOL-DIGEST');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F13 rejects a gate that passes everything', () => {
    const r = check((rec) => { rec.metrics.requiredWithinToleranceFraction = 0; });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('F13-METRICS');
  });

  it('F14 rejects a pending record that carries a result', () => {
    const r = check((rec) => {
      rec.result = {
        usableCheckpoints: 50,
        rmse: 0.08,
        bias: 0.01,
        withinToleranceFraction: 1,
        maxAbsResidual: 0.12,
      };
    });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('F14-UNCOUNTED-CARRIES-RESULT');
  });

  it('F15 rejects an observed outcome with no raw observations', () => {
    const r = check((rec) => {
      rec.status = 'meets';
      rec.statusReason = 'within tolerance';
      rec.result = {
        usableCheckpoints: 50,
        rmse: 0.08,
        bias: 0.01,
        withinToleranceFraction: 1,
        maxAbsResidual: 0.12,
      };
    });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('F15-RAW-MISSING');
  });

  it('F16 rejects a status the numbers do not support', () => {
    const r = check((rec) => {
      rec.status = 'meets';
      rec.statusReason = 'claimed';
      rec.checkpoints.rawPath = 'protocol.md';
      rec.checkpoints.rawSha256 = sha256('# test protocol\n\nFrozen before fieldwork.\n');
      rec.result = {
        usableCheckpoints: 50,
        rmse: 0.08,
        bias: 0.01,
        withinToleranceFraction: 0.4,
        maxAbsResidual: 0.9,
      };
    });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('F16-STATUS-VS-RESULT');
  });

  it('F17 rejects an RMSE finer than the reference instrument can resolve', () => {
    const r = check((rec) => {
      rec.status = 'meets';
      rec.statusReason = 'within tolerance';
      rec.checkpoints.rawPath = 'protocol.md';
      rec.checkpoints.rawSha256 = sha256('# test protocol\n\nFrozen before fieldwork.\n');
      rec.result = {
        usableCheckpoints: 50,
        // The instrument states 0.03 m vertical; a study cannot resolve below it.
        rmse: 0.004,
        bias: 0.0,
        withinToleranceFraction: 1,
        maxAbsResidual: 0.01,
      };
    });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('F17-BELOW-INSTRUMENT-RESOLUTION');
  });

  it('F18 rejects a scope broader than the strata surveyed', () => {
    const r = check((rec) => {
      rec.status = 'meets';
      rec.statusReason = 'within tolerance';
      rec.checkpoints.rawPath = 'protocol.md';
      rec.checkpoints.rawSha256 = sha256('# test protocol\n\nFrozen before fieldwork.\n');
      rec.result = {
        usableCheckpoints: 50,
        rmse: 0.08,
        bias: 0.01,
        withinToleranceFraction: 1,
        maxAbsResidual: 0.12,
      };
      rec.scope.supported = [{ stratum: 'urban', statement: 'holds in town too' }];
    });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('F18-SCOPE-BROADER');
  });
});

describe('the record-level refusal matches the array-level one', () => {
  // The verifier is a .mjs script and cannot import a .ts module without pulling
  // the application build into the scripts directory, so the usage vocabulary is
  // duplicated. These two assertions are what stops the duplicate drifting.
  it('carries the same checkpoint usages as checkpointAccuracy.ts', () => {
    expect(SCRIPT_USAGES).toEqual([...CHECKPOINT_USAGES]);
  });

  it('carries the same leaking usages as checkpointAccuracy.ts', () => {
    expect(SCRIPT_LEAKING).toEqual([...LEAKING_USAGES]);
  });

  it('refuses the same sample the accuracy function refuses', () => {
    // The array-level refusal, for the leakage the F5 case above bends a record
    // with. Both sides say no; that is the point of the pairing.
    const result = checkpointAccuracy(
      [
        { id: 'a', measured: 1, reference: 1, usage: 'independent' },
        { id: 'b', measured: 1, reference: 1, usage: 'control' },
      ],
      { minSample: 1 },
    );
    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toBe('leakage');
  });

  it('claims the evidence level the ladder actually defines', () => {
    expect(EVIDENCE_LEVELS).toContain('E5_EXTERNALLY_VALIDATED');
  });

  it('permits no status outside its own vocabulary', () => {
    const schema = JSON.parse(readFileSync(join(ROOT, 'validation/field/field-study.schema.json'), 'utf8'));
    expect(schema.properties.status.enum).toEqual(FIELD_STATUSES);
  });
});
